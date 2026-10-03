/**
 * Domain Management AI Agent
 *
 * Conversational interface for the renewal system using Workers AI
 * with tool-calling to query and act on domain infrastructure.
 *
 * Architecture:
 *   Chat UI → /api/chat → Workers AI (Llama 3.3) → Tool Loop → D1/DOs/Queue
 *
 * The agent uses the Vercel AI SDK for streaming + tool orchestration,
 * backed by Workers AI running Llama 3.3 on Cloudflare's GPU fleet.
 *
 * Tools map directly to existing infrastructure:
 *   - listDomains      → D1 query
 *   - getDomainDetails  → D1 + Durable Object state
 *   - renewDomain       → Queue → Workflow pipeline
 *   - getRenewalHistory → D1 query
 *   - getCircuitBreaker → Circuit Breaker DO
 *   - getDeadLetters    → D1 dead_letter_renewals table
 */

import { createWorkersAI } from "workers-ai-provider";
import { streamText, tool } from "ai";
import { z } from "zod";
import type { Env, DomainRecord, RenewalMessage } from "./types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
function formatDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar-day difference (positive = future, negative = past) */
function daysUntil(expiresAtMs: number): number {
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiry = new Date(expiresAtMs);
  const expiryUTC = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate());
  return Math.round((expiryUTC - todayUTC) / ONE_DAY_MS);
}

function urgencyTag(days: number): string {
  if (days < 0) return "EXPIRED";
  if (days === 0) return "TODAY";
  if (days <= 7) return "CRITICAL";
  if (days <= 30) return "URGENT";
  return "OK";
}

const SYSTEM_PROMPT = `You are a domain management assistant for a domain registrar. You help users manage their domains through natural conversation.

You can:
- List domains and check expiry dates
- Look up detailed domain info including Durable Object alarm state
- Trigger manual renewals through the workflow pipeline
- Check renewal history and troubleshoot failures
- Monitor registry circuit breaker health
- Check the dead-letter queue for failed renewals needing investigation
- Register new domains

Guidelines:
- Format expiry dates readably and flag anything expiring within 30 days as urgent
- When triggering renewals, explain the pipeline: Queue → Workflow (eligibility → payment → registry → update)
- For circuit breakers: CLOSED = healthy, OPEN = registry down (fail-fast), HALF_OPEN = testing recovery
- Be concise but thorough. Include relevant numbers and dates.
- If a domain isn't found, suggest checking the spelling.`;

export async function handleChatRequest(
  messages: Array<{ role: string; content: string }>,
  env: Env
): Promise<Response> {
  const workersai = createWorkersAI({ binding: env.AI });

  const result = streamText({
    model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    system: SYSTEM_PROMPT + `\n\nToday's date: ${new Date().toISOString().split("T")[0]}`,
    messages,
    tools: {
      listDomains: tool({
        description:
          "List all registered domains with status, expiry dates, days until expiry, and renewal price. Use when the user asks about their domains, what's expiring, or wants an overview.",
        parameters: z.object({}),
        execute: async () => {
          const domains = await env.DB.prepare(
            "SELECT domain_name, status, expires_at, auto_renew, renewal_price FROM domains ORDER BY expires_at ASC"
          ).all<DomainRecord>();

          return domains.results.map((d) => {
            const days = daysUntil(d.expires_at);
            return {
              domain: d.domain_name,
              expiryDate: formatDate(d.expires_at),
              daysUntilExpiry: days,
              urgency: urgencyTag(days),
              autoRenew: d.auto_renew === 1,
              renewalPrice: `$${d.renewal_price}`,
            };
          });
        },
      }),

      getDomainDetails: tool({
        description:
          "Get detailed info about a specific domain: D1 record + Durable Object state (alarm schedule, renewal attempts, auto-renew status). Use when the user asks about a specific domain.",
        parameters: z.object({
          domainName: z.string().describe("The domain name, e.g. 'example.com'"),
        }),
        execute: async ({ domainName }) => {
          const domain = await env.DB.prepare(
            "SELECT * FROM domains WHERE domain_name = ?1"
          )
            .bind(domainName)
            .first<DomainRecord>();

          if (!domain) {
            return { error: `Domain '${domainName}' not found in the system.` };
          }

          const doId = env.DOMAIN_RENEWAL.idFromName(domainName);
          const doStub = env.DOMAIN_RENEWAL.get(doId);
          const doState = await doStub.getState();

          const days = daysUntil(domain.expires_at);
          return {
            domain: {
              name: domain.domain_name,
              status: domain.status,
              expiryDate: formatDate(domain.expires_at),
              daysUntilExpiry: days,
              urgency: urgencyTag(days),
              autoRenew: domain.auto_renew === 1,
              renewalPrice: `$${domain.renewal_price}`,
              accountId: domain.account_id,
            },
            durableObjectState: doState,
          };
        },
      }),

      renewDomain: tool({
        description:
          "Trigger a manual renewal for a domain. Enqueues it into the renewal pipeline: Queue → Workflow (eligibility check → payment → registry EPP renew → record update → confirmation). Use when the user explicitly asks to renew a specific domain.",
        parameters: z.object({
          domainName: z.string().describe("The domain name to renew"),
        }),
        execute: async ({ domainName }) => {
          const domain = await env.DB.prepare(
            "SELECT * FROM domains WHERE domain_name = ?1"
          )
            .bind(domainName)
            .first<DomainRecord>();

          if (!domain) {
            return { error: `Domain '${domainName}' not found.` };
          }

          const idempotencyKey = `manual_${domainName}_${Date.now()}`;

          const message: RenewalMessage = {
            domainName,
            action: "manual_renew",
            triggerSource: "api_request",
            idempotencyKey,
          };

          await env.RENEWAL_QUEUE.send(message);

          return {
            status: "queued",
            message: `Renewal queued for ${domainName}`,
            idempotencyKey,
            renewalPrice: domain.renewal_price,
            pipeline: "Queue → Workflow: eligibility → payment → registry renew → update records → confirmation",
          };
        },
      }),

      getRenewalHistory: tool({
        description:
          "Get renewal history for a domain: past attempts, their status (success/failed/processing), trigger source, amounts charged, and any error messages. Use for troubleshooting or reviewing past renewals.",
        parameters: z.object({
          domainName: z.string().describe("The domain name to check history for"),
        }),
        execute: async ({ domainName }) => {
          const history = await env.DB.prepare(
            "SELECT * FROM renewal_history WHERE domain_name = ?1 ORDER BY created_at DESC LIMIT 20"
          )
            .bind(domainName)
            .all();

          if (history.results.length === 0) {
            return { domain: domainName, message: "No renewal history found." };
          }

          return {
            domain: domainName,
            renewals: history.results.map((h: any) => ({
              status: h.status,
              action: h.action,
              triggerSource: h.trigger_source,
              amountCharged: h.amount_charged,
              errorMessage: h.error_message,
              createdAt: new Date(h.created_at).toISOString(),
              completedAt: h.completed_at ? new Date(h.completed_at).toISOString() : null,
            })),
          };
        },
      }),

      getCircuitBreakerStatus: tool({
        description:
          "Check the circuit breaker state for a TLD registry (e.g. 'com', 'net', 'org'). Circuit breakers prevent thundering-herd retries when a registry is down. States: CLOSED = healthy (requests pass through), OPEN = registry down (requests fail-fast), HALF_OPEN = cooldown expired, testing with one request.",
        parameters: z.object({
          tld: z.string().describe("The TLD to check, e.g. 'com', 'net', 'org'"),
        }),
        execute: async ({ tld }) => {
          const breakerId = env.REGISTRY_BREAKER.idFromName(tld);
          const breaker = env.REGISTRY_BREAKER.get(breakerId);
          const state = await breaker.getState();
          return { tld, ...state };
        },
      }),

      resetCircuitBreaker: tool({
        description:
          "Manually reset a tripped circuit breaker for a TLD registry back to CLOSED state. Use when the registry is confirmed back online and you want to resume renewal processing.",
        parameters: z.object({
          tld: z.string().describe("The TLD whose circuit breaker to reset"),
        }),
        execute: async ({ tld }) => {
          const breakerId = env.REGISTRY_BREAKER.idFromName(tld);
          const breaker = env.REGISTRY_BREAKER.get(breakerId);
          const result = await breaker.reset();
          return { tld, ...result };
        },
      }),

      getDeadLetterItems: tool({
        description:
          "Check the dead-letter table for renewals that failed permanently and need manual investigation. These are cases where payment was charged but the registry operation failed after all retries — payment has been automatically refunded.",
        parameters: z.object({}),
        execute: async () => {
          const items = await env.DB.prepare(
            "SELECT * FROM dead_letter_renewals WHERE requires_action = 1 ORDER BY created_at DESC LIMIT 20"
          ).all();

          if (items.results.length === 0) {
            return { message: "No dead-letter items requiring action. All clear!" };
          }

          return {
            count: items.results.length,
            items: items.results.map((item: any) => ({
              domain: item.domain_name,
              accountId: item.account_id,
              error: item.error_message,
              paymentRefunded: item.payment_refunded === 1,
              createdAt: new Date(item.created_at).toISOString(),
            })),
          };
        },
      }),

      registerDomain: tool({
        description:
          "Register a new domain in the system. Creates a D1 database record and initializes a Durable Object with a renewal alarm set for 7 days before expiry.",
        parameters: z.object({
          domainName: z.string().describe("The domain name, e.g. 'example.com'"),
          accountId: z.string().describe("The account ID that owns this domain"),
          expiresAt: z.string().describe("Expiry date as ISO string, e.g. '2025-06-15'"),
          renewalPrice: z.number().optional().describe("Annual renewal price in USD (default: 12.99)"),
        }),
        execute: async ({ domainName, accountId, expiresAt, renewalPrice }) => {
          const expiresAtMs = new Date(expiresAt).getTime();
          if (isNaN(expiresAtMs)) {
            return { error: "Invalid date format. Use ISO format like '2025-06-15'" };
          }

          const price = renewalPrice ?? 12.99;

          try {
            await env.DB.prepare(
              `INSERT INTO domains (domain_name, account_id, status, expires_at, renewal_price)
               VALUES (?1, ?2, 'active', ?3, ?4)`
            ).bind(domainName, accountId, expiresAtMs, price).run();
          } catch (err: any) {
            if (err.message?.includes("UNIQUE constraint")) {
              return { error: `Domain '${domainName}' is already registered.` };
            }
            throw err;
          }

          const doId = env.DOMAIN_RENEWAL.idFromName(domainName);
          const doStub = env.DOMAIN_RENEWAL.get(doId);
          await doStub.initDomain(domainName, expiresAtMs, accountId);

          return {
            message: `Domain ${domainName} registered successfully`,
            expiresAt: new Date(expiresAtMs).toISOString(),
            renewalAlarmAt: new Date(expiresAtMs - SEVEN_DAYS_MS).toISOString(),
            renewalPrice: price,
          };
        },
      }),
    },
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
}
