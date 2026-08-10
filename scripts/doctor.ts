/**
 * Knowledge Mesh self-diagnostics: `pnpm doctor`
 * Checks every moving part and prints a one-screen health report.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, pool, getNeo4jDriver, closeNeo4j } from "../packages/shared/src/index.ts";

let failures = 0;
const ok = (label: string, detail = "") => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label: string, detail = "") => {
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
};

console.log("Knowledge Mesh doctor\n");

// ── Vault ────────────────────────────────────────────────────────
if (fs.existsSync(config.vaultPath)) {
  const notes = execSync(
    `find "${config.vaultPath}" -name '*.md' -not -path '*/.obsidian/*' | wc -l`
  )
    .toString()
    .trim();
  ok("vault", `${config.vaultPath} (${notes} notes)`);
} else {
  bad("vault", `${config.vaultPath} does not exist`);
}

// ── Postgres ─────────────────────────────────────────────────────
try {
  const { rows } = await pool.query(`
    SELECT (SELECT count(*) FROM documents) AS docs,
           (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded,
           (SELECT count(*) FROM chunks) AS chunks,
           (SELECT count(*) FROM entities) AS entities,
           (SELECT count(*) FROM relations) AS relations,
           (SELECT count(*) FROM documents d LEFT JOIN extraction_state es ON es.document_id = d.id
            WHERE es.document_id IS NULL OR es.last_hash <> d.content_hash) AS pending_extraction`);
  const r = rows[0];
  ok("postgres", `${r.docs} docs, ${r.embedded}/${r.chunks} chunks embedded, ${r.entities} entities, ${r.relations} relations`);
  if (Number(r.embedded) < Number(r.chunks)) bad("embeddings incomplete", `run: pnpm index --force`);
  if (Number(r.pending_extraction) > 0)
    ok("extraction backlog", `${r.pending_extraction} doc(s) pending (picked up automatically)`);
} catch (err) {
  bad("postgres", (err as Error).message.slice(0, 120));
}

// ── Vault hygiene ────────────────────────────────────────────────
try {
  // The vault is English-only; a Cyrillic-heavy note is invisible to the
  // full-text channel and splits the corpus by language.
  const { rows: docs } = await pool.query("SELECT path, content FROM documents");
  const russian = docs.filter((d) => {
    const cyr = (d.content.match(/[Ѐ-ӿ]/g) ?? []).length;
    const lat = (d.content.match(/[A-Za-z]/g) ?? []).length;
    return cyr > 40 && cyr / (cyr + lat) > 0.15;
  });
  russian.length === 0
    ? ok("english-only", "no Cyrillic-heavy notes")
    : bad(
        "english-only",
        `${russian.length} note(s) with heavy Cyrillic: ${russian
          .slice(0, 5)
          .map((d) => d.path)
          .join(", ")}${russian.length > 5 ? ", …" : ""} — translate or mark kind: archive`
      );

  // Conclusions duplicated across notes bury each other in retrieval.
  // Template/doc-set folders (technologies/, solution designs) are similar by
  // construction and excluded here — `pnpm dedup --all` inspects them.
  const { rows: dup } = await pool.query(
    `WITH docvec AS (
       SELECT c.document_id, avg(c.embedding) AS v, d.path
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL
         AND d.path NOT LIKE 'technologies/%'
         AND d.path NOT LIKE 'projects/solution_designs/%'
       GROUP BY c.document_id, d.path
     )
     SELECT count(*)::int AS pairs FROM docvec a
     JOIN docvec b ON a.document_id < b.document_id
     WHERE 1 - (a.v <=> b.v) > 0.9`
  );
  Number(dup[0].pairs) === 0
    ? ok("near-duplicates", "no doc pairs above 0.9 similarity (template folders excluded)")
    : bad("near-duplicates", `${dup[0].pairs} doc pair(s) above 0.9 similarity — run: pnpm dedup`);

  // The -2 suffix trap: a slug collision at write time silently minted a copy.
  const { rows: suffixed } = await pool.query(
    `SELECT copy.path FROM documents copy
     JOIN documents orig ON orig.path = regexp_replace(copy.path, '-[0-9]+\\.md$', '.md')
     WHERE copy.path ~ '-[0-9]+\\.md$' ORDER BY copy.path`
  );
  suffixed.length === 0
    ? ok("suffix collisions", "no -N copies of existing slugs")
    : bad(
        "suffix collisions",
        `${suffixed.length} suspected literal double(s): ${suffixed
          .slice(0, 5)
          .map((r) => r.path)
          .join(", ")}${suffixed.length > 5 ? ", …" : ""} — merge into the original`
      );

  // Agent tasks that never got closed keep their (discounted but present)
  // rank forever; flag stale ones so status gets flipped or the note expired.
  const { rows: staleTasks } = await pool.query(
    `SELECT path FROM documents
     WHERE path LIKE 'agents/%'
       AND frontmatter->>'kind' = 'task'
       AND COALESCE(frontmatter->>'status', 'open') = 'open'
       AND updated_at < now() - interval '14 days'
     ORDER BY updated_at`
  );
  staleTasks.length === 0
    ? ok("stale open tasks", "no agent tasks open and untouched >14 days")
    : bad(
        "stale open tasks",
        `${staleTasks.length} agent task(s) open >14 days: ${staleTasks
          .slice(0, 5)
          .map((r) => r.path)
          .join(", ")}${staleTasks.length > 5 ? ", …" : ""} — flip status: done or update`
      );
} catch (err) {
  bad("vault hygiene", (err as Error).message.slice(0, 120));
}

// ── Neo4j ────────────────────────────────────────────────────────
try {
  const session = getNeo4jDriver().session();
  const res = await session.run(
    "MATCH (n:Entity) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS edges"
  );
  await session.close();
  const nodes = res.records[0]?.get("nodes") ?? 0;
  const edges = res.records[0]?.get("edges") ?? 0;
  ok("neo4j", `${nodes} nodes, ${edges} edges`);
  if (Number(nodes) === 0) bad("graph empty", "run: pnpm index --force");
} catch (err) {
  bad("neo4j", (err as Error).message.slice(0, 120));
}

// ── Knowledge API ────────────────────────────────────────────────
try {
  const health = await fetch(`${config.api.url}/health`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error(`HTTP ${health.status}`);
  const search = await fetch(`${config.api.url}/search?q=doctor-probe&limit=1`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!search.ok) throw new Error(`search HTTP ${search.status}`);
  ok("knowledge API", `${config.api.url} (search pipeline incl. embedding model: working)`);
} catch (err) {
  bad("knowledge API", `${(err as Error).message} — start with: pnpm api (or launchctl kickstart gui/$UID/com.knowledge-mesh.api)`);
}

// ── Extractor engine ─────────────────────────────────────────────
try {
  execSync("command -v claude", { stdio: "pipe" });
  ok("claude CLI", "extractor engine available");
} catch {
  bad("claude CLI", "not found — semantic extraction unavailable (search still works)");
}

// ── launchd services (macOS) ─────────────────────────────────────
if (os.platform() === "darwin") {
  let list = "";
  try {
    list = execSync("launchctl list", { stdio: "pipe" }).toString();
  } catch { /* ignore */ }
  for (const svc of ["api", "watcher", "extract", "backup"]) {
    const line = list.split("\n").find((l) => l.includes(`com.knowledge-mesh.${svc}`));
    if (line) {
      const pid = line.trim().split(/\s+/)[0];
      ok(`service ${svc}`, pid !== "-" ? `running (pid ${pid})` : "loaded (on schedule)");
    } else {
      bad(`service ${svc}`, "not loaded — see scripts/install.sh");
    }
  }
}

// ── Backups ──────────────────────────────────────────────────────
const backupDir = process.env.BACKUP_DIR ?? path.join(os.homedir(), "Backups/knowledge-mesh");
const marker = path.join(backupDir, ".last-success");
if (fs.existsSync(marker)) {
  const ageHours = Math.round((Date.now() / 1000 - Number(fs.readFileSync(marker, "utf8").trim())) / 3600);
  ageHours <= 48 ? ok("backups", `last success ${ageHours}h ago (${backupDir})`)
                 : bad("backups", `last success ${ageHours}h ago — check ~/Library/Logs/knowledge-mesh-backup.log`);
} else {
  bad("backups", `no successful backup yet (expected marker in ${backupDir})`);
}

// ── Models ───────────────────────────────────────────────────────
if (fs.existsSync(config.modelsDir)) {
  ok("models dir", config.modelsDir);
} else {
  ok("models dir", "will be created on first embedding");
}

console.log(failures === 0 ? "\nAll good." : `\n${failures} problem(s) found.`);
await pool.end();
await closeNeo4j();
if (failures > 0) process.exit(1);
