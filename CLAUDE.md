# CoreMem (Knowledge Mesh)

One shared memory for humans and AI agents. Humans own markdown notes in an
Obsidian vault; the mesh indexes them (Postgres + pgvector hybrid search),
projects a typed graph (Neo4j), and extracts semantics with an LLM. Agents
consume and grow the same memory via MCP. Read [README.md](README.md) first;
per-app docs in [docs/apps/](docs/apps/README.md); state/next in
[docs/ROADMAP.md](docs/ROADMAP.md).

## Architecture invariants — do not violate

- **Markdown is the source of truth.** Postgres is operational, Neo4j is a
  disposable projection (rebuild: `pnpm index --force`). Never make the graph
  or DB the only home of any knowledge.
- **No format assumptions on notes.** The only invariant is "it's markdown".
  The LLM extractor is the universal parser; never write parsers that depend
  on a note's internal structure.
- **Relation ownership:** the indexer manages relations with
  `origin_document_id IS NULL` (wikilinks/frontmatter); the extractor manages
  rows with `origin_document_id` set. Each replaces only its own.
- **Agent writes are sandboxed or audited.** New knowledge → agent notes under
  `vault/agents/<name>/` (`/remember`). Edits of human notes → `/note/update`
  only: surgical old→new, mandatory reason, logged in `note_edits`, undoable.
  No git on the vault — history lives in Postgres (user's explicit decision).
- **One resident embedding model** — the API hosts it; everything else
  delegates via `EMBEDDING_REMOTE_URL` → `POST /embed`. Models download to
  `models/` (gitignored).
- **Idempotency everywhere:** content-hash incremental indexing/extraction,
  `MERGE` projection, advisory-locked extraction runs.

## Layout

- `packages/shared` — config, DB clients, embeddings, parse→chunk→store→project
  pipeline. Apps are thin wrappers; put logic here.
- `apps/indexer` — one-shot CLI + watcher (live index, event-driven extraction
  trigger after a 3-min quiet period).
- `apps/extractor` — `claude -p` headless engine (subscription, no API key),
  zod-validated output, suffix/separator-insensitive entity resolution.
- `apps/api` — Fastify on :3333. All knowledge access goes through it.
- `apps/mcp-server` — thin stdio client over the API; 12 `knowledge_*` tools.
- `scripts/` — `install.sh` (interactive setup), `golden.ts` (retrieval evals),
  `doctor.ts` (health), `backup.sh` (laptop-friendly: hourly check, ≥20h rule,
  optional rclone offsite), `generate-moc.ts`.
- `skills/` — shareable Claude Code skills built on the mesh; symlinked into
  `~/.claude/skills/`.
- `integrations/paperclip-plugin/` — Paperclip control-plane plugin
  contributing the `knowledge_*` tools to orchestrated agents. Standalone
  pnpm workspace (own lockfile, SDK tarballs in gitignored `.paperclip-sdk/`);
  build with its local `pnpm build`, not the root workspace commands.

## Working on this repo

- Run `pnpm run doctor` before debugging anything — it checks vault, DBs, API,
  services, backups in one shot.
- **Run `pnpm golden` after any change to retrieval** (embeddings, search
  fusion, chunking, extraction prompt, graph queries). 13 checks must pass.
- Typecheck: `pnpm -r exec tsc --noEmit`. No build step — apps run TS via tsx.
- After changing `apps/api` or `packages/shared`, restart the service:
  `launchctl kickstart -k gui/$UID/com.knowledge-mesh.api` (same for
  `.watcher`). MCP server changes need a `/mcp` reconnect in sessions.
- Schema changes go in `packages/shared/src/schema.sql` (idempotent,
  `IF NOT EXISTS`) + `pnpm migrate`. Embedding-dimension changes are handled
  by migrate automatically (drops index, resets vectors, then
  `pnpm index --force`).
- Changing the extractor prompt/schema requires `pnpm extract --force`
  (full re-extraction, ~25s/note on the user's Claude subscription — ask
  before triggering).
- launchd services on this machine: `com.knowledge-mesh.{api,watcher,extract,backup}`,
  logs in `~/Library/Logs/knowledge-mesh-*.log`.

## Conventions

- All persisted artifacts (code, comments, docs, commits) in English.
- Commit messages: conventional (`feat:`, `fix:`, `docs:`); no Co-Authored-By
  trailers; never push — the owner pushes.
- "CoreMem" (product) and "Knowledge Mesh" (architecture) are synonyms; keep
  both findable in docs and tool descriptions.
