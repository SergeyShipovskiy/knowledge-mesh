# `@knowledge-mesh/api` — Knowledge API

`apps/api` is the unified HTTP interface to the knowledge layer. Humans use
Obsidian; everything else — agents, the MCP server, scripts — goes through
this API. It is a Fastify server reading from Postgres (semantic search,
entities, relations) and writing through the shared pipeline (agent notes are
real markdown files in the vault, indexed immediately).

## Running

```bash
pnpm api        # from repo root → http://127.0.0.1:3333
```

Binds to `127.0.0.1` only (local-first, no auth — multi-user is explicitly
out of scope for v1). Port via `API_PORT`. Requests are logged by Fastify's
built-in logger.

## Endpoints

### `GET /health`

Liveness probe. → `{"status": "ok"}`

---

### `GET /search?q=<query>&limit=<n>`

**Hybrid search** over note chunks: vector similarity (pgvector cosine,
HNSW-indexed) fused with Postgres full-text search (`websearch_to_tsquery`)
via Reciprocal Rank Fusion. Vector catches paraphrased questions; full-text
guarantees exact tokens (service names, Kafka topics, error codes) are found.

- `q` *(required)* — natural-language query or exact term.
- `limit` — max results, default 8, capped at 50.

```json
{
  "query": "purchase.order.events",
  "results": [
    {
      "document_id": "7f0c…",
      "path": "technologies/qlty/platform/inventory-pm-service.md",
      "title": "inventory/pm-service",
      "chunk_content": "kafka:\n  subscribes:\n    - topic: purchase.order.events…",
      "similarity": 0.51,
      "entity_type": "Technology",
      "tags": ["ctx/inventory"],
      "matched_by": ["vector", "text"],
      "score": 0.0287
    }
  ]
}
```

`similarity` is `1 − cosine distance` (null for text-only matches); `score`
is the RRF fusion score results are ranked by; `matched_by` shows which
retriever(s) found the chunk. Results are chunk-level: one document can
appear multiple times.

`400` if `q` is missing.

---

### `GET /note?path=<path>` / `GET /note?name=<title-or-entity>`

Fetch **one full note**: complete markdown `content`, `frontmatter`, and the
note's graph entity. This is the "read" step after `/search` located a
document — agents use it instead of loading files from disk. `path` matches
exactly, then by substring; `name` matches note titles, then entity names.
`404` if nothing matches.

---

### `GET /context?q=<query>&limit=<n>`

Assembled context for grounding an answer: the top matching chunks **plus**
knowledge-graph relations of the documents they came from. This is the
endpoint agents should prefer when they want "what do we know about X".

- `q` *(required)*, `limit` — default 6, capped at 20.

Response fields:

- `context` — a single ready-to-inject markdown string:
  `# Knowledge context for: <q>`, one `## <title> (<path>, similarity <s>)`
  section per chunk, then a `## Related knowledge graph` section with lines
  like `- refund-service —[MENTIONS]→ Valkey (Note)`.
- `results` — same shape as `/search`.
- `entities` — the matched documents' entities with their in/out relations.

---

### `GET /graph?entity=<name>&hops=<1-3>&types=<A,B>`

Typed neighborhood of an entity in the knowledge graph. `entity` is resolved
fuzzily (doc-backed entities and exact matches preferred). `types` optionally
restricts which relation types are traversed
(e.g. `PUBLISHES_TO,SUBSCRIBES_TO`). Returns `nodes` (with type labels,
`kind`, `summary`) and `edges`. Capped at 200 paths.

### `GET /impact?service=<name>`

Blast-radius report for a platform service:

```json
{
  "service": {"name": "purchase/order-handler-service", "type": "Technology"},
  "belongs_to": ["purchase"],
  "publishes": [{"topic": "purchase.order.events", "consumers": ["inventory/pm-service", "…"]}],
  "subscribes": ["purchase.order.commands"],
  "calls_http": [], "called_by_http": [],
  "attached_knowledge": [
    {"type": "Decision", "name": "Idempotent CancelOrder suppression", "summary": "…", "source": "purchase/order-handler-service"}
  ]
}
```

Structural edges come from LLM extraction of the service notes (exhaustive
structural prompt), so completeness mirrors the notes themselves;
`attached_knowledge` surfaces Constraints/Decisions/Problems linked to the
service and its downstream consumers.

---

### `GET /entity/:id`

Entity by UUID, joined with its source document and all relations.

```json
{
  "id": "…", "type": "Technology", "name": "support/refund-service",
  "metadata": {"tags": ["ctx/support"], "path": "…"},
  "path": "technologies/…/support-refund-service.md",
  "title": "support/refund-service",
  "content": "--- full markdown of the note …",
  "relations": [
    {"direction": "out", "type": "MENTIONS", "other": "Valkey", "other_type": "Note"},
    {"direction": "in",  "type": "RELATES_TO", "other": "purchase/qliro-integration-service", "other_type": "Technology"}
  ]
}
```

`path`/`title`/`content` are `null` for placeholder entities (link targets
with no note yet). `404` if the id doesn't exist.

### `GET /entity?name=<substring>`

Entity lookup by case-insensitive name substring (`ILIKE %name%`), up to 20
rows. Use it to find the UUID for `/entity/:id`, or to check whether an
entity exists before calling `/link`.

---

### `POST /remember`

Store new knowledge as an **agent note**. The note becomes a real markdown
file under `vault/agents/<agent>/`, is indexed into Postgres, and projected
into Neo4j before the response returns — it is immediately searchable.

Body:

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes | Used for the H1-less frontmatter title and the slugged filename |
| `content` | yes | Markdown body; `[[wikilinks]]` create graph relations |
| `agent` | no | Agent identity, default `system` (MCP sends `claude`) |
| `type` | no | Entity type (`Note`, `Idea`, `Decision`, …) |
| `tags` | no | String array |

→ `201 {"status": "stored", "path": "agents/claude/<slug>.md"}`

Written file format:

```markdown
---
title: Knowledge Mesh MVP validated
created: '2026-06-10T10:14:48.972Z'
source: 'agent:claude'
type: Note
tags: [knowledge-mesh, milestone]
---

…content…
```

Safety properties (Phase 6 rules):

- Writes land **only** under `agents/<agent>/` — agents can never overwrite
  human notes.
- Filename collisions get a numeric suffix (`note.md`, `note-2.md`) — no
  silent overwrites of other agent notes either.
- Provenance is recorded in frontmatter (`source`, `created`), satisfying the
  MVP requirement that knowledge origin is traceable.

### `POST /proposal`

Same contract as `/remember` (minus `type`), but the file lands in
`agents/<agent>/proposals/` with `status: proposed` in frontmatter. Use for
agent suggestions that a human should review and promote into their own
notes. → `201 {"status": "proposed", "path": …}`

---

### `GET /changes?days=<n>&limit=<n>`

"What's new in the memory": recent agent edits of human notes (who, why,
when, reverted or not — from the `note_edits` audit log) plus notes
created/updated in the vault within the window (default 7 days). Backs the
`knowledge_changes` MCP tool.

---

### `POST /note/update` / `POST /note/undo` / `GET /note/history`

Audited agent edits of **human notes** — the controlled exception to
"agents never overwrite human notes", for when the human explicitly asks
("tick the checkbox in the plan") or confirms a factual status change.

- `POST /note/update` — body `{path, old_string, new_string | append, reason, agent}`.
  Surgical: `old_string` must match the current note exactly once (409
  otherwise — re-read and retry); `append` adds a section at the end.
  `reason` is mandatory. The edit is applied, audit-logged to the
  `note_edits` table, and the note is re-indexed immediately.
- `POST /note/undo` — body `{path, agent}`. Reverts the most recent
  non-reverted edit; call repeatedly to walk back while history remains
  (404 when empty; 409 if the note changed since the edit and the inverse
  no longer applies cleanly).
- `GET /note/history?path=` — the audit trail: who, when, why, reverted or not.

Path traversal outside the vault is rejected; only `.md` files are editable.

---

### `POST /link`

Create a typed relation between two **existing** entities, then re-project
the graph.

Body: `source`, `target` (entity names, case-insensitive exact `ILIKE` match;
entities backed by documents are preferred over placeholders), `type` (one of
`RELATES_TO`, `MENTIONS`, `USES`, `SUPPORTS`, `CONTRADICTS`, `SUPERSEDES`,
`CREATED_BY` — lowercased input is accepted and uppercased), optional
`confidence` (0–1, default 1.0; re-linking updates it).

→ `201 {"status": "linked", "source": "…", "target": "…", "type": "USES"}`
→ `404 {"error": "Entity not found", "missing": ["…"]}` if either side is unknown.

Note: relations created via `/link` live in Postgres + Neo4j but not in any
markdown file, so they survive re-indexing (relation sync only replaces
relations of notes that were re-indexed) but are not visible in Obsidian.
For human-visible links, prefer `/remember` with wikilinks in the content.

## Error handling

Validation failures return `400` with `{"error": "…"}`. Unhandled errors
surface as Fastify's default `500` with the error logged. There is no auth,
rate limiting, or CORS — local single-user scope.

## Source layout

| File | Contents |
| --- | --- |
| `src/server.ts` | Fastify instance + all routes |
| `src/search.ts` | `searchChunks` (vector query), `entityContextForDocuments` |
| `src/vaultWrite.ts` | `writeAgentNote` (slug, collision handling, frontmatter, index trigger) |
