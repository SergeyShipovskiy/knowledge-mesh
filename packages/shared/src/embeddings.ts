import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { TimeoutError, withTimeout } from "./timeout.js";

// Qwen3-Embedding is instruction-aware: queries carry an instruct prefix,
// documents are embedded as-is, and pooling is last-token (not mean).
const isQwen = /qwen/i.test(config.embedding.model);
const QWEN_QUERY_PREFIX =
  "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

const WORKER_PATH = fileURLToPath(new URL("./embed-worker.mjs", import.meta.url));
const COLD_RESPAWN_BACKOFF_MS = 2000;

type EmbedKind = "document" | "query";

interface EmbedderStats {
  modelLoaded: boolean;
  workers: number;
  inFlight: number;
  queued: number;
  completed: number;
  failed: number;
  shed: number;
  restarts: number;
  avgMs: number | null;
  lastError: string | null;
}

/** Queue is full — shed load now rather than accept work we cannot drain. */
export class EmbedderBusyError extends Error {
  readonly statusCode = 503;
  constructor(depth: number) {
    super(`embedding queue full (${depth} waiting)`);
    this.name = "EmbedderBusyError";
  }
}

interface Job {
  id: number;
  texts: string[];
  kind: EmbedKind;
  resolve: (v: number[][]) => void;
  reject: (e: Error) => void;
  startedAt: number | null;
  queueTimer: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface Slot {
  proc: ChildProcess;
  ready: boolean; // has answered about the model, successfully or not
  loadFailed: boolean;
  job: Job | null;
  dead: boolean;
}

/**
 * Hosts the resident model in a bounded pool of CHILD PROCESSES (not
 * worker_threads). Two reasons, both learned the hard way on the PS box:
 * killing a wedged worker_thread mid-`session.run` aborts the whole node
 * process (SIGABRT), and re-loading onnxruntime's native addon into a fresh
 * thread of the same process fails with "Module did not self-register". A
 * child dies alone and its replacement links the addon cleanly.
 */
class EmbedderHost {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private completed = 0;
  private failed = 0;
  private shed = 0;
  private restarts = 0;
  private totalMs = 0;
  private lastError: string | null = null;
  private exitHookInstalled = false;
  private coldFailAt: number | null = null;

  private get poolSize(): number {
    return Math.max(1, config.embedding.concurrency);
  }

  /** Spawn eagerly so the model warms off the request path at startup. */
  ensureStarted(): void {
    this.installExitHook();
    // A worker that died before it ever loaded will most likely die again
    // (bad model id, missing addon) — respawning flat out would spin.
    if (this.coldFailAt !== null && performance.now() - this.coldFailAt < COLD_RESPAWN_BACKOFF_MS) {
      return;
    }
    while (this.slots.length < this.poolSize) this.slots.push(this.spawn());
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    // Without this a crashing/exiting API leaves the model process orphaned,
    // holding ~1.4 GB and competing with its own replacement.
    process.on("exit", () => {
      for (const slot of this.slots) slot.proc.kill("SIGKILL");
    });
  }

  private spawn(): Slot {
    const proc = fork(
      WORKER_PATH,
      [
        JSON.stringify({
          model: config.embedding.model,
          dtype: config.embedding.dtype,
          dimensions: config.embedding.dimensions,
          isQwen,
          queryPrefix: QWEN_QUERY_PREFIX,
          cacheDir: config.modelsDir,
        }),
      ],
      // execArgv: [] — the parent may run under tsx; the worker is plain .mjs
      // and must not pay for (or trip over) the loader.
      { execArgv: [], serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] }
    );
    const slot: Slot = { proc, ready: false, loadFailed: false, job: null, dead: false };
    proc.on("message", (msg: any) => this.onMessage(slot, msg));
    proc.on("error", (err) => {
      this.lastError = `worker error: ${err.message}`;
    });
    proc.on("exit", (code, signal) => {
      if (slot.dead) return; // we killed it; replacement already scheduled
      this.replace(slot, `worker exited (code ${code}, signal ${signal})`);
    });
    proc.unref();
    proc.channel?.unref(); // the pool must not keep the process alive by itself
    return slot;
  }

  private onMessage(slot: Slot, msg: any): void {
    if (msg?.type === "ready") {
      // Ready either way: a slot that failed to load still takes jobs, so the
      // caller gets the real model error instead of a vague queue timeout.
      slot.ready = true;
      slot.loadFailed = Boolean(msg.error);
      if (msg.error) this.lastError = msg.error;
      this.pump();
      return;
    }
    const job = slot.job;
    if (!job || job.id !== msg?.id) return;
    if (msg.type === "progress") {
      this.armStall(job, slot); // one text done — the worker is alive
      return;
    }
    slot.job = null;
    if (msg.type === "error") {
      this.lastError = msg.error;
      this.settle(job, new Error(msg.error));
    } else {
      this.settle(job, null, msg.vectors);
    }
    this.pump();
  }

  private armStall(job: Job, slot: Slot): void {
    if (job.stallTimer) clearTimeout(job.stallTimer);
    const ms = config.embedding.timeoutMs;
    if (ms <= 0) return;
    job.stallTimer = setTimeout(() => {
      slot.job = null;
      this.settle(job, new TimeoutError(ms, "embed"));
      this.replace(slot, `stuck job >${ms}ms`);
    }, ms);
    job.stallTimer.unref?.();
  }

  /** Kill a wedged/dead worker and stand up a fresh one; its job is already lost. */
  private replace(slot: Slot, reason: string): void {
    if (slot.dead) return;
    this.coldFailAt = slot.ready ? null : performance.now();
    slot.dead = true;
    slot.ready = false;
    this.lastError = reason;
    this.restarts++;
    const job = slot.job;
    slot.job = null;
    if (job) this.settle(job, new Error(`embedding worker ${reason}`));
    slot.proc.kill("SIGKILL");
    const index = this.slots.indexOf(slot);
    if (index !== -1) this.slots.splice(index, 1);
    this.ensureStarted();
    this.pump();
    if (this.coldFailAt !== null) {
      const retry = setTimeout(() => {
        this.coldFailAt = null;
        this.ensureStarted();
        this.pump();
      }, COLD_RESPAWN_BACKOFF_MS);
      retry.unref?.();
    }
  }

  private settle(job: Job, error: Error | null, vectors?: number[][]): void {
    if (job.settled) return;
    job.settled = true;
    if (job.queueTimer) clearTimeout(job.queueTimer);
    if (job.stallTimer) clearTimeout(job.stallTimer);
    if (error) {
      this.failed++;
      job.reject(error);
    } else {
      this.completed++;
      if (job.startedAt !== null) this.totalMs += performance.now() - job.startedAt;
      job.resolve(vectors ?? []);
    }
    this.updateRefs();
  }

  /** An idle pool must not hold the process open; a busy one must not let it
   *  exit mid-embed (every handle here is unref'd by default). */
  private updateRefs(): void {
    const busy = this.queue.length > 0 || this.slots.some((s) => s.job !== null);
    for (const slot of this.slots) {
      if (busy) slot.proc.channel?.ref();
      else slot.proc.channel?.unref();
    }
  }

  private pump(): void {
    this.updateRefs();
    while (this.queue.length > 0) {
      // Only warm slots take work: a slot still loading the model would start
      // its stall clock on a download, and killing it would restart that.
      const slot = this.slots.find((s) => !s.dead && s.ready && s.job === null);
      if (!slot) return;
      const job = this.queue.shift()!;
      if (job.settled) continue; // timed out while waiting
      if (job.queueTimer) clearTimeout(job.queueTimer);
      job.queueTimer = null;
      job.startedAt = performance.now();
      slot.job = job;
      this.armStall(job, slot); // covers a cold model load too
      slot.proc.send({ id: job.id, texts: job.texts, kind: job.kind });
    }
  }

  dispatch(texts: string[], kind: EmbedKind): Promise<number[][]> {
    if (texts.length === 0) return Promise.resolve([]);
    this.ensureStarted();
    if (this.queue.length >= config.embedding.queueMax) {
      this.shed++;
      return Promise.reject(new EmbedderBusyError(this.queue.length));
    }
    return new Promise<number[][]>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        texts,
        kind,
        resolve,
        reject,
        startedAt: null,
        queueTimer: null,
        stallTimer: null,
        settled: false,
      };
      const waitMs = config.embedding.queueTimeoutMs;
      if (waitMs > 0) {
        job.queueTimer = setTimeout(() => {
          const at = this.queue.indexOf(job);
          if (at !== -1) this.queue.splice(at, 1); // don't let it count as depth
          this.settle(job, new TimeoutError(waitMs, "embed queue wait"));
        }, waitMs);
        job.queueTimer.unref?.();
      }
      // Searches jump the indexer's chunk batches: a read must not wait behind
      // a 40-chunk write. Documents are never dropped — the watcher retries.
      if (kind === "query") this.queue.unshift(job);
      else this.queue.push(job);
      this.pump();
    });
  }

  stats(): EmbedderStats {
    return {
      modelLoaded:
        this.slots.length > 0 && this.slots.every((s) => s.ready && !s.loadFailed),
      workers: this.slots.length,
      inFlight: this.slots.filter((s) => s.job !== null).length,
      queued: this.queue.length,
      completed: this.completed,
      failed: this.failed,
      shed: this.shed,
      restarts: this.restarts,
      avgMs: this.completed > 0 ? Math.round(this.totalMs / this.completed) : null,
      lastError: this.lastError,
    };
  }
}

let embedder: EmbedderHost | null = null;
function localEmbedder(): EmbedderHost {
  if (!embedder) embedder = new EmbedderHost();
  return embedder;
}

let localOnly = false;

/** Called by the API process: it hosts the model (in child processes) and must
 *  never delegate to itself. Spawns eagerly to warm the model. */
export function useLocalEmbeddings(): void {
  localOnly = true;
  localEmbedder().ensureStarted();
}

/** Live embedding stats for /embed/status; null when not hosting the model. */
export function embedderStats(): EmbedderStats | null {
  return localOnly && embedder ? embedder.stats() : null;
}

function useRemote(): boolean {
  return !localOnly && Boolean(config.embedding.remoteUrl);
}

/** Total time a caller may spend on `count` texts: queue wait + per-text stall
 *  budget. A flat cap would fail every large note by construction. */
function budgetMs(count: number): number {
  const { timeoutMs, queueTimeoutMs } = config.embedding;
  if (timeoutMs <= 0) return 0;
  return Math.max(0, queueTimeoutMs) + timeoutMs * count;
}

async function remoteEmbed(texts: string[], kind: EmbedKind): Promise<number[][]> {
  const url = `${config.embedding.remoteUrl}/embed`;
  const budget = budgetMs(texts.length);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, kind }),
        signal: budget > 0 ? AbortSignal.timeout(budget) : undefined,
      });
      if (!response.ok) throw new Error(`embed API ${response.status}`);
      const body = (await response.json()) as { vectors: number[][] };
      return body.vectors;
    } catch (err) {
      lastError = err;
      // 503 means the API is shedding load; back off harder than a plain error.
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(
    `Remote embedding failed (is the Knowledge API running at ${config.embedding.remoteUrl}?): ${(lastError as Error).message}`
  );
}

// Small enough that one HTTP call stays bounded and the API can interleave
// searches between an indexer's batches.
const REMOTE_BATCH = 16;

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

/** Embed documents/chunks (no instruction prefix). Bounded so a slow embed
 *  rejects (504) instead of wedging the caller. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  // Remote already bounds each batch; only the local path needs the outer net.
  if (useRemote()) return embedInner(texts);
  return withTimeout(embedInner(texts), budgetMs(texts.length), "embed");
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
  return withTimeout(inner, budgetMs(1), "embedQuery");
}
