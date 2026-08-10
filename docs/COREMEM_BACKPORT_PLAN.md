# Plan — backport the coremem fork's retrieval & hygiene work (2026-08-09)

Status: **IMPLEMENTED 2026-08-10** (P1–P4; golden 11/13 = pre-port baseline,
the two failures are the pre-existing ones documented below). Adaptations
made during the port: TITLE_WEIGHT 2→3 and named-note priority in the exact
channel (template service notes cross-mention names in short chunks and
crowded out the note the query names); doctor grew a stale-open-task check;
`collided_with` added explicitly to /remember. Written 2026-08-09 after the
Seyshi fork (`Spacefuel/coremem-server`, forked off this repo in June) shipped
and deployed a retrieval/write-path overhaul (its PRs #6/#7, plan in the
fork's `docs/RETRIEVAL_SUPERSESSION.md`). Most of it transfers here; some of
it this repo already solved its own way; a little of it does not apply.

One sentence: **ranking here is still per-chunk-signal with no notion of
currency, authority, or expiry, and the write path accepts anything — the
fork fixed both, and this vault measurably has the same diseases in its own
local forms.**

## Where the two lineages stand

Complementary, not conflicting:

| Concern | knowledge-mesh (this repo) | coremem fork |
| --- | --- | --- |
| One note = one result slot | ✅ doc-level RRF fusion (`5035998`) | ✅ collapse + representative chunk, `chunks_matched` |
| Embedding wedge under load | ✅ worker isolation, bounded chunks (`12214f0`) | ✅ (carries the same code) |
| Retracted text (corrections) | ❌ | ✅ `chunks.superseded` at index time |
| Verbatim rare tokens (numbers, service names) | ❌ (FTS only) | ✅ dedicated exact-substring channel, weight 3 |
| Authority / expiry weighting | ❌ | ✅ kind/folder/type factors |
| Own-note echo flag | ❌ | ✅ `own_recent_note` via `agent=` |
| Entity-join row multiplication in candidates | ⚠️ half-fixed (doc fusion stops double-counting, but duplicate rows still burn `CANDIDATES` slots) | ✅ join removed from candidate queries |
| Write validation (kind, title, language) | ❌ | ✅ required `kind`, 90-char title, English gate |
| `similar_existing` on remember | ❌ | ✅ |
| Dedup/hygiene tooling | ❌ | ✅ `pnpm dedup`, doctor checks, per-instance golden |

Nothing needs to flow the other way right now: the fork already carries the
wedge fix, and its collapse supersedes the doc-fusion approach.

## The same diseases, measured on THIS vault (2026-08-09)

231 notes: `agents/` 119, `technologies/` 83, `projects/` 28. 168/231 carry
wikilinks (healthy). 0 Cyrillic-heavy notes (the English gate is insurance
here, not a cure).

Near-duplicates (mean-chunk-embedding pairs > 0.85): **511 pairs, 166 of 231
notes** — but the composition matters and differs from the fork's vault:

- `agents/ ↔ agents/` — 101 pairs, max **0.998**: a literal double
  (`agents/claude/netsuite-payment-file-builder-solution-de…` written twice —
  the collision-safe `-2` suffix silently created a full copy), plus chains of
  status write-backs on the same ticket (e.g. PADE-738 review vs
  implementation notes at 0.938). **These are true duplicates/expired
  statuses** — exactly what `kind` + expiry + `similar_existing` prevent.
- `projects/ ↔ projects/` — 155 pairs, mostly inside
  `solution_designs/commissions/`: a deliberate multi-document design set
  sharing vocabulary. **Not duplicates** — a folder-aware dedup report must
  group these, not flag them.
- `technologies/ ↔ technologies/` — 143 pairs (e.g. `web-client-bffs` vs
  `web-client-ssr` at 0.947): template-generated service notes are
  structurally similar by construction. **Expected**, exclude or
  raise-threshold per folder.

So the headline number overstates the disease, but the `agents/` slice is
real: a third-generation status note competes with (and can outrank) the
current one, and nothing expires.

## Port plan

### P1 — retrieval (port `search.ts` + `chunk.ts` + `store.ts` + schema)

1. **Replace doc-fusion with the fork's collapse.** Same intent, more
   capable: representative-chunk selection (needed for supersession),
   `chunks_matched`, and the entity join removed from candidate queries
   (fetch entity types after fusion in one query). Keep `CANDIDATES = 50`.
2. **Exact-token channel.** This vault is full of high-signal identifiers —
   Kafka topics (`purchase.order.events`), service names, PADE/ticket codes.
   Verbatim substring match at weight 3; also covers tokens the `'english'`
   tsvector mangles.
3. **Chunk supersession.** Correction-heading detection at chunk time
   (`chunks.superseded` column, `pnpm index --force` backfill). Less frequent
   here than on the Persona side, but agent write-backs do append
   corrections, and it is free once ported.
4. **Authority/expiry weights, adapted to THIS vault's shape** (config map,
   same constants as the fork unless noted):
   - boost ×1.3: `entity_type = Decision`, `kind: decision|doctrine`;
     `projects/solution_designs/` (the closest thing to doctrine here).
     There is no `doctrine/` folder — do not invent one in ranking.
   - discount: `kind: task|status` open ×0.8 / done ×0.5; `kind: index`
     (MOCs, `generate-moc.ts` output) ×0.5; `kind: archive` ×0.3;
     `superseded_by:` ×0.4.
   - `agents/` gets **no blanket discount** — a fresh agent status is often
     the answer; expiry must come from `kind`/`status`, not the folder.
5. **`own_recent_note`** — `agent=` param on `/search`/`/context`, flag notes
   whose `source: agent:<caller>` and `updated_at` < 48h. This was the
   original echo-chamber worry in this repo's own roadmap.

### P2 — write path (port `validate.ts`, `vaultWrite.ts`, `noteEdit.ts` routes)

6. **Required `kind` on `/remember`** (`measurement report task runbook
   decision doctrine idea index reference archive`) + `status: open` stamp on
   tasks. The MCP tools live inline in `apps/mcp-server/src/server.ts` here
   (no `tools.ts` split) — update the schemas there. **Adaptation:** keep the
   `agents/<name>/` sandbox; write-anywhere + `folder` + `knowledge_move` /
   promote flow are separate fork product decisions, NOT prerequisites —
   `kind` works fine inside the sandbox.
7. **Title cap 90 chars** — same slug-truncation disease exists here.
8. **English gate** — trivially cheap; today's count is 0, keep it 0.
9. **`similar_existing` in the `/remember` response** — the single highest
   value item for this vault: it directly interrupts the agents/ status-note
   accumulation (101 near-duplicate pairs), and the PADE-style "review then
   implement then verify" chains would link instead of restating.
10. **Fix the `-2` suffix trap**: when the slug collides, the response should
    say so (the fork returns `similar_existing` which usually contains the
    collided note — verify that covers it; if not, add an explicit
    `collided_with` field). The 0.998 netsuite double came from exactly this.

### P3 — hygiene tooling (port `scripts/`)

11. **`pnpm dedup` with folder-awareness** (adaptation over the fork's
    version): report clusters grouped by top-level folder pair; default
    threshold 0.85 for `agents/`, 0.92+ or explicit opt-in for
    `technologies/` and `projects/solution_designs/` (template/doc-set
    folders); flag `-2`/`-3` filename suffixes as suspected literal doubles.
12. **Doctor checks**: Cyrillic-heavy count, near-duplicate pair count,
    suffix-collision list. Skip the fork's doctrine-misfiling check (no
    `doctrine/` here); add "agent status notes older than N days with
    `status: open`" as a staleness signal.
13. **Golden loader** (`GOLDEN_CHECKS` / `scripts/golden-checks.json`) + the
    collapse invariant (no duplicate documents per result set) asserted on
    every search check. The 13 built-in checks stay the default set —
    baseline is currently 11/13; the port must not go below that, and the
    collapse/authority work will likely help the two failing ones.

### P4 — one-off data campaigns on THIS vault (after P1–P2 deploy)

14. Merge the netsuite 0.998 literal double (append delta, delete/mark the
    `-2` copy).
15. Kind-backfill `agents/` notes (mostly `report`/`task`); flip finished
    ticket chains to `status: done` so they decay. The fork's lesson from its
    own backfill: pre-kind notes get no discount, and one mislabeled
    `type: Decision` on a task note out-boosted a canonical definition —
    audit `type:` while at it.
16. Re-run `pnpm dedup` after the campaigns for the before/after number.

### Explicitly NOT ported

- Streamable HTTP MCP transport + bearer auth (this instance is local stdio).
- Write-anywhere / `knowledge_move` / promote-flow changes (separate
  decision; the sandbox model still fits the CDON setup).
- The fork's Seyshi golden data (`golden-checks.seyshi.json`).
- Vault-content anything — the two instances' knowledge never mixes; this
  plan ports code and process only.

### Shared gap neither lineage has fixed (worth doing here first)

**The watcher drops re-indexes when `/embed` fails and never retries.** Hit
live on the fork's box on 2026-08-09 during a bulk edit campaign: notes
existed on disk but vanished from / went stale in Postgres (a `move` is the
worst case — old row deleted, new path never indexed). The wedge fix
(`12214f0`) made the API survive, but the watcher still treats a failed embed
as done. Fix: a small retry queue (or: failed paths recorded and re-attempted
on the next tick); repair meanwhile is `pnpm index`. If fixed here first, the
fork takes it back — the first change to flow upstream→fork→upstream both
ways.

## Mechanics

The fork renamed itself back to "CoreMem" while this repo dropped the brand
(`5f2e71c`), so files differ in prose even where logic matches — **manual
port, not cherry-pick**. Practical route: add the fork as a local remote
(`git remote add coremem /Users/sergship/Projects/Seyshi/coremem-server`),
diff per file, port `search.ts` / `chunk.ts` / `store.ts` / `schema.sql` /
`validate.ts` and the route/tool-schema edits, adapting names and the P1.4
weight map. Order: P1 → golden (≥11/13) → P2 → P3 → deploy (launchd
`kickstart` api + watcher, `pnpm index --force`) → P4 campaigns → `pnpm
dedup` after-number.
