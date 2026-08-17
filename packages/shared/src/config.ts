import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

loadEnv({ path: path.join(repoRoot, ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  vaultPath: path.resolve(required("OBSIDIAN_VAULT_PATH")),
  // Embedding models are downloaded here on first use (survives node_modules
  // reinstalls; gitignored).
  modelsDir: process.env.MODELS_DIR ?? path.join(repoRoot, "models"),
  postgres: {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? "knowledge",
    user: process.env.POSTGRES_USER ?? process.env.USER ?? "postgres",
    password: process.env.POSTGRES_PASSWORD || undefined,
  },
  neo4j: {
    uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
    user: process.env.NEO4J_USER ?? "neo4j",
    password: required("NEO4J_PASSWORD"),
  },
  embedding: {
    model: process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2",
    dimensions: Number(process.env.EMBEDDING_DIM ?? 384),
    dtype: process.env.EMBEDDING_DTYPE ?? "fp32",
    // When set, processes delegate embedding to the API over HTTP so the
    // model stays resident in exactly one process. The API itself opts out
    // via useLocalEmbeddings().
    remoteUrl: process.env.EMBEDDING_REMOTE_URL || undefined,
    // Stall budget for ONE text, not for a whole batch: the worker reports
    // progress per text and only a gap longer than this counts as stuck. A
    // 40-chunk note is therefore no longer a guaranteed timeout. 0 disables.
    timeoutMs: Number(process.env.EMBED_TIMEOUT_MS ?? 90000),
    // Bounded pool of embed child processes. ONNX Runtime already uses every
    // core per inference, so >1 mostly buys RAM (~1.4 GB resident model each).
    concurrency: Number(process.env.EMBED_CONCURRENCY ?? 1),
    // Backpressure: jobs waiting for a free worker. Over this, callers get 503
    // immediately instead of piling up behind a queue nobody can drain.
    queueMax: Number(process.env.EMBED_QUEUE_MAX ?? 64),
    // How long a job may WAIT for a worker before failing. Distinct from
    // timeoutMs — expiring here means "busy", never "stuck", so no worker dies.
    queueTimeoutMs: Number(process.env.EMBED_QUEUE_TIMEOUT_MS ?? 90000),
  },
  api: {
    port: Number(process.env.API_PORT ?? 3333),
    url: process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3333}`,
  },
};
