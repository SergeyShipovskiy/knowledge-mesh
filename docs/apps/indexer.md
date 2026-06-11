# `@knowledge-mesh/indexer` — Vault Indexer

`apps/indexer` turns the Obsidian vault into searchable knowledge. It is a
thin CLI over the shared pipeline (see [shared.md](shared.md)) with two entry
points: a one-shot scan and a continuous watcher.

## Commands

```bash
pnpm index               # one-shot incremental scan (root script)
pnpm index --force       # reindex everything, ignoring content hashes
pnpm index:watch         # initial scan, then watch for file changes
```

Equivalent direct invocations from `apps/indexer/`:

```bash
pnpm start [--force]     # src/main.ts
pnpm watch               # src/watch.ts
```

## One-shot mode (`src/main.ts`)

Runs `indexVault({force})` and prints a summary:

```
Indexing vault: /Users/you/Documents/MyVault
Done in 21.3s — indexed: 82, skipped: 0, removed: 0, graph: 157 nodes / 512 edges
```

What a run does, in order:

1. **Scan** — recursively list `.md` files under `OBSIDIAN_VAULT_PATH`,
   skipping `.obsidian`, `.trash`, `.git`, `node_modules`.
2. **Index** — for each file: SHA-256 the raw content and skip if it matches
   `sync_state` (unless `--force`); otherwise parse frontmatter/links, chunk,
   embed, and store document + chunks + entity in one transaction.
3. **Relations pass** — after *all* files are stored, sync each indexed
   note's relations. Running this as a second pass means wikilinks resolve
   against every real entity; only genuinely missing targets become
   placeholder entities.
4. **Prune** — documents whose files no longer exist on disk are deleted
   (chunks, entity, and relations cascade).
5. **Project** — full idempotent Neo4j projection; graph nodes for deleted
   entities are removed.

Exit code is non-zero on failure; the Postgres pool and Neo4j driver are
closed cleanly either way.

### Incremental behavior

The content hash lives in `sync_state (path, last_hash, indexed_at)`.
A re-run after no changes is fast: every file is `skipped` and only the
(cheap) relations/prune/projection steps run. `--force` bypasses the hash
check — use it after changing the embedding model, the chunking rules, or
the parser.

## Watch mode (`src/watch.ts`)

Performs the same initial full scan, then watches the vault with chokidar:

| Event | Action |
| --- | --- |
| `add` (new `.md`) | Index file, sync its relations, re-project graph |
| `change` | Re-index (forced — hash check skipped), re-project |
| `unlink` | Delete document from Postgres, re-project |

Operational details:

- **Debounce** — events for the same file are debounced by 500 ms, and
  chokidar's `awaitWriteFinish` (400 ms stability) prevents indexing
  half-written files while Obsidian saves.
- **Ignored paths** — any path containing a dot-prefixed segment
  (`.obsidian/`, `.trash/`, …) is ignored; non-`.md` files are ignored.
- **Error isolation** — a failure indexing one file is logged
  (`[watch] failed for <path>`) and does not stop the watcher.
- Obsidian edits, external edits (e.g. `vim`), and API agent writes are all
  picked up the same way — the watcher doesn't care who wrote the file.

Note: file *moves/renames* arrive as `unlink` + `add`, which is handled
naturally (old path pruned, new path indexed). The document gets a new row
and a new entity; relations are rebuilt on the relations pass.

## Failure modes & recovery

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing required env var` at startup | `.env` incomplete, or `#` in an unquoted value | Fill `.env`; quote passwords containing `#` |
| First run is slow | Embedding model download (~30 MB) + ONNX warmup | One-time cost; cached afterwards |
| Graph out of sync with Postgres | Manual Neo4j edits | `pnpm index` re-projects; the graph is disposable |
| Wrong entity types after moving folders | Type inferred from folder names | Re-run `pnpm index` — moved files re-index under new paths |
| Everything looks stale | Hashes match but parser/chunker changed | `pnpm index --force` |

The indexer is safe to run at any time, from any state — including against an
empty Neo4j database or right after `DETACH DELETE`-ing the whole graph.
