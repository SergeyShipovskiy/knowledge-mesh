# `@knowledge-mesh/extractor` — Semantic Extractor

`apps/extractor` upgrades the knowledge graph from *structural* to *semantic*.
The indexer alone produces low-information nodes — notes, folders, wikilinks.
The extractor reads each note with Claude and extracts the knowledge objects
the note actually contains:

| Object types | Decision, Idea, Claim, Problem, Constraint, Pattern, Technology, Project |
| --- | --- |
| **Relation types** | RELATES_TO, USES, SUPPORTS, CONTRADICTS, ADDRESSES, SUPERSEDES |
| **Provenance** | every object gets an `EXTRACTED_FROM` edge to its source note |

Example of what lands in Neo4j after extraction:

```
(:Decision {name: "Keep full ladder in old columns, overrides in new columns",
            summary: "Solution 1, the chosen and implemented approach: …",
            kind: "semantic"})
   -[:ADDRESSES]-> (:Problem {name: "Kafka events break external consumers"})
   -[:EXTRACTED_FROM]-> (:Note {path: "projects/…/CRITICAL_MIGRATION_ISSUE.md"})
```

## Running

```bash
pnpm extract                      # extract all new/changed documents
pnpm extract --limit 5            # only the first 5 pending documents
pnpm extract --path commissions   # only documents whose path matches
pnpm extract --force              # re-extract everything
```

Environment knobs (`.env` or shell):

| Var | Default | Meaning |
| --- | --- | --- |
| `EXTRACTOR_MODEL` | `claude-opus-4-8` | Model passed to the engine |
| `EXTRACTOR_CONCURRENCY` | `3` | Parallel extractions |

## Engine

The extractor calls Claude through the **local `claude` CLI in headless mode**
(`claude -p --output-format json`), running on the user's Claude subscription —
no `ANTHROPIC_API_KEY` required. The prompt instructs the model to emit a
single JSON object; the output is validated with a zod schema
(`src/schema.ts`) and retried once on parse/validation failure. Notes longer
than ~14k characters are truncated before prompting.

`src/engine.ts` is the only file that knows about the CLI. Swapping to the
Anthropic SDK (structured outputs via `client.messages.parse()`) later means
replacing one function.

## How extraction is stored

Extraction is **incremental and idempotent**, mirroring the indexer's design:

1. **Selection** — a document needs extraction when `extraction_state` has no
   row for it or its `content_hash` changed since the last extraction.
2. **Entity resolution** — each extracted object is matched against existing
   entities by case-insensitive name:
   - a **doc-backed entity** of any type wins (the note about Neo4j *is* the
     Neo4j entity — extraction links to it rather than duplicating it);
   - otherwise a same-name placeholder/semantic entity is adopted and retyped;
   - otherwise a new entity is inserted with
     `metadata = {kind: "semantic", summary, confidence, sources: [paths]}`.
3. **Relations** — object↔object relations plus one `EXTRACTED_FROM` edge per
   object back to the note's entity. All extracted relations carry
   `origin_document_id`, so re-extracting a note first deletes exactly the
   relations that note produced and nothing else.
4. **Cleanup** — semantic entities left with no relations after a re-extract
   are deleted (`deleteOrphanSemanticEntities`).
5. **Projection** — one `projectGraph()` at the end of the run pushes
   everything to Neo4j. Semantic nodes carry `kind: "semantic"` and `summary`
   properties; note nodes carry `kind: "note"`; unresolved wikilink targets
   remain `kind: "placeholder"`.

All writes for one document happen in a single Postgres transaction.

## Schema additions

| Object | Purpose |
| --- | --- |
| `extraction_state (document_id PK, last_hash, model, extracted_at)` | Drives incremental extraction |
| `relations.origin_document_id` (nullable FK) | Which document's extraction produced the relation; `NULL` for indexer/wikilink/API relations |

## Useful Neo4j queries

```cypher
// All decisions and what they address
MATCH (d:Decision)-[:ADDRESSES]->(p) RETURN d.name, d.summary, p.name

// Contradictions in the knowledge base
MATCH (a)-[:CONTRADICTS]->(b) RETURN a.name, b.name

// Where does this knowledge come from?
MATCH (o {kind: "semantic"})-[:EXTRACTED_FROM]->(n:Note)
RETURN o.name, n.path LIMIT 50

// Semantic neighborhood of a technology
MATCH (t:Technology {name: "Kafka"})<-[r]-(x) RETURN type(r), x.name, x.kind
```

## Known v1 limitations

- A relation claimed by two documents keeps only the first document's
  `origin_document_id`; re-extracting that document removes the relation even
  though the second document also asserted it. The next full `--force` run
  restores it.
- If an entity changes type across extractions (e.g. placeholder `Note` →
  `Technology`), the old Neo4j label can linger until the graph is rebuilt
  from scratch (wipe Neo4j + `pnpm index --force && pnpm extract --force`).
- Object names are canonicalized by the model, not by code — near-duplicates
  ("Refund service" vs "refund-service") can occasionally produce two nodes.
