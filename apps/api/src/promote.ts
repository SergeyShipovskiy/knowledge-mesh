import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  config,
  pool,
  deleteDocument,
  indexSingleFileAndProject,
} from "@knowledge-mesh/shared";

class PromoteError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
  }
}

/**
 * Review queue: agent-written notes awaiting a human decision. Proposals
 * (status: proposed) by default; includeAll widens it to every agent note,
 * since plain /remember notes can be promoted too.
 */
export async function listProposals(includeAll = false, limit = 30) {
  const { rows } = await pool.query(
    `SELECT path, title,
            frontmatter->>'source' AS source,
            frontmatter->>'status' AS status,
            frontmatter->>'type'   AS type,
            created_at, updated_at
     FROM documents
     WHERE path LIKE 'agents/%'
       ${includeAll ? "" : "AND frontmatter->>'status' = 'proposed'"}
     ORDER BY (frontmatter->>'status' = 'proposed') DESC, updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return { proposals: rows, include_all: includeAll };
}

export interface PromoteInput {
  path: string;
  target_path?: string;
  reason?: string;
  agent: string;
}

/**
 * Promote an agent note into the human part of the vault: move the file,
 * stamp promotion provenance in frontmatter, repoint extracted knowledge at
 * the new path (flipping origin agent→human), and audit-log the move.
 */
export async function promoteNote(input: PromoteInput) {
  const oldAbs = path.resolve(config.vaultPath, input.path);
  if (!oldAbs.startsWith(config.vaultPath + path.sep)) {
    throw new PromoteError("Path escapes the vault", 400);
  }
  const oldRel = path.relative(config.vaultPath, oldAbs);
  if (!oldRel.startsWith(`agents${path.sep}`)) {
    throw new PromoteError("Only notes under agents/ can be promoted", 400);
  }
  if (!oldAbs.endsWith(".md") || !fs.existsSync(oldAbs)) {
    throw new PromoteError(`Agent note not found: ${oldRel}`, 404);
  }

  // Default destination: inbox/ — visible in Obsidian for the human to refile.
  const requestedTarget = input.target_path ?? path.join("inbox", path.basename(oldRel));
  let targetAbs = path.resolve(config.vaultPath, requestedTarget);
  if (!targetAbs.startsWith(config.vaultPath + path.sep)) {
    throw new PromoteError("target_path escapes the vault", 400);
  }
  if (!targetAbs.endsWith(".md")) targetAbs += ".md";
  if (path.relative(config.vaultPath, targetAbs).startsWith(`agents${path.sep}`)) {
    throw new PromoteError("target_path must be outside agents/", 400);
  }
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  let counter = 2;
  const base = targetAbs.slice(0, -3);
  while (fs.existsSync(targetAbs)) {
    targetAbs = `${base}-${counter}.md`;
    counter++;
  }
  const newRel = path.relative(config.vaultPath, targetAbs);

  const parsed = matter(fs.readFileSync(oldAbs, "utf8"));
  delete parsed.data.status;
  parsed.data.promoted = new Date().toISOString();
  parsed.data.promoted_from = oldRel;

  fs.writeFileSync(targetAbs, matter.stringify(parsed.content, parsed.data), "utf8");
  fs.rmSync(oldAbs);

  // Extracted knowledge keeps source-note paths in metadata.sources; repoint
  // them at the new location and recompute origin (a promoted note is a
  // human-endorsed source, so agent-only objects flip to origin=human).
  await pool.query(
    `UPDATE entities
     SET metadata = jsonb_set(
       metadata, '{sources}',
       (SELECT jsonb_agg(CASE WHEN s = $1 THEN $2 ELSE s END)
        FROM jsonb_array_elements_text(metadata->'sources') AS s)
     )
     WHERE metadata->'sources' ? $1`,
    [oldRel, newRel]
  );
  await pool.query(
    `UPDATE entities
     SET metadata = metadata || jsonb_build_object(
       'origin',
       CASE WHEN (SELECT bool_and(s LIKE 'agents/%')
                  FROM jsonb_array_elements_text(metadata->'sources') AS s)
            THEN 'agent' ELSE 'human' END
     )
     WHERE metadata->'sources' ? $1`,
    [newRel]
  );

  const { rows } = await pool.query(
    `INSERT INTO note_edits (path, agent, reason, edit_kind, old_fragment, new_fragment)
     VALUES ($1, $2, $3, 'promote', $4, $5) RETURNING id`,
    [
      newRel,
      input.agent,
      input.reason ?? "Promoted from agent notes into the human vault",
      oldRel,
      newRel,
    ]
  );

  await deleteDocument(oldRel);
  await indexSingleFileAndProject(newRel);

  return {
    status: "promoted",
    from: oldRel,
    path: newRel,
    edit_id: rows[0].id,
  };
}
