# CoreMem Knowledge Mesh — Paperclip plugin

Exposes CoreMem (a.k.a. Knowledge Mesh) — the shared human/agent memory — to
agents orchestrated by [Paperclip](https://github.com/paperclipai/paperclip).
A thin connector over the CoreMem Knowledge API: all logic, retrieval quality
and write rules live in the API, so Paperclip agents, Claude Code sessions
(via the MCP server) and scripts all share one memory with identical behavior.

## Tools contributed to agents

| Tool | Purpose |
| --- | --- |
| `knowledge_search` | hybrid search over the shared vault (semantic + exact tokens) |
| `knowledge_context` | one-shot grounding context: note excerpts + graph relations |
| `knowledge_get` | read one full note (content + frontmatter + graph entity) |
| `knowledge_impact` | blast radius of a platform service (topics, consumers, attached decisions) |
| `knowledge_remember` | store new knowledge as an agent note (sandboxed, never overwrites human notes) |
| `knowledge_changes` | what changed in memory recently (agent edits + new/updated notes) |

Write-back notes land under `vault/agents/<agentName>/` (config, default
`paperclip`) with provenance frontmatter — same sandbox rules as every other
agent. A dashboard widget shows whether the Knowledge API is reachable.

> **Plugin vs MCP.** Paperclip can also attach MCP servers directly to an
> agent's toolkit, and CoreMem ships one (`apps/mcp-server`). Pick the plugin
> when you want the tools available platform-wide with one install plus
> server-side surface (dashboard, future event hooks); pick MCP for a quick
> per-agent hookup.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `apiUrl` | `http://127.0.0.1:3333` | Base URL of the CoreMem Knowledge API |
| `agentName` | `paperclip` | Agent identity recorded on write-back notes |

Loopback `apiUrl`s are fetched directly (the Paperclip host's SSRF guard
correctly blocks private addresses for `ctx.http`, but a local-first CoreMem
lives exactly there — direct fetch is sanctioned for trusted local plugins).
Remote URLs go through `ctx.http` and get the host's tracing/audit logging.

## Install into Paperclip

```bash
cd integrations/paperclip-plugin
pnpm install
pnpm build
paperclipai plugin install "$(pwd)"
```

Verify:

```bash
paperclipai plugin list                                  # status=ready
paperclipai plugin data coremem.knowledge-mesh health --payload-json '{}'
```

## Development

```bash
pnpm dev     # watch build; Paperclip reloads the worker on dist/ changes
pnpm test    # vitest against the SDK test harness (API stubbed)
pnpm typecheck
```

## SDK dependency

The build depends on `@paperclipai/plugin-sdk` + `@paperclipai/shared` as
packed tarballs in `.paperclip-sdk/` (gitignored), snapshotted from a local
Paperclip checkout so the plugin always matches the server it runs against.
After a fresh clone, restore them either way:

- re-scaffold the snapshot from your Paperclip checkout:
  `paperclipai plugin init` uses `--sdk-path <checkout>/packages/plugins/sdk`,
  or copy `.paperclip-sdk/` from any existing scaffold; or
- switch `package.json` to the npm-published versions of both packages.

This folder is its own pnpm workspace root (see `pnpm-workspace.yaml`) so its
lockfile and `file:` overrides stay isolated from the knowledge-mesh monorepo.
