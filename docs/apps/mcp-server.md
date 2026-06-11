# `@knowledge-mesh/mcp-server` — MCP Server

`apps/mcp-server` exposes the knowledge layer to AI agents over the Model
Context Protocol. It is deliberately a **thin stdio client over the Knowledge
API** — all logic, validation, and write rules live in the API, so every
agent (Claude Code, Codex, future Paperclip agents) goes through the same
single interface and gets the same behavior.

```
Agent ──MCP/stdio──► mcp-server ──HTTP──► Knowledge API ──► Postgres / Neo4j / Vault
```

## Running

The Knowledge API must be up first:

```bash
pnpm api    # terminal 1
pnpm mcp    # terminal 2 (or let the MCP client spawn it)
```

The server finds the API via `API_URL` (default
`http://localhost:<API_PORT|3333>`). Transport is stdio; diagnostics go to
stderr (stdout is reserved for the protocol).

### Registering in Claude Code

```bash
claude mcp add knowledge-mesh -- pnpm --dir /Users/sergship/Projects/knowledge-mesh mcp
```

Or per-project via `.mcp.json`:

```json
{
  "mcpServers": {
    "knowledge-mesh": {
      "command": "pnpm",
      "args": ["--dir", "/Users/sergship/Projects/knowledge-mesh", "mcp"]
    }
  }
}
```

Other MCP clients (Codex, etc.) point at the same command — one shared memory,
many clients.

## Tools

All tools return the API's JSON response pretty-printed as text content.
Input schemas are zod-validated by the SDK before the handler runs.

### `knowledge_search`

Semantic search over the shared vault. → `GET /search`

| Param | Type | Notes |
| --- | --- | --- |
| `query` | string, required | Natural-language query |
| `limit` | int 1–50, optional | Default 8 |

Returns chunk-level matches with `similarity`, `title`, `path`. Use when
looking for *where* something is written down.

### `knowledge_context`

Assembled grounding context for a topic. → `GET /context`

| Param | Type | Notes |
| --- | --- | --- |
| `query` | string, required | Topic or question |

Returns a ready-to-use markdown `context` block (note excerpts + related
graph relations). Prefer this over `knowledge_search` when answering
questions from shared memory.

### `knowledge_get`

Read one full note from the vault. → `GET /note`

| Param | Type | Notes |
| --- | --- | --- |
| `path` | string, optional | Vault-relative path from search results (substring ok) |
| `name` | string, optional | Note title or entity name when path is unknown |

The "drill-down" step: search locates the note, `knowledge_get` reads it in
full (content + frontmatter + graph entity) — no filesystem access needed.

### `knowledge_graph`

Explore the typed neighborhood of an entity. → `GET /graph`

| Param | Type | Notes |
| --- | --- | --- |
| `entity` | string, required | Fuzzy-matched entity name |
| `hops` | int 1–3, optional | Depth, default 1 |
| `types` | string, optional | Comma-separated relation types to follow |

Use when the question is about relationships ("what is connected to X"),
not text content.

### `knowledge_impact`

Blast-radius analysis for a platform service. → `GET /impact`

| Param | Type | Notes |
| --- | --- | --- |
| `service` | string, required | Service name, fuzzy-matched |

Returns topics published/subscribed, downstream consumers per topic, HTTP
callers/callees, bounded context, and attached Constraints/Decisions/Problems.
Built for PR reviews: "what breaks if I change this service".

### `knowledge_remember`

Persist new knowledge as an agent note. → `POST /remember`

| Param | Type | Notes |
| --- | --- | --- |
| `title` | string, required | |
| `content` | string, required | Markdown; `[[wikilinks]]` become graph edges |
| `type` | enum, optional | `Note`, `Idea`, `Decision`, `Project`, `Person`, `Technology`, `Meeting` |
| `tags` | string[], optional | |
| `agent` | string, optional | Defaults to `claude` |

The note is written to `vault/agents/<agent>/`, indexed, and graph-projected
before the tool returns — immediately searchable by every other agent and
visible to humans in Obsidian. Agents can never overwrite human notes.

### `knowledge_link`

Create a typed relation between two existing entities. → `POST /link`

| Param | Type | Notes |
| --- | --- | --- |
| `source` | string, required | Entity name |
| `target` | string, required | Entity name |
| `type` | enum, required | `RELATES_TO`, `MENTIONS`, `USES`, `SUPPORTS`, `CONTRADICTS`, `SUPERSEDES`, `CREATED_BY` |
| `confidence` | number 0–1, optional | Default 1.0 |

Fails with the API's `404` payload if either entity doesn't exist — search
first, or create the missing note with `knowledge_remember`.

## Error behavior

Non-2xx API responses are thrown as
`Knowledge API <status>: <body>`, which the MCP SDK surfaces to the client as
a tool error. If the API is down entirely, tools fail with a fetch error —
start `pnpm api`.

## Design notes

- **Why HTTP instead of importing the shared pipeline directly?** One
  operational write path. The API enforces the agent-write rules
  (`agents/<agent>/` only, provenance frontmatter, collision-safe filenames);
  the MCP layer cannot bypass them. It also keeps the MCP process light — the
  embedding model loads only in the API process.
- The four tools map 1:1 onto the plan's Phase 5 tool list
  (`knowledge_search`, `knowledge_context`, `knowledge_remember`,
  `knowledge_link`).
- Adding a tool = adding an API endpoint + a `registerTool` block in
  `src/server.ts` (the only source file).
