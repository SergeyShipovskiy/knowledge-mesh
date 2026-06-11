import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { parseNote, type ParsedNote } from "./parse.js";
import {
  hashContent,
  isUnchanged,
  storeNote,
  syncRelations,
  deleteDocument,
  listIndexedPaths,
} from "./store.js";
import { projectGraph } from "./graph.js";

const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

export function listVaultFiles(vaultPath = config.vaultPath): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".md")) {
        results.push(path.relative(vaultPath, path.join(dir, entry.name)));
      }
    }
  };
  walk(vaultPath);
  return results.sort();
}

export interface IndexResult {
  relPath: string;
  status: "indexed" | "skipped";
  note?: ParsedNote;
  entityId?: string;
}

export async function indexFile(
  relPath: string,
  { force = false } = {}
): Promise<IndexResult> {
  const absPath = path.join(config.vaultPath, relPath);
  const raw = fs.readFileSync(absPath, "utf8");

  if (!force && (await isUnchanged(relPath, hashContent(raw)))) {
    return { relPath, status: "skipped" };
  }

  const note = parseNote(relPath, raw);
  const { entityId } = await storeNote(note);
  return { relPath, status: "indexed", note, entityId };
}

export interface VaultIndexSummary {
  indexed: number;
  skipped: number;
  removed: number;
  graph: { nodes: number; edges: number };
}

export async function indexVault({ force = false } = {}): Promise<VaultIndexSummary> {
  const files = listVaultFiles();
  const results: IndexResult[] = [];

  for (const relPath of files) {
    results.push(await indexFile(relPath, { force }));
  }

  // Relations resolve by entity name, so they sync after every document
  // (and its entity) exists — otherwise links create placeholder entities
  // for notes that simply hadn't been indexed yet.
  for (const result of results) {
    if (result.status === "indexed" && result.note && result.entityId) {
      await syncRelations(result.entityId, result.note.links);
    }
  }

  const onDisk = new Set(files);
  let removed = 0;
  for (const indexedPath of await listIndexedPaths()) {
    if (!onDisk.has(indexedPath)) {
      await deleteDocument(indexedPath);
      removed++;
    }
  }

  const graph = await projectGraph();

  return {
    indexed: results.filter((r) => r.status === "indexed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    removed,
    graph,
  };
}

export async function indexSingleFileAndProject(relPath: string): Promise<IndexResult> {
  const result = await indexFile(relPath, { force: true });
  if (result.note && result.entityId) {
    await syncRelations(result.entityId, result.note.links);
  }
  await projectGraph();
  return result;
}

export async function removeFileAndProject(relPath: string): Promise<void> {
  await deleteDocument(relPath);
  await projectGraph();
}
