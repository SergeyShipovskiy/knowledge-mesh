import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const TOOL_NAMES = [
  "knowledge_search",
  "knowledge_context",
  "knowledge_get",
  "knowledge_impact",
  "knowledge_remember",
  "knowledge_changes",
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("knowledge-mesh plugin", () => {
  let harness: TestHarness;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    harness = createTestHarness({
      manifest,
      config: { apiUrl: "http://mesh.test:3333", agentName: "paperclip-test" },
    });
    await plugin.definition.setup(harness.ctx);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares the capabilities and tools it registers", () => {
    expect(manifest.capabilities).toContain("agent.tools.register");
    expect(manifest.capabilities).toContain("http.outbound");
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  it("knowledge_search hits /search with the query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ query: "refunds", results: [] }));
    const result = await harness.executeTool<ToolResult>("knowledge_search", {
      query: "refunds",
      limit: 5,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://mesh.test:3333/search?q=refunds&limit=5",
      expect.anything()
    );
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ query: "refunds", results: [] });
  });

  it("knowledge_remember posts with the configured agent identity", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "stored" }, 201));
    await harness.executeTool<ToolResult>("knowledge_remember", {
      title: "Test",
      content: "Body",
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ title: "Test", agent: "paperclip-test" });
  });

  it("surfaces API errors as ToolResult.error instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Service not found: nope" }, 404));
    const result = await harness.executeTool<ToolResult>("knowledge_impact", { service: "nope" });
    expect(result.error).toContain("404");
  });

  it("reports unreachable API in health data", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const health = await harness.getData<{ status: string }>("health");
    expect(health.status).toBe("unreachable");
  });

  it("rejects missing required params without calling the API", async () => {
    const result = await harness.executeTool<ToolResult>("knowledge_get", {});
    expect(result.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const COMPANY = "test-company";
const PR_DESC = "[https://github.com/acme/order-handler-service/pull/9](https://github.com/acme/order-handler-service/pull/9)";

function makeIssue(id: string, title: string, description: string | null): any {
  return { id, companyId: COMPANY, title, description };
}

const IMPACT_WITH_SIGNAL = {
  service: { name: "order-handler-service", type: "Technology" },
  belongs_to: ["purchase"],
  publishes: [{ topic: "purchase.order.events", consumers: ["inventory/pm-service"] }],
  subscribes: [],
  calls_http: [],
  called_by_http: [],
  attached_knowledge: [],
};

describe("PR-impact event hook", () => {
  let harness: TestHarness;
  const fetchMock = vi.fn();

  async function setup(config: Record<string, unknown> = {}) {
    harness = createTestHarness({
      manifest,
      config: { apiUrl: "http://mesh.test:3333", ...config },
    });
    await plugin.definition.setup(harness.ctx);
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function commentsOn(issueId: string) {
    return harness.ctx.issues.listComments(issueId, COMPANY);
  }

  it("attaches a blast-radius comment when a PR issue is created", async () => {
    await setup();
    harness.seed({ issues: [makeIssue("iss_1", "[PR Review] order handler", PR_DESC)] });
    fetchMock.mockResolvedValueOnce(jsonResponse(IMPACT_WITH_SIGNAL));

    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY });

    const comments = await commentsOn("iss_1");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Knowledge Mesh blast radius");
    expect(comments[0].body).toContain("purchase.order.events");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://mesh.test:3333/impact?service=order-handler-service",
      expect.anything()
    );
  });

  it("only posts once across repeated events for the same issue", async () => {
    await setup();
    harness.seed({ issues: [makeIssue("iss_2", "[PR Review] x", PR_DESC)] });
    fetchMock.mockResolvedValue(jsonResponse(IMPACT_WITH_SIGNAL));

    await harness.emit("issue.created", {}, { entityId: "iss_2", companyId: COMPANY });
    await harness.emit("issue.updated", {}, { entityId: "iss_2", companyId: COMPANY });
    await harness.emit("issue.updated", {}, { entityId: "iss_2", companyId: COMPANY });

    expect(await commentsOn("iss_2")).toHaveLength(1);
  });

  it("does nothing for an issue without a PR URL", async () => {
    await setup();
    harness.seed({ issues: [makeIssue("iss_3", "Fix the build", "no link here")] });

    await harness.emit("issue.created", {}, { entityId: "iss_3", companyId: COMPANY });

    expect(await commentsOn("iss_3")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts nothing (and does not retry) when the service is unknown to Knowledge Mesh", async () => {
    await setup();
    harness.seed({ issues: [makeIssue("iss_4", "[PR Review] mystery", PR_DESC)] });
    fetchMock.mockResolvedValue(jsonResponse({ error: "Service not found" }, 404));

    await harness.emit("issue.created", {}, { entityId: "iss_4", companyId: COMPANY });
    await harness.emit("issue.updated", {}, { entityId: "iss_4", companyId: COMPANY });

    expect(await commentsOn("iss_4")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // skip state prevents a re-query
  });

  it("is disabled when prImpactComments is false", async () => {
    await setup({ prImpactComments: false });
    harness.seed({ issues: [makeIssue("iss_5", "[PR Review] off", PR_DESC)] });

    await harness.emit("issue.created", {}, { entityId: "iss_5", companyId: COMPANY });

    expect(await commentsOn("iss_5")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
