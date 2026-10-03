# Architectural Decision Records

Key design decisions made while building the domain renewal system, with context on alternatives considered and trade-offs accepted.

## ADR-001: Durable Objects for Per-Domain Scheduling

**Context:** Domains need to trigger their own renewal 7 days before expiry. The traditional approach is a central cron job that sweeps the database for expiring domains.

**Decision:** Each domain gets its own Durable Object instance with an Alarm API timer.

**Alternatives considered:**
- **Cron-only sweep:** Simple, but at scale (millions of domains), a single sweep query becomes expensive and creates a thundering herd of renewals at 6am daily. Also, if the cron fails, nothing fires until the next run.
- **External scheduler (e.g., Redis sorted set):** Would work, but adds an external dependency and doesn't leverage Cloudflare's platform primitives.

**Trade-offs accepted:**
- (+) Each domain is an independent state machine — no shared state, no coordination overhead
- (+) Alarm fires exactly when needed, not on a polling interval
- (+) Natural retry: set another alarm 24h later if renewal doesn't complete
- (-) More Durable Object instances (one per domain) = higher baseline cost at scale
- (-) Harder to do bulk operations (e.g., "renew all domains for account X")

**Why this fits Cloudflare:** DOs are a first-class Cloudflare primitive. Using them for per-entity scheduling demonstrates understanding of the platform's strengths — the same pattern applies to session management, rate limiting, and coordination problems across Cloudflare's product suite.

## ADR-002: Queue Between Triggers and Workflow

**Context:** Three trigger sources (DO alarm, cron sweep, manual API) all need to start the same renewal pipeline.

**Decision:** All triggers enqueue a message to a Cloudflare Queue. The queue consumer starts the Workflow.

**Alternatives considered:**
- **Direct Workflow invocation from each trigger:** Simpler, fewer moving parts. But ties trigger rate to Workflow capacity, and loses the retry/backpressure semantics that Queues provide.
- **HTTP call to a central endpoint:** Adds network latency and requires the endpoint to be available.

**Trade-offs accepted:**
- (+) Decouples trigger rate from processing capacity — a burst of cron-triggered renewals doesn't overwhelm the Workflow system
- (+) At-least-once delivery guarantees (with idempotency guard in the Workflow)
- (+) Failed messages retry automatically with backoff
- (+) Single funnel point for monitoring and rate control
- (-) Adds latency (message enqueue → dequeue → Workflow start)
- (-) One more component to understand and monitor

## ADR-003: Circuit Breaker as Durable Object (Not KV)

**Context:** When a TLD registry goes down, all renewal Workflows for that TLD will retry, hammering the dead endpoint.

**Decision:** Per-TLD circuit breaker implemented as a Durable Object.

**Alternatives considered:**
- **Workers KV:** Simpler API, lower cost. But KV is eventually consistent — two concurrent Workflows could both read `CLOSED`, both get failures, and both try to write `OPEN`, resulting in a race condition.
- **In-memory state in the Worker:** Would reset on every deployment or Worker restart.
- **External service (Redis, etc.):** Adds a dependency outside Cloudflare's platform.

**Trade-offs accepted:**
- (+) Atomic state transitions — check-and-update in a single DO method call
- (+) Escalating cooldowns with `tripCount` tracking
- (+) Durably persisted — survives Worker restarts
- (-) One DO instance per TLD — but there are only ~1,500 TLDs, so this is fine
- (-) Extra RPC call per renewal (Workflow → Circuit Breaker DO → back)

## ADR-004: Payment Before Registry (Not After)

**Context:** The renewal pipeline needs to charge the customer and extend the domain at the registry. These two operations can't be atomic.

**Decision:** Charge payment first, then call the registry. If the registry fails, auto-refund.

**Alternatives considered:**
- **Registry first, then payment:** If registry succeeds but payment fails, you've extended a domain the customer can't pay for. Clawing back a domain extension is operationally much harder than processing a refund.
- **Two-phase commit:** Not feasible across an EPP registry and a billing system.

**Trade-offs accepted:**
- (+) Failed registry → automatic refund is a clean, well-understood recovery path
- (+) Dead-letter table captures these cases for manual investigation
- (-) Brief window where customer's balance is reduced but domain isn't yet renewed
- (-) Refund processing adds complexity

## ADR-005: Workers AI for the Ops Agent (Not External LLM)

**Context:** The system needed a conversational interface for ops. Options were an external LLM API (OpenAI, Anthropic) or Cloudflare's own Workers AI.

**Decision:** Workers AI running Llama 3.3 70B, accessed via the `AI` binding.

**Alternatives considered:**
- **External LLM API (OpenAI/Anthropic):** Higher capability models, but adds external dependency, API keys, egress costs, and latency.
- **No agent, traditional dashboard:** Simpler, but doesn't demonstrate the AI integration capability the role calls for.

**Trade-offs accepted:**
- (+) Zero-config — `AI` binding is a first-class Cloudflare primitive, no API keys needed
- (+) Low latency — inference runs on Cloudflare's GPU fleet, same network as the Worker
- (+) Demonstrates platform dogfooding — using Cloudflare's AI to manage Cloudflare infrastructure
- (-) Llama 3.3 strips numeric digits from generated text — required moving all data formatting to tool results and building a custom renderer
- (-) Smaller context window and less capable than frontier models

## ADR-006: EPP Info Guard Before Renew

**Context:** If a renewal Workflow crashes after the registry renew succeeds but before the local database is updated, the retry would send a duplicate renew to the registry.

**Decision:** Before every `eppRenew()`, call `eppInfo()` to check the current expiry. If the expiry is already extended beyond what we'd set, skip the renew.

**Alternatives considered:**
- **Rely on registry-side idempotency:** Some registries support this, but it's not guaranteed across all TLDs, and the behavior varies.
- **Mark the renewal in a separate "in-flight" table before calling the registry:** Would work, but adds another table and the same crash-between-write-and-registry problem.

**Trade-offs accepted:**
- (+) Handles the "unknown state after crash" problem cleanly
- (+) Works regardless of registry-side idempotency support
- (-) Extra EPP call per renewal (info + renew instead of just renew)
- (-) Small race window between info and renew (acceptable given single-writer-per-domain constraint from DO)

## ADR-007: Vercel AI SDK for Streaming

**Context:** The AI agent needs to stream responses to the chat UI, including interleaved tool calls and results.

**Decision:** Use the Vercel AI SDK (`ai` package) with the `workers-ai-provider` adapter.

**Alternatives considered:**
- **Raw SSE streaming:** Full control, but would need to implement the tool-calling loop, streaming protocol, and client-side parsing from scratch.
- **Cloudflare's native AI gateway:** Doesn't support tool-calling orchestration out of the box.

**Trade-offs accepted:**
- (+) Handles the multi-step tool loop automatically (`maxSteps: 5`)
- (+) Well-defined streaming protocol (data stream with typed prefixes)
- (+) Client-side SDK available for parsing (though we use a custom parser for the styled cards)
- (-) Additional dependency
- (-) The data stream format requires understanding prefix codes (`0:` text, `9:` tool call, `a:` tool result)
