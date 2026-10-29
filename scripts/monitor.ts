/**
 * Unattended health monitor: `pnpm monitor`, run hourly by
 * com.knowledge-mesh.monitor. Where `pnpm doctor` is the full report you read
 * on demand (hygiene included), this checks only what counts as *broken* and
 * raises a macOS notification when the state changes — so a service that dies
 * at 3am is not discovered a week later.
 *
 * Notifications are de-duplicated: a problem notifies when it appears, again
 * every REMIND_H hours while it persists, and once more when it clears.
 *
 *   pnpm monitor [--verbose] [--notify-test]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, pool, getNeo4jDriver, closeNeo4j } from "../packages/shared/src/index.ts";
import { analysisSyncHealth, analysisRefreshHealth } from "./lib/analysis-sync-health.ts";

const VERBOSE = process.argv.includes("--verbose");
const REMIND_H = Number(process.env.MONITOR_REMIND_H ?? 24);
const STATE_FILE =
  process.env.MONITOR_STATE ?? path.join(os.homedir(), "Library/Logs/knowledge-mesh-monitor-state.json");

interface Problem { key: string; detail: string }
const problems: Problem[] = [];
const healthy: string[] = [];
const bad = (key: string, detail: string) => problems.push({ key, detail });
const ok = (label: string, detail = "") => healthy.push(detail ? `${label} — ${detail}` : label);

function notify(title: string, body: string): void {
  if (os.platform() !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    execFileSync("osascript", [
      "-e",
      `display notification "${esc(body.slice(0, 220))}" with title "${esc(title)}" sound name "Basso"`,
    ]);
  } catch (err) {
    console.error(`notification failed: ${(err as Error).message.slice(0, 120)}`);
  }
}

if (process.argv.includes("--notify-test")) {
  notify("Knowledge Mesh", "Monitor test notification — delivery works.");
  console.log("test notification sent");
  process.exit(0);
}

// ── Postgres + embedding backlog ─────────────────────────────────
try {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT count(*) FROM documents)::int AS docs,
            (SELECT count(*) FROM chunks)::int AS chunks,
            (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL)::int AS embedded`
  );
  ok("postgres", `${r.docs} docs, ${r.embedded}/${r.chunks} chunks embedded`);
  if (r.embedded < r.chunks)
    bad("embeddings incomplete", `${r.chunks - r.embedded} chunk(s) without a vector — run: pnpm index --force`);
} catch (err) {
  bad("postgres unreachable", (err as Error).message.slice(0, 140));
}

// ── Neo4j ────────────────────────────────────────────────────────
try {
  const session = getNeo4jDriver().session();
  const res = await session.run("MATCH (n:Entity) RETURN count(n) AS nodes");
  await session.close();
  const nodes = Number(res.records[0]?.get("nodes") ?? 0);
  nodes > 0 ? ok("neo4j", `${nodes} nodes`) : bad("graph empty", "no entities projected — run: pnpm index --force");
} catch (err) {
  bad("neo4j unreachable", (err as Error).message.slice(0, 140));
}

// ── Knowledge API (health + the full search path) ────────────────
let apiUp = false;
try {
  const health = await fetch(`${config.api.url}/health`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error(`health HTTP ${health.status}`);
  const search = await fetch(`${config.api.url}/search?q=monitor-probe&limit=1`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!search.ok) throw new Error(`search HTTP ${search.status}`);
  ok("knowledge API", config.api.url);
  apiUp = true;
} catch (err) {
  bad("knowledge API down", `${(err as Error).message.slice(0, 100)} — launchctl kickstart -k gui/$UID/com.knowledge-mesh.api`);
}

// ── Entity resolution (impact/graph by bare service name) ────────
// A wikilink like [[order-handler-service]] creates a doc-less placeholder.
// If /impact resolves the bare name to it instead of `purchase/order-handler-service`,
// impact and graph come back empty with no error - silent for PR reviews.
if (apiUp) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT p.name FROM entities p
       WHERE p.document_id IS NULL
         AND coalesce((p.metadata->>'placeholder')::boolean, false)
         AND EXISTS (SELECT 1 FROM entities d
                     WHERE d.document_id IS NOT NULL
                       AND lower(replace(d.name, '/', '-')) LIKE '%-' || lower(replace(p.name, '/', '-')))`
    );
    const shadowed: string[] = [];
    for (const { name } of rows) {
      const res = await fetch(`${config.api.url}/impact?service=${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`impact HTTP ${res.status} for ${name}`);
      const d = await res.json();
      if (d.service?.name === name) shadowed.push(name);
    }
    shadowed.length === 0
      ? ok("entity resolution", `${rows.length} bare name(s) resolve past their placeholder`)
      : bad(
          "entity resolution",
          `${shadowed.length} bare name(s) resolve to an empty placeholder, e.g. ${shadowed[0]} - see resolveEntity in apps/api/src/graph.ts`
        );
  } catch (err) {
    bad("entity resolution check failed", (err as Error).message.slice(0, 140));
  }
}

// ── Platform analysis sync (per-instance add-on; silent when absent) ──
let syncInstalled = false;
try {
  const sync = await analysisSyncHealth(pool);
  syncInstalled = sync.available;
  if (sync.available) {
    if (sync.summary) ok("analysis-sync", sync.summary);
    for (const i of sync.issues) bad(i.key, i.detail);
  }
} catch (err) {
  bad("analysis-sync check failed", (err as Error).message.slice(0, 140));
}

let refreshInstalled = false;
try {
  const refresh = await analysisRefreshHealth(pool);
  refreshInstalled = refresh.available;
  if (refresh.available) {
    if (refresh.summary) ok("analysis-refresh", refresh.summary);
    for (const i of refresh.issues) bad(i.key, i.detail);
  }
} catch (err) {
  bad("analysis-refresh check failed", (err as Error).message.slice(0, 140));
}

// ── launchd services ─────────────────────────────────────────────
if (os.platform() === "darwin") {
  let list = "";
  try {
    list = execFileSync("launchctl", ["list"], { encoding: "utf8" });
  } catch { /* ignore */ }
  // api and watcher are resident; the rest are periodic and idle between ticks.
  const services: [string, boolean][] = [
    ["api", true], ["watcher", true], ["extract", false],
    ["backup", false], ["monitor", false],
  ];
  if (syncInstalled) services.push(["analysis-sync", false]);
  if (refreshInstalled) services.push(["analysis-refresh", false]);
  for (const [svc, resident] of services) {
    const line = list.split("\n").find((l) => l.includes(`com.knowledge-mesh.${svc}`));
    if (!line) {
      bad(`service ${svc} not loaded`, "see scripts/install.sh");
      continue;
    }
    const pid = line.trim().split(/\s+/)[0];
    if (resident && pid === "-") bad(`service ${svc} not running`, `launchctl kickstart -k gui/$UID/com.knowledge-mesh.${svc}`);
    else ok(`service ${svc}`, pid !== "-" ? `pid ${pid}` : "on schedule");
  }
}

// ── Backups ──────────────────────────────────────────────────────
const backupDir = process.env.BACKUP_DIR ?? path.join(os.homedir(), "Backups/knowledge-mesh");
const marker = path.join(backupDir, ".last-success");
if (fs.existsSync(marker)) {
  const ageH = Math.round((Date.now() / 1000 - Number(fs.readFileSync(marker, "utf8").trim())) / 3600);
  ageH <= 48 ? ok("backups", `last success ${ageH}h ago`) : bad("backups stale", `last success ${ageH}h ago — see knowledge-mesh-backup.log`);
} else {
  bad("no backup yet", `expected marker in ${backupDir}`);
}

// ── Report + notify on state change ──────────────────────────────
const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
if (VERBOSE) for (const h of healthy) console.log(`  ✓ ${h}`);
for (const p of problems) console.log(`  ✗ ${p.key} — ${p.detail}`);

let state: Record<string, string> = {};
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
} catch { /* first run, or unreadable — start clean */ }

const now = Date.now();
const current = new Set(problems.map((p) => p.key));
const worth = problems.filter(
  (p) => !state[p.key] || (now - Date.parse(state[p.key])) / 3600000 >= REMIND_H
);
const cleared = Object.keys(state).filter((k) => !current.has(k));

if (worth.length > 0) {
  const head = worth[0];
  const more = worth.length > 1 ? ` (+${worth.length - 1} more)` : "";
  notify(`Knowledge Mesh: ${problems.length} problem(s)`, `${head.key} — ${head.detail}${more}`);
}
if (cleared.length > 0 && problems.length === 0) {
  notify("Knowledge Mesh: recovered", `resolved: ${cleared.join(", ")}`);
}

const next: Record<string, string> = {};
for (const p of problems) next[p.key] = worth.includes(p) ? new Date(now).toISOString() : state[p.key];
try {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
} catch (err) {
  console.error(`could not persist monitor state: ${(err as Error).message.slice(0, 120)}`);
}

console.log(
  problems.length === 0
    ? `${stamp} monitor: all good (${healthy.length} checks)`
    : `${stamp} monitor: ${problems.length} problem(s), ${healthy.length} ok${worth.length ? ` — notified about ${worth.length}` : " — already notified"}`
);

await pool.end();
await closeNeo4j();
if (problems.length > 0) process.exit(1);
