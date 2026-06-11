---
name: qlty-pr-service-change-analyzer
description: Mandatory pre-merge analysis runbook for any QLTY PR review. Maps the diff to the services and bounded contexts it touches, classifies the change (Kafka producer/consumer, HTTP contract, DB/migration, config, infra, refactor), computes downstream blast radius from CoreMem (knowledge_impact / GET /impact; fallback: vault notes on disk), applies production-safety guardrails (Avro schema impact, event-path HTTP coupling, accounting-pm critical path), produces a risk verdict (safe-to-merge / needs-dev-env-validation / needs-deeper-review / blocker), emits a structured `---INLINE---` / `---SUMMARY---` PR-review draft the CTO pipeline already consumes, and writes the learned delta back to CoreMem. Use this skill on every PR you review before signing off — never approve without running it. Pair with `qlty-platform-guide` (how to query CoreMem), `qlty` (deeper cross-service analysis), and `qlty-local-dev` (Tester escalation target).
---

# QLTY PR — Service-Change Blast-Radius Analyzer

> **When to use:** Every time you (Developer / S. Coder, agent [`4ea6a5c2`](/CDO/agents/developer)) are assigned a PR-review task by the CTO PR pipeline. Run this **before** writing your verdict. Do not approve or request changes until you have a verdict from this skill.
>
> **Why it exists:** QLTY is a 75-service event-driven platform across 6 bounded contexts. A single-file change can ripple through 12+ downstream consumers via Kafka or break a synchronous HTTP dependency invoked inside event processing. A green CI run does **not** tell you whether you just broke a downstream consumer in a different bounded context. CoreMem does — one `knowledge_impact` call returns the full downstream picture.

## Authoritative references (query these — do not guess)

**Primary: CoreMem (the shared knowledge mesh).** One call answers blast radius:

- MCP tool `knowledge_impact(service)` — topics published/subscribed, downstream
  consumers per topic, HTTP callers/callees, bounded context, plus attached
  Constraints/Decisions/Problems for the affected services.
- No MCP in your runtime? Same data over HTTP:
  `curl -s 'http://localhost:3333/impact?service=<name>'`
- Supporting tools: `knowledge_search` (find notes), `knowledge_get` (read one
  note in full), `knowledge_graph` (typed neighborhood).

**Fallback (only if the CoreMem API is down)** — read the vault notes directly
from disk (they are the same single source CoreMem indexes):

- `/Users/sergship/Documents/CDON_Vault/technologies/qlty/QLTY Platform MOC.md` — services by bounded context
- `/Users/sergship/Documents/CDON_Vault/technologies/qlty/platform/<service>.md` — per-service notes
  (kafka subscribes/publishes, http-depends, databases). Grep the folder for a
  topic name to find its consumers.

If a question requires confirming an exact consumer set that CoreMem and the
vault notes don't answer, spawn a child issue to [Coder](/CDO/agents/coder) with
the specific question (do **not** block on full platform re-analysis).

## Workflow — seven steps, in order

### Step 1 — Identify the service(s) touched by the diff

For each file in the PR diff:

1. Resolve the **repo / service name** from the file path. QLTY conventions:
   - Services live in `bounded_contexts/<context>/<service>/...` or as standalone repos at `/QLTY/<service>/`.
   - Helm/Kustomize/Skaffold edits also implicate the owning service (one service can have multiple deployments — e.g., `accounting-pm-service` has `purchase-order` and `refund` deployments).
2. Resolve the **bounded context** via CoreMem: `knowledge_impact(<service>)` returns `belongs_to` (or `curl -s 'http://localhost:3333/impact?service=<name>'`). Contexts: `accounting`, `inventory`, `merchant`, `purchase`, `shop`, `support`.
3. If the same PR touches services in **multiple bounded contexts**, list each and flag it — cross-context PRs are higher-risk by default.

Output for this step: a bullet list `service → context` per touched service.

### Step 2 — Classify the change type(s)

Classify every change in the diff into one or more of these buckets. A single PR can hit multiple buckets — list all that apply:

- **Kafka producer change** — new topic, new event type, new field, removed/renamed field, Avro schema change in `avro-schemas/`, new `producer.send()`/`emit()` callsite.
- **Kafka consumer change** — new subscription, removed handler, changed dispatch logic, new dead-letter behavior.
- **HTTP API change** — route added/removed, request/response contract change, status-code semantics, auth requirement change, query/path parameter change.
- **Database / migration change** — Alembic migration, new column, dropped column, index change, MongoDB schema/index, Mongo migration script, raw SQL DDL.
- **Config / env change** — secret references, feature flags, env vars, resource limits, replica counts, autoscaler tuning.
- **Infra / Helm / Kustomize change** — `kustomize/{fyndiq,cdon}/*`, `skaffold/{fyndiq,cdon}.yaml`, Helm values, k8s manifests, Terraform/Terragrunt.
- **Pure refactor / test-only** — no behaviour change, no contract change, no config change. (Verify carefully — "pure refactor" claims hide real changes more often than not.)

Output for this step: a bullet list of categories present, with one-line evidence per category (the file path or hunk that proves it).

### Step 3 — Compute blast radius

For each change category from Step 2, list **every downstream service** that consumes the affected topic or calls the affected HTTP endpoint. Pull this from CoreMem — do not estimate. One `knowledge_impact(<service>)` call per touched service returns the full picture: topics published with their consumer lists, subscriptions, HTTP callers/callees, bounded context, **and attached Constraints/Decisions/Problems** — read those too, they encode prior incidents and standing decisions about the affected services.

How to look it up:

- **Kafka producer change** → `knowledge_impact(<producer>)` → `publishes[].consumers`. Example: a change to `purchase.order.events` has **17+ consumers across 6 contexts**.
- **Kafka consumer change** → `knowledge_graph(<topic>, types=PUBLISHES_TO,SUBSCRIBES_TO)` lists the producer(s) and all sibling consumers (ordering/partition effects).
- **HTTP API change** → `knowledge_impact(<service>)` → `called_by_http`, **then** check whether any caller invokes this endpoint inside Kafka event processing (`knowledge_search("<caller> http calls during event processing")`). Calls on the event path cascade — they are not the same risk as a synchronous request initiated by a user click.
- **DB / migration** → identify any service that reads the same database (shared MongoDBs exist — e.g., `inventory-article-api-service` reads `article-projection-service`'s MongoDB); `knowledge_get(<service note>)` lists databases per service.
- **Config / env** → identify the deployments affected (Fyndiq vs CDON, multi-deployment services like `shop-article-enricher-service` with 5 deployments).
- **Infra / Helm** — identify whether the change is overlay-local (single deployment) or chart-wide (all deployments).

**Cross-bounded-context impact must be called out explicitly.** If the change in service A (context X) reaches consumers in context Y, that fact is a finding regardless of code quality. Mark it: `⚠️ cross-context impact: <X> → <Y>`.

Output for this step: a table `Change → Downstream service(s) → Bounded context(s)`.

### Step 4 — Risk verdict

Pick exactly one verdict per PR:

| Verdict | Criteria (any one is sufficient) |
|---|---|
| `safe-to-merge` | Pure refactor / test-only / dev-tooling. Or single-service config edit with no contract, schema, or migration change. Blast radius = 1 service, no consumers affected. |
| `needs-dev-env-validation` | Any Kafka schema/topic change on a topic with **>1 consumer**. Any new Kafka consumer. Any DB migration touching a table read by another service. Any Helm/Kustomize change touching replicas, resources, or env on a service in active production traffic. Tester runs the relevant bounded-context flow in Colima (see `qlty-local-dev` skill). |
| `needs-deeper-review` | Any HTTP contract change on a service listed in `http_calls_during_event_processing.md`. Any change to one of the **handler services** (see "Handler services" below). Any change touching more than one bounded context. Removing a Kafka field (vs adding). Any auth/security change. |
| `blocker` | Any change to `accounting-pm-service`'s HTTP dependencies — `article-projection-api-service` (shipped_from on every order event) or `merchant-internal-api-service` (country_code for NO market). These are flagged ⚠️ in the platform map and run inside event processing on **every** order event. Block until the board has signed off. |

### Production-safety guardrails (apply even when other criteria look benign)

1. **Avro schema change on a Kafka topic with >1 consumer** ⇒ minimum `needs-dev-env-validation`. Always. The platform map lists consumer counts; if the topic has >1 entry in the "Kafka Sub" columns, the rule applies.
2. **HTTP contract change on any service in `http_calls_during_event_processing.md`** ⇒ `needs-deeper-review` regardless of diff size. Those calls cascade into event processing.
3. **Change to a handler service** (source-of-truth event store) ⇒ `needs-deeper-review` by default. Handler services produce the broadcast event topics every projection / PM / integration depends on. The handler services to watch (confirm via `knowledge_impact`):
   - `accounting-handler-service` → `accounting.accounting.events`
   - `inventory-article-handler-service` → `inventory.article.events`, `inventory.article.snapshot`, `inventory.article-market.events`, `inventory.article.signals`
   - `inventory-stock-handler-service` → `inventory.stock.events`, `inventory.stock.signals`
   - `inventory-article-price-service` → `inventory.price.events`, `inventory.price.signals`
   - `merchant-handler-service` → `merchant.merchant.events`, `merchant.profitshare.events`
   - `shop-article-handler-service` → `shop.article.events`, `shop.enricher.commands`
   - `purchase-order-handler-service` → `purchase.order.events`
4. **`accounting-pm-service` HTTP-dependency change** ⇒ `blocker` until explicit board sign-off. This is non-negotiable; the platform map calls these calls out with ⚠️.

If two guardrails conflict, pick the **more severe** verdict.

### Step 5 — Tester escalation (only when verdict is `needs-dev-env-validation`)

When the verdict is `needs-dev-env-validation`, **create a child issue assigned to** [Tester](/CDO/agents/tester) — do not @-mention Tester from inside the PR review thread.

Child-issue contract:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "title": "[PR Review] Dev-env validation: <PR title>",
  "description": "## Context\n\nQLTY PR change-analyzer flagged this PR `needs-dev-env-validation`.\n\n- Services touched: ...\n- Change type(s): ...\n- Blast radius: ... downstream consumers\n\n## Scenarios to validate in Colima\n\n1. ...\n2. ...\n\n## How to apply\n\nUse the `qlty-local-dev` skill to spin up the affected bounded context(s) and run the scenarios above. Report pass/fail per scenario with logs.",
  "assigneeAgentId": "<tester-agent-id>",
  "parentId": "<this-pr-review-issue-id>",
  "status": "todo",
  "priority": "high"
}
JSON
```

Then add the new child to the PR-review issue's `blockedByIssueIds` so the parent re-wakes when Tester finishes.

Do **not** wait for Tester inside the same heartbeat — the parent will get an `issue_blockers_resolved` wake when the child closes.

### Step 6 — Produce the PR-review draft

Emit the analysis as a structured document using the **exact** `---INLINE---` / `---SUMMARY---` delimiters the CTO PR pipeline consumes (see the CTO AGENTS.md `Stage 3 — Writer` section). Writer rewrites prose inside each `body:` and inside the `SUMMARY` block but must preserve the delimiters.

#### Inline comments — one per finding tied to a specific file + line

For each finding with a clear code-location anchor (e.g., a removed Avro field, a renamed HTTP route, a new producer call), emit:

```
---INLINE---
file: <repo-relative path, exactly as it appears in the diff>
line: <integer — last line of the diff hunk this comment applies to>
body: <one-paragraph finding. State the change, the consumer(s) impacted (named, from the platform map), and the verdict criterion that fires.>
```

Repeat per finding. Close the inline section with `---END_INLINE---`. **If there are no inline findings, omit the inline section entirely.**

#### Summary block — one per PR

```
---SUMMARY---
**Services touched:** <service → context, one per bullet>

**Change types:** <bullet list from Step 2>

**Blast radius:**
- <change> → <downstream services + contexts>
- <change> → <downstream services + contexts>

**Cross-context impact:** <yes / no — if yes, list the contexts>

**Guardrail hits:** <which production-safety guardrails fired, if any>

**Verdict:** `safe-to-merge` | `needs-dev-env-validation` | `needs-deeper-review` | `blocker`

**Reasoning:** <one paragraph tying the verdict to the criteria above>

**Tester child issue:** <issue id + link, or "n/a">

**Recommendation to author:** <one-line next step for the PR author — e.g., "Add a no-op default for the new Avro field so existing consumers stay forward-compatible.">

LGTM | Request changes
---END_SUMMARY---
```

End the summary with either `LGTM` (only when verdict is `safe-to-merge`) or `Request changes` (every other verdict). The CTO pipeline uses this string to pick `APPROVE` vs `REQUEST_CHANGES` for the GitHub review event.

### Step 7 — Write the delta back to CoreMem

Reviews routinely surface facts the knowledge base doesn't have yet: a new
consumer, a new topic, a contract change, a constraint confirmed in discussion.
**Do not let them die in the review thread.** After emitting the draft, store
each genuinely new fact:

- MCP: `knowledge_remember(title, content, tags=["qlty","pr-review"], agent=<your name>)`
- HTTP: `curl -s -X POST http://localhost:3333/remember -H 'Content-Type: application/json' -d '{"title":"...","content":"...","tags":["qlty","pr-review"],"agent":"<your name>"}'`

Content rules: one fact per note, reference the PR (`repo#number`), name the
services with `[[wikilinks]]` so the graph picks up relations. Skip this step
only when the review surfaced nothing the mesh didn't already know.

If the PR **changes** an architectural fact recorded in an existing service
note (e.g. it adds a Kafka subscription), do not edit the human note yourself —
record it via `knowledge_remember`; the human promotes it after merge.

## Worked example (compact)

PR adds a new optional field to `purchase.order.events` Avro schema and updates the producer in `purchase-order-handler-service`.

- **Touched:** `purchase-order-handler-service` → `purchase`; `avro-schemas` (shared)
- **Change type:** Kafka producer change (Avro schema additive change)
- **Blast radius:** `knowledge_impact(order-handler-service)` → 17+ consumers of `purchase.order.events`. Cross-context: `purchase → accounting`, `purchase → inventory`, `purchase → shop`, `purchase → support`, `purchase → merchant`. Attached knowledge surfaced `Decision: Idempotent CancelOrder suppression` — checked the diff doesn't regress it.
- **Guardrails:** Avro change on topic with >1 consumer ⇒ `needs-dev-env-validation`. Handler-service change ⇒ `needs-deeper-review`.
- **Verdict:** `needs-deeper-review` (the more severe of the two guardrails fired).
- **Action:** request changes; ask author to confirm the field is `optional` with a default, so non-updated consumers keep deserializing.

## Anti-patterns — do not do these

- ❌ Approve a PR without running this skill because "the diff is small".
- ❌ Estimate consumer counts from memory. Always look them up via `knowledge_impact` (or the vault notes if the API is down).
- ❌ Skip Step 7 when the review established a new fact. Unrecorded findings get re-discovered (and re-paid for) on the next PR.
- ❌ @-mention Tester or IDP from the PR-review thread. Escalation is via child issue only.
- ❌ Change the verdict because the author pushes back. Verdict is a function of the criteria, not negotiation.
- ❌ Skip Step 6's structured output. The CTO pipeline parses these delimiters — free-form prose breaks Stage 5.
- ❌ Mark `safe-to-merge` for any change that touches `accounting-pm-service`'s HTTP path, a handler service, or a topic with multiple consumers. If in doubt, escalate.
