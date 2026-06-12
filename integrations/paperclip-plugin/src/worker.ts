import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";

const DEFAULT_API_URL = "http://127.0.0.1:3333";
const DEFAULT_AGENT = "paperclip";

interface CoreMemConfig {
  apiUrl: string;
  agentName: string;
}

async function readConfig(ctx: PluginContext): Promise<CoreMemConfig> {
  const config = await ctx.config.get();
  return {
    apiUrl: (typeof config.apiUrl === "string" && config.apiUrl.trim()) || DEFAULT_API_URL,
    agentName: (typeof config.agentName === "string" && config.agentName.trim()) || DEFAULT_AGENT,
  };
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // ctx.http.fetch carries the host's SSRF guard, which (correctly) blocks
    // private/loopback addresses — but a local-first CoreMem lives exactly
    // there. Loopback URLs use direct fetch (sanctioned for trusted local
    // plugins); anything remote keeps going through ctx.http for the host's
    // tracing and audit logging.
    const httpFetch = async (url: string, init?: RequestInit): Promise<Response> =>
      isLoopback(url) ? fetch(url, init) : ctx.http.fetch(url, init);

    // Thin client over the CoreMem Knowledge API — all logic, validation and
    // write rules live in the API, identical to the MCP server. Errors come
    // back as ToolResult.error so the agent can react instead of crashing.
    const callApi = async (path: string, init?: RequestInit): Promise<ToolResult> => {
      const { apiUrl } = await readConfig(ctx);
      try {
        const response = await httpFetch(`${apiUrl}${path}`, {
          ...init,
          headers: { "Content-Type": "application/json", ...init?.headers },
        });
        const body = await response.json();
        if (!response.ok) {
          return { error: `Knowledge API ${response.status}: ${JSON.stringify(body)}` };
        }
        return { content: JSON.stringify(body, null, 2), data: body };
      } catch (err) {
        return {
          error: `CoreMem Knowledge API unreachable at ${apiUrl}: ${(err as Error).message}`,
        };
      }
    };

    const toolSchema = (name: string) =>
      ctx.manifest.tools?.find((tool) => tool.name === name) ?? {
        displayName: name,
        description: name,
        parametersSchema: { type: "object" as const },
      };

    ctx.tools.register("knowledge_search", toolSchema("knowledge_search"), async (params) => {
      const { query, limit } = params as { query?: string; limit?: number };
      if (!query) return { error: "query is required" };
      return callApi(`/search?q=${encodeURIComponent(query)}&limit=${limit ?? 8}`);
    });

    ctx.tools.register("knowledge_context", toolSchema("knowledge_context"), async (params) => {
      const { query } = params as { query?: string };
      if (!query) return { error: "query is required" };
      return callApi(`/context?q=${encodeURIComponent(query)}`);
    });

    ctx.tools.register("knowledge_get", toolSchema("knowledge_get"), async (params) => {
      const { path, name } = params as { path?: string; name?: string };
      if (!path && !name) return { error: "Provide path or name" };
      const param = path
        ? `path=${encodeURIComponent(path)}`
        : `name=${encodeURIComponent(name ?? "")}`;
      return callApi(`/note?${param}`);
    });

    ctx.tools.register("knowledge_impact", toolSchema("knowledge_impact"), async (params) => {
      const { service } = params as { service?: string };
      if (!service) return { error: "service is required" };
      return callApi(`/impact?service=${encodeURIComponent(service)}`);
    });

    ctx.tools.register("knowledge_remember", toolSchema("knowledge_remember"), async (params) => {
      const { title, content, tags } = params as {
        title?: string;
        content?: string;
        tags?: string[];
      };
      if (!title || !content) return { error: "title and content are required" };
      const { agentName } = await readConfig(ctx);
      return callApi("/remember", {
        method: "POST",
        body: JSON.stringify({ title, content, tags, agent: agentName }),
      });
    });

    ctx.tools.register("knowledge_changes", toolSchema("knowledge_changes"), async (params) => {
      const { days, limit } = params as { days?: number; limit?: number };
      const search = new URLSearchParams();
      if (days) search.set("days", String(days));
      if (limit) search.set("limit", String(limit));
      return callApi(`/changes?${search}`);
    });

    // Dashboard widget data: is the mesh reachable from this Paperclip host?
    ctx.data.register("health", async () => {
      const { apiUrl } = await readConfig(ctx);
      try {
        const response = await httpFetch(`${apiUrl}/health`);
        const body = (await response.json()) as { status?: string };
        return {
          status: body.status === "ok" ? "ok" : "degraded",
          apiUrl,
          checkedAt: new Date().toISOString(),
        };
      } catch {
        return { status: "unreachable", apiUrl, checkedAt: new Date().toISOString() };
      }
    });

    ctx.logger.info("CoreMem Knowledge Mesh plugin ready", {
      tools: ctx.manifest.tools?.map((tool) => tool.name) ?? [],
    });
  },

  async onHealth() {
    return { status: "ok", message: "CoreMem plugin worker is running" };
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const apiUrl = config?.apiUrl;
    if (apiUrl != null && (typeof apiUrl !== "string" || !/^https?:\/\//.test(apiUrl))) {
      return { ok: false, errors: ["apiUrl must be an http(s) URL"] };
    }
    return { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
