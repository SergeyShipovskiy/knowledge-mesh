import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "coremem.knowledge-mesh",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "CoreMem Knowledge Mesh",
  description:
    "Shared human/agent memory (CoreMem, a.k.a. Knowledge Mesh): hybrid search, full-note reads, knowledge graph, blast-radius reports and agent write-back over the CoreMem Knowledge API.",
  author: "Sergey Shipovskiy",
  categories: ["connector"],
  capabilities: ["agent.tools.register", "http.outbound", "ui.dashboardWidget.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      apiUrl: {
        type: "string",
        description: "Base URL of the CoreMem Knowledge API",
        default: "http://127.0.0.1:3333",
      },
      agentName: {
        type: "string",
        description:
          "Agent identity recorded on write-back notes (they land under vault/agents/<agentName>/)",
        default: "paperclip",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "CoreMem Knowledge Mesh Health",
        exportName: "DashboardWidget",
      },
    ],
  },
  tools: [
    {
      name: "knowledge_search",
      displayName: "Search shared memory",
      description:
        "CoreMem (a.k.a. Knowledge Mesh) — the shared human/agent memory. Call this FIRST whenever a question may be covered by the shared knowledge vault (projects, platform services, solution designs, past decisions) — before reading repos or asking. Hybrid search: semantic similarity plus exact keyword match, so both paraphrased questions and exact tokens (service names, Kafka topics, error codes) work. Returns note chunks with paths; follow up with knowledge_get to read a full note.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language question or exact term (service name, topic, error code)",
          },
          limit: { type: "number", description: "Max results, 1-50 (default 8)" },
        },
        required: ["query"],
      },
    },
    {
      name: "knowledge_context",
      displayName: "Get grounding context",
      description:
        "Call this when you need to ANSWER from shared memory in one shot: returns a ready-to-use markdown context block with the most relevant note excerpts plus the knowledge-graph relations (decisions, constraints, dependencies) around them. Prefer this over knowledge_search when the goal is grounding an answer rather than locating a note.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic or question to build context for" },
        },
        required: ["query"],
      },
    },
    {
      name: "knowledge_get",
      displayName: "Read a full note",
      description:
        "Read ONE FULL note from the shared vault after knowledge_search pointed at it. Accepts a vault-relative path (preferred, from search results) or a note title / entity name. Returns full markdown content, frontmatter, and the note's graph entity.",
      parametersSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path from search results (substring match allowed)",
          },
          name: { type: "string", description: "Note title or entity name, when path is unknown" },
        },
      },
    },
    {
      name: "knowledge_impact",
      displayName: "Service blast radius",
      description:
        "BLAST-RADIUS analysis of a platform service before approving changes to it: which Kafka topics it publishes/subscribes, which services consume its events downstream, HTTP callers/callees, its bounded context — plus known Constraints/Decisions/Problems attached to the affected services (each with origin: human or agent-sourced). Use for PR reviews and 'what breaks if I change X' questions.",
      parametersSchema: {
        type: "object",
        properties: {
          service: {
            type: "string",
            description: "Service name, e.g. 'order-handler-service' (fuzzy match allowed)",
          },
        },
        required: ["service"],
      },
    },
    {
      name: "knowledge_remember",
      displayName: "Store new knowledge",
      description:
        "Store a new piece of knowledge in the shared vault as an agent note (never overwrites human notes). It is indexed and added to the knowledge graph immediately — searchable by every agent and visible to humans in Obsidian.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short note title" },
          content: {
            type: "string",
            description: "Markdown content; [[wikilinks]] become graph relations",
          },
          tags: { type: "array", items: { type: "string" }, description: "Tags for the note" },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "knowledge_changes",
      displayName: "What changed in memory",
      description:
        "See WHAT CHANGED in the shared memory recently: agent edits of human notes (who, why, when) and notes created/updated in the vault. Use for 'what's new', 'which services were updated lately', 'did anything change in X since last week'.",
      parametersSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Look-back window in days, 1-90 (default 7)" },
          limit: { type: "number", description: "Max entries per list, 1-200 (default 30)" },
        },
      },
    },
  ],
};

export default manifest;
