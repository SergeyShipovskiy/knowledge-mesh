import { pool, getNeo4jDriver } from "@knowledge-mesh/shared";

const REL_PATTERN = /^[A-Z][A-Z_]*$/;

export interface ResolvedEntity {
  id: string;
  type: string;
  name: string;
}

/** Resolve a fuzzy name to an entity, preferring doc-backed and exact matches. */
export async function resolveEntity(name: string): Promise<ResolvedEntity | null> {
  const { rows } = await pool.query(
    `SELECT id, type, name FROM entities
     WHERE lower(replace(name, '/', '-')) = lower(replace($1, '/', '-'))
        OR lower(replace(name, '/', '-')) LIKE '%-' || lower(replace($1, '/', '-'))
        OR name ILIKE '%' || $1 || '%'
     ORDER BY (lower(replace(name, '/', '-')) = lower(replace($1, '/', '-'))) DESC,
              (lower(replace(name, '/', '-')) LIKE '%-' || lower(replace($1, '/', '-'))) DESC,
              (document_id IS NOT NULL) DESC,
              length(name)
     LIMIT 1`,
    [name]
  );
  return rows[0] ?? null;
}

export interface GraphNeighborhood {
  root: ResolvedEntity;
  nodes: {
    name: string;
    types: string[];
    kind: string | null;
    origin: string | null;
    summary: string | null;
  }[];
  edges: { source: string; type: string; target: string }[];
}

export async function neighborhood(
  entity: ResolvedEntity,
  hops: number,
  relationTypes?: string[]
): Promise<GraphNeighborhood> {
  const safeHops = Math.min(Math.max(1, hops), 3);
  const relFilter =
    relationTypes && relationTypes.length
      ? ":" +
        relationTypes
          .map((t) => {
            const upper = t.toUpperCase();
            if (!REL_PATTERN.test(upper)) throw new Error(`Bad relation type: ${t}`);
            return upper;
          })
          .join("|")
      : "";

  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (root:Entity {entity_id: $id})
       CALL {
         WITH root
         MATCH path = (root)-[${relFilter}*1..${safeHops}]-(m:Entity)
         RETURN path LIMIT 200
       }
       UNWIND relationships(path) AS rel
       WITH DISTINCT rel, startNode(rel) AS s, endNode(rel) AS e
       RETURN s.name AS source, type(rel) AS relType, e.name AS target,
              [s.name, e.name] AS names,
              [{name: s.name, labels: labels(s), kind: s.kind, origin: s.origin, summary: s.summary},
               {name: e.name, labels: labels(e), kind: e.kind, origin: e.origin, summary: e.summary}] AS nodePair`,
      { id: entity.id }
    );

    const nodes = new Map<string, GraphNeighborhood["nodes"][number]>();
    const edges: GraphNeighborhood["edges"] = [];
    for (const record of result.records) {
      edges.push({
        source: record.get("source"),
        type: record.get("relType"),
        target: record.get("target"),
      });
      for (const n of record.get("nodePair")) {
        if (!nodes.has(n.name)) {
          nodes.set(n.name, {
            name: n.name,
            types: (n.labels as string[]).filter((l) => l !== "Entity"),
            kind: n.kind ?? null,
            origin: n.origin ?? null,
            summary: n.summary ?? null,
          });
        }
      }
    }
    return { root: entity, nodes: [...nodes.values()], edges };
  } finally {
    await session.close();
  }
}

export interface ImpactReport {
  service: ResolvedEntity;
  belongs_to: string[];
  publishes: { topic: string; consumers: string[] }[];
  subscribes: string[];
  calls_http: string[];
  called_by_http: string[];
  attached_knowledge: {
    type: string;
    name: string;
    summary: string | null;
    origin: string | null;
    source: string;
  }[];
}

export async function impact(entity: ResolvedEntity): Promise<ImpactReport> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Entity {entity_id: $id})
       OPTIONAL MATCH (s)-[:BELONGS_TO]->(bc)
       OPTIONAL MATCH (s)-[:PUBLISHES_TO]->(pt)
       OPTIONAL MATCH (pt)<-[:SUBSCRIBES_TO]-(consumer) WHERE consumer <> s
       OPTIONAL MATCH (s)-[:SUBSCRIBES_TO]->(st)
       OPTIONAL MATCH (s)-[:CALLS_HTTP]->(callee)
       OPTIONAL MATCH (caller)-[:CALLS_HTTP]->(s)
       RETURN collect(DISTINCT bc.name) AS contexts,
              collect(DISTINCT {topic: pt.name, consumer: consumer.name}) AS pubs,
              collect(DISTINCT st.name) AS subs,
              collect(DISTINCT callee.name) AS callees,
              collect(DISTINCT caller.name) AS callers`,
      { id: entity.id }
    );

    const record = result.records[0];
    const pubMap = new Map<string, Set<string>>();
    for (const p of record.get("pubs")) {
      if (!p.topic) continue;
      if (!pubMap.has(p.topic)) pubMap.set(p.topic, new Set());
      if (p.consumer) pubMap.get(p.topic)!.add(p.consumer);
    }

    // Semantic knowledge attached to this service and its direct consumers:
    // constraints, decisions, problems extracted from notes that mention them.
    const affectedNames = [
      entity.name,
      ...[...pubMap.values()].flatMap((s) => [...s]),
    ];
    const knowledge = await session.run(
      `MATCH (o:Entity)-[r:RELATES_TO|ADDRESSES|SUPPORTS|CONTRADICTS|USES|EXTRACTED_FROM]-(target:Entity)
       WHERE target.name IN $names
         AND o.kind = 'semantic'
         AND any(l IN labels(o) WHERE l IN ['Constraint', 'Decision', 'Problem'])
       RETURN DISTINCT head([l IN labels(o) WHERE l <> 'Entity']) AS type,
              o.name AS name, o.summary AS summary, o.origin AS origin,
              target.name AS source
       LIMIT 30`,
      { names: affectedNames }
    );

    return {
      service: entity,
      belongs_to: record.get("contexts").filter(Boolean),
      publishes: [...pubMap.entries()].map(([topic, consumers]) => ({
        topic,
        consumers: [...consumers].sort(),
      })),
      subscribes: record.get("subs").filter(Boolean),
      calls_http: record.get("callees").filter(Boolean),
      called_by_http: record.get("callers").filter(Boolean),
      attached_knowledge: knowledge.records.map((r) => ({
        type: r.get("type"),
        name: r.get("name"),
        summary: r.get("summary"),
        origin: r.get("origin") ?? null,
        source: r.get("source"),
      })),
    };
  } finally {
    await session.close();
  }
}
