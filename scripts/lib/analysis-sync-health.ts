/**
 * Health of the platform analysis sync (scripts/local/analysis-sync.ts).
 *
 * Shared by `pnpm doctor` and `pnpm monitor`. The sync is a per-instance
 * add-on: when its tables are absent this reports `available: false` and both
 * callers stay silent, so a deployment without it sees nothing.
 */
import { execFileSync } from "node:child_process";

/** Hours since the machine last woke. A laptop that slept all night has no
 * business being reported as "stalled": launchd cannot tick while asleep, and
 * it needs a few minutes after wake to catch up. Returns Infinity when the
 * wake time cannot be read (non-macOS), i.e. no suppression. */
function hoursSinceWake(): number {
  try {
    const out = execFileSync("sysctl", ["-n", "kern.waketime"], { encoding: "utf8" });
    const sec = Number(out.match(/sec\s*=\s*(\d+)/)?.[1]);
    if (!sec) return Infinity;
    return (Date.now() / 1000 - sec) / 3600;
  } catch {
    return Infinity;
  }
}
const WAKE_GRACE_H = Number(process.env.MONITOR_WAKE_GRACE_H ?? 1.5);

// Structurally typed so this module needs no direct pg dependency.
type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

// A run starts hourly; phase B can legitimately hold the lock for hours, so
// "stalled" is judged on finished runs with a live run as the escape hatch.
const MAX_RUN_AGE_H = Number(process.env.SYNC_MAX_RUN_AGE_H ?? 6);
const MAX_ACTIVE_H = Number(process.env.SYNC_MAX_ACTIVE_H ?? 12);
const MAX_FAILED_RATIO = Number(process.env.SYNC_MAX_FAILED_RATIO ?? 0.2);
// The refresh drip ticks every 2h and takes one note; a gap much larger than
// that with work still queued means the job is not running.
const MAX_REFRESH_AGE_H = Number(process.env.REFRESH_MAX_AGE_H ?? 6);

export interface SyncIssue {
  key: string;
  detail: string;
}
export interface SyncHealth {
  available: boolean;
  summary: string | null;
  issues: SyncIssue[];
}

export async function analysisSyncHealth(pool: Queryable): Promise<SyncHealth> {
  const { rows: [present] } = await pool.query(
    "SELECT to_regclass('analysis_sync_runs') IS NOT NULL AS runs, to_regclass('analysis_sync') IS NOT NULL AS state"
  );
  if (!present.runs || !present.state) return { available: false, summary: null, issues: [] };

  const issues: SyncIssue[] = [];
  const { rows: [last] } = await pool.query(
    `SELECT id, finished_at IS NULL AS active, checked, diverged, archived, skipped, failed, updated,
            extract(epoch FROM now() - started_at) / 3600 AS started_h
     FROM analysis_sync_runs ORDER BY started_at DESC LIMIT 1`
  );
  const { rows: [done] } = await pool.query(
    `SELECT checked, diverged, archived, skipped, failed, updated,
            extract(epoch FROM now() - finished_at) / 3600 AS finished_h
     FROM analysis_sync_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`
  );

  if (!last) {
    issues.push({ key: "analysis-sync never ran", detail: "no run recorded — check launchctl list | grep analysis-sync" });
    return { available: true, summary: null, issues };
  }

  // A run row is opened after the lock and closed on the way out, so a stale
  // open row is a crashed or killed process — not a slow one.
  const startedH = Number(last.started_h);
  const finishedH = done ? Number(done.finished_h) : null;
  if (last.active && startedH > MAX_ACTIVE_H) {
    issues.push({
      key: "analysis-sync run never finished",
      detail: `run #${last.id} started ${Math.round(startedH)}h ago and never closed — process died mid-run; check ~/Library/Logs/knowledge-mesh-analysis-sync.log`,
    });
  }
  const liveRun = last.active && startedH <= MAX_ACTIVE_H;
  const justWoke = hoursSinceWake() < WAKE_GRACE_H;
  if (!liveRun && !justWoke && (finishedH === null || finishedH > MAX_RUN_AGE_H)) {
    issues.push({
      key: "analysis-sync stalled",
      detail: done
        ? `last completed run was ${Math.round(finishedH!)}h ago (expected hourly) — is com.knowledge-mesh.analysis-sync loaded?`
        : "no run has ever completed",
    });
  }
  if (done && done.checked > 0 && done.failed / done.checked > MAX_FAILED_RATIO) {
    issues.push({
      key: "analysis-sync run degraded",
      detail: `${done.failed}/${done.checked} note(s) failed in the last run — gh auth/network or GitHub outage`,
    });
  }
  if (done && done.skipped > 0) {
    issues.push({
      key: "untracked service notes",
      detail: `${done.skipped} note(s) have no line-leading "analysis-commit:" and are silently not tracked`,
    });
  }

  // A crash that a later tick recovered from leaves its run row open. Looking
  // only at the newest run would miss it, so count recent ones — the window
  // lets a one-off fade after a day while repeated crashes keep alerting.
  const { rows: [crashed] } = await pool.query(
    `SELECT count(*)::int AS n FROM analysis_sync_runs
     WHERE finished_at IS NULL AND id <> $1
       AND started_at BETWEEN now() - interval '24 hours' AND now() - ($2 || ' hours')::interval`,
    [last.id, MAX_ACTIVE_H]
  );
  if (crashed.n > 0) {
    issues.push({
      key: "analysis-sync crashed",
      detail: `${crashed.n} run(s) in the last 24h started and never finished — check ~/Library/Logs/knowledge-mesh-analysis-sync.log`,
    });
  }

  const { rows: [wedged] } = await pool.query(
    `SELECT count(*)::int AS n, coalesce(string_agg(d.path, ', '), '') AS paths
     FROM analysis_sync s JOIN documents d ON d.id = s.document_id
     WHERE s.last_result LIKE 'edit-failed%'`
  );
  if (wedged.n > 0) {
    issues.push({
      key: "notes wedged on a failed edit",
      detail: `${wedged.n} note(s) could not be updated: ${wedged.paths.slice(0, 160)}`,
    });
  }

  const { rows: [counts] } = await pool.query(
    `SELECT count(*) FILTER (WHERE content ~ '(?m)^analysis-commit:') ::int AS tracked,
            count(*) FILTER (WHERE content ~ '(?m)^repo-archived:') ::int AS archived
     FROM documents`
  );
  const age = last.active ? `running for ${Math.round(startedH)}h` : `last run ${finishedH === null ? "?" : Math.round(finishedH)}h ago`;
  const summary =
    `${age}: ${counts.tracked - counts.archived} tracked, ${counts.archived} archived` +
    (done ? `, last result ${done.checked} checked / ${done.diverged} diverged / ${done.updated} updated / ${done.failed} failed` : "");

  return { available: true, summary, issues };
}

/** Progress of the rolling full re-analysis (scripts/local/analysis-refresh.ts).
 * Separate from the sync: sync keeps notes current, refresh keeps them coherent. */
export async function analysisRefreshHealth(pool: Queryable): Promise<SyncHealth> {
  const { rows: [present] } = await pool.query(
    "SELECT to_regclass('analysis_refresh') IS NOT NULL AS ok"
  );
  if (!present.ok) return { available: false, summary: null, issues: [] };

  const { rows: [stat] } = await pool.query(
    `WITH tracked AS (
       SELECT d.id FROM documents d
       WHERE d.path LIKE 'technologies/qlty/platform/%'
         AND d.content ~ '(?m)^analysis-commit:' AND d.content !~ '(?m)^repo-archived:'
     )
     SELECT (SELECT count(*) FROM tracked)::int AS tracked,
            (SELECT count(*) FROM analysis_refresh r JOIN tracked t ON t.id = r.document_id)::int AS refreshed,
            (SELECT extract(epoch FROM now() - max(refreshed_at)) / 3600 FROM analysis_refresh) AS last_h`
  );
  // A cooldown is the drip deliberately waiting out a subscription limit —
  // reporting that as "stalled" would cry wolf every hour until quota returns.
  const { rows: [cool] } = await pool.query(
    `SELECT to_regclass('analysis_refresh_cooldown') IS NOT NULL AS present`
  );
  let coolingUntil: string | null = null;
  if (cool.present) {
    const { rows: [row] } = await pool.query(
      "SELECT until FROM analysis_refresh_cooldown WHERE id = 1 AND until > now()"
    );
    coolingUntil = row ? new Date(row.until).toISOString().slice(11, 16) : null;
  }

  const due = stat.tracked - stat.refreshed;
  const lastH = stat.last_h === null ? null : Number(stat.last_h);
  const issues: SyncIssue[] = [];
  if (due > 0 && coolingUntil === null && hoursSinceWake() >= WAKE_GRACE_H && (lastH === null || lastH > MAX_REFRESH_AGE_H)) {
    issues.push({
      key: "analysis-refresh stalled",
      detail: lastH === null
        ? `${due} note(s) never re-analysed and no refresh has ever run — is com.knowledge-mesh.analysis-refresh loaded?`
        : `last refresh ${Math.round(lastH)}h ago with ${due} note(s) still due — check ~/Library/Logs/knowledge-mesh-analysis-refresh.log`,
    });
  }
  const summary =
    `${stat.refreshed}/${stat.tracked} note(s) re-analysed, ${due} due` +
    (lastH === null ? "" : `, last ${Math.round(lastH)}h ago`) +
    (coolingUntil ? ` — paused on a subscription limit until ${coolingUntil} UTC` : "");
  return { available: true, summary, issues };
}
