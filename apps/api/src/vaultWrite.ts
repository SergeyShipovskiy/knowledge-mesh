import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { config } from "@knowledge-mesh/shared";
import { assertEnglish, assertTitle, type NoteKind } from "./validate.js";

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

export interface AgentNoteInput {
  title: string;
  content: string;
  agent?: string;
  type?: string;
  tags?: string[];
  kind?: "note" | "proposal";
  /** What the note is (measurement, doctrine, task, ...) — drives ranking authority/expiry. */
  noteKind?: NoteKind;
}

/**
 * Agents never overwrite human notes — agent writes land only under
 * vault/agents/<agent>/ and get a unique filename if the slug is taken.
 * Provenance is carried in frontmatter too: `source: agent:<name>` is the
 * machine marker and the `agent/<name>` tag the human-visible one.
 */
export async function writeAgentNote(
  input: AgentNoteInput
): Promise<{ relPath: string; collidedWith?: string }> {
  assertTitle(input.title);
  assertEnglish(`${input.title}\n${input.content}`, "The note");

  const agent = slugify(input.agent ?? "system");
  const subdir =
    input.kind === "proposal"
      ? path.join("agents", agent, "proposals")
      : path.join("agents", agent);

  const dir = path.join(config.vaultPath, subdir);
  fs.mkdirSync(dir, { recursive: true });

  const base = slugify(input.title);
  let relPath = path.join(subdir, `${base}.md`);
  let counter = 2;
  // A taken slug usually means this note already exists — surface the
  // collision instead of silently minting a -2 copy (the -2 trap: literal
  // doubles that later compete in retrieval).
  let collidedWith: string | undefined;
  while (fs.existsSync(path.join(config.vaultPath, relPath))) {
    collidedWith ??= relPath;
    relPath = path.join(subdir, `${base}-${counter}.md`);
    counter++;
  }

  const tags = [...new Set([...(input.tags ?? []), `agent/${agent}`])];
  const frontmatter: Record<string, unknown> = {
    title: input.title,
    created: new Date().toISOString(),
    created_by: agent,
    source: `agent:${agent}`,
    tags,
  };
  if (input.type) frontmatter.type = input.type;
  if (input.noteKind) frontmatter.kind = input.noteKind;
  // Tasks expire: they open at creation and decay out of default retrieval
  // once their status is flipped to done (via knowledge_update_note).
  if (input.noteKind === "task") frontmatter.status = "open";
  if (input.kind === "proposal") frontmatter.status = "proposed";

  const markdown = matter.stringify(`\n${input.content.trim()}\n`, frontmatter);
  fs.writeFileSync(path.join(config.vaultPath, relPath), markdown, "utf8");

  // Indexing (embed + store + graph) is done asynchronously by the watcher,
  // which observes the vault write — the request never blocks on embedding.
  // Markdown on disk is the source of truth; the note is searchable shortly
  // after (watcher debounce ~1s).
  return { relPath, ...(collidedWith ? { collidedWith } : {}) };
}
