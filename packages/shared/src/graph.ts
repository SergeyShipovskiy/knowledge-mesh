import { pool } from "./db.js";
import { getNeo4jDriver } from "./neo4j.js";

const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function assertSafe(identifier: string): string {
  if (!LABEL_PATTERN.test(identifier)) {
    throw new Error(`Unsafe graph identifier: ${identifier}`);
  }
  return identifier;
}

/**
 * Full idempotent projection of Postgres entities/relations into Neo4j.
 * Cheap at personal-vault scale; avoids tracking graph diffs.
 */
export async function projectGraph(): Promise<{ nodes: number; edges: number }> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  const { rows: entities } = await pool.query(
    `SELECT e.id, e.type, e.name, e.metadata, d.path, d.title
     FROM entities e LEFT JOIN documents d ON d.id = e.document_id`
  );
  const { rows: relations } = await pool.query(
    `SELECT r.source_entity_id, r.target_entity_id, r.relation_type
     FROM relations r`
  );

  try {
    for (const entity of entities) {
      const label = assertSafe(entity.type);
      const kind =
        entity.metadata?.kind ??
        (entity.path != null ? "note" : "placeholder");
      await session.run(
        `MERGE (n:Entity {entity_id: $id})
         SET n:${label},
             n.name = $name,
             n.path = $path,
             n.tags = $tags,
             n.kind = $kind,
             n.summary = $summary,
             n.placeholder = $placeholder`,
        {
          id: entity.id,
          name: entity.name,
          path: entity.path ?? null,
          tags: entity.metadata?.tags ?? [],
          kind,
          summary: entity.metadata?.summary ?? null,
          placeholder: kind === "placeholder",
        }
      );
    }

    for (const rel of relations) {
      const relType = assertSafe(rel.relation_type);
      await session.run(
        `MATCH (s:Entity {entity_id: $sourceId})
         MATCH (t:Entity {entity_id: $targetId})
         MERGE (s)-[:${relType}]->(t)`,
        { sourceId: rel.source_entity_id, targetId: rel.target_entity_id }
      );
    }

    await session.run(
      `MATCH (n:Entity) WHERE NOT n.entity_id IN $ids DETACH DELETE n`,
      { ids: entities.map((e) => e.id) }
    );
  } finally {
    await session.close();
  }

  return { nodes: entities.length, edges: relations.length };
}
