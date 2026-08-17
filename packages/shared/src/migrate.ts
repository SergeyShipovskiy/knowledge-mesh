import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { config } from "./config.js";

const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema.sql"
);

async function alignEmbeddingDimensions() {
  const { rows } = await pool.query(
    `SELECT atttypmod AS dim FROM pg_attribute
     WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`
  );
  const currentDim = rows[0]?.dim;
  const targetDim = config.embedding.dimensions;
  if (currentDim === targetDim) return;

  // Vectors from a different model/dimension are not comparable — drop them
  // and let a forced reindex regenerate embeddings with the new model.
  console.log(
    `Embedding dimension change ${currentDim} → ${targetDim}: resetting embeddings (run "pnpm index --force" after this)`
  );
  await pool.query("DROP INDEX IF EXISTS chunks_embedding_idx");
  await pool.query(
    `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(${targetDim}) USING NULL`
  );
}

// Must stay in sync with schema.sql. A generated column's expression cannot be
// ALTERed, and `ADD COLUMN IF NOT EXISTS` is a no-op on an existing one, so a
// change here only reaches an existing database through this rebuild.
const TS_EXPRESSION = `to_tsvector('english', translate(content, '/', ' '))`;

async function alignTextSearchVector() {
  const { rows } = await pool.query(
    `SELECT pg_get_expr(ad.adbin, ad.adrelid) AS expr
     FROM pg_attrdef ad
     JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE ad.adrelid = 'chunks'::regclass AND a.attname = 'ts'`
  );
  const current: string | undefined = rows[0]?.expr;
  if (current === undefined || current.includes("translate(")) return;

  // Regenerating from `content`, which is already stored — no re-index needed.
  console.log("Text-search vector is stale (no '/' split): rebuilding chunks.ts");
  await pool.query("DROP INDEX IF EXISTS chunks_ts_idx");
  await pool.query("ALTER TABLE chunks DROP COLUMN ts");
  await pool.query(
    `ALTER TABLE chunks ADD COLUMN ts tsvector GENERATED ALWAYS AS (${TS_EXPRESSION}) STORED`
  );
  await pool.query("CREATE INDEX chunks_ts_idx ON chunks USING gin(ts)");
}

async function migrate() {
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);
  await alignEmbeddingDimensions();
  await alignTextSearchVector();

  // HNSW needs pgvector >= 0.5; fall back to no ANN index (fine at small scale).
  try {
    await pool.query(
      "CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops)"
    );
    console.log("HNSW index ready");
  } catch (err) {
    console.warn(`Skipping HNSW index: ${(err as Error).message}`);
  }

  console.log("Schema applied");
  await pool.end();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
