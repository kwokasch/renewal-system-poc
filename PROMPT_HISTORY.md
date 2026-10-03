# AI Prompt Engineering History

How I used AI tools (Claude, Gemini) to design and build this domain renewal system POC — and what that process reveals about how I'd lead engineering teams using AI-assisted development.

## 1. System Architecture Design

### Prompt: "Design a domain renewal system on Cloudflare Workers"

**What I asked:** I needed a proof-of-concept that demonstrated distributed systems patterns relevant to domain registrar infrastructure — specifically the kind of thing Cloudflare Registrar deals with: millions of domains, each with independent renewal lifecycles, where missed renewals have real business impact.

**What AI helped with:**
- Mapped the problem to Cloudflare primitives: Durable Objects for per-domain state machines, Workflows for durable multi-step execution, Queues for decoupling triggers from processing, D1 for the persistence layer
- Identified the "defense in depth" trigger pattern: DO alarms as primary + cron sweep as backup + manual API as escape hatch — all funneling into the same queue and workflow
- Surfaced the circuit breaker pattern early: registries go down, and without a breaker you get thundering-herd retries across thousands of domains hitting the same dead endpoint

**What I brought:**
- Domain industry knowledge from my experience at Name.com — real renewal timing patterns (7-day window → daily retries → day-of), the EPP protocol flow, why payment-before-registry is the right order (refund is cheaper than a double-renew)
- The insight that Durable Objects are a natural fit for per-domain scheduling — each domain is an independent state machine, which maps 1:1 to the DO model. This eliminates the central batch job / thundering herd problem that traditional cron-based systems have
- Operational requirements: idempotency keys, dead-letter queues for the payment-charged-but-registry-failed case, audit trails on every attempt

**Key architectural decisions that emerged:**
1. DO alarms over cron-only → independent scheduling, no coordination overhead
2. Queue between triggers and Workflow → decouples trigger rate from processing capacity
3. Circuit breaker as a DO (not KV) → needs atomic state transitions, KV is eventually consistent
4. EPP info guard before renew → handles the "unknown state after crash" problem

### Prompt: "Build a simulated EPP registry with realistic failure modes"

**What I asked:** The POC can't call a real registry, but it needs to demonstrate the failure handling patterns that matter in production. I needed a simulator that makes the Workflow's retry logic actually exercise.

**What AI helped with:**
- Generated the `registry-simulator.ts` with configurable failure rates, timeout simulation, and the two EPP operations (info + renew)
- Structured the simulator to return realistic EPP-style responses (success codes, error codes, transaction IDs)

**What I brought:**
- The specific failure modes that matter: timeouts (most common), auth failures (non-retryable), rate limiting, and the critical "renew succeeded but we crashed before recording it" case
- The EPP info-before-renew pattern that catches duplicate renewals — this is a real production technique, not something you'd think of from first principles

## 2. Durable Execution & Error Handling

### Prompt: "Implement the renewal workflow with proper step isolation"

**What I asked:** Each step in the renewal pipeline needs to be independently retryable. If the registry call fails after payment succeeds, we can't re-charge the customer on retry.

**What AI helped with:**
- Scaffolded the 5-step Workflow using `step.do()` for each phase, with correct retry configuration (exponential backoff, different limits per step)
- Implemented the dead-letter pattern: when registry fails permanently after payment, auto-refund + record for manual investigation

**What I brought:**
- The step ordering constraint: eligibility → payment → registry → records → confirmation. This ordering is deliberate — payment before registry means we might need to refund, but registry before payment means we might extend a domain the customer can't pay for (which is worse from a business perspective)
- The idempotency key design: `renew_{domain}_{expiresAt}` scopes dedup to the renewal period, so the same domain can renew in different years without collision
- The "unknown is a real state" principle for the EPP info guard — after a timeout, you don't know if the renew succeeded. Check before retrying.

### Prompt: "Add a circuit breaker for registry calls"

**What I asked:** When a TLD registry (.com, .net) goes down, hundreds of renewal workflows will be retrying simultaneously. I needed a per-TLD circuit breaker to fail-fast.

**What AI helped with:**
- Implemented the CLOSED → OPEN → HALF_OPEN → CLOSED state machine as a Durable Object
- Added escalating cooldowns with `tripCount` tracking (1min → 2min → 4min → ... → 30min max)

**What I brought:**
- The decision to use a Durable Object instead of KV — circuit breaker state transitions need to be atomic (check-and-update in one operation). KV's eventual consistency means two workflows could both read "CLOSED" and both trip the breaker, or worse, both try to transition HALF_OPEN → CLOSED simultaneously
- The failure window concept: reset the fail counter if no failures occur for 1 minute, so transient blips don't accumulate toward the threshold

## 3. AI Agent & Ops Interface

### Prompt: "Build a conversational agent that can query and act on the renewal infrastructure"

**What I asked:** Instead of building a traditional dashboard, I wanted to demonstrate how Workers AI could provide a natural-language ops interface — an agent that understands the domain model and can query D1, inspect Durable Object state, and trigger renewals through the existing pipeline.

**What AI helped with:**
- Set up the Vercel AI SDK integration with Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)
- Defined 8 tools mapping to infrastructure: `listDomains`, `getDomainDetails`, `renewDomain`, `getRenewalHistory`, `getCircuitBreakerStatus`, `resetCircuitBreaker`, `getDeadLetterItems`, `registerDomain`
- Built the streaming chat UI with server-sent events and tool result rendering

**What I brought:**
- Tool design philosophy: each tool maps directly to an existing backend capability (D1 query, DO RPC, Queue send). The agent doesn't have its own data access layer — it uses the same infrastructure the API endpoints use
- The system prompt engineering: urgency classification (EXPIRED/TODAY/CRITICAL/URGENT/OK), pipeline explanation for renewals, circuit breaker state semantics
- The insight that the chat UI should render tool results as styled cards, not dump raw JSON — this makes the agent feel like an ops dashboard that you talk to

### Prompt: "Fix the LLM stripping numbers from tool results"

**What I asked:** Workers AI (Llama 3.3) has a known issue where it strips numeric digits from generated text. Dates like "2026-10-03" become "---" and prices like "$12.99" become "$.".

**What I brought (no AI needed for the fix):**
- Moved all formatting to the tool results themselves, so the LLM just passes through pre-formatted data
- Built the HTML renderer to parse tool call/result events from the Vercel AI SDK data stream and render structured cards directly — bypassing the LLM's text generation for anything with numbers
- This is a good example of working with model limitations rather than fighting them: the LLM handles natural language (which it's good at), and the UI handles data display (which it's good at)

## 4. Debugging & Iteration

### Prompt: "Days-left calculation is off by one"

**What went wrong:** The original `daysUntil()` used raw timestamp arithmetic, which gave fractional days. `Math.floor(-1.1)` = -2, causing "2 days expired" to show for a domain that expired yesterday.

**The fix:** Normalize both dates to UTC midnight using `Date.UTC()` before computing the difference, then use `Math.round()` instead of `Math.floor()`. This gives clean calendar-day differences regardless of the time of day.

**Lesson:** Date math in distributed systems is always harder than it looks. UTC normalization at the boundaries is the only safe pattern.

### Prompt: "Circuit breaker showing UNKNOWN instead of CLOSED"

**What went wrong:** The Durable Object's `getState()` returns `{ status: "CLOSED" }`, but the renderer was checking `result.state` (wrong field name). Similarly, `failCount` vs `failureCount`.

**The fix:** Updated the renderer to check `result.status || result.state` with a fallback chain. This kind of defensive field access is standard practice when multiple components evolve independently.

## 5. How This Informs My Leadership Approach

### AI-Assisted Development in Practice
This POC demonstrates the workflow I'd encourage on engineering teams: use AI for scaffolding and acceleration, but bring domain expertise for the decisions that matter — system boundaries, failure modes, data consistency guarantees, and operational patterns.

### What AI Was Good At
- Boilerplate and scaffolding (Workflow step structure, DO lifecycle methods)
- SDK integration patterns (Vercel AI SDK, Workers AI provider)
- Generating test data and SQL schemas
- Catching typos and suggesting defensive patterns

### What Required Human Judgment
- Architectural decisions (DO vs KV for circuit breaker, payment-before-registry ordering)
- Domain expertise (EPP protocol patterns, renewal timing windows, idempotency key design)
- Failure mode analysis (what happens when payment succeeds but registry fails?)
- Operational concerns (dead-letter queues, audit trails, circuit breaker thresholds)
- Debugging subtle issues (UTC date normalization, field name mismatches across boundaries)

### For Engineering Teams I'd Lead
I'd set the expectation that AI tools accelerate the 80% of work that's well-understood, and engineers focus their expertise on the 20% that determines whether the system works in production. Code review should focus on that 20%: the parts where AI might generate something that looks right but has subtle correctness issues (like the `Math.floor` on negative fractions bug).
