import { describe, expect, it } from "vitest";
import { extractPrRepo, formatImpactComment, type ImpactData } from "../src/pr-impact.js";

const EMPTY: ImpactData = {
  service: { name: "order-handler-service", type: "Technology" },
  belongs_to: [],
  publishes: [],
  subscribes: [],
  calls_http: [],
  called_by_http: [],
  attached_knowledge: [],
};

describe("extractPrRepo", () => {
  it("pulls the repo slug out of a GitHub PR URL", () => {
    expect(
      extractPrRepo("Review https://github.com/Spacefuel/order-handler-service/pull/142 please")
    ).toBe("order-handler-service");
  });

  it("works with a markdown-link description (CTO enrichment format)", () => {
    const desc = "[https://github.com/acme/inventory-pm-service/pull/7](https://github.com/acme/inventory-pm-service/pull/7)\n\nbody";
    expect(extractPrRepo(desc)).toBe("inventory-pm-service");
  });

  it("strips a trailing .git", () => {
    expect(extractPrRepo("https://github.com/acme/foo-service.git/pull/3")).toBe("foo-service");
  });

  it("returns null when there is no PR URL", () => {
    expect(extractPrRepo("just a normal task, no link")).toBeNull();
    expect(extractPrRepo("https://github.com/acme/foo/issues/3")).toBeNull();
    expect(extractPrRepo(null)).toBeNull();
  });
});

describe("formatImpactComment", () => {
  it("returns null when the service resolved to nothing meaningful", () => {
    expect(formatImpactComment(EMPTY)).toBeNull();
  });

  it("renders topics, consumers, and attached knowledge with origin", () => {
    const impact: ImpactData = {
      service: { name: "purchase/order-handler-service", type: "Technology" },
      belongs_to: ["purchase"],
      publishes: [{ topic: "purchase.order.events", consumers: ["inventory/pm-service", "accounting-pm-service"] }],
      subscribes: ["purchase.order.commands"],
      calls_http: [],
      called_by_http: ["backstage-next"],
      attached_knowledge: [
        { type: "Decision", name: "Idempotent CancelOrder", summary: "suppress dup refunds", origin: "human", source: "purchase/order-handler-service" },
        { type: "Problem", name: "race on projection", summary: null, origin: "agent", source: "x" },
      ],
    };
    const out = formatImpactComment(impact)!;
    expect(out).toContain("CoreMem blast radius");
    expect(out).toContain("purchase.order.events");
    expect(out).toContain("inventory/pm-service, accounting-pm-service");
    expect(out).toContain("**Bounded context:** purchase");
    expect(out).toContain("**[Decision]** Idempotent CancelOrder");
    expect(out).toContain("_(agent-sourced)_");
    expect(out).toContain("**Called by (HTTP):** backstage-next");
  });

  it("notes when a published topic has no known consumers", () => {
    const impact: ImpactData = { ...EMPTY, publishes: [{ topic: "lonely.topic", consumers: [] }] };
    expect(formatImpactComment(impact)).toContain("_no known consumers_");
  });
});
