/**
 * DomainRenewal Durable Object
 *
 * Each domain gets its own DO instance. The DO holds per-domain state
 * and uses the Alarm API as the PRIMARY renewal trigger.
 *
 * This is the Cloudflare-native approach: instead of a central cron job
 * sweeping a database (the traditional pattern), each domain independently
 * schedules its own renewal. No shared state, no batch coordination,
 * no thundering herd.
 *
 * Interview talking point: "Durable Objects turn a centralized batch problem
 * into independent per-entity state machines."
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, RenewalMessage } from "./types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class DomainRenewal extends DurableObject<Env> {
  /**
   * Initialize a domain's renewal DO.
   * Called once when a domain is registered or imported.
   */
  async initDomain(domainName: string, expiresAt: number, accountId: string): Promise<void> {
    await this.ctx.storage.put({
      domainName,
      expiresAt,
      accountId,
      autoRenew: true,
      status: "active",
      renewalAttempts: 0,
    });

    // Set alarm for 7 days before expiry
    const alarmTime = expiresAt - SEVEN_DAYS_MS;
    const now = Date.now();

    if (alarmTime > now) {
      await this.ctx.storage.setAlarm(alarmTime);
      console.log(`[DO] Alarm set for ${domainName}: ${new Date(alarmTime).toISOString()}`);
    } else if (expiresAt > now) {
      // Already within 7-day window — trigger immediately
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      console.log(`[DO] Immediate alarm for ${domainName}: already in renewal window`);
    }
  }

  /**
   * Alarm handler — fires when the domain enters its renewal window.
   *
   * This is the PRIMARY trigger path. The alarm fires independently
   * per domain, with no central coordination needed.
   */
  async alarm(): Promise<void> {
    const domainName = await this.ctx.storage.get<string>("domainName");
    const autoRenew = await this.ctx.storage.get<boolean>("autoRenew");
    const status = await this.ctx.storage.get<string>("status");
    const expiresAt = await this.ctx.storage.get<number>("expiresAt");
    const attempts = (await this.ctx.storage.get<number>("renewalAttempts")) ?? 0;

    if (!domainName || !expiresAt) {
      console.error("[DO] Alarm fired but missing domain state");
      return;
    }

    if (status !== "active") {
      console.log(`[DO] Skipping ${domainName}: status is ${status}`);
      return;
    }

    if (!autoRenew) {
      console.log(`[DO] Skipping ${domainName}: auto-renew is off`);
      return;
    }

    // Generate idempotency key: domain + expiry period
    // This ensures retries for the same renewal period don't double-charge
    const idempotencyKey = `renew_${domainName}_${expiresAt}`;

    // Enqueue the renewal
    const message: RenewalMessage = {
      domainName,
      action: "auto_renew",
      triggerSource: "do_alarm",
      idempotencyKey,
    };

    try {
      await this.env.RENEWAL_QUEUE.send(message);
      await this.ctx.storage.put("renewalAttempts", attempts + 1);
      console.log(`[DO] Enqueued renewal for ${domainName} (attempt ${attempts + 1})`);

      // Schedule a follow-up alarm in 24h to retry if renewal didn't complete
      // This creates the multi-day retry window (i.e. 7d → 1d → day-of)
      const nextCheck = Date.now() + ONE_DAY_MS;
      if (nextCheck < expiresAt) {
        await this.ctx.storage.setAlarm(nextCheck);
        console.log(`[DO] Follow-up alarm set for ${domainName}: ${new Date(nextCheck).toISOString()}`);
      }
    } catch (err) {
      console.error(`[DO] Failed to enqueue ${domainName}: ${err}`);
      // Retry in 1 hour on queue failure
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    }
  }

  /**
   * Called after successful renewal to update state and reschedule.
   */
  async renewalCompleted(newExpiresAt: number): Promise<void> {
    const domainName = await this.ctx.storage.get<string>("domainName");
    await this.ctx.storage.put({
      expiresAt: newExpiresAt,
      renewalAttempts: 0,
      status: "active",
    });

    // Schedule next renewal alarm
    const nextAlarm = newExpiresAt - SEVEN_DAYS_MS;
    await this.ctx.storage.setAlarm(nextAlarm);
    console.log(`[DO] Renewal complete for ${domainName}, next alarm: ${new Date(nextAlarm).toISOString()}`);
  }

  /**
   * Toggle auto-renew (called from API).
   */
  async setAutoRenew(enabled: boolean): Promise<void> {
    await this.ctx.storage.put("autoRenew", enabled);
    const domainName = await this.ctx.storage.get<string>("domainName");
    console.log(`[DO] Auto-renew ${enabled ? "enabled" : "disabled"} for ${domainName}`);
  }

  /**
   * Simulate an alarm firing (for testing via API).
   * Cannot call alarm() directly over RPC — it's reserved.
   */
  async simulateAlarm(): Promise<void> {
    await this.alarm();
  }

  /**
   * Get current DO state (for debugging / API).
   */
  async getState(): Promise<Record<string, unknown>> {
    const entries = await this.ctx.storage.list();
    const state: Record<string, unknown> = {};
    entries.forEach((value, key) => {
      state[key] = value;
    });
    // Add alarm info
    const alarm = await this.ctx.storage.getAlarm();
    state.nextAlarm = alarm ? new Date(alarm).toISOString() : null;
    return state;
  }
}
