import fs from "node:fs";
import path from "node:path";
import { config, pool, indexSingleFileAndProject } from "@knowledge-mesh/shared";

class EditError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
  }
}

/** Resolve a vault-relative md path, refusing traversal outside the vault. */
function resolveVaultPath(relPath: string): { relPath: string; absPath: string } {
  const absPath = path.resolve(config.vaultPath, relPath);
  if (!absPath.startsWith(config.vaultPath + path.sep)) {
    throw new EditError("Path escapes the vault", 400);
  }
  if (!absPath.endsWith(".md")) {
    throw new EditError("Only .md notes can be edited", 400);
  }
  if (!fs.existsSync(absPath)) {
    throw new EditError(`Note not found: ${relPath}`, 404);
  }
  return { relPath: path.relative(config.vaultPath, absPath), absPath };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    count++;
  }
  return count;
}

export interface UpdateNoteInput {
  path: string;
  old_string?: string;
  new_string?: string;
  append?: string;
  reason: string;
  agent: string;
}

export async function updateNote(input: UpdateNoteInput) {
  const { relPath, absPath } = resolveVaultPath(input.path);
  const content = fs.readFileSync(absPath, "utf8");

  let updated: string;
  let editKind: "replace" | "append";
  let oldFragment: string | null;
  let newFragment: string;

  if (input.append != null) {
    editKind = "append";
    oldFragment = null;
    newFragment = `\n${input.append.trim()}\n`;
    updated = content.replace(/\n*$/, "\n") + newFragment;
  } else {
    if (!input.old_string || input.new_string == null) {
      throw new EditError(
        "Provide either append, or old_string + new_string",
        400
      );
    }
    const occurrences = countOccurrences(content, input.old_string);
    if (occurrences === 0) {
      throw new EditError(
        "old_string not found in the note — re-read it with knowledge_get and retry with the exact current text",
        409
      );
    }
    if (occurrences > 1) {
      throw new EditError(
        `old_string matches ${occurrences} places — extend it with surrounding context so it is unique`,
        409
      );
    }
    editKind = "replace";
    oldFragment = input.old_string;
    newFragment = input.new_string;
    updated = content.replace(input.old_string, input.new_string);
  }

  fs.writeFileSync(absPath, updated, "utf8");

  const { rows } = await pool.query(
    `INSERT INTO note_edits (path, agent, reason, edit_kind, old_fragment, new_fragment)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [relPath, input.agent, input.reason, editKind, oldFragment, newFragment]
  );

  await indexSingleFileAndProject(relPath);

  return {
    status: "updated",
    path: relPath,
    edit_id: rows[0].id,
    edit_kind: editKind,
    reason: input.reason,
  };
}

export async function undoLastEdit(notePath: string, agent: string) {
  const { relPath, absPath } = resolveVaultPath(notePath);

  const { rows } = await pool.query(
    `SELECT id, edit_kind, old_fragment, new_fragment, agent, reason, created_at
     FROM note_edits
     WHERE path = $1 AND reverted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [relPath]
  );
  if (rows.length === 0) {
    throw new EditError("No edits left to undo for this note", 404);
  }
  const edit = rows[0];

  if (edit.edit_kind === "promote") {
    throw new EditError(
      "The last entry is a promotion (file move), which cannot be undone automatically — move the note back in Obsidian if needed.",
      409
    );
  }

  const content = fs.readFileSync(absPath, "utf8");
  const occurrences = countOccurrences(content, edit.new_fragment);
  if (occurrences !== 1) {
    throw new EditError(
      `Cannot undo automatically: the edited fragment ${occurrences === 0 ? "is no longer present" : "appears multiple times"} (the note changed since). Fix manually in Obsidian.`,
      409
    );
  }

  const restored =
    edit.edit_kind === "append"
      ? content.replace(edit.new_fragment, "")
      : content.replace(edit.new_fragment, edit.old_fragment);
  fs.writeFileSync(absPath, restored, "utf8");

  await pool.query(
    "UPDATE note_edits SET reverted_at = now(), reverted_by = $2 WHERE id = $1",
    [edit.id, agent]
  );
  await indexSingleFileAndProject(relPath);

  const remaining = await pool.query(
    "SELECT count(*)::int AS n FROM note_edits WHERE path = $1 AND reverted_at IS NULL",
    [relPath]
  );

  return {
    status: "reverted",
    path: relPath,
    undone_edit: {
      id: edit.id,
      agent: edit.agent,
      reason: edit.reason,
      created_at: edit.created_at,
    },
    undoable_edits_remaining: remaining.rows[0].n,
  };
}

export async function noteHistory(notePath: string) {
  const { relPath } = resolveVaultPath(notePath);
  const { rows } = await pool.query(
    `SELECT id, agent, reason, edit_kind, created_at, reverted_at, reverted_by
     FROM note_edits WHERE path = $1 ORDER BY created_at DESC LIMIT 50`,
    [relPath]
  );
  return { path: relPath, edits: rows };
}
