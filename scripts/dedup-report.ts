/**
 * Near-duplicate report: `pnpm dedup [--threshold 0.85] [--all]`
 *
 * Compares every pair of documents by mean chunk embedding, clusters pairs
 * (union-find), and prints clusters grouped by folder pair — the newest note
 * first as the suggested canonical home. Read-only; merging is a human/agent
 * decision (append deltas to the canonical note, delete or mark the rest
 * with a `superseded_by:` frontmatter pointer).
 *
 * Folder-aware thresholds: template/doc-set folders (technologies/, the
 * solution-design sets) are structurally similar by construction, so pairs
 * touching them only count above a stricter threshold — otherwise the report
 * drowns real duplicates in expected ones. `--all` disables the folder rules
 * and applies the base threshold everywhere.
 */
import path from "node:path";
import { pool } from "../packages/shared/src/index.ts";

const baseThreshold = Number(
  process.argv.includes("--threshold")
    ? process.argv[process.argv.indexOf("--threshold") + 1]
    : 0.85
);
const includeAll = process.argv.includes("--all");

// Folders whose notes share a template or a deliberate document-set
// vocabulary: near-duplicate similarity there is expected, not disease.
const STRICT_FOLDERS: Record<string, number> = {
  technologies: 0.92,
  "projects/solution_designs": 0.92,
};

function folderKey(relPath: string): string {
  if (relPath.startsWith("projects/solution_designs/")) return "projects/solution_designs";
  return relPath.split("/")[0] ?? "";
}

function pairThreshold(pathA: string, pathB: string): number {
  if (includeAll) return baseThreshold;
  const strict = Math.max(
    STRICT_FOLDERS[folderKey(pathA)] ?? 0,
    STRICT_FOLDERS[folderKey(pathB)] ?? 0
  );
  return Math.max(baseThreshold, strict);
}

interface Pair {
  d1: string;
  d2: string;
  sim: number;
}

// Fetch at the loose base threshold; folder rules filter afterwards so the
// report can say how much the template folders were suppressed.
const { rows: rawPairs } = await pool.query<Pair>(
  `WITH docvec AS (
     SELECT document_id, avg(embedding) AS v
     FROM chunks WHERE embedding IS NOT NULL GROUP BY document_id
   )
   SELECT a.document_id AS d1, b.document_id AS d2, 1 - (a.v <=> b.v) AS sim
   FROM docvec a JOIN docvec b ON a.document_id < b.document_id
   WHERE 1 - (a.v <=> b.v) > $1
   ORDER BY sim DESC`,
  [baseThreshold]
);

const allRawIds = [...new Set(rawPairs.flatMap((p) => [p.d1, p.d2]))];
const docs = new Map<
  string,
  { path: string; title: string; kind: string | null; updated_at: Date }
>();
if (allRawIds.length > 0) {
  const { rows } = await pool.query(
    `SELECT id, path, title, frontmatter->>'kind' AS kind, updated_at
     FROM documents WHERE id = ANY($1)`,
    [allRawIds]
  );
  for (const r of rows) docs.set(r.id, r);
}

const pairs = rawPairs.filter((p) => {
  const a = docs.get(p.d1);
  const b = docs.get(p.d2);
  return a && b && p.sim > pairThreshold(a.path, b.path);
});
const suppressed = rawPairs.length - pairs.length;

// Union-find over surviving pairs → clusters.
const parent = new Map<string, string>();
const find = (x: string): string => {
  let root = parent.get(x) ?? x;
  if (root !== x) {
    root = find(root);
    parent.set(x, root);
  }
  return root;
};
const union = (a: string, b: string) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
};
for (const p of pairs) union(p.d1, p.d2);

const clusters = new Map<string, Set<string>>();
for (const p of pairs) {
  const root = find(p.d1);
  const set = clusters.get(root) ?? new Set<string>();
  set.add(p.d1);
  set.add(p.d2);
  clusters.set(root, set);
}

const involved = [...new Set(pairs.flatMap((p) => [p.d1, p.d2]))];
const simOf = (a: string, b: string) =>
  pairs.find((p) => (p.d1 === a && p.d2 === b) || (p.d1 === b && p.d2 === a))?.sim;

const clusterFolders = (cluster: Set<string>): string =>
  [...new Set([...cluster].map((id) => folderKey(docs.get(id)!.path)))].sort().join(" ↔ ");

const sorted = [...clusters.values()].sort((a, b) => {
  const fa = clusterFolders(a);
  const fb = clusterFolders(b);
  return fa === fb ? b.size - a.size : fa.localeCompare(fb);
});

console.log(
  `Near-duplicate clusters at threshold ${baseThreshold}` +
    (includeAll ? " (--all: folder rules off)" : "") +
    `: ${sorted.length} cluster(s), ${involved.length} note(s), ${pairs.length} pair(s)` +
    (suppressed > 0
      ? ` — ${suppressed} pair(s) in template folders suppressed (stricter threshold; --all to see them)`
      : "") +
    "\n"
);

let currentGroup = "";
let n = 0;
for (const cluster of sorted) {
  n++;
  const group = clusterFolders(cluster);
  if (group !== currentGroup) {
    currentGroup = group;
    console.log(`━━ ${group} ━━\n`);
  }
  const members = [...cluster]
    .map((id) => ({ id, ...docs.get(id)! }))
    .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
  console.log(`Cluster ${n} (${members.length} notes) — suggested canonical: ${members[0].path}`);
  for (const m of members) {
    // "trans": no direct pair with the canonical — linked via another member.
    const direct = simOf(m.id, members[0].id);
    const sim = m.id === members[0].id ? "canon" : direct != null ? direct.toFixed(3) : "trans";
    console.log(
      `  [${sim}] ${m.path}${m.kind ? ` (kind: ${m.kind})` : ""} — updated ${m.updated_at.toISOString().slice(0, 10)}`
    );
  }
  console.log();
}

if (sorted.length === 0) console.log("No near-duplicates found. Clean.");

// The -2 suffix trap: a slug collision at write time silently minted a copy.
// These are suspected LITERAL doubles regardless of embedding similarity.
const { rows: suspects } = await pool.query<{ copy: string; original: string }>(
  `SELECT copy.path AS copy, orig.path AS original
   FROM documents copy
   JOIN documents orig
     ON orig.path = regexp_replace(copy.path, '-[0-9]+\\.md$', '.md')
   WHERE copy.path ~ '-[0-9]+\\.md$'
   ORDER BY copy.path`
);
if (suspects.length > 0) {
  console.log(`Suffix-collision suspects (slug taken at write time → -N copy):`);
  for (const s of suspects) {
    console.log(`  ${s.copy} ← check against ${s.original}`);
  }
}

await pool.end();
