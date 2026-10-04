# Testing the Domain Renewal POC

A hands-on guide for exploring the live system. Everything below runs against the deployed Worker, with no setup required beyond `curl`.

```bash
BASE=https://renewal-system-poc.katie-wokasch.workers.dev
```

## Before you start

- **State is shared and persistent.** Renewals charge a (fake) account balance and extend expiry dates. Anything you do is visible to the next person.
- **The circuit breaker is shared per TLD.** Tripping the `.com` breaker slows renewals for every `.com` domain. For outage tests, use a less busy TLD (`.dev` or `.io`) and reset the breaker afterwards (see [Reset](#reset)).
- **Renewals are asynchronous.** A renew request returns immediately; the queue batches for up to ~30 seconds before the workflow starts. Allow about a minute before checking results.
- **The registry is simulated.** There is no real EPP registry. Failure modes are triggered by markers in the domain name (see [Failure-path scenarios](#failure-path-scenarios)).

## 1. Five-minute tour (chat UI)

Open the live URL and try the suggested prompts, or type your own:

| Prompt | What it exercises |
|---|---|
| "Show my domains" | D1 query; expiry urgency badges (EXPIRED / TODAY / CRITICAL / URGENT / OK) |
| "What's expiring soon?" | Same data, filtered by the model |
| "Tell me about urgent-renew.io" | D1 plus Durable Object state (alarm schedule, attempt count) |
| "Check circuit breaker for .com" | Reads the per-TLD breaker Durable Object |
| "Any dead-letter items?" | Renewals that failed after payment and need follow-up |
| "Show renewal history for example.com" | Audit trail in D1 |

Note: the chat model (Llama 3.3 on Workers AI) sometimes mangles numeric tool arguments, so for anything involving dates or IDs, prefer the REST calls below. Structured results are rendered by the UI directly from the tool output, not from the model's text.

## 2. Seeded domains

| Domain | Account | What it demonstrates |
|---|---|---|
| `example.com` | `acct_001` | Healthy domain far from expiry |
| `test-renewal.com` | `acct_001` | Healthy baseline |
| `urgent-renew.io` | `acct_001` | Expiring within days |
| `plenty-of-time.dev` | `acct_002` | Expiring in roughly a month |
| `manual-only.com` | `acct_002` | Auto-renew OFF and expired: only a manual renewal works |
| `cant-afford.net` | `acct_003` | Balance ($5) below the renewal price: payment step fails gracefully |

Seed dates were set at a fixed point in time, so some have since passed. That is expected: they remain useful scenarios.

Try it:

```bash
curl -X POST $BASE/domains/cant-afford.net/renew      # queue a renewal that will fail on payment
sleep 45
curl $BASE/history/cant-afford.net                    # expect status "payment_failed"
```

## 3. Register your own domain

Registering creates a D1 record and a per-domain Durable Object that sets its own renewal alarm 7 days before expiry.

```bash
# expiresAt is epoch milliseconds; this is 30 days from now
EXP=$(( ($(date +%s) + 30*86400) * 1000 ))

curl -X POST $BASE/domains -H "Content-Type: application/json" \
  -d "{\"domainName\":\"my-demo.dev\",\"accountId\":\"acct_001\",\"expiresAt\":$EXP}"

curl $BASE/domains/my-demo.dev      # D1 record plus Durable Object state (nextAlarm, renewalAttempts)
```

### Happy path

```bash
curl -X POST $BASE/domains/my-demo.dev/renew
sleep 45
curl $BASE/history/my-demo.dev      # expect "success"; amount charged = renewal price
curl $BASE/domains/my-demo.dev      # expiry extended by one year; DO alarm rescheduled
```

### Simulate the alarm (the primary trigger)

```bash
curl -X POST $BASE/simulate/alarm/my-demo.dev
```

This fires the Durable Object's alarm handler, which enqueues an `auto_renew` message exactly as the real alarm would. It only works for domains registered through `POST /domains`, because that call initialises the Durable Object. The seeded domains were inserted directly into D1 and may have no alarm state.

## Failure-path scenarios

The simulator reacts to substrings in the domain name. Register a domain containing the marker, then renew it.

| Name contains | Simulated registry response | What to expect |
|---|---|---|
| `registry-error` | EPP 2304 (status prohibits operation) | Domain-level rejection: refund and dead-letter entry for that domain; **circuit breaker stays CLOSED**; no pointless retries |
| `registry-down` | EPP 2400 (command failed) | Infrastructure failure: retried with backoff; **trips the circuit breaker** after 3 failures within 5 minutes |
| `registry-auth` | EPP 2501 (authentication error) | **Opens the breaker immediately**; no retries |
| `already-renewed` | Registry already shows an extended expiry | EPP info guard skips the duplicate renew call (look for a `DEDUP-` transaction id in the workflow logs) |

### Trip the circuit breaker

Use a quiet TLD so you don't affect `.com` renewals.

```bash
EXP=$(( ($(date +%s) + 30*86400) * 1000 ))
curl -X POST $BASE/domains -H "Content-Type: application/json" \
  -d "{\"domainName\":\"registry-down-demo.dev\",\"accountId\":\"acct_001\",\"expiresAt\":$EXP}"

# Send several renewals at once so the failures land close together
for i in 1 2 3 4 5 6; do curl -s -X POST $BASE/domains/registry-down-demo.dev/renew & done; wait

# Watch the breaker (allow 1 to 4 minutes: failed registry calls retry after 30s, 60s, then 120s)
curl $BASE/circuit/dev
```

You should see `failCount` climb and then `"status":"OPEN"`. While it is open, other renewals for `.dev` are held back before payment (see the workflow steps below). After the cooldown (1 minute, doubling on each failed test request, up to 30 minutes) the breaker moves to HALF_OPEN and lets a single test request through. If that succeeds it closes; if it fails it re-opens with a longer cooldown.

### Reset

```bash
curl -X POST $BASE/circuit/dev/reset
```

## 4. Watching what happens

**Workflow steps.** Cloudflare dashboard → Workflows → `renewal-workflow`. Open an instance to see each step and its timing. In a held-back renewal you will see `check-circuit-breaker-0` followed by a `wait-for-circuit-0` sleep with no `process-payment` step until it wakes.

**Live logs.**

```bash
npx wrangler tail
```

Look for `[Queue]`, `[Workflow]`, and `[CircuitBreaker]` lines.

**Database.**

```bash
npx wrangler d1 execute renewal-db --remote --command \
  "SELECT domain_name, status, error_message FROM renewal_history ORDER BY created_at DESC LIMIT 10"
```

## 5. What to look for

- **Idempotency.** Each renewal carries an idempotency key; duplicate triggers don't double-charge.
- **Money safety.** Payment is taken before the registry call. If the registry then fails permanently, the customer is automatically refunded and a dead-letter record is written.
- **Failure classification.** Registry outages (2400/2500/2502) trip the shared breaker; one domain's rejection (2304) does not.
- **A workflow's "Complete" status is not the same as a successful renewal.** A workflow that handles a failure (refund and dead-letter) still ends as Complete. Check `renewal_history.status` for the business outcome.

## 6. Known limitations

These are documented deliberately; see [DECISIONS.md](./DECISIONS.md) (ADR-008, ADR-009) for the reasoning.

- **Recovery edge.** When a breaker's cooldown ends, every waiting renewal wakes at once and passes the pre-flight check. Only one gets the real test request, so the others can still be charged, retry, and be refunded. The fix would be letting a single renewal claim the test slot first.
- **Dead-letter noise.** Renewals that failed only because of an outage (and were refunded) are still flagged as needing action. A production version would separate "retry later" from "needs a human".
- **First failures still charge.** The breaker only knows about failures that have already been reported, so the first few renewals into an outage are charged and then refunded.
- **Simulated registry and payments.** Balances are rows in D1; the registry is a local simulator.
- **LLM limitation.** Llama 3.3 on Workers AI can drop digits from its generated text, so the UI renders data from tool results directly.
