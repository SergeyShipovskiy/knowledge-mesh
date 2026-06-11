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
  },
  api: {
    port: Number(process.env.API_PORT ?? 3333),
    url: process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3333}`,
  },
};
