import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import chokidar from "chokidar";
import {
  config,
  indexVault,
  indexSingleFileAndProject,
  removeFileAndProject,
} from "@knowledge-mesh/shared";

const DEBOUNCE_MS = 500;
const pending = new Map<string, NodeJS.Timeout>();

// Event-driven semantic extraction: any vault change arms a quiet-period
// timer; when the vault has been quiet for EXTRACTOR_QUIET_MS the incremental
// extractor runs (it no-ops for unchanged docs, and a Postgres advisory lock
// prevents overlap with manual/scheduled runs).
const EXTRACTOR_QUIET_MS = Number(process.env.EXTRACTOR_QUIET_MS ?? 180_000);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

let extractTimer: NodeJS.Timeout | null = null;
let extractRunning = false;

function scheduleExtraction() {
  if (extractTimer) clearTimeout(extractTimer);
  extractTimer = setTimeout(runExtraction, EXTRACTOR_QUIET_MS);
}

function runExtraction() {
  if (extractRunning) {
    scheduleExtraction();
    return;
  }
  extractRunning = true;
  console.log("[watch] vault quiet — running incremental extraction…");
  const child = spawn("pnpm", ["--dir", REPO_ROOT, "extract"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("close", (code) => {
    extractRunning = false;
    console.log(`[watch] extraction finished (exit ${code})`);
  });
  child.on("error", (err) => {
    extractRunning = false;
    console.error("[watch] extraction failed to start:", err.message);
  });
}

function schedule(relPath: string, action: () => Promise<void>) {
  clearTimeout(pending.get(relPath));
  pending.set(
    relPath,
    setTimeout(async () => {
      pending.delete(relPath);
      try {
        await action();
      } catch (err) {
        console.error(`[watch] failed for ${relPath}:`, err);
      }
    }, DEBOUNCE_MS)
  );
}

async function main() {
  console.log(`Initial scan of ${config.vaultPath}…`);
  const summary = await indexVault();
  console.log(
    `Initial scan done — indexed: ${summary.indexed}, skipped: ${summary.skipped}, removed: ${summary.removed}`
  );

  const watcher = chokidar.watch(config.vaultPath, {
    ignored: (file) => file.split(path.sep).some((s) => s.startsWith(".")),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  const toRel = (absPath: string) => path.relative(config.vaultPath, absPath);

  watcher.on("add", (absPath) => {
    if (!absPath.endsWith(".md")) return;
    const relPath = toRel(absPath);
    schedule(relPath, async () => {
      await indexSingleFileAndProject(relPath);
      console.log(`[watch] indexed ${relPath}`);
      scheduleExtraction();
    });
  });

  watcher.on("change", (absPath) => {
    if (!absPath.endsWith(".md")) return;
    const relPath = toRel(absPath);
    schedule(relPath, async () => {
      await indexSingleFileAndProject(relPath);
      console.log(`[watch] re-indexed ${relPath}`);
      scheduleExtraction();
    });
  });

  watcher.on("unlink", (absPath) => {
    if (!absPath.endsWith(".md")) return;
    const relPath = toRel(absPath);
    schedule(relPath, async () => {
      await removeFileAndProject(relPath);
      console.log(`[watch] removed ${relPath}`);
      scheduleExtraction(); // extractor run also sweeps orphaned semantic entities
    });
  });

  console.log("Watching for changes… (Ctrl+C to stop)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
