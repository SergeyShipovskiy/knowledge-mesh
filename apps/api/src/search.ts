import { pool, toVectorLiteral, embedQuery, embed } from "@knowledge-mesh/shared";

export interface HybridSearchResult {
  document_id: string;
  path: string;
  title: string;
  chunk_content: string;
  similarity: number | null;
  entity_type: string | null;
  tags: string[];
  matched_by: ("vector" | "text" | "title" | "exact")[];
  score: number;
  // Freshness: when the note was last indexed, and the platform-analysis
  // commit it was last reconciled against (for service notes maintained by
  // analysis-sync). Lets consumers weigh how current a hit is.
  updated_at: string | null;
  analysis_commit: string | null;
  // Collapse-by-document: one result per note; how many of its chunks matched.
  // Several chunks of one note are one voice, not corroboration.
  chunks_matched: number;
  // Currency: true when the best-matching chunk is retracted by a later
  // correction section of the same note; `correction` carries that section.
  superseded: boolean;
  correction: string | null;
  // Authority: rank multiplier applied from kind/folder/type (1 = neutral).
  authority: number;
  kind: string | null;
  author: string | null;
  // Echo guard: the top hit being the caller's own recent note is not
  // corroboration. Set only when the caller identifies itself via `agent`.
  own_recent_note?: boolean;
}

const CANDIDATES = 50;
const RRF_K = 60;
// Title/path hits answer "I typed an exact note/service name" lookups —
// rank them above frequency-based chunk matches. Weight 3 (not the fork's 2):
// this vault's template service notes cross-mention each other's names, so
// the note NAMED by the query needs the extra margin over notes citing it.
const TITLE_WEIGHT = 3;
// Rare exact tokens (numbers, identifiers) are the highest-signal part of a
// query — a verbatim hit must outrank paraphrases of it.
const EXACT_WEIGHT = 3;
const CORRECTION_SNIPPET = 500;
const OWN_NOTE_WINDOW_MS = 48 * 3600 * 1000;

// Authority weighting: small constant factors, not a re-ranking regime.
// Doctrine and decisions outrank a plain note of equal similarity; what
// expires (closed tasks, archives, navigation indexes) decays out of
// default results while staying findable by exact title/path.
const BOOST_DOCTRINE = 1.3;
const DISCOUNT_CLOSED_TASK = 0.5;
const DISCOUNT_INDEX = 0.5;
const DISCOUNT_ARCHIVE = 0.3;
const DISCOUNT_SUPERSEDED_DOC = 0.4;

const RESULT_COLUMNS = `
  c.id AS chunk_id, c.document_id, c.chunk_index, c.content AS chunk_content,
  c.superseded, d.path, d.title, d.updated_at, d.frontmatter,
  substring(d.content from 'analysis-commit:[[:space:]]*([0-9a-f]{6,40})') AS analysis_commit`;

interface CandidateChunk {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  chunk_content: string;
  superseded: boolean;
  path: string;
  title: string;
  updated_at: string | null;
  frontmatter: Record<string, unknown>;
  analysis_commit: string | null;
  similarity: number | null;
  matched_by: Set<"vector" | "text" | "title" | "exact">;
  score: number;
}

/**
 * Extract high-signal exact tokens from a query: percentages, multi-digit
 * numbers, and separator-joined identifiers (kebab/snake/dotted names).
 * These get a verbatim-substring channel so they outrank semantic echoes.
 */
export function rareTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const m of query.matchAll(/\d+(?:[.,]\d+)?%?/g)) {
    const t = m[0];
    if (t.includes("%") || t.length >= 3) tokens.add(t);
  }
  for (const m of query.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_./][A-Za-z0-9]+)+/g)) {
    if (m[0].length >= 4) tokens.add(m[0]);
  }
  return [...tokens].slice(0, 6);
}

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Separators carry no meaning in a note name: `payment_files_service`,
// `payment-files-service` and `payment files service` are the same lookup.
// Applied to both sides of the loose title/path comparison.
const SEPARATOR_RUN = /[-_./\s]+/g;
function normalizeSeparators(text: string): string {
  return text.toLowerCase().replace(SEPARATOR_RUN, " ").trim();
}
const SQL_NORMALIZE = `regexp_replace(lower(%s), '[-_./[:space:]]+', ' ', 'g')`;

function authorityFactor(
  path: string,
  entityType: string | null,
  fm: Record<string, unknown>
): number {
  const kind = typeof fm.kind === "string" ? fm.kind.toLowerCase() : "";
  const status = typeof fm.status === "string" ? fm.status.toLowerCase() : "";

  let factor = 1;
  // This vault has no doctrine/ folder; solution designs are the closest
  // thing to doctrine (deliberate, reviewed, long-lived).
  if (
    path.startsWith("projects/solution_designs/") ||
    kind === "doctrine" ||
    kind === "decision" ||
    entityType === "Decision"
  ) {
    factor = BOOST_DOCTRINE;
  }

  // Only a CLOSED task has expired. An open one is live, actionable knowledge —
  // discounting it buried the very notes that record what is still broken.
  if ((kind === "task" || kind === "status") && ["done", "closed", "resolved"].includes(status)) {
    factor *= DISCOUNT_CLOSED_TASK;
  }
  if (kind === "index" || kind === "moc") factor *= DISCOUNT_INDEX;
  if (kind === "archive" || path.startsWith("archive/")) factor *= DISCOUNT_ARCHIVE;
  if (fm.superseded_by) factor = Math.min(factor, DISCOUNT_SUPERSEDED_DOC);

  return factor;
}

/**
 * Full-text candidates. `websearch_to_tsquery` requires EVERY term in one
 * chunk, which is the right default — but when nothing satisfies it the
 * channel used to go silent and hybrid search quietly degraded to vector-only.
 * So: all-terms first, and only if that finds nothing, fall back to any-term
 * (ts_rank still puts the widest coverage on top). The query is split on '/'
 * to match how chunks.ts is generated.
 */
async function textCandidates(query: string) {
  const all = await pool.query(
    `SELECT ${RESULT_COLUMNS}, NULL::float AS similarity
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.ts @@ websearch_to_tsquery('english', translate($1, '/', ' '))
     ORDER BY ts_rank(c.ts, websearch_to_tsquery('english', translate($1, '/', ' '))) DESC
     LIMIT $2`,
    [query, CANDIDATES]
  );
  if (all.rows.length > 0) return all;

  return pool.query(
    `WITH q AS (
       SELECT (SELECT string_agg(quote_literal(l), ' | ')
               FROM unnest(tsvector_to_array(to_tsvector('english', translate($1, '/', ' ')))) l
              )::tsquery AS tq
     )
     SELECT ${RESULT_COLUMNS}, NULL::float AS similarity
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     CROSS JOIN q
     WHERE q.tq IS NOT NULL AND c.ts @@ q.tq
     ORDER BY ts_rank(c.ts, q.tq) DESC
     LIMIT $2`,
    [query, CANDIDATES]
  );
}

function frontmatterAuthor(fm: Record<string, unknown>): string | null {
  if (typeof fm.source === "string" && fm.source.startsWith("agent:")) {
    return fm.source.slice("agent:".length);
  }
  if (typeof fm.created_by === "string") return fm.created_by;
  return null;
}

/**
 * Hybrid retrieval, fused with Reciprocal Rank Fusion across four channels:
 * vector similarity (paraphrases), full-text (keywords), title/path (exact
 * note names), and verbatim rare tokens (numbers, identifiers). Results are
 * collapsed to one row per document, weighted by authority (doctrine/decision
 * up, expired/archived down), and never represented by a chunk that a later
 * correction section of the same note retracts.
 */
export async function searchChunks(
  query: string,
  limit = 8,
  agent?: string
): Promise<HybridSearchResult[]> {
  const vector = toVectorLiteral(await embedQuery(query));
  const exact = rareTokens(query);

  const exactPatterns = exact.map((t) => `%${escapeLike(t)}%`);
  const exactHits = exactPatterns
    .map((_, i) => `(CASE WHEN c.content ILIKE $${i + 1} ESCAPE '\\' THEN 1 ELSE 0 END)`)
    .join(" + ");
  const exactInContent = exactPatterns
    .map((_, i) => `c.content ILIKE $${i + 1} ESCAPE '\\'`)
    .join(" OR ");
  const exactNamed = exactPatterns
    .map((_, i) => `d.title ILIKE $${i + 1} ESCAPE '\\' OR d.path ILIKE $${i + 1} ESCAPE '\\'`)
    .join(" OR ");

  // LIKE metacharacters in a query must stay literal: unescaped, a single '%'
  // matches every title and hands the ten shortest notes a weight-3 boost.
  const titlePattern = `%${escapeLike(query)}%`;
  const pathPattern = `%${escapeLike(query.replace(/ /g, "-"))}%`;
  const loosePattern = `%${escapeLike(normalizeSeparators(query))}%`;

  const [vectorRows, textRows, titleRows, exactRows] = await Promise.all([
    pool.query(
      `SELECT ${RESULT_COLUMNS}, 1 - (c.embedding <=> $1::vector) AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      [vector, CANDIDATES]
    ),
    textCandidates(query),
    pool.query(
      `SELECT ${RESULT_COLUMNS}, NULL::float AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.chunk_index = 0
         AND (d.title ILIKE $1 ESCAPE '\\'
              OR d.path ILIKE $2 ESCAPE '\\'
              OR ${SQL_NORMALIZE.replace("%s", "d.title")} LIKE $3 ESCAPE '\\'
              OR ${SQL_NORMALIZE.replace("%s", "d.path")} LIKE $3 ESCAPE '\\')
       ORDER BY length(d.title)
       LIMIT 10`,
      [titlePattern, pathPattern, loosePattern]
    ),
    exact.length === 0
      ? Promise.resolve({ rows: [] })
      : pool.query(
          // Notes NAMED by a token come before notes that merely cite it —
          // template service notes mention each other in short chunks, and
          // the shortest-chunk tiebreak alone would crowd out the named note.
          // The named note must match on its NAME alone. Matching only
          // c.content missed it whenever the token lives in the title/path and
          // in no chunk body — exactly the "I typed the note's name" lookup
          // this channel exists for. Restricted to chunk 0 so one note cannot
          // fill the limit with every chunk it owns.
          `SELECT ${RESULT_COLUMNS}, NULL::float AS similarity, ${exactHits} AS hits,
                  (${exactNamed})::int AS named
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
           WHERE (${exactInContent})
              OR (c.chunk_index = 0 AND (${exactNamed}))
           ORDER BY named DESC, hits DESC, length(c.content)
           LIMIT 20`,
          exactPatterns
        ),
  ]);

  const fused = new Map<string, CandidateChunk>();

  const fuse = (rows: any[], source: "vector" | "text" | "title" | "exact", weight: number) => {
    const seen = new Set<string>();
    rows.forEach((row, rank) => {
      if (seen.has(row.chunk_id)) return; // one contribution per chunk per channel
      seen.add(row.chunk_id);
      const contribution = weight / (RRF_K + rank + 1);
      const existing = fused.get(row.chunk_id);
      if (existing) {
        existing.score += contribution;
        existing.matched_by.add(source);
        if (row.similarity != null) existing.similarity = Number(row.similarity);
      } else {
        fused.set(row.chunk_id, {
          chunk_id: row.chunk_id,
          document_id: row.document_id,
          chunk_index: row.chunk_index,
          chunk_content: row.chunk_content,
          superseded: Boolean(row.superseded),
          path: row.path,
          title: row.title,
          updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
          frontmatter: row.frontmatter ?? {},
          analysis_commit: row.analysis_commit ?? null,
          similarity: row.similarity != null ? Number(row.similarity) : null,
          matched_by: new Set([source]),
          score: contribution,
        });
      }
    });
  };

  fuse(vectorRows.rows, "vector", 1);
  fuse(textRows.rows, "text", 1);
  fuse(titleRows.rows, "title", TITLE_WEIGHT);
  fuse(exactRows.rows as any[], "exact", EXACT_WEIGHT);

  // Collapse to one result per document. Doc score = best chunk score (a
  // note matching with five chunks is still one source). The representative
  // chunk is the best NON-retracted match; a retracted chunk may only stand
  // in (flagged, with the correction attached) when nothing else matched.
  const byDoc = new Map<string, CandidateChunk[]>();
  for (const chunk of fused.values()) {
    const list = byDoc.get(chunk.document_id);
    if (list) list.push(chunk);
    else byDoc.set(chunk.document_id, [chunk]);
  }

  const docIds = [...byDoc.keys()];
  const entityTypes = new Map<string, string>();
  if (docIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT e.document_id, e.type
       FROM entities e JOIN documents d ON d.id = e.document_id
       WHERE e.document_id = ANY($1)
       ORDER BY (e.name = d.title) DESC`,
      [docIds]
    );
    for (const row of rows) {
      if (!entityTypes.has(row.document_id)) entityTypes.set(row.document_id, row.type);
    }
  }

  const results: HybridSearchResult[] = [];
  for (const [documentId, chunks] of byDoc) {
    chunks.sort((a, b) => b.score - a.score);
    const best = chunks[0];
    const representative = chunks.find((c) => !c.superseded) ?? best;
    const fm = representative.frontmatter;
    const entityType = entityTypes.get(documentId) ?? null;
    const authority = authorityFactor(representative.path, entityType, fm);

    const tags = Array.isArray(fm.tags)
      ? fm.tags.map(String)
      : typeof fm.tags === "string"
        ? [fm.tags]
        : [];

    const author = frontmatterAuthor(fm);
    const ownRecent =
      agent != null &&
      author === agent &&
      representative.updated_at != null &&
      Date.now() - Date.parse(representative.updated_at) < OWN_NOTE_WINDOW_MS;

    results.push({
      document_id: documentId,
      path: representative.path,
      title: representative.title,
      chunk_content: representative.chunk_content,
      similarity: representative.similarity,
      entity_type: entityType,
      tags,
      matched_by: [...representative.matched_by],
      score: best.score * authority,
      updated_at: representative.updated_at,
      analysis_commit: representative.analysis_commit,
      chunks_matched: chunks.length,
      superseded: representative.superseded,
      correction: null,
      authority,
      kind: typeof fm.kind === "string" ? fm.kind : null,
      author,
      ...(ownRecent ? { own_recent_note: true } : {}),
    });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);

  // A retracted representative must never be handed back bare: attach the
  // note's latest non-retracted section so the reader gets the correction
  // in the same glance as the claim it retracts.
  await Promise.all(
    top
      .filter((r) => r.superseded)
      .map(async (r) => {
        const { rows } = await pool.query(
          `SELECT content FROM chunks
           WHERE document_id = $1 AND NOT superseded
           ORDER BY chunk_index DESC LIMIT 1`,
          [r.document_id]
        );
        const correction = rows[0]?.content;
        if (correction) {
          r.correction =
            correction.length > CORRECTION_SNIPPET
              ? `${correction.slice(0, CORRECTION_SNIPPET)}…`
              : correction;
        }
      })
  );

  return top;
}

export interface SimilarNote {
  path: string;
  title: string;
  similarity: number;
}

const SIMILAR_MIN = 0.72;

/**
 * Nearest existing notes to a piece of text — offered to the writer at
 * /remember time so a conclusion that already has a home gets linked or
 * appended to instead of restated in a parallel note.
 */
export async function similarNotes(
  text: string,
  excludePath?: string,
  limit = 5
): Promise<SimilarNote[]> {
  const [vec] = await embed([text.slice(0, 4000)]);
  const { rows } = await pool.query(
    `SELECT path, title, sim FROM (
       SELECT DISTINCT ON (c.document_id)
              d.path, d.title, 1 - (c.embedding <=> $1::vector) AS sim
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.path <> $2
       ORDER BY c.document_id, c.embedding <=> $1::vector
     ) t
     WHERE sim > $3
     ORDER BY sim DESC LIMIT $4`,
    [toVectorLiteral(vec), excludePath ?? "", SIMILAR_MIN, limit]
  );
  return rows.map((r) => ({
    path: r.path,
    title: r.title,
    similarity: Number(r.sim),
  }));
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
