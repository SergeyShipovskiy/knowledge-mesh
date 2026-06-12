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

describe("coremem plugin", () => {
  let harness: TestHarness;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    harness = createTestHarness({
      manifest,
      config: { apiUrl: "http://coremem.test:3333", agentName: "paperclip-test" },
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
      "http://coremem.test:3333/search?q=refunds&limit=5",
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
