/**
 * Renewal System POC — Main Worker
 *
 * This is the entry point. It handles:
 *   1. HTTP API —"manual renewal triggers, domain management, status checks
 *   2. Chat API — AI-powered conversational interface (proxies to DomainAgent DO)
 *   3. Cron trigger — daily reconciliation sweep (BACKUP, not primary trigger)
 *   4. Queue consumer — receives messages from DOs/cron, dispatches to Workflow
 *
 * Architecture:
 *   PRIMARY:   DO Alarm → Queue → Workflow → Registry
 *   BACKUP:    Cron → D1 scan → Queue → Workflow → Registry
 *   MANUAL:    API → Queue → Workflow → Registry
 *   AI AGENT:  Chat UI → Agent DO → Workers AI → Tools → D1/DOs/Queue
 */

import type { Env, RenewalMessage, DomainRecord } from "./types";

// Re-export the Durable Object and Workflow classes so wrangler finds them
export { DomainRenewal } from "./domain-renewal";
export { RenewalWorkflow } from "./renewal-workflow";
export { RegistryCircuitBreaker } from "./registry-circuit-breaker";
import { handleChatRequest } from "./agent";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // HTTP API + Chat API + Static Assets
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // ── Chat API: AI agent powered by Workers AI ────────────────
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = await request.json<{ messages: Array<{ role: string; content: string }> }>();
        if (!body.messages || !Array.isArray(body.messages)) {
          return Response.json({ error: "Missing messages array" }, { status: 400 });
        }
        return handleChatRequest(body.messages, env);
      }

      // ── REST API endpoints ───────────────────────────────────────

      // POST /domains — Register a new domain (creates DO + DB record)
      if (request.method === "POST" && url.pathname === "/domains") {
        return await handleRegisterDomain(request, env);
      }

      // POST /domains/:name/renew — Manual renewal trigger
      if (request.method === "POST" && url.pathname.match(/^\/domains\/[^/]+\/renew$/)) {
        const domainName = url.pathname.split("/")[2];
        return await handleManualRenew(domainName, env);
      }

      // GET /domains/:name — Domain status + DO state
      if (request.method === "GET" && url.pathname.match(/^\/domains\/[^/]+$/)) {
        const domainName = url.pathname.split("/")[2];
        return await handleGetDomain(domainName, env);
      }

      // GET /domains — List all domains
      if (request.method === "GET" && url.pathname === "/domains") {
        return await handleListDomains(env);
      }

      // GET /history/:name — Renewal history for a domain
      if (request.method === "GET" && url.pathname.match(/^\/history\/[^/]+$/)) {
        const domainName = url.pathname.split("/")[2];
        return await handleGetHistory(domainName, env);
      }

      // POST /simulate/alarm/:name — Force-fire a DO alarm (testing)
      if (request.method === "POST" && url.pathname.match(/^\/simulate\/alarm\/[^/]+$/)) {
        const domainName = url.pathname.split("/")[2];
        return await handleSimulateAlarm(domainName, env);
      }

      // GET /circuit/:tld — Circuit breaker state for a TLD
      if (request.method === "GET" && url.pathname.match(/^\/circuit\/[^/]+$/)) {
        const tld = url.pathname.split("/")[2];
        const breakerId = env.REGISTRY_BREAKER.idFromName(tld);
        const breaker = env.REGISTRY_BREAKER.get(breakerId);
        const state = await breaker.getState();
        return Response.json({ tld, ...state });
      }

      // POST /circuit/:tld/reset — Manually reset a tripped circuit breaker
      if (request.method === "POST" && url.pathname.match(/^\/circuit\/[^/]+\/reset$/)) {
        const tld = url.pathname.split("/")[2];
        const breakerId = env.REGISTRY_BREAKER.idFromName(tld);
        const breaker = env.REGISTRY_BREAKER.get(breakerId);
        const result = await breaker.reset();
        return Response.json({ tld, ...result });
      }

      // Static assets (chat UI at /) are served automatically by Cloudflare's
      // asset platform before the Worker runs — no code needed here.

      return Response.json(
        {
          error: "Not found",
          routes: [
            "GET    /                     — Chat UI",
            "POST   /api/chat             — Chat API (AI agent)",
            "POST   /domains              — Register domain",
            "GET    /domains              — List all domains",
            "GET    /domains/:name        — Domain status",
            "POST   /domains/:name/renew  — Manual renewal",
            "GET    /history/:name        — Renewal history",
            "POST   /simulate/alarm/:name — Force DO alarm (testing)",
            "GET    /circuit/:tld         — Circuit breaker state",
            "POST   /circuit/:tld/reset   — Reset circuit breaker",
          ],
        },
        { status: 404 }
      );
    } catch (err) {
      console.error(`[API] Error: ${err}`);
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CRON — Reconciliation sweep (backup trigger)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    console.log("[Cron] Reconciliation sweep starting...");

    const now = Date.now();
    const windowEnd = now + SEVEN_DAYS_MS;

    const expiring = await env.DB.prepare(
      `SELECT domain_name, expires_at, account_id
       FROM domains
       WHERE expires_at < ?1
         AND status = 'active'
         AND auto_renew = 1
         AND domain_name NOT IN (
           SELECT domain_name FROM renewal_history
           WHERE status = 'success'
             AND created_at > ?2
         )`
    ).bind(windowEnd, now - SEVEN_DAYS_MS).all<DomainRecord>();

    console.log(`[Cron] Found ${expiring.results.length} domains needing renewal`);

    for (const domain of expiring.results) {
      const idempotencyKey = `renew_${domain.domain_name}_${domain.expires_at}`;

      const message: RenewalMessage = {
        domainName: domain.domain_name,
        action: "auto_renew",
        triggerSource: "cron_sweep",
        idempotencyKey,
      };

      await env.RENEWAL_QUEUE.send(message);
      console.log(`[Cron] Enqueued reconciliation renewal for ${domain.domain_name}`);
    }

    console.log("[Cron] Reconciliation sweep complete");
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // QUEUE CONSUMER — Dispatches renewal messages to Workflow
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async queue(batch: MessageBatch<RenewalMessage>, env: Env): Promise<void> {
    console.log(`[Queue] Processing batch of ${batch.messages.length} messages`);

    for (const msg of batch.messages) {
      const { domainName, action, triggerSource, idempotencyKey } = msg.body;

      try {
        const instance = await env.RENEWAL_WORKFLOW.create({
          id: idempotencyKey,
          params: {
            domainName,
            action,
            triggerSource,
            idempotencyKey,
          },
        });

        console.log(`[Queue] Started workflow ${instance.id} for ${domainName}`);
        msg.ack();
      } catch (err: any) {
        if (err.message?.includes("already exists")) {
          console.log(`[Queue] Workflow already exists for ${idempotencyKey}, deduped`);
          msg.ack();
        } else {
          console.error(`[Queue] Failed to create workflow for ${domainName}: ${err}`);
          msg.retry();
        }
      }
    }
  },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REST API Handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleRegisterDomain(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    domainName: string;
    accountId: string;
    expiresAt: number;
    renewalPrice?: number;
  }>();

  if (!body.domainName || !body.accountId || !body.expiresAt) {
    return Response.json({ error: "Missing required fields: domainName, accountId, expiresAt" }, { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO domains (domain_name, account_id, status, expires_at, renewal_price)
     VALUES (?1, ?2, 'active', ?3, ?4)`
  ).bind(body.domainName, body.accountId, body.expiresAt, body.renewalPrice ?? 12.99).run();

  const doId = env.DOMAIN_RENEWAL.idFromName(body.domainName);
  const doStub = env.DOMAIN_RENEWAL.get(doId);
  await doStub.initDomain(body.domainName, body.expiresAt, body.accountId);

  return Response.json(
    {
      message: `Domain ${body.domainName} registered`,
      expiresAt: new Date(body.expiresAt).toISOString(),
      renewalAlarmAt: new Date(body.expiresAt - SEVEN_DAYS_MS).toISOString(),
    },
    { status: 201 }
  );
}

async function handleManualRenew(domainName: string, env: Env): Promise<Response> {
  const domain = await env.DB.prepare(
    "SELECT * FROM domains WHERE domain_name = ?1"
  ).bind(domainName).first<DomainRecord>();

  if (!domain) {
    return Response.json({ error: `Domain ${domainName} not found` }, { status: 404 });
  }

  const idempotencyKey = `manual_${domainName}_${Date.now()}`;

  const message: RenewalMessage = {
    domainName,
    action: "manual_renew",
    triggerSource: "api_request",
    idempotencyKey,
  };

  await env.RENEWAL_QUEUE.send(message);

  return Response.json({
    message: `Manual renewal queued for ${domainName}`,
    idempotencyKey,
  }, { status: 202 });
}

async function handleGetDomain(domainName: string, env: Env): Promise<Response> {
  const domain = await env.DB.prepare(
    "SELECT * FROM domains WHERE domain_name = ?1"
  ).bind(domainName).first<DomainRecord>();

  if (!domain) {
    return Response.json({ error: `Domain ${domainName} not found` }, { status: 404 });
  }

  const doId = env.DOMAIN_RENEWAL.idFromName(domainName);
  const doStub = env.DOMAIN_RENEWAL.get(doId);
  const doState = await doStub.getState();

  return Response.json({
    domain: {
      ...domain,
      expiresAtHuman: new Date(domain.expires_at).toISOString(),
    },
    durableObject: doState,
  });
}

async function handleListDomains(env: Env): Promise<Response> {
  const domains = await env.DB.prepare(
    "SELECT domain_name, status, expires_at, auto_renew, renewal_price FROM domains ORDER BY expires_at ASC"
  ).all<DomainRecord>();

  return Response.json({
    count: domains.results.length,
    domains: domains.results.map((d) => ({
      ...d,
      expiresAtHuman: new Date(d.expires_at).toISOString(),
      daysUntilExpiry: Math.floor((d.expires_at - Date.now()) / (24 * 60 * 60 * 1000)),
    })),
  });
}

async function handleGetHistory(domainName: string, env: Env): Promise<Response> {
  const history = await env.DB.prepare(
    `SELECT * FROM renewal_history WHERE domain_name = ?1 ORDER BY created_at DESC LIMIT 50`
  ).bind(domainName).all();

  return Response.json({
    domain: domainName,
    history: history.results,
  });
}

async function handleSimulateAlarm(domainName: string, env: Env): Promise<Response> {
  const doId = env.DOMAIN_RENEWAL.idFromName(domainName);
  const doStub = env.DOMAIN_RENEWAL.get(doId);

  await doStub.simulateAlarm();

  return Response.json({
    message: `Alarm simulated for ${domainName}`,
  });
}
