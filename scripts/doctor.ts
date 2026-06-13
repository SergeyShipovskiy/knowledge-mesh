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
