/**
 * Concurrent-load regression test for the embedding pool:
 *
 *   pnpm embed:load                      # 8 concurrent clients, 40 requests
 *   pnpm embed:load --concurrency 16 --requests 80 --texts 8
 *
 * Reproduces the 2026-08-16 failure mode (concurrent /embed → stuck jobs →
 * worker SIGABRT → 500s → watcher crash-loop). Exits non-zero if any request
 * fails, if a worker was restarted, or if /health went unresponsive while
 * embeddings were running.
 */
import { config } from "../packages/shared/src/index.ts";

const API = process.env.API_URL ?? config.api.url;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const CONCURRENCY = arg("concurrency", 8);
const REQUESTS = arg("requests", 40);
const TEXTS = arg("texts", 4);
// Near the 1500-char chunk cap: trivial strings never reproduced the wedge.
const CHARS = arg("chars", 1200);
// The API sheds load above EMBED_QUEUE_MAX; 503 is a correct answer, not a bug.
const ALLOW_SHED = process.argv.includes("--allow-shed");

const LOREM =
  "The knowledge mesh indexes markdown notes into Postgres with pgvector and " +
  "projects a typed graph into Neo4j, while an LLM extractor mines semantics. ";

function makeText(seed: number): string {
  const body = LOREM.repeat(Math.ceil(CHARS / LOREM.length)).slice(0, CHARS);
  return `req-${seed} ${body}`;
}

interface Outcome {
  ok: boolean;
  ms: number;
  status: number;
  error?: string;
}

async function embedRequest(seed: number): Promise<Outcome> {
  const texts = Array.from({ length: TEXTS }, (_, i) => makeText(seed * 100 + i));
  const started = performance.now();
  try {
    const response = await fetch(`${API}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
    });
    const ms = performance.now() - started;
    if (!response.ok) {
      return { ok: false, ms, status: response.status, error: await response.text() };
    }
    const body = (await response.json()) as { vectors: number[][] };
    if (body.vectors?.length !== texts.length) {
      return { ok: false, ms, status: 200, error: `got ${body.vectors?.length} vectors` };
    }
    if (body.vectors.some((v) => v.length !== config.embedding.dimensions)) {
      return { ok: false, ms, status: 200, error: "wrong vector dimension" };
    }
    return { ok: true, ms, status: 200 };
  } catch (err) {
    return {
      ok: false,
      ms: performance.now() - started,
      status: 0,
      error: (err as Error).message,
    };
  }
}

/** The point of the worker isolation: /health must stay fast under embed load. */
async function pollHealth(stop: { done: boolean }): Promise<number[]> {
  const samples: number[] = [];
  while (!stop.done) {
    const started = performance.now();
    try {
      await fetch(`${API}/health`, { signal: AbortSignal.timeout(10_000) });
      samples.push(performance.now() - started);
    } catch {
      samples.push(10_000);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return samples;
}

async function status(): Promise<any> {
  try {
    const response = await fetch(`${API}/embed/status`);
    return (await response.json())?.embedder;
  } catch {
    return null;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

async function main(): Promise<void> {
  console.log(
    `Load test → ${API}/embed  (${REQUESTS} requests, ${CONCURRENCY} concurrent, ` +
      `${TEXTS} texts × ${CHARS} chars)\n`
  );
  const before = await status();
  if (before) console.log(`before: ${JSON.stringify(before)}`);

  const stop = { done: false };
  const healthPromise = pollHealth(stop);

  let issued = 0;
  const outcomes: Outcome[] = [];
  const started = performance.now();
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (issued < REQUESTS) {
      const seed = issued++;
      outcomes.push(await embedRequest(seed));
    }
  });
  await Promise.all(workers);
  const elapsed = performance.now() - started;

  stop.done = true;
  const health = await healthPromise;
  const after = await status();

  const failures = outcomes.filter((o) => !o.ok);
  const shed = failures.filter((o) => o.status === 503);
  const hard = ALLOW_SHED ? failures.filter((o) => o.status !== 503) : failures;
  const latencies = outcomes.filter((o) => o.ok).map((o) => o.ms);
  const restarts = (after?.restarts ?? 0) - (before?.restarts ?? 0);

  console.log(`after:  ${JSON.stringify(after)}\n`);
  console.log(`wall clock      ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`ok / total      ${outcomes.length - failures.length} / ${outcomes.length}`);
  console.log(`embed p50/p95   ${percentile(latencies, 50)}ms / ${percentile(latencies, 95)}ms`);
  console.log(`health p95/max  ${percentile(health, 95)}ms / ${Math.round(Math.max(...health))}ms`);
  console.log(`worker restarts ${restarts}`);
  if (shed.length > 0) console.log(`shed (503)      ${shed.length}`);

  const problems: string[] = [];
  for (const failure of hard.slice(0, 5)) {
    problems.push(`request failed (${failure.status}): ${failure.error?.slice(0, 200)}`);
  }
  if (hard.length > 5) problems.push(`…and ${hard.length - 5} more failures`);
  if (restarts > 0) problems.push(`${restarts} worker restart(s) — a job wedged or the worker died`);
  // 2s is generous; the whole point of off-thread inference is single-digit ms.
  if (percentile(health, 95) > 2000) problems.push("/health p95 > 2s — the API event loop stalled");

  if (problems.length > 0) {
    console.log(`\n✗ FAIL`);
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`\n✓ PASS`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
