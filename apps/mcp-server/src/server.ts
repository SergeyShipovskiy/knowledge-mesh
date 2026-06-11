import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "@knowledge-mesh/shared";

const API = config.api.url;

async function callApi(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Knowledge API ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: "coremem-knowledge-mesh", version: "0.1.0" });

server.registerTool(
  "knowledge_search",
  {
    description:
      "CoreMem (a.k.a. Knowledge Mesh) — the shared human/agent memory. Call this FIRST whenever a question may be covered by the shared knowledge vault (projects, platform services, solution designs, past decisions, meeting notes) — before reading repos or asking the user. Hybrid search: semantic similarity plus exact keyword match, so both paraphrased questions ('how are refunds handled') and exact tokens ('purchase.order.events', 'order-handler-service') work. Returns note chunks with paths; follow up with knowledge_get to read a full note.",
    inputSchema: {
      query: z.string().describe("Natural-language question or exact term (service name, topic, error code)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 8)"),
    },
  },
  async ({ query, limit }) =>
    asText(await callApi(`/search?q=${encodeURIComponent(query)}&limit=${limit ?? 8}`))
);

server.registerTool(
  "knowledge_context",
  {
    description:
      "Call this when you need to ANSWER from shared memory in one shot: returns a ready-to-use markdown context block with the most relevant note excerpts plus the knowledge-graph relations (decisions, constraints, dependencies) around them. Prefer this over knowledge_search when the goal is grounding an answer rather than locating a file.",
    inputSchema: {
      query: z.string().describe("Topic or question to build context for"),
    },
  },
  async ({ query }) => asText(await callApi(`/context?q=${encodeURIComponent(query)}`))
);

server.registerTool(
  "knowledge_get",
  {
    description:
      "Call this to read ONE FULL note from the vault after knowledge_search/knowledge_context pointed at it — instead of loading markdown files from disk. Accepts a vault-relative path (preferred, from search results) or a note title / entity name. Returns full markdown content, frontmatter, and the note's graph entity.",
    inputSchema: {
      path: z.string().optional().describe("Vault-relative path, e.g. 'projects/solution_designs/commissions/commission_cleanup_plan.md' (substring match allowed)"),
      name: z.string().optional().describe("Note title or entity name, used when path is unknown"),
    },
  },
  async ({ path, name }) => {
    const param = path
      ? `path=${encodeURIComponent(path)}`
      : `name=${encodeURIComponent(name ?? "")}`;
    return asText(await callApi(`/note?${param}`));
  }
);

server.registerTool(
  "knowledge_graph",
  {
    description:
      "Call this to EXPLORE the knowledge graph around an entity: 'what is connected to X and how'. Returns the typed neighborhood (services, topics, decisions, problems, technologies) up to N hops. Use after search located an entity, or when the question is about relationships/dependencies rather than text content.",
    inputSchema: {
      entity: z.string().describe("Entity name (service, topic, technology, project — fuzzy match allowed)"),
      hops: z.number().int().min(1).max(3).optional().describe("Neighborhood depth (default 1)"),
      types: z
        .string()
        .optional()
        .describe("Comma-separated relation types to follow, e.g. 'PUBLISHES_TO,SUBSCRIBES_TO' (default: all)"),
    },
  },
  async ({ entity, hops, types }) => {
    const params = new URLSearchParams({ entity });
    if (hops) params.set("hops", String(hops));
    if (types) params.set("types", types);
    return asText(await callApi(`/graph?${params}`));
  }
);

server.registerTool(
  "knowledge_impact",
  {
    description:
      "Call this for BLAST-RADIUS analysis of a platform service before approving changes to it: which Kafka topics it publishes/subscribes, which services consume its events downstream, HTTP callers/callees, its bounded context — plus known Constraints/Decisions/Problems attached to the affected services. Use for PR reviews and 'what breaks if I change X' questions.",
    inputSchema: {
      service: z.string().describe("Service name, e.g. 'order-handler-service' (fuzzy match allowed)"),
    },
  },
  async ({ service }) =>
    asText(await callApi(`/impact?service=${encodeURIComponent(service)}`))
);

server.registerTool(
  "knowledge_remember",
  {
    description:
      "Store a new piece of knowledge in the shared vault as an agent note (never overwrites human notes). It is indexed and added to the graph immediately.",
    inputSchema: {
      title: z.string().describe("Short note title"),
      content: z.string().describe("Markdown content of the note"),
      type: z
        .enum(["Note", "Idea", "Decision", "Project", "Person", "Technology", "Meeting"])
        .optional()
        .describe("Entity type (default Note)"),
      tags: z.array(z.string()).optional().describe("Tags for the note"),
      agent: z.string().optional().describe("Agent identity (default: claude)"),
    },
  },
  async ({ title, content, type, tags, agent }) =>
    asText(
      await callApi("/remember", {
        method: "POST",
        body: JSON.stringify({ title, content, type, tags, agent: agent ?? "claude" }),
      })
    )
);

server.registerTool(
  "knowledge_update_note",
  {
    description:
      "Edit an EXISTING human note in the vault. Call this ONLY when the human explicitly asked to modify a note, or to record a factual status change they confirmed (tick a checkbox, update a status line/date). Never use it for opinions, findings, or new knowledge — those go to knowledge_remember. Edits are surgical: old_string must match the current note text exactly once (re-read with knowledge_get first). Every edit is audit-logged with your reason and is reversible via knowledge_undo_edit.",
    inputSchema: {
      path: z.string().describe("Vault-relative path of the note (from knowledge_search/knowledge_get)"),
      old_string: z.string().optional().describe("Exact current text to replace (must be unique in the note)"),
      new_string: z.string().optional().describe("Replacement text"),
      append: z.string().optional().describe("Alternative to old/new: markdown to append at the end of the note"),
      reason: z.string().describe("Why this edit is being made — goes into the audit log"),
      agent: z.string().optional().describe("Agent identity (default: claude)"),
    },
  },
  async ({ path, old_string, new_string, append, reason, agent }) =>
    asText(
      await callApi("/note/update", {
        method: "POST",
        body: JSON.stringify({
          path,
          old_string,
          new_string,
          append,
          reason,
          agent: agent ?? "claude",
        }),
      })
    )
);

server.registerTool(
  "knowledge_undo_edit",
  {
    description:
      "Revert the most recent not-yet-reverted agent edit of a note (stepwise: call repeatedly to walk further back while history remains). Use when the human asks to undo an agent change, or when your own knowledge_update_note turned out wrong.",
    inputSchema: {
      path: z.string().describe("Vault-relative path of the note"),
      agent: z.string().optional().describe("Agent identity (default: claude)"),
    },
  },
  async ({ path, agent }) =>
    asText(
      await callApi("/note/undo", {
        method: "POST",
        body: JSON.stringify({ path, agent: agent ?? "claude" }),
      })
    )
);

server.registerTool(
  "knowledge_link",
  {
    description:
      "Create a typed relation between two existing entities in the knowledge graph (e.g. 'Knowledge Mesh' USES 'Neo4j').",
    inputSchema: {
      source: z.string().describe("Source entity name"),
      target: z.string().describe("Target entity name"),
      type: z
        .enum(["RELATES_TO", "MENTIONS", "USES", "SUPPORTS", "CONTRADICTS", "SUPERSEDES", "CREATED_BY"])
        .describe("Relation type"),
      confidence: z.number().min(0).max(1).optional().describe("Confidence 0-1 (default 1)"),
    },
  },
  async ({ source, target, type, confidence }) =>
    asText(
      await callApi("/link", {
        method: "POST",
        body: JSON.stringify({ source, target, type, confidence }),
      })
    )
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`knowledge-mesh MCP server running (API: ${API})`);
