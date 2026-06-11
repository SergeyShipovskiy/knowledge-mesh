import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { config, indexSingleFileAndProject } from "@knowledge-mesh/shared";

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
}

/**
 * Agents never overwrite human notes — agent writes land only under
 * vault/agents/<agent>/ and get a unique filename if the slug is taken.
 */
export async function writeAgentNote(input: AgentNoteInput): Promise<{ relPath: string }> {
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
  while (fs.existsSync(path.join(config.vaultPath, relPath))) {
    relPath = path.join(subdir, `${base}-${counter}.md`);
    counter++;
  }

  const frontmatter: Record<string, unknown> = {
    title: input.title,
    created: new Date().toISOString(),
    source: `agent:${agent}`,
  };
  if (input.type) frontmatter.type = input.type;
  if (input.tags?.length) frontmatter.tags = input.tags;
  if (input.kind === "proposal") frontmatter.status = "proposed";

  const markdown = matter.stringify(`\n${input.content.trim()}\n`, frontmatter);
  fs.writeFileSync(path.join(config.vaultPath, relPath), markdown, "utf8");

  await indexSingleFileAndProject(relPath);
  return { relPath };
}
