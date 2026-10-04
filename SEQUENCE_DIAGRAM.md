# Renewal Flow — Sequence Diagrams

## Happy Path: Auto-Renewal via DO Alarm

The circuit breaker is consulted twice. Step 1b is a read-only peek, so a known outage doesn't cost the customer a charge. Step 3a is the real gate: it is the call that moves an expired OPEN breaker to HALF_OPEN and lets a single probe through to the registry.

```
┌──────┐  ┌──────────┐  ┌─────┐  ┌────────┐   ┌────────┐  ┌─────────┐  ┌────┐
│  DO  │  │  Queue   │  │ WF  │  │Circuit │   │Registry│  │    D1   │  │ DO │
│Alarm │  │          │  │     │  │Breaker │   │  (EPP) │  │         │  │    │
└──┬───┘  └────┬─────┘  └──┬──┘  └───┬────┘   └───┬────┘  └────┬────┘  └─┬──┘
   │           │           │         │            │            │         │
   │  enqueue  │           │         │            │            │         │
   │──────────▶│           │         │            │            │         │
   │           │           │         │            │            │         │
   │  set next │           │         │            │            │         │
   │  alarm    │  dequeue  │         │            │            │         │
   │  (+24h)   │──────────▶│         │            │            │         │
   │           │           │         │            │            │         │
   │           │           │ Step 1: Check eligibility         │         │
   │           │           │─────────────────────────────────▶ │         │
   │           │           │        domain record + idemp check│         │
   │           │           │◀───────────────────────────────── │         │
   │           │           │         │            │            │         │
   │           │           │ Step 1b: Peek breaker (read-only) │         │
   │           │           │────────▶│            │            │         │
   │           │           │ allowed │            │            │         │
   │           │           │◀────────│            │            │         │
   │           │           │         │            │            │         │
   │           │           │ Step 2: Process payment           │         │
   │           │           │─────────────────────────────────▶ │         │
   │           │           │        deduct balance             │         │
   │           │           │◀───────────────────────────────── │         │
   │           │           │         │            │            │         │
   │           │           │ Step 3a: Breaker gate (+probe)    │         │
   │           │           │────────▶│            │            │         │
   │           │           │ allowed │            │            │         │
   │           │           │◀────────│            │            │         │
   │           │           │         │            │            │         │
   │           │           │ Step 3b: EPP info (guard)         │         │
   │           │           │─────────────────────▶│            │         │
   │           │           │  current expiry      │            │         │
   │           │           │◀─────────────────────│            │         │
   │           │           │         │            │            │         │
   │           │           │ Step 3c: EPP renew   │            │         │
   │           │           │─────────────────────▶│            │         │
   │           │           │  new expiry date     │            │         │
   │           │           │◀─────────────────────│            │         │
   │           │           │         │            │            │         │
   │           │           │ report success       │            │         │
   │           │           │────────▶│            │            │         │
   │           │           │         │            │            │         │
   │           │           │ Step 4: Update D1 + DO            │         │
   │           │           │─────────────────────────────────▶ │         │
   │           │           │─────────────────────────────────────────── ▶│
   │           │           │         │            │            │  reset  │
   │           │           │         │            │            │  alarm  │
   │           │           │         │            │            │ (+1yr)  │
   │           │           │ Step 5: Log confirmation          │         │
   │           │           │  Done   │            │            │         │
```

## Failure Path: Registry Fails After Payment → Refund → Dead Letter

The breaker was still CLOSED at the pre-flight (the outage hadn't been reported yet), so payment was taken. This is the case the refund and dead-letter path exists for.

```
┌──────┐  ┌─────┐  ┌────────┐  ┌────────┐   ┌─────────┐
│Queue │  │ WF  │  │Circuit │  │Registry│   │    D1   │
└──┬───┘  └──┬──┘  └───┬────┘  └───┬────┘   └────┬────┘
   │         │         │           │             │
   │dequeue  │         │           │             │
   │────────▶│         │           │             │
   │         │ Step 1: Eligibility ✓             │
   │         │ Step 2: Payment ✓ ($12.99 charged)│
   │         │         │           │             │
   │         │ check   │           │             │
   │         │────────▶│           │             │
   │         │ allowed │           │             │
   │         │◀────────│           │             │
   │         │         │           │             │
   │         │ EPP renew (attempt 1)             │
   │         │────────────────────▶│             │
   │         │         │     TIMEOUT             │
   │         │◀────────────────────│             │
   │         │         │           │             │
   │         │ report failure      │             │
   │         │────────▶│           │             │
   │         │         │           │             │
   │         │ (retry ×2 more, all fail)         │
   │         │         │           │             │
   │         │ ══════ ALL RETRIES EXHAUSTED ════ │
   │         │         │           │             │
   │         │ Then: refund payment              │
   │         │──────────────────────────────────▶│
   │         │         │    +$12.99 to balance   │
   │         │         │           │             │
   │         │ Then: dead-letter record          │
   │         │──────────────────────────────────▶│
   │         │         │   INSERT dead_letter    │
   │         │         │   UPDATE history=failed │
   │         │         │           │             │
   │         │   Return failure    │             │
   │         │  "Payment refunded. Dead-lettered."
```

## Breaker Already OPEN: Wait, Don't Charge

Once failures have opened the breaker, new renewals are held before payment.

```
┌──────┐  ┌─────┐  ┌────────┐  ┌─────────┐
│Queue │  │ WF  │  │Circuit │  │    D1   │
└──┬───┘  └──┬──┘  └───┬────┘  └────┬────┘
   │         │         │            │
   │dequeue  │         │            │
   │────────▶│         │            │
   │         │ Step 1: Eligibility ✓│
   │         │         │            │
   │         │ Step 1b: peek        │
   │         │────────▶│            │
   │         │ OPEN, retry in 89s   │
   │         │◀────────│            │
   │         │                      │
   │         │ step.sleep (durable; free while waiting)
   │         │                      │
   │         │ peek again           │
   │         │────────▶│            │
   │         │ allowed (cooldown over)
   │         │◀────────│            │
   │         │ continue → Step 2: payment → Step 3 (real probe)
   │         │                      │
   │   ─ ─ if still OPEN after 3 waits ─ ─
   │         │ record "customer not charged"
   │         │─────────────────────▶│
   │         │ Return failure; next trigger retries
```

## Circuit Breaker State Transitions

```
                    ┌──────────────────────┐
                    │                      │
              ┌─────▼─────┐          ┌─────┴─────┐
              │  CLOSED   │          │  CLOSED   │
              │ (healthy) │          │ (healthy) │
              └─────┬─────┘          └───────────┘
                    │                      ▲
          3 failures                       │
         within 5 min                 test request
                    │                  succeeds
                    ▼                      │
              ┌───────────┐          ┌─────┴─────┐
              │   OPEN    │──────── ▶│ HALF_OPEN │
              │(fail-fast)│ cooldown │ (testing) │
              └───────────┘ expires  └─────┬─────┘
                    ▲                      │
                    │                 test request
                    │                   fails
                    │                      │
                    └──────────────────────┘
                      (escalated cooldown:
                       1m → 2m → 4m → ... → 30m)
```

## AI Agent Tool Call Flow

```
┌──────┐  ┌────────┐  ┌───────────┐   ┌──────┐  ┌────┐
│ User │  │Chat UI │  │Workers AI │   │ Tool │  │ D1 │
│      │  │        │  │(Llama 3.3)│   │ Exec │  │/DO │
└──┬───┘  └───┬────┘  └─────┬─────┘   └──┬───┘  └─┬──┘
   │          │             │            │        │
   │ "What's  │             │            │        │
   │  expiring│  POST       │            │        │
   │  soon?"  │  /api/chat  │            │        │
   │─────────▶│────────────▶│            │        │
   │          │             │            │        │
   │          │    stream   │            │        │
   │          │◀───0:"Let me│            │        │
   │          │    check"   │            │        │
   │          │             │            │        │
   │          │◀───9:tool_call           │        │
   │          │   listDomains            │        │
   │          │             │            │        │
   │          │             │  execute   │        │
   │          │             │───────────▶│        │
   │          │             │            │ SELECT │
   │          │             │            │───────▶│
   │          │             │            │ rows   │
   │          │             │            │◀───────│
   │          │             │  result    │        │
   │          │             │◀───────────│        │
   │          │             │            │        │
   │          │◀───a:tool_result         │        │
   │          │   [{domain,expiry,...}]  │        │
   │          │             │            │        │
   │          │ render as   │            │        │
   │  styled  │ styled card │            │        │
   │  table   │ (bypass LLM │            │        │
   │◀─────────│  for data)  │            │        │
   │          │             │            │        │
   │          │◀───0:"You have           │        │
   │  summary │  2 domains expiring..."  │        │
   │◀─────────│             │            │        │
```
