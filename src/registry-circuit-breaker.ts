/**
 * Registry Circuit Breaker — Durable Object
 *
 * One instance per TLD (e.g., "com", "net", "org").
 * Prevents thundering-herd retries when a registry is down.
 *
 * State machine:
 *   CLOSED    → healthy, all requests pass through
 *   OPEN      → registry is down, all requests fail-fast without calling EPP
 *   HALF_OPEN → cooldown expired, one test request allowed through
 *
 * Transitions:
 *   CLOSED    → OPEN      : failureThreshold consecutive failures from different workflows
 *   OPEN      → HALF_OPEN : cooldown timer expires
 *   HALF_OPEN → CLOSED    : test request succeeds
 *   HALF_OPEN → OPEN      : test request fails (longer cooldown)
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

interface CircuitState {
  status: "CLOSED" | "OPEN" | "HALF_OPEN";
  failCount: number;
  tripCount: number;       // how many times we've tripped open — drives cooldown escalation
  openedAt: number | null;
  cooldownMs: number;
  lastFailure: string | null;
}

const FAILURE_THRESHOLD = 5;          // failures before tripping open
const BASE_COOLDOWN_MS = 60_000;      // 1 minute initial cooldown
const MAX_COOLDOWN_MS = 30 * 60_000;  // 30 minute max cooldown
const FAILURE_WINDOW_MS = 60_000;     // reset fail count if no failures for 1 minute

export class RegistryCircuitBreaker extends DurableObject<Env> {

  // ── Read current state ──────────────────────────────────────────
  private async getCircuitState(): Promise<CircuitState> {
    const stored = await this.ctx.storage.get<CircuitState>("circuit");
    return stored ?? {
      status: "CLOSED",
      failCount: 0,
      tripCount: 0,
      openedAt: null,
      cooldownMs: BASE_COOLDOWN_MS,
      lastFailure: null,
    };
  }

  private async saveCircuitState(state: CircuitState): Promise<void> {
    await this.ctx.storage.put("circuit", state);
  }

  // ── Called by workflows BEFORE making an EPP call ───────────────
  async checkRegistry(): Promise<{ allowed: boolean; status: string; retryAfterMs?: number }> {
    const state = await this.getCircuitState();

    if (state.status === "CLOSED") {
      return { allowed: true, status: "CLOSED" };
    }

    if (state.status === "OPEN") {
      const elapsed = Date.now() - (state.openedAt ?? 0);

      if (elapsed >= state.cooldownMs) {
        // Cooldown expired — transition to HALF_OPEN, let one request test
        state.status = "HALF_OPEN";
        await this.saveCircuitState(state);
        console.log(`[CircuitBreaker] Transitioning to HALF_OPEN — allowing test request`);
        return { allowed: true, status: "HALF_OPEN" };
      }

      const retryAfterMs = state.cooldownMs - elapsed;
      console.log(`[CircuitBreaker] Circuit OPEN — blocking request. Retry in ${Math.round(retryAfterMs / 1000)}s`);
      return { allowed: false, status: "OPEN", retryAfterMs };
    }

    // HALF_OPEN — already let one through, block the rest until we get a result
    return { allowed: false, status: "HALF_OPEN", retryAfterMs: 5000 };
  }

  // ── Called by workflows AFTER a successful EPP call ─────────────
  async reportSuccess(): Promise<void> {
    const state = await this.getCircuitState();

    if (state.status === "HALF_OPEN") {
      console.log(`[CircuitBreaker] Test request succeeded — closing circuit`);
      state.status = "CLOSED";
      state.failCount = 0;
      state.tripCount = 0;  // full reset on recovery
      state.openedAt = null;
      state.lastFailure = null;
    } else if (state.status === "CLOSED") {
      // Successful call in closed state — reset the fail counter
      state.failCount = 0;
    }

    await this.saveCircuitState(state);
  }

  // ── Called by workflows AFTER a failed EPP call ─────────────────
  async reportFailure(errorMessage: string): Promise<void> {
    const state = await this.getCircuitState();

    if (state.status === "HALF_OPEN") {
      // Test request failed — back to OPEN with escalated cooldown
      state.status = "OPEN";
      state.tripCount += 1;
      state.cooldownMs = Math.min(BASE_COOLDOWN_MS * Math.pow(2, state.tripCount), MAX_COOLDOWN_MS);
      state.openedAt = Date.now();
      state.lastFailure = errorMessage;
      console.log(`[CircuitBreaker] Test request failed — re-opening circuit. Cooldown: ${state.cooldownMs / 1000}s`);
    } else if (state.status === "CLOSED") {
      state.failCount += 1;
      state.lastFailure = errorMessage;

      if (state.failCount >= FAILURE_THRESHOLD) {
        // Trip the circuit open
        state.status = "OPEN";
        state.tripCount += 1;
        state.cooldownMs = Math.min(BASE_COOLDOWN_MS * Math.pow(2, state.tripCount - 1), MAX_COOLDOWN_MS);
        state.openedAt = Date.now();
        console.log(`[CircuitBreaker] ${state.failCount} failures — OPENING circuit. Cooldown: ${state.cooldownMs / 1000}s`);
      }
    }

    await this.saveCircuitState(state);
  }

  // ── API: get current breaker state (for monitoring/debugging) ───
  async getState(): Promise<CircuitState & { tld?: string }> {
    return await this.getCircuitState();
  }

  // ── API: manually reset the circuit (ops intervention) ──────────
  async reset(): Promise<{ message: string }> {
    await this.saveCircuitState({
      status: "CLOSED",
      failCount: 0,
      tripCount: 0,
      openedAt: null,
      cooldownMs: BASE_COOLDOWN_MS,
      lastFailure: null,
    });
    console.log(`[CircuitBreaker] Manually reset to CLOSED`);
    return { message: "Circuit breaker reset to CLOSED" };
  }
}
