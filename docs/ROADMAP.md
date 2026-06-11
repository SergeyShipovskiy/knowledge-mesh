# Knowledge Mesh (CoreMem) — Roadmap

## Done

### Phase 0 — Foundation (MVP)
- ✅ pnpm/TypeScript monorepo: `apps/{indexer,extractor,api,mcp-server}` + `packages/shared`
- ✅ PostgreSQL + pgvector (`knowledge` DB): documents, chunks, entities, relations, sync/extraction state
- ✅ Neo4j graph projection (idempotent, fully rebuildable from Postgres)
- ✅ Obsidian vault as the human source of truth (`CDON_Vault`)
- ✅ Local embeddings (transformers.js, all-MiniLM-L6-v2) — no API keys
- ✅ MVP validated end-to-end: note → Postgres → Neo4j → API, with traceable provenance

### Indexing
- ✅ Incremental indexer (SHA-256 content hashes), full-scan and watch modes
- ✅ Deletion/move handling: vault deletes cascade through Postgres and Neo4j
- ✅ Frontmatter capture, heading-based chunking, wikilink → relation extraction
- ✅ Watcher runs as a launchd service (live indexing on vault edits)

### Retrieval (Phase 1)
- ✅ Hybrid search: vector + Postgres full-text, fused with RRF — exact tokens
  (service names, Kafka topics) always findable
- ✅ Result metadata: entity type, tags, match source
- ✅ `GET /note` + `knowledge_get` — full-note reads through the API/MCP
- ✅ Prescriptive MCP tool descriptions (agents know *when* to use each tool)

### Semantic layer (Phase 2)
- ✅ LLM extractor (`claude -p` headless, on subscription; model/concurrency configurable)
- ✅ Semantic objects: Decision, Idea, Claim, Problem, Constraint, Pattern, Technology, Project
- ✅ Structural objects: Service, Topic, BoundedContext with exhaustive
  PUBLISHES_TO / SUBSCRIBES_TO / CALLS_HTTP / BELONGS_TO extraction
- ✅ Provenance: every object carries `EXTRACTED_FROM` → source note
- ✅ Incremental + idempotent (re-extraction replaces exactly its own output; orphan cleanup)
- ✅ `GET /graph` + `knowledge_graph` — typed neighborhood traversal (1–3 hops)
- ✅ `GET /impact` + `knowledge_impact` — blast-radius reports for platform services,
  including attached Constraints/Decisions/Problems

### Agent access & ops
- ✅ Knowledge API (Fastify) on localhost:3333, launchd-managed, survives reboots
- ✅ MCP server registered user-wide in Claude Code (7 tools)
- ✅ Agent write path: `/remember`, `/proposal` → `vault/agents/<agent>/` only,
  collision-safe, provenance frontmatter
- ✅ Agent status write-back validated end-to-end (commission cleanup status note
  → searchable in seconds → human promoted it into the plan)
- ✅ **Audited edits of human notes** — `knowledge_update_note` /
  `knowledge_undo_edit`: surgical old→new edits with mandatory reason,
  Postgres audit log (`note_edits`), stepwise undo while history remains.
  Replaces the blanket "agents never touch human notes" rule with
  "every edit is attributed and reversible"
- ✅ **Event-driven extraction** — vault changes arm a 3-min quiet-period timer
  in the watcher; extraction runs automatically after editing stops
  (30-min launchd job kept as a fallback; Postgres advisory lock prevents
  overlapping runs; orphan sweep covers note deletions)

### Infrastructure & retrieval quality (post-hackathon)
- ✅ **CoreMem** adopted as product name (Knowledge Mesh = architecture name)
- ✅ Neo4j migrated podman container → native brew service; podman VM retired
  (~4 GB RAM reclaimed); zero-VM boot chain: Postgres + Neo4j (brew),
  API + watcher (launchd)
- ✅ Embeddings upgraded `all-MiniLM-L6-v2` (384d, 256 ctx) →
  **Qwen3-Embedding-0.6B q8** (1024d, last-token pooling, instruct-aware
  queries, multilingual) — validated against golden queries, no regressions
- ✅ Single resident embedding model: `POST /embed` + `EMBEDDING_REMOTE_URL`,
  indexer/watcher delegate to the API (no per-process model copies)
- ✅ `pnpm migrate` handles embedding-dimension changes automatically
- ✅ Relation ownership fix: indexer replaces only its own relations
  (`origin_document_id IS NULL`), extractor manages its own — force reindex
  no longer wipes structural edges
- ✅ Entity dedup: separator-insensitive name matching + one-off SQL merge
  (85 duplicates collapsed)

## Next

### Near term
- [ ] **Golden-set as a script** — the 8-query before/after comparison was run
  manually for the embedding migration; codify 10–15 canonical questions into
  a repeatable script run after every retrieval change
- [ ] **Orphan semantic cleanup in the indexer path** — deletions fully clean the
  graph immediately, not at next extract run
- [ ] **MOC (Map of Content) notes** — generated index notes per area
  (QLTY platform, Commissions) for human navigation and agent drill-down
- [x] **Vault is the single source** — all references to
  `fyndiq-2.0/platform_analysis` removed from skills/agents; fallbacks point at
  the vault itself (✅ 2026-06-11). The analysis-update mechanism (repo diff →
  vault notes) will be redesigned separately
- [x] **Rewire QLTY skills** — `qlty-pr-service-change-analyzer` computes blast
  radius via `knowledge_impact` (MCP or curl) with vault-on-disk fallback, plus
  Step 7 write-back via `knowledge_remember`; `qlty-platform-guide` rewritten as
  "how to query CoreMem"; `qlty-analyst` agent queries the API first, code
  second. Skills now live in this repo (`skills/`) and are symlinked into
  `~/.claude/skills` (✅ 2026-06-11)
- [x] **Scheduled extraction** — launchd job (`com.knowledge-mesh.extract`) runs the
  incremental extractor every 30 min; Postgres advisory lock prevents
  overlapping runs (✅ 2026-06-11)

### Near term (hygiene — next up, in order)
- [ ] **Backups** — nightly launchd job: `pg_dump` of the `knowledge` DB
  (semantic layer = hours of Opus extraction) + vault archive copy. The vault
  is the canon: losing it loses everything
- [ ] **`pnpm doctor`** — one-command self-diagnostics: API/Postgres/Neo4j up,
  watcher alive, counts sane, documents pending extraction
- [ ] **CLAUDE.md** — repo-level guidance so any agent/colleague opening the
  repo understands the architecture and conventions

### Mid term
- [ ] **`origin: agent` provenance on semantic objects** — mark graph objects
  extracted from agent notes so agents can weigh agent-sourced knowledge vs
  human-sourced (echo-chamber protection)
- [ ] **Analysis-update mechanism** — redesign of the old repo-diff script
  (pull repos, diff master vs recorded analysis, update vault notes); design
  pending (owner has a better idea than the export-cache approach)
- [ ] **Plugin for Paperclip** — expose the mesh to the Paperclip agent control
  plane: a plugin wrapping the Knowledge API (search/context/get/impact/remember)
  so Paperclip-orchestrated agents (Developer, Coder, CTO pipeline) share the
  same memory as Claude Code sessions; PR-review tasks attach a
  `knowledge_impact` report automatically
- [ ] **Entity dedup/canonicalization pass** — merge near-duplicate names
  ("Refund service" vs "refund-service"), periodic curation report of new
  semantic entities for human review
- [ ] **Agent-note promotion workflow** — review queue for `vault/agents/*`
  proposals, one-keystroke promotion into human notes
- [ ] **Freshness surfacing** — analysis-commit / dates in search and impact
  results; staleness warnings against repo HEAD
- [ ] **Codex / other MCP clients** — register the same MCP server in Codex CLI

### Long term
- [ ] **Server deployment & remote access** — move the stack (Postgres, Neo4j,
  API, indexer) to a server; vault synced via git/Obsidian Sync; MCP served
  over Streamable HTTP with auth, so any machine and any agent connects to the
  same memory remotely
- [ ] Contradiction monitoring (CONTRADICTS edges as a review queue)
- [ ] Temporal knowledge (SUPERSEDES chains as decision history timelines)
- [ ] Cross-vault federation (work + personal vaults, one query surface)
- [ ] Graph visualization beyond Neo4j Browser (Obsidian graph enrichment or web UI)
- [ ] Memory decay/archival policies for agent-generated notes
