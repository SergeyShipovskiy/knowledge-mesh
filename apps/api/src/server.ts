import Fastify from "fastify";
import {
  config,
  pool,
  projectGraph,
  embed,
  embedQuery,
  useLocalEmbeddings,
} from "@knowledge-mesh/shared";
import { searchChunks, entityContextForDocuments } from "./search.js";
import { writeAgentNote } from "./vaultWrite.js";
import { resolveEntity, neighborhood, impact } from "./graph.js";
import { updateNote, undoLastEdit, noteHistory } from "./noteEdit.js";
import { listProposals, promoteNote } from "./promote.js";

// The API hosts the only resident embedding model; other processes
// (indexer, watcher) delegate here via EMBEDDING_REMOTE_URL.
useLocalEmbeddings();

const app = Fastify({ logger: true });

// Adoption metrics: record one usage_events row per knowledge-facing request.
// Runs in onResponse (after the client already has the reply), best-effort —
// a metrics insert must never break or slow a real request.
const TRACKED_ROUTES = new Set([
  "/search",
  "/context",
  "/note",
  "/entity/:id",
  "/entity",
  "/graph",
  "/impact",
  "/remember",
  "/proposal",
  "/proposals",
  "/promote",
  "/changes",
  "/note/update",
  "/note/undo",
  "/note/history",
  "/link",
]);

app.addHook("onResponse", async (request, reply) => {
  const route = request.routeOptions?.url;
  if (!route || !TRACKED_ROUTES.has(route)) return;
  const body = request.body as { agent?: unknown } | undefined;
  const query = request.query as { agent?: unknown } | undefined;
  const rawAgent = body?.agent ?? query?.agent;
  const agent = typeof rawAgent === "string" && rawAgent.trim() ? rawAgent.trim() : null;
  try {
    await pool.query(
      `INSERT INTO usage_events (endpoint, method, status, duration_ms, agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [route, request.method, reply.statusCode, Math.round(reply.elapsedTime ?? 0), agent]
    );
  } catch (err) {
    request.log.warn({ err }, "usage_events insert failed");
  }
});

app.post<{ Body: { texts?: string[]; kind?: "document" | "query" } }>(
  "/embed",
  async (request, reply) => {
    const { texts, kind } = request.body ?? {};
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 200) {
      return reply.code(400).send({ error: "Required: texts (1-200 strings)" });
    }
    const vectors =
      kind === "query"
        ? [await embedQuery(texts[0]), ...(await embed(texts.slice(1)))]
        : await embed(texts);
    return { vectors };
  }
);

app.get("/health", async () => ({ status: "ok" }));

app.get<{ Querystring: { q?: string; limit?: string } }>(
  "/search",
  async (request, reply) => {
    const { q, limit } = request.query;
    if (!q) return reply.code(400).send({ error: "Missing query parameter: q" });
    const results = await searchChunks(q, Math.min(Number(limit ?? 8), 50));
    return { query: q, results };
  }
);

app.get<{ Querystring: { q?: string; limit?: string } }>(
  "/context",
  async (request, reply) => {
    const { q, limit } = request.query;
    if (!q) return reply.code(400).send({ error: "Missing query parameter: q" });

    const results = await searchChunks(q, Math.min(Number(limit ?? 6), 20));
    const documentIds = [...new Set(results.map((r) => r.document_id))];
    const entities = await entityContextForDocuments(documentIds);

    const sections = results.map((r) => {
      const via =
        r.similarity != null
          ? `similarity ${r.similarity.toFixed(2)}`
          : `matched by ${r.matched_by.join("+")}`;
      return `## ${r.title} (${r.path}, ${via})\n\n${r.chunk_content}`;
    });
    const graphLines = entities.flatMap((e) =>
      e.relations.map((rel) =>
        rel.direction === "out"
          ? `- ${e.name} —[${rel.type}]→ ${rel.other} (${rel.otherType})`
          : `- ${rel.other} (${rel.otherType}) —[${rel.type}]→ ${e.name}`
      )
    );

    const context = [
      `# Knowledge context for: ${q}`,
      ...sections,
      ...(graphLines.length ? ["## Related knowledge graph", ...graphLines] : []),
    ].join("\n\n");

    return { query: q, context, results, entities };
  }
);

app.get<{ Params: { id: string } }>("/entity/:id", async (request, reply) => {
  const { id } = request.params;
  const { rows } = await pool.query(
    `SELECT e.id, e.type, e.name, e.metadata, d.path, d.title, d.content
     FROM entities e LEFT JOIN documents d ON d.id = e.document_id
     WHERE e.id = $1`,
    [id]
  );
  if (rows.length === 0) return reply.code(404).send({ error: "Entity not found" });

  const { rows: relations } = await pool.query(
    `SELECT 'out' AS direction, r.relation_type AS type, t.name AS other, t.type AS other_type
     FROM relations r JOIN entities t ON t.id = r.target_entity_id
     WHERE r.source_entity_id = $1
     UNION ALL
     SELECT 'in' AS direction, r.relation_type AS type, s.name AS other, s.type AS other_type
     FROM relations r JOIN entities s ON s.id = r.source_entity_id
     WHERE r.target_entity_id = $1`,
    [id]
  );

  return { ...rows[0], relations };
});

app.get<{ Querystring: { path?: string; name?: string } }>(
  "/note",
  async (request, reply) => {
    const { path: notePath, name } = request.query;
    if (!notePath && !name) {
      return reply
        .code(400)
        .send({ error: "Provide query parameter: path or name" });
    }

    let doc: any;
    if (notePath) {
      const exact = await pool.query(
        "SELECT id, path, title, content, frontmatter, updated_at FROM documents WHERE path = $1",
        [notePath]
      );
      doc =
        exact.rows[0] ??
        (
          await pool.query(
            "SELECT id, path, title, content, frontmatter, updated_at FROM documents WHERE path ILIKE '%' || $1 || '%' ORDER BY path LIMIT 1",
            [notePath]
          )
        ).rows[0];
    } else {
      const byTitle = await pool.query(
        `SELECT id, path, title, content, frontmatter, updated_at FROM documents
         WHERE title ILIKE '%' || $1 || '%' ORDER BY (lower(title) = lower($1)) DESC, title LIMIT 1`,
        [name]
      );
      doc =
        byTitle.rows[0] ??
        (
          await pool.query(
            `SELECT d.id, d.path, d.title, d.content, d.frontmatter, d.updated_at
             FROM entities e JOIN documents d ON d.id = e.document_id
             WHERE e.name ILIKE '%' || $1 || '%' LIMIT 1`,
            [name]
          )
        ).rows[0];
    }

    if (!doc) return reply.code(404).send({ error: "Note not found" });

    const { rows: entities } = await pool.query(
      "SELECT id, type, name FROM entities WHERE document_id = $1",
      [doc.id]
    );
    return { ...doc, entity: entities[0] ?? null };
  }
);

app.get<{ Querystring: { name?: string } }>("/entity", async (request, reply) => {
  const { name } = request.query;
  if (!name) return reply.code(400).send({ error: "Missing query parameter: name" });
  const { rows } = await pool.query(
    `SELECT id, type, name, metadata FROM entities
     WHERE name ILIKE '%' || $1 || '%' ORDER BY name LIMIT 20`,
    [name]
  );
  return { entities: rows };
});

app.get<{ Querystring: { entity?: string; hops?: string; types?: string } }>(
  "/graph",
  async (request, reply) => {
    const { entity, hops, types } = request.query;
    if (!entity) return reply.code(400).send({ error: "Missing query parameter: entity" });
    const resolved = await resolveEntity(entity);
    if (!resolved) return reply.code(404).send({ error: `Entity not found: ${entity}` });
    const relationTypes = types ? types.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    return neighborhood(resolved, Number(hops ?? 1), relationTypes);
  }
);

app.get<{ Querystring: { service?: string } }>("/impact", async (request, reply) => {
  const { service } = request.query;
  if (!service) return reply.code(400).send({ error: "Missing query parameter: service" });
  const resolved = await resolveEntity(service);
  if (!resolved) return reply.code(404).send({ error: `Service not found: ${service}` });
  return impact(resolved);
});

app.post<{
  Body: { title?: string; content?: string; agent?: string; type?: string; tags?: string[] };
}>("/remember", async (request, reply) => {
  const { title, content, agent, type, tags } = request.body ?? {};
  if (!title || !content) {
    return reply.code(400).send({ error: "Required fields: title, content" });
  }
  const { relPath } = await writeAgentNote({ title, content, agent, type, tags, kind: "note" });
  return reply.code(201).send({ status: "stored", path: relPath });
});

app.post<{
  Body: { title?: string; content?: string; agent?: string; tags?: string[] };
}>("/proposal", async (request, reply) => {
  const { title, content, agent, tags } = request.body ?? {};
  if (!title || !content) {
    return reply.code(400).send({ error: "Required fields: title, content" });
  }
  const { relPath } = await writeAgentNote({ title, content, agent, tags, kind: "proposal" });
  return reply.code(201).send({ status: "proposed", path: relPath });
});

app.post<{
  Body: {
    path?: string;
    old_string?: string;
    new_string?: string;
    append?: string;
    reason?: string;
    agent?: string;
  };
}>("/note/update", async (request, reply) => {
  const { path: notePath, old_string, new_string, append, reason, agent } =
    request.body ?? {};
  if (!notePath || !reason) {
    return reply.code(400).send({ error: "Required fields: path, reason" });
  }
  try {
    return await updateNote({
      path: notePath,
      old_string,
      new_string,
      append,
      reason,
      agent: agent ?? "system",
    });
  } catch (err: any) {
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  }
});

app.post<{ Body: { path?: string; agent?: string } }>(
  "/note/undo",
  async (request, reply) => {
    const { path: notePath, agent } = request.body ?? {};
    if (!notePath) return reply.code(400).send({ error: "Required field: path" });
    try {
      return await undoLastEdit(notePath, agent ?? "system");
    } catch (err: any) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  }
);

app.get<{ Querystring: { all?: string; limit?: string } }>(
  "/proposals",
  async (request) => {
    const includeAll = request.query.all === "1" || request.query.all === "true";
    const limit = Math.min(Number(request.query.limit ?? 30), 200);
    return listProposals(includeAll, limit);
  }
);

app.post<{
  Body: { path?: string; target_path?: string; reason?: string; agent?: string };
}>("/promote", async (request, reply) => {
  const { path: notePath, target_path, reason, agent } = request.body ?? {};
  if (!notePath) return reply.code(400).send({ error: "Required field: path" });
  try {
    const result = await promoteNote({
      path: notePath,
      target_path,
      reason,
      agent: agent ?? "system",
    });
    return reply.code(201).send(result);
  } catch (err: any) {
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  }
});

app.get<{ Querystring: { days?: string } }>("/stats", async (request) => {
  const days = Math.min(Math.max(Number(request.query.days ?? 30), 1), 365);
  const window = [days];

  const [byEndpoint, byDay, byAgent, totals] = await Promise.all([
    pool.query(
      `SELECT endpoint, count(*)::int AS calls,
              round(avg(duration_ms))::int AS avg_ms,
              count(*) FILTER (WHERE status >= 400)::int AS errors
       FROM usage_events WHERE ts > now() - ($1 || ' days')::interval
       GROUP BY endpoint ORDER BY calls DESC`,
      window
    ),
    pool.query(
      `SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day, count(*)::int AS calls
       FROM usage_events WHERE ts > now() - ($1 || ' days')::interval
       GROUP BY 1 ORDER BY 1 DESC`,
      window
    ),
    pool.query(
      `SELECT agent, count(*)::int AS writes
       FROM usage_events
       WHERE ts > now() - ($1 || ' days')::interval AND agent IS NOT NULL
       GROUP BY agent ORDER BY writes DESC`,
      window
    ),
    pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE method = 'GET')::int AS reads,
              count(*) FILTER (WHERE method <> 'GET')::int AS writes,
              min(ts) AS since
       FROM usage_events WHERE ts > now() - ($1 || ' days')::interval`,
      window
    ),
  ]);

  return {
    days,
    totals: totals.rows[0],
    by_endpoint: byEndpoint.rows,
    by_day: byDay.rows,
    writes_by_agent: byAgent.rows,
  };
});

app.get<{ Querystring: { days?: string; limit?: string } }>(
  "/changes",
  async (request) => {
    const days = Math.min(Number(request.query.days ?? 7), 90);
    const limit = Math.min(Number(request.query.limit ?? 30), 200);

    const { rows: agentEdits } = await pool.query(
      `SELECT path, agent, reason, edit_kind, created_at, reverted_at IS NOT NULL AS reverted
       FROM note_edits
       WHERE created_at > now() - ($1 || ' days')::interval
       ORDER BY created_at DESC LIMIT $2`,
      [days, limit]
    );

    const { rows: changedNotes } = await pool.query(
      `SELECT path, title, updated_at, created_at = updated_at AS is_new
       FROM documents
       WHERE updated_at > now() - ($1 || ' days')::interval
       ORDER BY updated_at DESC LIMIT $2`,
      [days, limit]
    );

    return { days, agent_edits: agentEdits, changed_notes: changedNotes };
  }
);

app.get<{ Querystring: { path?: string } }>(
  "/note/history",
  async (request, reply) => {
    const { path: notePath } = request.query;
    if (!notePath) return reply.code(400).send({ error: "Missing query parameter: path" });
    try {
      return await noteHistory(notePath);
    } catch (err: any) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  }
);

app.post<{
  Body: { source?: string; target?: string; type?: string; confidence?: number };
}>("/link", async (request, reply) => {
  const { source, target, type, confidence } = request.body ?? {};
  if (!source || !target || !type) {
    return reply.code(400).send({ error: "Required fields: source, target, type" });
  }

  const find = (name: string) =>
    pool
      .query(
        `SELECT id, name FROM entities WHERE name ILIKE $1
         ORDER BY (document_id IS NOT NULL) DESC LIMIT 1`,
        [name]
      )
      .then((r) => r.rows[0]);

  const [sourceEntity, targetEntity] = await Promise.all([find(source), find(target)]);
  if (!sourceEntity || !targetEntity) {
    return reply.code(404).send({
      error: "Entity not found",
      missing: [...(!sourceEntity ? [source] : []), ...(!targetEntity ? [target] : [])],
    });
  }

  await pool.query(
    `INSERT INTO relations (source_entity_id, target_entity_id, relation_type, confidence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_entity_id, target_entity_id, relation_type) DO UPDATE
       SET confidence = EXCLUDED.confidence`,
    [sourceEntity.id, targetEntity.id, type.toUpperCase(), confidence ?? 1.0]
  );
  await projectGraph();

  return reply.code(201).send({
    status: "linked",
    source: sourceEntity.name,
    target: targetEntity.name,
    type: type.toUpperCase(),
  });
});

app
  .listen({ port: config.api.port, host: "127.0.0.1" })
  .then(() => console.log(`Knowledge API listening on ${config.api.url}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
