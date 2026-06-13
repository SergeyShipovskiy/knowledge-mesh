/**
 * CoreMem adoption metrics: `pnpm stats [--days N]`
 *
 * Shows whether the shared memory is actually used and which tools agents
 * reach for, from the `usage_events` table (filled by the API's onResponse
 * hook). Write endpoints carry an agent identity; reads do not.
 *
 * One-time history import:
 *   pnpm stats --backfill ~/Library/Logs/knowledge-mesh-api.log
 * parses the Fastify request log into usage_events (refuses if the table is
 * already populated, unless --force) so the first report has prior history.
 */
import fs from "node:fs";
import { pool } from "../packages/shared/src/index.ts";

const args = process.argv.slice(2);
const days = args.includes("--days") ? Math.max(1, Number(args[args.indexOf("--days") + 1])) : 30;
const backfillIdx = args.indexOf("--backfill");
const force = args.includes("--force");

// Endpoints worth counting — must match TRACKED_ROUTES in apps/api/src/server.ts.
const TRACKED = new Set([
  "/search", "/context", "/note", "/entity", "/graph", "/impact",
  "/remember", "/proposal", "/proposals", "/promote", "/changes",
  "/note/update", "/note/undo", "/note/history", "/link",
]);

/** Map a concrete request URL (with query/params) to its route pattern. */
function routeOf(url: string): string | null {
  const path = url.split("?")[0];
  if (TRACKED.has(path)) return path;
  if (/^\/entity\/[^/]+$/.test(path)) return "/entity/:id";
  return null;
}

async function backfill(logPath: string) {
  if (!fs.existsSync(logPath)) {
    console.error(`Log not found: ${logPath}`);
    process.exit(1);
  }
  const existing = await pool.query("SELECT count(*)::int AS n FROM usage_events");
  if (existing.rows[0].n > 0 && !force) {
    console.error(
      `usage_events already has ${existing.rows[0].n} rows — refusing to backfill (pass --force to override).`
    );
    process.exit(1);
  }

  // Fastify logs an "incoming request" line per request with method+url+time.
  let imported = 0;
  for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
    if (!line.includes('"incoming request"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const req = entry.req;
    if (!req?.url || !req?.method || !entry.time) continue;
    const route = routeOf(req.url);
    if (!route) continue;
    await pool.query(
      `INSERT INTO usage_events (ts, endpoint, method, status, duration_ms, agent)
       VALUES (to_timestamp($1 / 1000.0), $2, $3, NULL, NULL, NULL)`,
      [entry.time, route, req.method]
    );
    imported++;
  }
  console.log(`Backfilled ${imported} request(s) from ${logPath} (status/duration/agent unavailable in the log).`);
}

async function report() {
  const w = [days];
  const totals = (
    await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE method = 'GET')::int AS reads,
              count(*) FILTER (WHERE method <> 'GET')::int AS writes,
              to_char(min(ts), 'YYYY-MM-DD') AS since
       FROM usage_events WHERE ts > now() - ($1 || ' days')::interval`,
      w
    )
  ).rows[0];

  console.log(`\nCoreMem adoption — last ${days} day(s)\n`);
  if (!totals.total) {
    console.log("  No usage recorded yet. The API records events going forward;");
    console.log("  import history with: pnpm stats --backfill ~/Library/Logs/knowledge-mesh-api.log\n");
    return;
  }
  console.log(`  total ${totals.total}   reads ${totals.reads}   writes ${totals.writes}   since ${totals.since}\n`);

  const byEndpoint = (
    await pool.query(
      `SELECT endpoint, count(*)::int AS calls, round(avg(duration_ms))::int AS avg_ms,
              count(*) FILTER (WHERE status >= 400)::int AS errors
       FROM usage_events WHERE ts > now() - ($1 || ' days')::interval
       GROUP BY endpoint ORDER BY calls DESC`,
      w
    )
  ).rows;
  console.log("  by endpoint:");
  for (const r of byEndpoint) {
    const ms = r.avg_ms != null ? `${r.avg_ms}ms` : "—";
    const errs = r.errors ? `, ${r.errors} err` : "";
    console.log(`    ${r.endpoint.padEnd(16)} ${String(r.calls).padStart(5)}  (${ms}${errs})`);
  }

  const byAgent = (
    await pool.query(
      `SELECT agent, count(*)::int AS writes
       FROM usage_events
       WHERE ts > now() - ($1 || ' days')::interval AND agent IS NOT NULL
       GROUP BY agent ORDER BY writes DESC`,
      w
    )
  ).rows;
  if (byAgent.length) {
    console.log("\n  writes by agent:");
    for (const r of byAgent) console.log(`    ${r.agent.padEnd(16)} ${String(r.writes).padStart(5)}`);
  }

  // Human-note edits carry agent attribution regardless of endpoint volume.
  const edits = (
    await pool.query(
      `SELECT agent, count(*)::int AS edits
       FROM note_edits WHERE created_at > now() - ($1 || ' days')::interval
       GROUP BY agent ORDER BY edits DESC`,
      w
    )
  ).rows;
  if (edits.length) {
    console.log("\n  human-note edits by agent (audited):");
    for (const r of edits) console.log(`    ${r.agent.padEnd(16)} ${String(r.edits).padStart(5)}`);
  }
  console.log("");
}

try {
  if (backfillIdx !== -1) await backfill(args[backfillIdx + 1]);
  await report();
} finally {
  await pool.end();
}
