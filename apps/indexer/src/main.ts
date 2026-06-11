import { config, indexVault, pool, closeNeo4j } from "@knowledge-mesh/shared";

const force = process.argv.includes("--force");

async function main() {
  console.log(`Indexing vault: ${config.vaultPath}${force ? " (forced)" : ""}`);
  const started = Date.now();
  const summary = await indexVault({ force });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `Done in ${seconds}s — indexed: ${summary.indexed}, skipped: ${summary.skipped}, ` +
      `removed: ${summary.removed}, graph: ${summary.graph.nodes} nodes / ${summary.graph.edges} edges`
  );
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
