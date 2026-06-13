import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { extractPrRepo, formatImpactComment, type ImpactData } from "./pr-impact.js";

const DEFAULT_API_URL = "http://127.0.0.1:3333";
const DEFAULT_AGENT = "paperclip";

interface CoreMemConfig {
  apiUrl: string;
  agentName: string;
  prImpactComments: boolean;
}

async function readConfig(ctx: PluginContext): Promise<CoreMemConfig> {
  const config = await ctx.config.get();
  return {
    apiUrl: (typeof config.apiUrl === "string" && config.apiUrl.trim()) || DEFAULT_API_URL,
    agentName: (typeof config.agentName === "string" && config.agentName.trim()) || DEFAULT_AGENT,
    prImpactComments: config.prImpactComments !== false,
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

    // Proactive memory: when an issue carrying a GitHub PR URL appears,
    // attach a CoreMem blast-radius comment for the touched service before
    // a reviewer starts — memory shows up unasked instead of waiting to be
    // queried. Idempotent per issue via plugin state; fires on create and
    // update because the PR URL is often added during a later enrichment pass.
    const STATE_KEY = "pr-impact-comment";

    const maybePostImpact = async (issueId: string, companyId: string): Promise<void> => {
      const { prImpactComments } = await readConfig(ctx);
      if (!prImpactComments) return;

      const scope = { scopeKind: "issue" as const, scopeId: issueId, stateKey: STATE_KEY };
      if (await ctx.state.get(scope)) return; // already handled this issue

      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) return;

      const repo = extractPrRepo(`${issue.title}\n${issue.description ?? ""}`);
      if (!repo) return; // not a PR issue — leave it untouched, re-check on future updates

      const result = await callApi(`/impact?service=${encodeURIComponent(repo)}`);
      if (result.error) {
        // Service not in the vault (404) or API down: record skip so we don't
        // re-query on every subsequent update of this issue.
        ctx.logger.debug("No CoreMem impact for PR repo", { repo, error: result.error });
        await ctx.state.set(scope, "skipped");
        return;
      }

      const comment = formatImpactComment(result.data as ImpactData);
      if (!comment) {
        await ctx.state.set(scope, "empty");
        return;
      }

      await ctx.issues.createComment(issueId, comment, companyId);
      await ctx.state.set(scope, "posted");
      ctx.logger.info("Attached CoreMem blast-radius to PR issue", { issueId, repo });
    };

    const onIssueEvent = async (event: { entityId?: string; companyId: string }): Promise<void> => {
      if (!event.entityId) return;
      try {
        await maybePostImpact(event.entityId, event.companyId);
      } catch (err) {
        ctx.logger.error("PR impact hook failed", { error: (err as Error).message });
      }
    };

    ctx.events.on("issue.created", onIssueEvent);
    ctx.events.on("issue.updated", onIssueEvent);

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
