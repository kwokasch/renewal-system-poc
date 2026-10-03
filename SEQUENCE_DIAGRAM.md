# Renewal Flow — Sequence Diagrams

## Happy Path: Auto-Renewal via DO Alarm

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
   │           │           │ Step 2: Process payment           │         │
   │           │           │─────────────────────────────────▶ │         │
   │           │           │        deduct balance             │         │
   │           │           │◀───────────────────────────────── │         │
   │           │           │         │            │            │         │
   │           │           │ Step 3a: Check circuit breaker    │         │
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

## Failure Path: Registry Down → Refund → Dead Letter

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
   │         │ Step 3a: Refund payment           │
   │         │──────────────────────────────────▶│
   │         │         │    +$12.99 to balance   │
   │         │         │           │             │
   │         │ Step 3b: Dead-letter record       │
   │         │──────────────────────────────────▶│
   │         │         │   INSERT dead_letter    │
   │         │         │   UPDATE history=failed │
   │         │         │           │             │
   │         │   Return failure    │             │
   │         │  "Payment refunded. Dead-lettered."
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
          5 consecutive                    │
            failures                  test request
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
