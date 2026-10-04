# Domain Renewal System POC

A proof-of-concept domain auto-renewal system built on **Cloudflare Workers**, **Durable Objects**, **Workflows**, **Queues**, **D1**, and **Workers AI**, demonstrating distributed systems patterns critical to registrar infrastructure.

**[Live Demo →](https://renewal-system-poc.katie-wokasch.workers.dev)**

New here? **[TESTING.md](./TESTING.md)** walks through trying the system, including how to trigger each failure path.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TRIGGER LAYER                                │
│                                                                     │
│  ┌──────────────────────┐       ┌──────────────────────────────┐    │
│  │  Durable Object (DO) │       │  Cron Trigger (Daily 6am)    │    │
│  │  Per-Domain Alarm    │       │  Reconciliation Sweep        │    │
│  │  ═══════════════     │       │  ════════════════════        │    │
│  │  PRIMARY trigger     │       │  BACKUP — catches anything   │    │
│  │  Independent per     │       │  DOs missed. Scans D1 for    │    │
│  │  domain. No central  │       │  domains expiring within     │    │
│  │  coordination.       │       │  7 days without a recent     │    │
│  │                      │       │  successful renewal.         │    │
│  │  Sets alarm 7 days   │       │                              │    │
│  │  before expiry.      │       │                              │    │
│  │  Retries daily.      │       │                              │    │
│  └──────────┬───────────┘       └──────────────┬───────────────┘    │
│             │                                  │                    │
│             ▼                                  ▼                    │
│  ┌──────────────────────┐       ┌──────────────────────────────┐    │
│  │  Manual API Request  │       │                              │    │
│  │  POST /domains/      │───────▶      RENEWAL QUEUE           │    │
│  │    :name/renew       │       │                              │    │
│  └──────────────────────┘       │  At-least-once delivery.     │    │
│             ▲                   │  Batches of 10.              │    │
│  ┌──────────┴───────────┐       │  Failed messages retry.      │    │
│  │  AI Chat Agent       │       └───────────────┬──────────────┘    │
│  │  Workers AI (Llama   │                       │                   │
│  │  3.3 70B) + tools    │                       │                   │
│  └──────────────────────┘                       │                   │
└─────────────────────────────────────────────────┼───────────────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     RENEWAL WORKFLOW                                │
│                     (Durable Execution)                             │
│                                                                     │
│    ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐    │
│    │   Step 1  │   │  Step 1b  │   │   Step 2  │   │   Step 3  │    │
│    │   Check   │   │  Breaker  │   │  Process  │   │  Registry │    │
│    │Eligibility│   │ Pre-flight│   │  Payment  │   │Renew (EPP)│    │
│    │           │   │           │   │           │   │           │    │
│    │• Idemp.   │   │• Read-only│   │• Charge   │   │• Breaker  │    │
│    │  guard    │──▶│  peek     │──▶│  balance  │──▶│  probe    │    │
│    │• Domain   │   │• Sleep if │   │• Retry ×3 │   │• EPP info │    │
│    │  status   │   │  OPEN     │   │• Fail on  │   │  guard    │    │
│    │• Audit    │   │• Not      │   │  insuff.  │   │• Classify │    │
│    │  record   │   │  charged  │   │  balance  │   │  errors   │    │
│    └───────────┘   └───────────┘   └───────────┘   └───────────┘    │
│                                                                     │
│    (Step 3 success continues to Step 4)                             │
│                                                                     │
│    ┌───────────┐   ┌───────────┐   ┌─────────────────────────────┐  │
│    │   Step 4  │   │   Step 5  │   │ Dead Letter (on failure)    │  │
│    │   Update  │──▶│    Send   │   │                             │  │
│    │  Records  │   │  Confirm  │   │ Registry failed after       │  │
│    │           │   └───────────┘   │ payment was taken:          │  │
│    │• D1 batch │                   │ • Refund payment            │  │
│    │• Update   │                   │ • Record for follow-up      │  │
│    │  DO alarm │                   │ • Skips Steps 4 and 5       │  │
│    └───────────┘                   └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        DATA LAYER                                   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  D1 (Serverless SQLite)                                      │   │
│  │                                                              │   │
│  │  domains           accounts          renewal_history         │   │
│  │  ─────────         ─────────         ─────────────────       │   │
│  │  domain_name (PK)  account_id (PK)   id (PK)                 │   │
│  │  account_id        email             domain_name             │   │
│  │  status            balance           idempotency_key (UQ)    │   │
│  │  expires_at                          action                  │   │
│  │  auto_renew                          trigger_source          │   │
│  │  renewal_price                       status                  │   │
│  │                                      amount_charged          │   │
│  │                                      registry_response       │   │
│  │                                                              │   │
│  │  dead_letter_renewals                                        │   │
│  │  ────────────────────                                        │   │
│  │  id (PK)                                                     │   │
│  │  domain_name                                                 │   │
│  │  account_id                                                  │   │
│  │  error_message                                               │   │
│  │  payment_refunded                                            │   │
│  │  requires_action                                             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Durable Objects                                             │   │
│  │                                                              │   │
│  │  DomainRenewal (per-domain)     RegistryCircuitBreaker       │   │
│  │  ──────────────────────         ─────────────────────        │   │
│  │  Alarm-based scheduling         Per-TLD circuit breaker      │   │
│  │  Renewal attempt tracking       States: CLOSED → OPEN →      │   │
│  │  Domain lifecycle state           HALF_OPEN → CLOSED         │   │
│  │                                 Prevents thundering herd     │   │
│  │                                 Opens: 3 failures/5 min      │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## AI Chat Agent

The system includes a conversational AI agent powered by **Workers AI (Llama 3.3 70B)** and the **Vercel AI SDK**. 

    Why Vercel AI SDK? It handles the multi-step tool-calling loop and streaming protocol that would otherwise require building a custom state machine, letting the agent chain up to 5 tool calls per turn while streaming results to the UI, all without leaving Cloudflare's network via the workers-ai-provider binding.

The agent provides a natural-language interface to the entire domain infrastructure:

| Tool | Backend | Purpose |
|---|---|---|
| `listDomains` | D1 query | Overview of all domains with expiry urgency |
| `getDomainDetails` | D1 + Durable Object | Deep-dive into a specific domain's state |
| `renewDomain` | Queue → Workflow | Trigger manual renewal through the pipeline |
| `getRenewalHistory` | D1 query | Audit trail of past renewal attempts |
| `getCircuitBreakerStatus` | Circuit Breaker DO | Check TLD registry health |
| `resetCircuitBreaker` | Circuit Breaker DO | Manually reset a tripped breaker |
| `getDeadLetterItems` | D1 dead_letter table | Find renewals needing manual investigation |
| `registerDomain` | D1 + Durable Object | Register a new domain in the system |

The chat UI renders tool results as styled cards with urgency badges, status indicators, and formatted tables — providing an ops dashboard experience through conversation.

## Design Principles

| Principle | How It's Applied |
|---|---|
| **Idempotency** | Every renewal carries a key (`renew_{domain}_{expiresAt}`). Duplicate triggers are caught at the Workflow ID level and the DB idempotency guard. |
| **Durable execution** | Workflow steps are independently retryable. A payment that succeeds is never re-executed, even if the registry call after it fails. |
| **Independent scheduling** | Each domain's Durable Object sets its own alarm — no central batch job, no thundering herd, no shared state. |
| **Defense in depth** | Primary trigger (DO alarm) + backup trigger (cron sweep) + manual trigger (API) + AI agent. Same queue, same workflow. |
| **Circuit breaker** | Per-TLD Durable Objects prevent thundering-herd retries when a registry is down. Opens after 3 failures within 5 minutes; CLOSED → OPEN (fail-fast) → HALF_OPEN (test recovery) → CLOSED, with escalating cooldowns (1m, 2m, 4m… capped at 30m). |
| **Breaker pre-flight** | Before taking payment, the workflow reads the breaker's recorded state (read-only; it never contacts the registry). If open, it sleeps durably instead of charging the customer and refunding later. |
| **EPP error classification** | Failures are classified by result code: infrastructure (2400/2500/2502) trips the breaker and retries, auth (2501) opens it immediately and alerts, domain-level errors (22xx/23xx) fail only that renewal and never trip the shared breaker. |
| **Dead-letter queue** | Renewals where payment succeeded but registry failed are captured with automatic refund, flagged for manual investigation. |
| **Audit trail** | Every attempt is recorded in `renewal_history` with trigger source, outcome, and registry response. |
| **Graceful failure** | Payment failures are business outcomes (don't retry). Registry timeouts retry with exponential backoff. Queue failures retry with per-message ack/nack. |

## Getting Started

```bash
# Install dependencies
npm install

# Initialize local D1 database
npm run db:init

# Seed test data (domains at various lifecycle stages)
npm run db:seed

# Start local dev server
npm run dev
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/domains` | Register a new domain (creates DO + DB record) |
| `GET` | `/domains` | List all domains with expiry info |
| `GET` | `/domains/:name` | Domain status + Durable Object state |
| `POST` | `/domains/:name/renew` | Manual renewal trigger |
| `GET` | `/history/:name` | Renewal audit history |
| `POST` | `/simulate/alarm/:name` | Force-fire a DO alarm (testing) |
| `POST` | `/api/chat` | AI agent chat endpoint (streaming) |

## Test Scenarios (Seed Data)

| Domain | Account | Scenario |
|---|---|---|
| `example.com` | `acct_001` | Healthy, far from expiry, auto-renew on |
| `urgent-renew.io` | `acct_001` | Expires within days — critical window, auto-renew on |
| `plenty-of-time.dev` | `acct_002` | Expires in about a month — urgent but not critical |
| `manual-only.com` | `acct_002` | Auto-renew OFF, expired — only manual renewal works |
| `cant-afford.net` | `acct_003` | Low balance — payment step fails gracefully |
| `test-renewal.com` | `acct_001` | Healthy baseline |

### Failure-path test hooks

The registry simulator reacts to substrings in the domain name, so you can exercise each path from the chat or API:

| Name contains | Simulated registry behavior |
|---|---|
| `registry-down` | EPP 2400 (command failed): trips the circuit breaker |
| `registry-auth` | EPP 2501 (authentication error): opens the breaker immediately, no retries |
| `registry-error` | EPP 2304 (status prohibits operation): fails that domain only, breaker untouched |
| `already-renewed` | Registry already shows an extended expiry: exercises the EPP info guard |

Register the domain first (`POST /domains`), then renew it.

## Project Structure

```
src/
├── index.ts                 # Worker: API + cron + queue consumer
├── agent.ts                 # AI chat agent: Workers AI + tool-calling
├── domain-renewal.ts        # Durable Object: per-domain alarm + state
├── renewal-workflow.ts      # Workflow: 5-step durable renewal execution
├── registry-simulator.ts    # Simulated EPP registry (with failure modes)
├── registry-circuit-breaker.ts  # Circuit breaker DO: per-TLD fail-fast
├── epp-errors.ts            # EPP result-code classification (infra / domain / auth)
├── types.ts                 # Shared TypeScript interfaces
├── schema.sql               # D1 table definitions
└── seed.sql                 # Test data

public/
└── index.html               # Chat UI with streaming + tool result rendering
```

## Deploying to Cloudflare

```bash
# Create the D1 database
wrangler d1 create renewal-db

# Update wrangler.toml with the real database_id from the output above

# Deploy
npm run deploy
```

## Key Technical Decisions

See [DECISIONS.md](./DECISIONS.md) for detailed architectural decision records covering:
- Why Durable Objects over cron-only scheduling
- Why Queues sit between triggers and Workflows
- Circuit breaker as a Durable Object vs. KV
- Workers AI for the ops agent vs. external LLM APIs
- EPP error classification: which failures may trip the shared breaker
- Checking the circuit breaker before taking payment
