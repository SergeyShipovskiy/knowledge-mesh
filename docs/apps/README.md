# Knowledge Mesh — Application Documentation

Knowledge Mesh is a pnpm monorepo with three runnable applications and one
shared library. All heavy lifting (parsing, chunking, embeddings, storage,
graph projection) lives in the shared package; the apps are thin entry points
around it.

| Package | Path | Role |
| --- | --- | --- |
| [`@knowledge-mesh/shared`](shared.md) | `packages/shared` | Core pipeline library: config, DB clients, embeddings, parse → chunk → store → project |
| [`@knowledge-mesh/indexer`](indexer.md) | `apps/indexer` | CLI that indexes the Obsidian vault, one-shot or in watch mode |
| [`@knowledge-mesh/extractor`](extractor.md) | `apps/extractor` | LLM semantic extraction: decisions, claims, problems, patterns → graph |
| [`@knowledge-mesh/api`](api.md) | `apps/api` | HTTP Knowledge API: search, context, entities, agent writes |
| [`@knowledge-mesh/mcp-server`](mcp-server.md) | `apps/mcp-server` | MCP stdio server exposing the API as agent tools |

## Data flow

```
Obsidian Vault (markdown, human-owned)
      │  read / watch
      ▼
Indexer ──► packages/shared pipeline
      │        1. parse frontmatter, links, entity type
      │        2. chunk by headings (~1500 chars)
      │        3. embed locally (all-MiniLM-L6-v2, 384 dims)
      │        4. store documents/chunks/entities/relations in Postgres
      │        5. project entities + relations into Neo4j (idempotent)
      ▼
PostgreSQL (operational source)          Neo4j (graph projection)
      ▲                                        ▲
      └──────────── Knowledge API ─────────────┘
                         ▲
                         │ HTTP (localhost)
                   MCP Server (stdio)
                         ▲
                         │ MCP protocol
              Agents (Claude Code, Codex, …)
```

Three storage roles, per the project plan:

- **Markdown files** — human source of truth. Always readable and editable in
  Obsidian. Nothing exists only in a database.
- **PostgreSQL** — operational source: full document copies, embedded chunks,
  entities, relations, sync state.
- **Neo4j** — disposable projection. It can be wiped and fully rebuilt from
  Postgres at any time by re-running the indexer.

## Write path for agents

Agents never modify human notes. The only write surface is the Knowledge API
(`POST /remember`, `POST /proposal`, `POST /link`), and file writes land
exclusively under `vault/agents/<agent>/`. Each agent note records provenance
in frontmatter (`source: agent:<name>`, `created` timestamp), so every piece
of knowledge can be traced to its origin.

## Running everything

```bash
pnpm install
pnpm migrate        # apply Postgres schema (packages/shared/src/schema.sql)
pnpm index          # one-shot vault index
pnpm index:watch    # continuous indexing
pnpm api            # Knowledge API on :3333
pnpm mcp            # MCP server (requires the API to be up)
```

Configuration is a single `.env` at the repo root, documented in
[shared.md](shared.md#configuration). Copy `.env.example` to start.

## Conventions shared by all apps

- **TypeScript, ESM, no build step.** Apps run sources directly with `tsx`;
  `@knowledge-mesh/shared` is consumed as TypeScript via its `main` field.
- **One config object.** Everything reads `config` from the shared package,
  which loads the repo-root `.env` exactly once.
- **Idempotency.** Indexing the same content twice is a no-op (content
  hashes); graph projection uses `MERGE`; relation inserts use
  `ON CONFLICT DO NOTHING`.
