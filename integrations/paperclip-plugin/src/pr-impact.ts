// Proactive memory: when a PR-review issue appears, attach a Knowledge Mesh
// blast-radius report so the reviewer sees downstream impact before starting.
// Pure string logic here (no I/O) so it is trivially testable; the worker
// owns the HTTP call and comment post.

/** Shape of GET /impact (subset the comment needs). */
export interface ImpactData {
  service: { name: string; type: string };
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

const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/([\w.-]+?)(?:\.git)?\/pull\/\d+/i;

/**
 * Extract the repository name from the first GitHub PR URL in some text.
 * In the QLTY platform a repo maps to a service, and Knowledge Mesh resolves the
 * name fuzzily, so the repo slug is a good /impact key. Returns null when
 * no PR URL is present.
 */
export function extractPrRepo(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = PR_URL_RE.exec(text);
  return match ? match[1] : null;
}

function hasSignal(impact: ImpactData): boolean {
  return (
    impact.publishes.length > 0 ||
    impact.subscribes.length > 0 ||
    impact.calls_http.length > 0 ||
    impact.called_by_http.length > 0 ||
    impact.attached_knowledge.length > 0
  );
}

/**
 * Render the impact report as a concise markdown comment. Returns null when
 * the service resolved to nothing meaningful — in that case the worker posts
 * no comment rather than noise.
 */
export function formatImpactComment(impact: ImpactData): string | null {
  if (!hasSignal(impact)) return null;

  const lines: string[] = [
    `## Knowledge Mesh blast radius — \`${impact.service.name}\``,
    "",
    "_Auto-attached from Knowledge Mesh on PR-review intake. Verify against the actual diff — this reflects what the vault knows, not the branch._",
    "",
  ];

  if (impact.belongs_to.length) {
    lines.push(`**Bounded context:** ${impact.belongs_to.join(", ")}`, "");
  }

  if (impact.publishes.length) {
    lines.push("**Publishes** (downstream consumers break if the contract changes):");
    for (const pub of impact.publishes) {
      const consumers = pub.consumers.length ? pub.consumers.join(", ") : "_no known consumers_";
      lines.push(`- \`${pub.topic}\` → ${consumers}`);
    }
    lines.push("");
  }

  if (impact.subscribes.length) {
    lines.push(`**Subscribes to:** ${impact.subscribes.map((t) => `\`${t}\``).join(", ")}`, "");
  }

  if (impact.calls_http.length) {
    lines.push(`**Calls (HTTP):** ${impact.calls_http.join(", ")}`, "");
  }

  if (impact.called_by_http.length) {
    lines.push(`**Called by (HTTP):** ${impact.called_by_http.join(", ")}`, "");
  }

  if (impact.attached_knowledge.length) {
    lines.push("**Known constraints / decisions / problems:**");
    for (const k of impact.attached_knowledge) {
      const origin = k.origin === "agent" ? " _(agent-sourced)_" : "";
      const summary = k.summary ? ` — ${k.summary}` : "";
      lines.push(`- **[${k.type}]** ${k.name}${origin}${summary}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
