# `@knowledge-mesh/shared` — Core Pipeline Library

`packages/shared` contains everything the three apps have in common:
configuration, database clients, the embedding model, and the full
markdown → Postgres → Neo4j indexing pipeline. The apps are thin wrappers
around this package, which is why `POST /remember` in the API produces exactly
the same index state as the indexer CLI re-scanning the file.

## Module map

| Module | Exports | Purpose |
| --- | --- | --- |
| `config.ts` | `config` | Loads repo-root `.env`, validates required vars |
| `db.ts` | `pool`, `toVectorLiteral` | pg connection pool, pgvector literal helper |
| `neo4j.ts` | `getNeo4jDriver`, `closeNeo4j` | Lazy singleton Neo4j bolt driver |
| `embeddings.ts` | `embed`, `embedOne` | Local sentence embeddings (transformers.js) |
| `parse.ts` | `parseNote` | Frontmatter, title, entity type, links extraction |
| `chunk.ts` | `chunkContent` | Heading-based chunking |
| `store.ts` | `storeNote`, `syncRelations`, `deleteDocument`, … | Postgres persistence |
| `graph.ts` | `projectGraph` | Full idempotent Neo4j projection |
| `pipeline.ts` | `indexVault`, `indexFile`, `indexSingleFileAndProject`, … | Orchestration |
| `types.ts` | `EntityType`, `RelationType`, record interfaces | Shared types |
| `migrate.ts` | (script) | Applies `schema.sql` + HNSW index |

## Configuration

`config.ts` loads `.env` from the repository root (resolved relative to the
module file, so it works from any working directory) and exposes:

| Key | Env var | Default | Notes |
| --- | --- | --- | --- |
| `config.vaultPath` | `OBSIDIAN_VAULT_PATH` | — (required) | Absolute path to the vault |
| `config.postgres.host` | `POSTGRES_HOST` | `localhost` | |
| `config.postgres.port` | `POSTGRES_PORT` | `5432` | |
| `config.postgres.database` | `POSTGRES_DB` | `knowledge` | |
| `config.postgres.user` | `POSTGRES_USER` | `$USER` / `postgres` | |
| `config.postgres.password` | `POSTGRES_PASSWORD` | none | Empty string → no password |
| `config.neo4j.uri` | `NEO4J_URI` | `bolt://localhost:7687` | |
| `config.neo4j.user` | `NEO4J_USER` | `neo4j` | |
| `config.neo4j.password` | `NEO4J_PASSWORD` | — (required) | **Quote values containing `#`** — dotenv treats unquoted `#` as a comment |
| `config.embedding.model` | `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | |
| `config.embedding.dimensions` | `EMBEDDING_DIM` | `384` | Must match the model and the `vector(384)` column |
| `config.api.port` | `API_PORT` | `3333` | |
| `config.api.url` | `API_URL` | `http://localhost:<port>` | Used by the MCP server to find the API |

## Embeddings

Embeddings are computed **locally** with transformers.js
(`@huggingface/transformers`). Default model:
`onnx-community/Qwen3-Embedding-0.6B-ONNX` (q8, 1024 dims) — instruction-aware,
multilingual, 32k context. No API keys; the model (~640 MB) is downloaded and
cached on first use. Qwen3 uses **last-token pooling** and an instruct prefix
for queries; non-Qwen models (e.g. the original `Xenova/all-MiniLM-L6-v2`)
fall back to mean pooling. All vectors are L2-normalized.

- `embed(texts)` — documents/chunks (no prefix).
- `embedQuery(query)` — search queries (instruct prefix on Qwen models).
- `embedOne(text)` — single document.

**Single resident model:** when `EMBEDDING_REMOTE_URL` is set, all processes
delegate embedding to the Knowledge API's `POST /embed` (batched ×100, with
retries) so the model lives in exactly one process; the API itself calls
`useLocalEmbeddings()` to host it. Unset the variable for fully standalone
(per-process) embedding.

Changing the model: update `EMBEDDING_MODEL`/`EMBEDDING_DIM`/`EMBEDDING_DTYPE`,
run `pnpm migrate` (detects a dimension change, drops the index and resets the
vector column), then `pnpm index --force`.

## Parsing (`parse.ts`)

`parseNote(relPath, raw)` returns a `ParsedNote` with:

- **Title** — first of: frontmatter `title`, first `# h1` heading, file
  basename without `.md`.
- **Entity type** — first of:
  1. Frontmatter `type:` if it matches a known type (case-insensitive):
     `Project`, `Note`, `Decision`, `Idea`, `Person`, `Technology`,
     `Meeting`, `Agent`.
  2. Any path segment matching a folder convention:
     `projects/` → `Project`, `ideas/` → `Idea`, `decisions/` → `Decision`,
     `people/` → `Person`, `technologies/` → `Technology`,
     `meetings/` → `Meeting`, `agents/` → `Agent`.
  3. Fallback: `Note`.
- **Tags** — frontmatter `tags` (array or single string).
- **Links** — two sources, deduplicated by `(type, target)`:
  - Body wikilinks `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]` →
    `MENTIONS` relation to `Target` (alias and heading stripped; self-links
    to the note's own title are skipped).
  - Frontmatter relation keys → typed relations:
    `relates_to` → `RELATES_TO`, `mentions` → `MENTIONS`, `uses` → `USES`,
    `supports` → `SUPPORTS`, `contradicts` → `CONTRADICTS`,
    `supersedes` → `SUPERSEDES`, `created_by` → `CREATED_BY`.
    Values may be scalars or arrays and may use wikilink syntax
    (`uses: ["[[Neo4j]]", "PostgreSQL"]`).

## Chunking (`chunk.ts`)

`chunkContent(body)` splits the note body into chunks for embedding:

1. Split on markdown headings (any level) — each section starts a chunk.
2. Sections longer than **1500 characters** are split further on blank lines
   (paragraph boundaries), greedily packing paragraphs up to the limit.
3. A single paragraph longer than the limit is kept whole; the embedding
   model truncates at its token limit anyway.

Empty sections are dropped. Chunk order is preserved as `chunk_index`.

## Storage (`store.ts`)

All writes for one note happen in a single Postgres transaction.

`storeNote(note)`:

1. Upsert into `documents` keyed by `path` (updates `title`, `content`,
   `content_hash`, `updated_at`).
2. Delete and re-insert all `chunks` with embeddings (`vector(384)`).
3. Upsert the note's entity with **adoption logic** to keep relations stable:
   - first try updating the entity already attached to this `document_id`;
   - else adopt a *placeholder* entity with the same name (created earlier by
     a wikilink before the note existed) — it gains the real type and
     `document_id`, and existing relations keep pointing at the same row;
   - else insert, with `ON CONFLICT (type, name)` update as a last resort.
4. Upsert `sync_state` with the new content hash.

`syncRelations(entityId, links)` — deletes the entity's outgoing relations and
re-creates them from the parsed links. Targets are resolved by name
(entities with documents preferred); unresolved targets become **placeholder
entities** (`type = 'Note'`, `metadata.placeholder = true`). Self-relations
are skipped.

`hashContent` / `isUnchanged` — SHA-256 content hash checked against
`sync_state` so unchanged files are skipped entirely (no parsing, no
embedding).

`deleteDocument(path)` — removes the document; chunks and the attached entity
(and its relations) cascade.

## Postgres schema (`schema.sql`)

| Table | Key columns | Notes |
| --- | --- | --- |
| `documents` | `path` (unique), `title`, `content`, `content_hash` | Full markdown copy |
| `chunks` | `document_id` FK, `chunk_index`, `content`, `embedding vector(384)` | `UNIQUE (document_id, chunk_index)`; HNSW cosine index (falls back gracefully on pgvector < 0.5) |
| `entities` | `type`, `name` (unique together), `metadata jsonb`, `document_id` FK nullable | `document_id IS NULL` ⇒ placeholder |
| `relations` | `source_entity_id`, `target_entity_id`, `relation_type`, `confidence` | `UNIQUE (source, target, type)` |
| `sync_state` | `path` (PK), `last_hash`, `indexed_at` | Drives incremental indexing |

Apply with `pnpm migrate` (idempotent — everything is `IF NOT EXISTS`).

## Graph projection (`graph.ts`)

`projectGraph()` is a **full, idempotent projection** of Postgres state into
Neo4j — chosen over diff tracking because it is cheap at personal-vault scale
(hundreds of nodes):

1. Every entity becomes a node: `MERGE (n:Entity {entity_id})`, plus a label
   for its type (`:Technology`, `:Decision`, …) and properties `name`,
   `path`, `tags`, `placeholder`.
2. Every relation becomes a typed edge between `entity_id`-matched nodes.
3. Nodes whose `entity_id` no longer exists in Postgres are `DETACH DELETE`d.

Labels and relationship types cannot be parameterized in Cypher, so they are
interpolated — but only after validation against `^[A-Za-z][A-Za-z0-9_]*$`,
and both come from closed enums in practice.

Because the graph is a pure projection, wiping Neo4j entirely and re-running
`pnpm index --force` restores it exactly.

## Pipeline orchestration (`pipeline.ts`)

- `listVaultFiles()` — recursive `.md` scan of the vault, skipping
  `.obsidian`, `.trash`, `.git`, `node_modules`. Returns vault-relative paths.
- `indexFile(relPath, {force})` — hash-check then parse + store one file.
- `indexVault({force})` — full run: index all files, **then** sync relations
  in a second pass (so links resolve against every entity, not just those
  indexed earlier in the scan), remove documents whose files vanished,
  project the graph. Returns `{indexed, skipped, removed, graph}` counts.
- `indexSingleFileAndProject(relPath)` — force-index one file, sync its
  relations, re-project. Used by the watcher and by API writes.
- `removeFileAndProject(relPath)` — delete + re-project. Used by the watcher.
