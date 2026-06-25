import { Worker } from "node:worker_threads";
import { config } from "./config.js";
import { withTimeout } from "./timeout.js";

// Qwen3-Embedding is instruction-aware: queries carry an instruct prefix,
// documents are embedded as-is, and pooling is last-token (not mean).
const isQwen = /qwen/i.test(config.embedding.model);
const QWEN_QUERY_PREFIX =
  "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

type EmbedKind = "document" | "query";

interface EmbedderStats {
  modelLoaded: boolean;
  queued: number; // pending jobs (in-flight + waiting); worker serializes
  completed: number;
  avgMs: number | null;
  lastError: string | null;
}

/**
 * Runs the resident model in a worker_thread so inference never blocks the API
 * event loop. The worker is plain .mjs and gets all params via workerData.
 */
interface PendingJob {
  resolve: (v: number[][]) => void;
  reject: (e: Error) => void;
  watchdog: ReturnType<typeof setTimeout>;
}

class WorkerEmbedder {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingJob>();
  private modelLoaded = false;
  private completed = 0;
  private totalMs = 0;
  private lastError: string | null = null;

  private spawn(): Worker {
    const worker = new Worker(new URL("./embed-worker.mjs", import.meta.url), {
      workerData: {
        model: config.embedding.model,
        dtype: config.embedding.dtype,
        dimensions: config.embedding.dimensions,
        isQwen,
        queryPrefix: QWEN_QUERY_PREFIX,
        cacheDir: config.modelsDir,
      },
    });
    worker.on("message", (msg: any) => {
      if (msg?.type === "ready") {
        this.modelLoaded = !msg.error;
        if (msg.error) this.lastError = msg.error;
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.watchdog);
      this.pending.delete(msg.id);
      if (msg.error) {
        this.lastError = msg.error;
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg.vectors);
      }
    });
    worker.on("error", (err) => this.recycle(`error: ${err.message}`, worker));
    worker.on("exit", (code) => {
      if (code !== 0) this.recycle(`exited with code ${code}`, worker);
    });
    worker.unref(); // never keep the process alive on the worker alone
    return worker;
  }

  /**
   * Replace a dead or stuck worker and fail its in-flight jobs. The worker runs
   * a single FIFO inference chain that ONNX can't cancel, so one wedged job
   * would block all later ones forever — recycling turns that permanent wedge
   * into a transient error the caller (watcher) simply retries against a fresh
   * worker.
   */
  private recycle(reason: string, from: Worker): void {
    if (this.worker !== from) return; // already recycled
    this.lastError = reason;
    this.modelLoaded = false;
    this.worker = null;
    from.terminate();
    const dead = new Error(`embedding worker ${reason}`);
    for (const job of this.pending.values()) {
      clearTimeout(job.watchdog);
      job.reject(dead);
    }
    this.pending.clear();
  }

  /** Spawn eagerly so the model warms off the main thread at startup. */
  ensureStarted(): void {
    if (!this.worker) this.worker = this.spawn();
  }

  dispatch(texts: string[], kind: EmbedKind): Promise<number[][]> {
    if (texts.length === 0) return Promise.resolve([]);
    if (!this.worker) this.worker = this.spawn();
    const worker = this.worker;
    const id = this.nextId++;
    const startedAt = performance.now();
    return new Promise<number[][]>((resolve, reject) => {
      const watchdog = setTimeout(() => {
        if (this.pending.has(id)) this.recycle(`stuck job >${config.embedding.timeoutMs}ms`, worker);
      }, config.embedding.timeoutMs);
      watchdog.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          this.completed++;
          this.totalMs += performance.now() - startedAt;
          resolve(v);
        },
        reject,
        watchdog,
      });
      worker.postMessage({ id, texts, kind });
    });
  }

  stats(): EmbedderStats {
    return {
      modelLoaded: this.modelLoaded,
      queued: this.pending.size,
      completed: this.completed,
      avgMs: this.completed > 0 ? Math.round(this.totalMs / this.completed) : null,
      lastError: this.lastError,
    };
  }
}

let embedder: WorkerEmbedder | null = null;
function localEmbedder(): WorkerEmbedder {
  if (!embedder) embedder = new WorkerEmbedder();
  return embedder;
}

let localOnly = false;

/** Called by the API process: it hosts the model (in a worker) and must never
 *  delegate to itself. Spawns the worker eagerly to warm the model. */
export function useLocalEmbeddings(): void {
  localOnly = true;
  localEmbedder().ensureStarted();
}

/** Live embedding stats for /embed/status; null when not hosting the model. */
export function embedderStats(): EmbedderStats | null {
  return localOnly && embedder ? embedder.stats() : null;
}

async function remoteEmbed(
  texts: string[],
  kind: EmbedKind
): Promise<number[][]> {
  const url = `${config.embedding.remoteUrl}/embed`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, kind }),
        signal: config.embedding.timeoutMs > 0
          ? AbortSignal.timeout(config.embedding.timeoutMs)
          : undefined,
      });
      if (!response.ok) throw new Error(`embed API ${response.status}`);
      const body = (await response.json()) as { vectors: number[][] };
      return body.vectors;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(
    `Remote embedding failed (is the Knowledge API running at ${config.embedding.remoteUrl}?): ${(lastError as Error).message}`
  );
}

function useRemote(): boolean {
  return !localOnly && Boolean(config.embedding.remoteUrl);
}

const REMOTE_BATCH = 100;

async function embedInner(texts: string[]): Promise<number[][]> {
  if (useRemote()) {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += REMOTE_BATCH) {
      vectors.push(...(await remoteEmbed(texts.slice(i, i + REMOTE_BATCH), "document")));
    }
    return vectors;
  }
  return localEmbedder().dispatch(texts, "document");
}

/** Embed documents/chunks (no instruction prefix). Timed out so a slow embed
 *  rejects (504) instead of wedging the API process. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return withTimeout(embedInner(texts), config.embedding.timeoutMs, "embed");
}

/** Embed a single document/chunk. */
export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  return vector;
}

/** Embed a search query (instruction prefix on instruction-aware models). */
export async function embedQuery(query: string): Promise<number[]> {
  const inner = useRemote()
    ? remoteEmbed([query], "query").then(([v]) => v)
    : localEmbedder()
        .dispatch([query], "query")
        .then(([v]) => v);
  return withTimeout(inner, config.embedding.timeoutMs, "embedQuery");
}
