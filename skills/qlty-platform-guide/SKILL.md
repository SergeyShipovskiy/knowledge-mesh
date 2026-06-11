---
name: qlty-platform-guide
description: How to answer QLTY platform questions (which services exist, bounded contexts, Kafka topics, HTTP deps, tech stacks) by querying CoreMem — the shared knowledge mesh. Use when any agent needs platform structure knowledge. The old embedded service registry is gone; CoreMem is the single live source (vault notes in Obsidian, indexed into Postgres + Neo4j).
---

# QLTY Platform Guide — query CoreMem

The platform knowledge lives in **CoreMem** (a.k.a. Knowledge Mesh): human-curated
notes in the Obsidian vault, indexed for hybrid search and projected into a typed
graph. Do not rely on static snapshots — query live.

## Architecture at a glance (stable facts)

- ~70 services across 6 bounded contexts: **accounting, inventory, merchant, purchase, shop, support**
- Backend: Python (FastAPI / Sanic / Flask + confluent-kafka); frontends: TypeScript (Next.js 15, Express BFFs)
- Event bus: Kafka + Confluent Schema Registry over Avro
- Two storefronts: **Fyndiq** and **CDON** — services ship parallel `kustomize/{fyndiq,cdon}/` + `skaffold/{fyndiq,cdon}.yaml`
- Local dev: see the `qlty-local-dev` skill (Colima k3s)

## How to query

**In Claude Code (MCP tools):**

| Question | Tool |
|---|---|
| "which services / what does X do" | `knowledge_search("X")`, then `knowledge_get(path)` |
| "what do we know about X" (broad) | `knowledge_context("X")` |
| "who consumes topic T / what breaks if I change S" | `knowledge_impact("S")` |
| "what is connected to X" | `knowledge_graph("X", hops=2)` |
| services of a bounded context | `knowledge_graph("<context>", types="BELONGS_TO")` |

**Without MCP (any agent with Bash):** same data over HTTP —

```bash
curl -s 'http://localhost:3333/search?q=order-handler-service&limit=5'
curl -s 'http://localhost:3333/impact?service=order-handler-service'
curl -s 'http://localhost:3333/graph?entity=support&types=BELONGS_TO'
curl -s 'http://localhost:3333/note?path=purchase-order-handler-service'
```

**Fallback if the CoreMem API is down:** read the vault directly —
`/Users/sergship/Documents/CDON_Vault/technologies/qlty/QLTY Platform MOC.md`
(services grouped by context), per-service notes in `technologies/qlty/platform/`.

## Learned something new?

Store it back so the next agent doesn't re-discover it:

```bash
curl -s -X POST http://localhost:3333/remember -H 'Content-Type: application/json' \
  -d '{"title":"<fact>","content":"<details, [[wikilinks]] to services>","tags":["qlty"],"agent":"<your-name>"}'
```

Code is the ultimate source of truth: `/Users/sergship/Projects/QLTY/fyndiq-2.0/bounded_contexts/<context>/<service>/`.
For PR reviews, use the `qlty-pr-service-change-analyzer` skill (CoreMem-first blast radius + verdict).
