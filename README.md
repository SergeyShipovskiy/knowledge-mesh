# Knowledge Mesh (CoreMem)

> Also known as **CoreMem** — the two names are synonyms: CoreMem is the
> product name, Knowledge Mesh describes the architecture.

**One shared, persistent memory for humans and AI agents — local-first, model-agnostic.**

Humans read and write plain markdown in [Obsidian](https://obsidian.md). The
mesh turns those notes into a hybrid search index (PostgreSQL + pgvector +
full-text) and a typed knowledge graph (Neo4j), enriched by an LLM extractor
that pulls out decisions, problems, constraints, claims — and service
architecture (Kafka topics, HTTP dependencies). Agents (Claude Code, Codex,
any MCP client) query and grow the same memory through 9 MCP tools, with full
provenance and reversibility.

```
Obsidian Vault (markdown, human-owned)
      ↓ watcher (live, seconds)
   Indexer  →  PostgreSQL + pgvector  →  Neo4j graph
      ↓          (hybrid search)         (typed relations)
 LLM Extractor (event-driven, ~3 min after editing stops)
      ↓
 Knowledge API (REST, :3333)  →  MCP Server  →  Agents
```

- **Humans first** — knowledge never locks inside a database: markdown is the
  single source of truth; Postgres is operational; Neo4j is a disposable
  projection, rebuildable with one command.
- **Agents are guests with an audit trail** — they write to their own
  `vault/agents/<name>/` area; edits to human notes are surgical, reasoned,
  audit-logged, and undoable step by step.
- **Model/agent-independent** — knowledge lives in markdown and open
  databases; MCP is an open standard; the extractor LLM is one swappable
  function (currently Claude via the `claude` CLI); embeddings are a local
  open model (Qwen3-Embedding-0.6B). Better model tomorrow? Swap it in.

See [docs/PLAN.md](docs/PLAN.md) for the original design,
[docs/ROADMAP.md](docs/ROADMAP.md) for done/next,
[docs/PRESENTATION.md](docs/PRESENTATION.md) for the pitch, and
[docs/apps/](docs/apps/README.md) for per-application documentation
([indexer](docs/apps/indexer.md), [extractor](docs/apps/extractor.md),
[api](docs/apps/api.md), [mcp-server](docs/apps/mcp-server.md),
[shared](docs/apps/shared.md)).

## Install

```bash
git clone <this repo> && cd knowledge-mesh
./scripts/install.sh
```

The interactive installer checks prerequisites, detects existing local
Postgres/Neo4j (and asks before touching anything), lets you set your own
connection parameters and vault path, writes `.env`, applies the schema, and
optionally registers the MCP server and background services. You'll need a
vault — any folder of markdown notes works; [Obsidian](https://obsidian.md)
(free) is the recommended editor for it.

### Prerequisites & minimum resources

| Requirement | Notes |
| --- | --- |
| macOS (Apple Silicon tested) | Background services use launchd; Linux works with systemd units instead |
| Node.js ≥ 20 + pnpm ≥ 9 | runtime for all apps |
| PostgreSQL ≥ 14 + pgvector | operational store + hybrid search |
| Neo4j ≥ 5 (brew) | graph projection — disposable, rebuildable |
| Claude Code CLI (`claude`) | the extractor's LLM engine (subscription; no API key needed) |
| [Obsidian](https://obsidian.md) | human interface to the vault (optional but recommended) |

Measured footprint (M-series MacBook, ~140-note vault):

| Component | RAM | Disk |
| --- | --- | --- |
| Knowledge API (Node + Qwen3-0.6B q8 loaded) | ~530–900 MB | `models/` ~650 MB (auto-downloaded on first run, survives reinstalls) |
| Vault watcher | ~30–50 MB | — |
| PostgreSQL (`knowledge` DB) | ~230 MB | ~40 MB per 150 notes |
| Neo4j (native, idle→loaded) | ~90 MB → ~1 GB | ~30 MB |
| `node_modules` | — | ~1.1 GB |
| **Total working set** | **~1–2.5 GB RAM** | **~3 GB disk** |

The extractor additionally spawns transient `claude` CLI processes while it
runs (~25 s per new/changed note, concurrency 3).

## Usage

```bash
pnpm index          # one-shot incremental vault index
pnpm index:watch    # live indexing (runs as a service after install)
pnpm extract        # LLM semantic extraction (event-driven after install)
pnpm api            # Knowledge API on http://localhost:3333
pnpm mcp            # MCP server (stdio); requires the API
pnpm golden         # retrieval quality evaluation (13 checks)
pnpm run doctor     # one-screen health report (vault, DBs, API, services, backups)
pnpm backup         # manual backup (runs hourly via launchd; ≥20h freshness rule)
./scripts/restore.sh  # interactive restore: DB and/or vault, local or Google Drive
pnpm moc            # regenerate Map-of-Content notes in the vault
pnpm migrate        # apply/upgrade DB schema (handles embedding-dim changes)
```

## MCP tools (12)

| Tool | Purpose |
| --- | --- |
| `knowledge_search` | hybrid search: vector + full-text + title, RRF-fused |
| `knowledge_context` | one-shot grounding: excerpts + graph relations |
| `knowledge_get` | read one full note (content + frontmatter + entity) |
| `knowledge_graph` | typed neighborhood of an entity, 1–3 hops (nodes carry `origin: human\|agent`) |
| `knowledge_impact` | blast radius of a service: topics, consumers, HTTP, attached decisions |
| `knowledge_remember` | store an agent note (own area, never overwrites human notes) |
| `knowledge_changes` | what changed recently: agent edits + new/updated notes |
| `knowledge_update_note` | surgical audited edit of a human note (explicit request only) |
| `knowledge_undo_edit` | stepwise revert of agent edits |
| `knowledge_proposals` | review queue: agent notes awaiting human decision |
| `knowledge_promote` | move an approved agent note into the human vault (audited) |
| `knowledge_link` | typed relation between entities |

Register user-wide in Claude Code (the installer offers this):

```bash
claude mcp add -s user knowledge-mesh -- pnpm --dir <repo-path> mcp
```

## Skills

[skills/](skills/) contains shareable Claude Code skills built on the mesh
(symlink them into `~/.claude/skills/`):

- `qlty-pr-service-change-analyzer` — PR blast-radius runbook: one
  `knowledge_impact` call instead of re-reading a platform map, verdict
  guardrails, and write-back of learned facts
- `qlty-platform-guide` — how to answer platform questions by querying the mesh

## Integrations

- [integrations/paperclip-plugin/](integrations/paperclip-plugin/) — plugin
  for the [Paperclip](https://github.com/paperclipai/paperclip) agent control
  plane: contributes the `knowledge_*` tools to orchestrated agents, so they
  share the same memory as Claude Code sessions. The architecture stays
  client-agnostic: any runtime can either talk to the Knowledge API directly,
  mount the MCP server, or wrap it in its own plugin format like this one.
