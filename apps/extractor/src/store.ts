import { pool } from "@knowledge-mesh/shared";
import type { Extraction } from "./schema.js";

export interface DocumentRow {
  id: string;
  path: string;
  title: string;
  content: string;
  content_hash: string;
}

export async function documentsNeedingExtraction(opts: {
  force?: boolean;
  limit?: number;
  pathFilter?: string;
}): Promise<DocumentRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!opts.force) {
    conditions.push(
      "(es.document_id IS NULL OR es.last_hash <> d.content_hash)"
    );
  }
  if (opts.pathFilter) {
    params.push(`%${opts.pathFilter}%`);
    conditions.push(`d.path ILIKE $${params.length}`);
  }

  let sql = `SELECT d.id, d.path, d.title, d.content, d.content_hash
     FROM documents d
     LEFT JOIN extraction_state es ON es.document_id = d.id
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY d.path`;
  if (opts.limit) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Resolve an extracted object to an entity, reusing existing entities by
 * case-insensitive name so "Kafka" mentioned in ten notes stays one node.
 * Preference order: doc-backed entity of any type → same-type entity →
 * adoptable placeholder → fresh insert.
 */
async function upsertSemanticEntity(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  object: Extraction["objects"][number],
  sourcePath: string
): Promise<string> {
  // Name matching is separator-insensitive ('-' vs '/') and suffix-aware, so
  // "order-handler-service", "purchase-order-handler-service" and the
  // "purchase/order-handler-service" note all resolve to one entity.
  const found = await client.query(
    `SELECT id, type, document_id, metadata FROM entities
     WHERE lower(replace(name, '/', '-')) = lower(replace($1, '/', '-'))
        OR lower(replace(name, '/', '-')) LIKE '%-' || lower(replace($1, '/', '-'))
        OR lower(replace($1, '/', '-')) LIKE '%-' || lower(replace(name, '/', '-'))
     ORDER BY (document_id IS NOT NULL) DESC,
              (lower(replace(name, '/', '-')) = lower(replace($1, '/', '-'))) DESC,
              (type = $2) DESC
     LIMIT 1`,
    [object.name, object.type]
  );

  const existing = found.rows[0];
  if (existing) {
    if (existing.document_id != null) {
      // A real note already embodies this entity — link to it, don't relabel it.
      return existing.id;
    }
    const sources: string[] = existing.metadata?.sources ?? [];
    if (!sources.includes(sourcePath)) sources.push(sourcePath);
    const updated = await client.query(
      `UPDATE entities
       SET type = $1,
           metadata = $2
       WHERE id = $3
       RETURNING id`,
      [
        object.type,
        JSON.stringify({
          kind: "semantic",
          summary: object.summary,
          confidence: object.confidence,
          sources,
        }),
        existing.id,
      ]
    );
    return updated.rows[0].id;
  }

  const inserted = await client.query(
    `INSERT INTO entities (type, name, metadata)
     VALUES ($1, $2, $3)
     ON CONFLICT (type, name) DO UPDATE SET metadata = EXCLUDED.metadata
     RETURNING id`,
    [
      object.type,
      object.name,
      JSON.stringify({
        kind: "semantic",
        summary: object.summary,
        confidence: object.confidence,
        sources: [sourcePath],
      }),
    ]
  );
  return inserted.rows[0].id;
}

export async function storeExtraction(
  doc: DocumentRow,
  extraction: Extraction,
  model: string
): Promise<{ objects: number; relations: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("DELETE FROM relations WHERE origin_document_id = $1", [
      doc.id,
    ]);

    const noteEntity = await client.query(
      "SELECT id FROM entities WHERE document_id = $1 LIMIT 1",
      [doc.id]
    );
    const noteEntityId: string | undefined = noteEntity.rows[0]?.id;

    const nameToId = new Map<string, string>();
    if (noteEntityId) nameToId.set(doc.title.toLowerCase(), noteEntityId);

    for (const object of extraction.objects) {
      const entityId = await upsertSemanticEntity(client, object, doc.path);
      nameToId.set(object.name.toLowerCase(), entityId);

      // Provenance edge: every extracted object points back at the note it
      // came from, so knowledge stays traceable to its markdown source.
      if (noteEntityId && entityId !== noteEntityId) {
        await client.query(
          `INSERT INTO relations (source_entity_id, target_entity_id, relation_type, confidence, origin_document_id)
           VALUES ($1, $2, 'EXTRACTED_FROM', $3, $4)
           ON CONFLICT (source_entity_id, target_entity_id, relation_type) DO NOTHING`,
          [entityId, noteEntityId, object.confidence, doc.id]
        );
      }
    }

    let relationCount = 0;
    for (const relation of extraction.relations) {
      const sourceId = nameToId.get(relation.source.toLowerCase());
      const targetId = nameToId.get(relation.target.toLowerCase());
      if (!sourceId || !targetId || sourceId === targetId) continue;
      await client.query(
        `INSERT INTO relations (source_entity_id, target_entity_id, relation_type, confidence, origin_document_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_entity_id, target_entity_id, relation_type) DO NOTHING`,
        [sourceId, targetId, relation.type, relation.confidence, doc.id]
      );
      relationCount++;
    }

    await client.query(
      `INSERT INTO extraction_state (document_id, last_hash, model, extracted_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (document_id) DO UPDATE
         SET last_hash = $2, model = $3, extracted_at = now()`,
      [doc.id, doc.content_hash, model]
    );

    await client.query("COMMIT");
    return { objects: extraction.objects.length, relations: relationCount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteOrphanSemanticEntities(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM entities e
     WHERE e.metadata->>'kind' = 'semantic'
       AND e.document_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM relations r
         WHERE r.source_entity_id = e.id OR r.target_entity_id = e.id
       )`
  );
  return rowCount ?? 0;
}
