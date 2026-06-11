export { config } from "./config.js";
export { pool, toVectorLiteral } from "./db.js";
export { getNeo4jDriver, closeNeo4j } from "./neo4j.js";
export { embed, embedOne, embedQuery, useLocalEmbeddings } from "./embeddings.js";
export { parseNote, type ParsedNote, type ParsedLink } from "./parse.js";
export { chunkContent } from "./chunk.js";
export {
  hashContent,
  isUnchanged,
  storeNote,
  syncRelations,
  deleteDocument,
  listIndexedPaths,
} from "./store.js";
export { projectGraph } from "./graph.js";
export {
  listVaultFiles,
  indexFile,
  indexVault,
  indexSingleFileAndProject,
  removeFileAndProject,
  type IndexResult,
  type VaultIndexSummary,
} from "./pipeline.js";
export * from "./types.js";
