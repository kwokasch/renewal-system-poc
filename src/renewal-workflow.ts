/**
 * Renewal Workflow
 *
 * Durable, multi-step renewal execution using Cloudflare Workflows.
 *
 * Each step.do() is independently retryable and idempotent.
 * If the Worker crashes mid-workflow, execution resumes from the
 * last completed step — not from the beginning.
 *
 * Protective measures:
 *   - Idempotency guard in step 1 (DB-level dedup)
 *   - EPP info check before renew (handles "unknown state" after timeout)
 *   - Refund on permanent registry failure (payment succeeded but renew didn't)
 *   - Dead-letter recording for manual investigation
 *
 * Step sequence:
 *   1. Check domain eligibility + idempotency guard
 *   2. Process payment (charge account balance)
 *   3. Registry renew (EPP info guard → EPP renew, with retry + backoff)
 *   4. Update local records (D1 + Durable Object)
 *   5. Send confirmation notification
 *
 *   On permanent registry failure after payment:
 *   3a. Refund payment
 *   3b. Record to dead-letter table for manual investigation
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env, DomainRecord, AccountRecord, RenewalResult } from "./types";
import { eppRenew, eppInfo } from "./registry-simulator";

interface RenewalParams {
  domainName: string;
  action: string;
  triggerSource: string;
  idempotencyKey: string;
}

export class RenewalWorkflow extends WorkflowEntrypoint<Env, RenewalParams> {
  async run(event: WorkflowEvent<RenewalParams>, step: WorkflowStep): Promise<RenewalResult> {
    const { domainName, action, triggerSource, idempotencyKey } = event.payload;

    // ── Step 1: Check eligibility + idempotency guard ──────────────
    const domainInfo = await step.do("check-eligibility", async () => {
      // Idempotency check: has this exact renewal already been processed?
      const existing = await this.env.DB.prepare(
        "SELECT status FROM renewal_history WHERE idempotency_key = ?1"
      ).bind(idempotencyKey).first<{ status: string }>();

      if (existing?.status === "success") {
        return { skip: true, reason: "Already renewed for this period" } as const;
      }

      // Fetch current domain state
      const domain = await this.env.DB.prepare(
        "SELECT * FROM domains WHERE domain_name = ?1"
      ).bind(domainName).first<DomainRecord>();

      if (!domain) {
        return { skip: true, reason: `Domain ${domainName} not found` } as const;
      }
      if (domain.status !== "active") {
        return { skip: true, reason: `Domain ${domainName} status: ${domain.status}` } as const;
      }

      // Insert audit record as "processing"
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO renewal_history (domain_name, account_id, action, trigger_source, status, idempotency_key)
         VALUES (?1, ?2, ?3, ?4, 'processing', ?5)`
      ).bind(domainName, domain.account_id, action, triggerSource, idempotencyKey).run();

      return { skip: false, domain } as const;
    });

    if (domainInfo.skip) {
      console.log(`[Workflow] Skipping ${domainName}: ${domainInfo.reason}`);
      return { success: false, domain: domainName, error: domainInfo.reason };
    }

    const domain = domainInfo.domain;

    // ── Step 2: Process payment ────────────────────────────────────
    const paymentResult = await step.do(
      "process-payment",
      {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
      },
      async () => {
        const account = await this.env.DB.prepare(
          "SELECT * FROM accounts WHERE account_id = ?1"
        ).bind(domain.account_id).first<AccountRecord>();

        if (!account) {
          throw new Error(`Account ${domain.account_id} not found`);
        }

        if (account.balance < domain.renewal_price) {
          // Payment failure is a business outcome, not a retry-able error.
          // Record it and stop — don't retry charging an empty account.
          await this.env.DB.prepare(
            `UPDATE renewal_history SET status = 'payment_failed', error_message = ?1, completed_at = ?2
             WHERE idempotency_key = ?3`
          ).bind(
            `Insufficient balance: ${account.balance} < ${domain.renewal_price}`,
            Date.now(),
            idempotencyKey
          ).run();

          return { success: false, reason: "insufficient_balance" } as const;
        }

        // Deduct balance
        await this.env.DB.prepare(
          "UPDATE accounts SET balance = balance - ?1 WHERE account_id = ?2"
        ).bind(domain.renewal_price, domain.account_id).run();

        return {
          success: true,
          charged: domain.renewal_price,
          transactionId: `PAY-${Date.now()}`,
        } as const;
      }
    );

    if (!paymentResult.success) {
      return { success: false, domain: domainName, error: "Payment failed: " + paymentResult.reason };
    }

    // ── Step 3: Registry renew with EPP info guard ─────────────────
    //
    // The "unknown is a real state" pattern:
    // Before sending a renew, check registry state with EPP info.
    // If a previous attempt already renewed (but we crashed before
    // checkpointing), info tells us — we don't send a duplicate renew.
    //
    // Flow:
    //   info → expiry already extended? → skip renew, use existing expiry
    //   info → expiry not extended?     → safe to send renew
    //   info fails?                     → throw, let retry handle it

    let registryResult: { success: boolean; domainName: string; newExpiryDate: number; transactionId: string };

    try {
      registryResult = await step.do(
        "registry-renew",
        {
          retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
        },
        async () => {
          // ── Circuit breaker: fail fast if registry is known to be down ──
          const tld = domainName.split('.').pop() ?? "unknown";
          const breakerId = this.env.REGISTRY_BREAKER.idFromName(tld);
          const breaker = this.env.REGISTRY_BREAKER.get(breakerId);
          const circuitCheck = await breaker.checkRegistry();

          if (!circuitCheck.allowed) {
            throw new Error(`Circuit breaker OPEN for .${tld} registry (status: ${circuitCheck.status}). Retry after ${Math.round((circuitCheck.retryAfterMs ?? 0) / 1000)}s`);
          }

          // ── EPP Info guard: check current state before renewing ──
          console.log(`[Workflow] Checking registry state for ${domainName} before renew...`);
          const currentState = await eppInfo(domainName);

          if (!currentState.exists) {
            await breaker.reportFailure(`Domain ${domainName} not found at registry`);
            throw new Error(`Domain ${domainName} not found at registry`);
          }

          // If expiry is already beyond what we'd set, a previous attempt succeeded
          // Don't renew again — just use the existing expiry
          const expectedMinExpiry = domain.expires_at;
          if (currentState.expiryDate && currentState.expiryDate > expectedMinExpiry + 180 * 24 * 60 * 60 * 1000) {
            console.log(`[Workflow] Registry shows ${domainName} already renewed (expiry: ${new Date(currentState.expiryDate).toISOString()}). Skipping duplicate renew.`);
            return {
              success: true,
              domainName,
              newExpiryDate: currentState.expiryDate,
              transactionId: `DEDUP-${Date.now()}`,
            };
          }

          // ── Safe to renew ──
          console.log(`[Workflow] Registry confirms ${domainName} needs renewal. Sending EPP renew...`);
          const result = await eppRenew(domainName, 1);

          if (!result.success) {
            await breaker.reportFailure(`EPP renew failed: ${result.errorCode} - ${result.errorMessage}`);
            throw new Error(`EPP renew failed: ${result.errorCode} - ${result.errorMessage}`);
          }

          // Registry call succeeded — report to circuit breaker
          await breaker.reportSuccess();
          return result;
        }
      );
    } catch (err) {
      // ── Registry failed permanently after all retries ──────────
      // Payment was already taken. We must:
      //   1. Refund the payment
      //   2. Record to dead-letter for manual investigation
      //   3. Return failure

      await step.do("refund-payment", async () => {
        console.log(`[Workflow] Registry renew failed permanently for ${domainName}. Refunding $${domain.renewal_price}...`);
        await this.env.DB.prepare(
          "UPDATE accounts SET balance = balance + ?1 WHERE account_id = ?2"
        ).bind(domain.renewal_price, domain.account_id).run();
        console.log(`[Workflow] Refund complete for account ${domain.account_id}`);
      });

      await step.do("dead-letter-record", async () => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[Workflow] DEAD LETTER: ${domainName} — ${errorMessage}`);

        await this.env.DB.batch([
          // Update audit trail
          this.env.DB.prepare(
            `UPDATE renewal_history
             SET status = 'failed', error_message = ?1, completed_at = ?2
             WHERE idempotency_key = ?3`
          ).bind(errorMessage, Date.now(), idempotencyKey),

          // Insert dead-letter record for manual investigation
          this.env.DB.prepare(
            `INSERT INTO dead_letter_renewals (domain_name, account_id, idempotency_key, error_message, payment_refunded, requires_action)
             VALUES (?1, ?2, ?3, ?4, 1, 1)`
          ).bind(domainName, domain.account_id, idempotencyKey, errorMessage),
        ]);
      });

      return {
        success: false,
        domain: domainName,
        error: `Registry renew failed after retries. Payment refunded. Dead-lettered for investigation.`,
      };
    }

    // ── Step 4: Update local records ───────────────────────────────
    await step.do("update-records", async () => {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE domains SET expires_at = ?1, updated_at = ?2 WHERE domain_name = ?3`
        ).bind(registryResult.newExpiryDate, Date.now(), domainName),

        this.env.DB.prepare(
          `UPDATE renewal_history
           SET status = 'success', amount_charged = ?1, registry_response = ?2, completed_at = ?3
           WHERE idempotency_key = ?4`
        ).bind(
          domain.renewal_price,
          JSON.stringify(registryResult),
          Date.now(),
          idempotencyKey
        ),
      ]);

      // Update the Durable Object so its alarm reschedules
      const doId = this.env.DOMAIN_RENEWAL.idFromName(domainName);
      const doStub = this.env.DOMAIN_RENEWAL.get(doId);
      await doStub.renewalCompleted(registryResult.newExpiryDate);
    });

    // ── Step 5: Send confirmation ──────────────────────────────────
    await step.do("send-confirmation", async () => {
      console.log(
        `[Workflow] ✅ Renewal confirmed: ${domainName} → ${new Date(registryResult.newExpiryDate).toISOString()}`
      );
      console.log(
        `[Workflow] Charged $${domain.renewal_price} to account ${domain.account_id}`
      );
      console.log(
        `[Workflow] Registry transaction: ${registryResult.transactionId}`
      );
    });

    return {
      success: true,
      domain: domainName,
      newExpiry: registryResult.newExpiryDate,
    };
  }
}
