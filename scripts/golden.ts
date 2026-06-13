/**
 * Golden-set retrieval evaluation. Run after any change to embeddings,
 * search fusion, chunking, or graph extraction:
 *
 *   pnpm golden
 *
 * Exits non-zero if any check fails. Checks are intentionally loose
 * (expected path in top-3, count thresholds) so vault growth doesn't
 * break them, while real regressions do.
 */
const API = process.env.API_URL ?? "http://localhost:3333";

interface SearchCheck {
  kind: "search";
  query: string;
  expectPathIncludes: string;
  topN?: number;
}
interface ImpactCheck {
  kind: "impact";
  service: string;
  expectTopic: string;
  minConsumers: number;
  expectContext: string;
}
interface GraphCheck {
  kind: "graph";
  entity: string;
  types: string;
  expectRootType: string;
  minEdges: number;
}
interface NoteCheck {
  kind: "note";
  path: string;
  minContentLength: number;
}
type Check = SearchCheck | ImpactCheck | GraphCheck | NoteCheck;

const CHECKS: Check[] = [
  // — paraphrased questions (vector retrieval)
  { kind: "search", query: "how are refunds processed", expectPathIncludes: "refund-service" },
  { kind: "search", query: "what is the cleanup plan for commission service", expectPathIncludes: "commission_cleanup_plan" },
  { kind: "search", query: "reverse shadow rollout commission lookup", expectPathIncludes: "rollout" },
  { kind: "search", query: "why do we keep full ladder in old columns", expectPathIncludes: "commissions" },
  { kind: "search", query: "idempotent cancel order suppression", expectPathIncludes: "order-handler-service", topN: 3 },
  { kind: "search", query: "merchant search performance backstage", expectPathIncludes: "commission" },
  // — exact tokens (FTS retrieval)
  { kind: "search", query: "purchase.order.events", expectPathIncludes: "qlty/platform" },
  { kind: "search", query: "order-handler-service", expectPathIncludes: "order-handler-service" },
  // — agent write-back retrievable
  { kind: "search", query: "what is the status of backstage-next commission cleanup", expectPathIncludes: "agents/claude" },
  { kind: "search", query: "knowledge mesh", expectPathIncludes: "knowledge-mesh" },
  // — graph layer
  { kind: "impact", service: "order-handler-service", expectTopic: "purchase.order.events", minConsumers: 12, expectContext: "purchase" },
  { kind: "graph", entity: "support", types: "BELONGS_TO", expectRootType: "BoundedContext", minEdges: 5 },
  // — full-note read
  { kind: "note", path: "commission_cleanup_plan", minContentLength: 5000 },
];

async function get(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function runCheck(check: Check): Promise<{ name: string; ok: boolean; detail: string }> {
  try {
    switch (check.kind) {
      case "search": {
        const topN = check.topN ?? 3;
        const d = await get(`/search?q=${encodeURIComponent(check.query)}&limit=${topN}`);
        const paths: string[] = d.results.map((r: any) => r.path);
        const ok = paths.some((p) => p.includes(check.expectPathIncludes));
        return {
          name: `search: ${check.query}`,
          ok,
          detail: ok ? `hit in top-${topN}` : `expected *${check.expectPathIncludes}* in top-${topN}, got: ${paths.join(", ")}`,
        };
      }
      case "impact": {
        const d = await get(`/impact?service=${encodeURIComponent(check.service)}`);
        const pub = d.publishes.find((p: any) => p.topic === check.expectTopic);
        const consumers = pub?.consumers?.length ?? 0;
        const contextOk = d.belongs_to.includes(check.expectContext);
        const ok = consumers >= check.minConsumers && contextOk;
        return {
          name: `impact: ${check.service}`,
          ok,
          detail: `consumers=${consumers} (min ${check.minConsumers}), context ${contextOk ? "ok" : "MISSING " + check.expectContext}`,
        };
      }
      case "graph": {
        const d = await get(`/graph?entity=${encodeURIComponent(check.entity)}&types=${check.types}&hops=1`);
        const ok = d.root.type === check.expectRootType && d.edges.length >= check.minEdges;
        return {
          name: `graph: ${check.entity} (${check.types})`,
          ok,
          detail: `root=${d.root.type}, edges=${d.edges.length} (min ${check.minEdges})`,
        };
      }
      case "note": {
        const d = await get(`/note?path=${encodeURIComponent(check.path)}`);
        const ok = (d.content?.length ?? 0) >= check.minContentLength;
        return {
          name: `note: ${check.path}`,
          ok,
          detail: `content ${d.content?.length ?? 0} chars (min ${check.minContentLength})`,
        };
      }
    }
  } catch (err) {
    return { name: `${check.kind}: ${JSON.stringify(check).slice(0, 60)}`, ok: false, detail: (err as Error).message };
  }
}

const results = await Promise.all(CHECKS.map(runCheck));
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` — ${r.detail}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
