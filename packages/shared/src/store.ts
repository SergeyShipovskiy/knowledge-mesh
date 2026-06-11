import crypto from "node:crypto";
import { pool, toVectorLiteral } from "./db.js";
import { embed } from "./embeddings.js";
import { chunkContent } from "./chunk.js";
import type { ParsedNote } from "./parse.js";

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function isUnchanged(relPath: string, hash: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM sync_state WHERE path = $1 AND last_hash = $2",
    [relPath, hash]
  );
  return rows.length > 0;
}

export interface StoredNote {
  documentId: string;
  entityId: string;
}

export async function storeNote(note: ParsedNote): Promise<StoredNote> {
  const hash = hashContent(note.content);
  const chunks = chunkContent(note.body);
  const embeddings = await embed(chunks);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const docResult = await client.query(
      `INSERT INTO documents (path, title, content, content_hash, frontmatter)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (path) DO UPDATE
         SET title = EXCLUDED.title,
             content = EXCLUDED.content,
             content_hash = EXCLUDED.content_hash,
             frontmatter = EXCLUDED.frontmatter,
             updated_at = now()
       RETURNING id`,
      [note.relPath, note.title, note.content, hash, JSON.stringify(note.frontmatter)]
    );
    const documentId: string = docResult.rows[0].id;

    await client.query("DELETE FROM chunks WHERE document_id = $1", [documentId]);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO chunks (document_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4::vector)`,
        [documentId, i, chunks[i], toVectorLiteral(embeddings[i])]
      );
    }

    const metadata = JSON.stringify({ tags: note.tags, path: note.relPath });

    // Adopt this document's existing entity, then a placeholder with the same
    // name, before inserting fresh — keeps relations pointing at one entity.
    const adopted = await client.query(
      `UPDATE entities SET type = $1, name = $2, metadata = $3
       WHERE document_id = $4 RETURNING id`,
      [note.type, note.title, metadata, documentId]
    );
    let entityId: string | undefined = adopted.rows[0]?.id;

    if (!entityId) {
      const placeholder = await client.query(
        `UPDATE entities SET type = $1, metadata = $2, document_id = $3
         WHERE name = $4 AND document_id IS NULL RETURNING id`,
        [note.type, metadata, documentId, note.title]
      );
      entityId = placeholder.rows[0]?.id;
    }

    if (!entityId) {
      const inserted = await client.query(
        `INSERT INTO entities (type, name, metadata, document_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (type, name) DO UPDATE
           SET metadata = EXCLUDED.metadata, document_id = EXCLUDED.document_id
         RETURNING id`,
        [note.type, note.title, metadata, documentId]
      );
      entityId = inserted.rows[0].id as string;
    }

    await client.query(
      `INSERT INTO sync_state (path, last_hash, indexed_at)
       VALUES ($1, $2, now())
       ON CONFLICT (path) DO UPDATE SET last_hash = $2, indexed_at = now()`,
      [note.relPath, hash]
    );

    await client.query("COMMIT");
    return { documentId, entityId: entityId! };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function syncRelations(
  sourceEntityId: string,
  links: ParsedNote["links"]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Only replace relations the indexer owns (wikilinks/frontmatter).
    // Extractor-produced relations carry origin_document_id and are managed
    // by the extractor's own replace cycle.
    await client.query(
      "DELETE FROM relations WHERE source_entity_id = $1 AND origin_document_id IS NULL",
      [sourceEntityId]
    );

    for (const link of links) {
      const found = await client.query(
        `SELECT id FROM entities WHERE name = $1
         ORDER BY (document_id IS NOT NULL) DESC LIMIT 1`,
        [link.target]
      );
      let targetId: string | undefined = found.rows[0]?.id;
      if (!targetId) {
        const created = await client.query(
          `INSERT INTO entities (type, name, metadata)
           VALUES ('Note', $1, '{"placeholder": true}')
           ON CONFLICT (type, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [link.target]
        );
        targetId = created.rows[0].id;
      }
      if (targetId === sourceEntityId) continue;
      await client.query(
        `INSERT INTO relations (source_entity_id, target_entity_id, relation_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (source_entity_id, target_entity_id, relation_type) DO NOTHING`,
        [sourceEntityId, targetId, link.type]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteDocument(relPath: string): Promise<void> {
  await pool.query("DELETE FROM documents WHERE path = $1", [relPath]);
  await pool.query("DELETE FROM sync_state WHERE path = $1", [relPath]);
}

export async function listIndexedPaths(): Promise<string[]> {
  const { rows } = await pool.query("SELECT path FROM sync_state");
  return rows.map((r) => r.path);
}
