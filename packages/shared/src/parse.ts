import matter from "gray-matter";
import path from "node:path";
import type { EntityType, RelationType } from "./types.js";

const ENTITY_TYPES: EntityType[] = [
  "Project",
  "Note",
  "Decision",
  "Idea",
  "Person",
  "Technology",
  "Meeting",
  "Agent",
  "Claim",
  "Problem",
  "Constraint",
  "Pattern",
];

const FOLDER_TYPES: Record<string, EntityType> = {
  projects: "Project",
  ideas: "Idea",
  decisions: "Decision",
  people: "Person",
  technologies: "Technology",
  meetings: "Meeting",
  agents: "Agent",
};

const RELATION_KEYS: Record<string, RelationType> = {
  relates_to: "RELATES_TO",
  mentions: "MENTIONS",
  uses: "USES",
  supports: "SUPPORTS",
  contradicts: "CONTRADICTS",
  supersedes: "SUPERSEDES",
  created_by: "CREATED_BY",
};

export interface ParsedLink {
  target: string;
  type: RelationType;
}

export interface ParsedNote {
  relPath: string;
  title: string;
  type: EntityType;
  content: string;
  body: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  links: ParsedLink[];
}

function inferType(relPath: string, frontmatter: Record<string, unknown>): EntityType {
  const fmType = typeof frontmatter.type === "string" ? frontmatter.type : null;
  if (fmType) {
    const normalized = (fmType.charAt(0).toUpperCase() +
      fmType.slice(1).toLowerCase()) as EntityType;
    if (ENTITY_TYPES.includes(normalized)) return normalized;
  }
  for (const segment of relPath.toLowerCase().split(path.sep)) {
    if (FOLDER_TYPES[segment]) return FOLDER_TYPES[segment];
  }
  return "Note";
}

function stripWikilink(value: string): string {
  const match = value.match(/^\[\[([^\]|#]+)/);
  return (match ? match[1] : value).trim();
}

export function parseNote(relPath: string, raw: string): ParsedNote {
  const { data, content: body } = matter(raw);
  const frontmatter = data as Record<string, unknown>;

  const headingMatch = body.match(/^#\s+(.+)$/m);
  const title =
    (typeof frontmatter.title === "string" && frontmatter.title) ||
    (headingMatch ? headingMatch[1].trim() : path.basename(relPath, ".md"));

  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.map(String)
    : typeof frontmatter.tags === "string"
      ? [frontmatter.tags]
      : [];

  const links = new Map<string, ParsedLink>();

  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const target = match[1].trim();
    if (target && target !== title) {
      links.set(`MENTIONS:${target}`, { target, type: "MENTIONS" });
    }
  }

  for (const [key, relType] of Object.entries(RELATION_KEYS)) {
    const value = frontmatter[key];
    const values = Array.isArray(value) ? value : value != null ? [value] : [];
    for (const v of values) {
      const target = stripWikilink(String(v));
      if (target) links.set(`${relType}:${target}`, { target, type: relType });
    }
  }

  return {
    relPath,
    title,
    type: inferType(relPath, frontmatter),
    content: raw,
    body,
    tags,
    frontmatter,
    links: [...links.values()],
  };
}
