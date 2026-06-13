import { pool, toVectorLiteral, embedQuery } from "@knowledge-mesh/shared";

export interface HybridSearchResult {
  document_id: string;
  path: string;
  title: string;
  chunk_content: string;
  similarity: number | null;
  entity_type: string | null;
  tags: string[];
  matched_by: ("vector" | "text" | "title")[];
  score: number;
  // Freshness: when the note was last indexed, and the platform-analysis
  // commit it was last reconciled against (for service notes maintained by
  // analysis-sync). Lets consumers weigh how current a hit is.
  updated_at: string | null;
  analysis_commit: string | null;
}

const CANDIDATES = 30;
const RRF_K = 60;
// Title/path hits answer "I typed an exact note/service name" lookups —
// rank them above frequency-based chunk matches.
const TITLE_WEIGHT = 2;

const RESULT_COLUMNS = `
  c.id AS chunk_id, c.document_id, d.path, d.title, c.content AS chunk_content,
  e.type AS entity_type, COALESCE(e.metadata->'tags', '[]'::jsonb) AS tags,
  d.updated_at,
  substring(d.content from 'analysis-commit:[[:space:]]*([0-9a-f]{6,40})') AS analysis_commit`;

/**
 * Hybrid retrieval: vector similarity catches paraphrased questions, full-text
 * catches exact tokens (service names, Kafka topics, error codes) that
 * embedding models blur. Results are fused with Reciprocal Rank Fusion.
 */
export async function searchChunks(
  query: string,
  limit = 8
): Promise<HybridSearchResult[]> {
  const vector = toVectorLiteral(await embedQuery(query));

  const [vectorRows, textRows, titleRows] = await Promise.all([
    pool.query(
      `SELECT ${RESULT_COLUMNS}, 1 - (c.embedding <=> $1::vector) AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN entities e ON e.document_id = d.id
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      [vector, CANDIDATES]
    ),
    pool.query(
      `SELECT ${RESULT_COLUMNS}, NULL::float AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN entities e ON e.document_id = d.id
       WHERE c.ts @@ websearch_to_tsquery('english', $1)
       ORDER BY ts_rank(c.ts, websearch_to_tsquery('english', $1)) DESC
       LIMIT $2`,
      [query, CANDIDATES]
    ),
    pool.query(
      `SELECT ${RESULT_COLUMNS}, NULL::float AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN entities e ON e.document_id = d.id
       WHERE c.chunk_index = 0
         AND (d.title ILIKE '%' || $1 || '%' OR d.path ILIKE '%' || replace($1, ' ', '-') || '%')
       ORDER BY length(d.title)
       LIMIT 10`,
      [query]
    ),
  ]);

  const fused = new Map<string, HybridSearchResult>();

  const fuse = (rows: any[], source: "vector" | "text" | "title") => {
    const weight = source === "title" ? TITLE_WEIGHT : 1;
    rows.forEach((row, rank) => {
      const existing = fused.get(row.chunk_id);
      const contribution = weight / (RRF_K + rank + 1);
      if (existing) {
        existing.score += contribution;
        existing.matched_by.push(source);
        if (row.similarity != null) existing.similarity = Number(row.similarity);
      } else {
        fused.set(row.chunk_id, {
          document_id: row.document_id,
          path: row.path,
          title: row.title,
          chunk_content: row.chunk_content,
          similarity: row.similarity != null ? Number(row.similarity) : null,
          entity_type: row.entity_type,
          tags: Array.isArray(row.tags) ? row.tags : [],
          matched_by: [source],
          score: contribution,
          updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
          analysis_commit: row.analysis_commit ?? null,
        });
      }
    });
  };

  fuse(vectorRows.rows, "vector");
  fuse(textRows.rows, "text");
  fuse(titleRows.rows, "title");

  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface EntityContext {
  id: string;
  type: string;
  name: string;
  relations: { direction: "out" | "in"; type: string; other: string; otherType: string }[];
}

export async function entityContextForDocuments(
  documentIds: string[]
): Promise<EntityContext[]> {
  if (documentIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT e.id, e.type, e.name FROM entities e WHERE e.document_id = ANY($1)`,
    [documentIds]
  );

  const contexts: EntityContext[] = [];
  for (const entity of rows) {
    const { rows: rels } = await pool.query(
      `SELECT 'out' AS direction, r.relation_type, t.name AS other, t.type AS other_type
       FROM relations r JOIN entities t ON t.id = r.target_entity_id
       WHERE r.source_entity_id = $1
       UNION ALL
       SELECT 'in' AS direction, r.relation_type, s.name AS other, s.type AS other_type
       FROM relations r JOIN entities s ON s.id = r.source_entity_id
       WHERE r.target_entity_id = $1`,
      [entity.id]
    );
    contexts.push({
      id: entity.id,
      type: entity.type,
      name: entity.name,
      relations: rels.map((r) => ({
        direction: r.direction,
        type: r.relation_type,
        other: r.other,
        otherType: r.other_type,
      })),
    });
  }
  return contexts;
}
