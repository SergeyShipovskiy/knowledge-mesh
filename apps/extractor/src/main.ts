import { pool, closeNeo4j, projectGraph } from "@knowledge-mesh/shared";
import { extract, MODEL } from "./engine.js";
import {
  documentsNeedingExtraction,
  storeExtraction,
  deleteOrphanSemanticEntities,
  type DocumentRow,
} from "./store.js";

const CONCURRENCY = Number(process.env.EXTRACTOR_CONCURRENCY ?? 3);

function parseArgs() {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const pathIndex = args.indexOf("--path");
  return {
    force: args.includes("--force"),
    limit: limitIndex !== -1 ? Number(args[limitIndex + 1]) : undefined,
    pathFilter: pathIndex !== -1 ? args[pathIndex + 1] : undefined,
  };
}

async function processDoc(doc: DocumentRow): Promise<boolean> {
  try {
    const extraction = await extract(doc);
    const { objects, relations } = await storeExtraction(doc, extraction, MODEL);
    console.log(`✓ ${doc.path} — ${objects} objects, ${relations} relations`);
    return true;
  } catch (err) {
    console.error(`✗ ${doc.path} — ${(err as Error).message.slice(0, 300)}`);
    return false;
  }
}

// Single arbitrary lock id for "extraction is running" — prevents a scheduled
// run from overlapping a manual or still-running one.
const EXTRACTION_LOCK_ID = 7421001;

async function main() {
  const opts = parseArgs();

  const lock = await pool.query("SELECT pg_try_advisory_lock($1) AS ok", [
    EXTRACTION_LOCK_ID,
  ]);
  if (!lock.rows[0].ok) {
    console.log("Another extraction run is already in progress — exiting.");
    return;
  }

  const docs = await documentsNeedingExtraction(opts);

  if (docs.length === 0) {
    // Still sweep semantic entities orphaned by note deletions.
    const orphans = await deleteOrphanSemanticEntities();
    if (orphans > 0) {
      const graph = await projectGraph();
      console.log(
        `Nothing to extract; removed ${orphans} orphaned entities, graph: ${graph.nodes}/${graph.edges}`
      );
    } else {
      console.log("Nothing to extract — all documents are up to date.");
    }
    return;
  }
  console.log(
    `Extracting semantics from ${docs.length} document(s) with ${MODEL} (concurrency ${CONCURRENCY})…`
  );

  const queue = [...docs];
  let succeeded = 0;
  let failed = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let doc = queue.shift(); doc; doc = queue.shift()) {
      (await processDoc(doc)) ? succeeded++ : failed++;
    }
  });
  await Promise.all(workers);

  const orphans = await deleteOrphanSemanticEntities();
  const graph = await projectGraph();

  console.log(
    `Done — extracted: ${succeeded}, failed: ${failed}, orphans removed: ${orphans}, ` +
      `graph: ${graph.nodes} nodes / ${graph.edges} edges`
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    await closeNeo4j();
  });
