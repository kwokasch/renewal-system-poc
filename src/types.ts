// Shared types across the renewal system

export interface Env {
  DB: D1Database;
  AI: Ai;
  DOMAIN_RENEWAL: DurableObjectNamespace;
  REGISTRY_BREAKER: DurableObjectNamespace;
  RENEWAL_QUEUE: Queue<RenewalMessage>;
  RENEWAL_WORKFLOW: Workflow;

}

export interface RenewalMessage {
  domainName: string;
  action: "auto_renew" | "manual_renew" | "reconciliation";
  triggerSource: "do_alarm" | "cron_sweep" | "api_request";
  idempotencyKey: string;
}

export interface DomainRecord {
  domain_name: string;
  account_id: string;
  status: string;
  expires_at: number;
  auto_renew: number;
  renewal_price: number;
  created_at: number;
  updated_at: number;
}

export interface AccountRecord {
  account_id: string;
  email: string;
  balance: number;
  created_at: number;
}

export interface RenewalResult {
  success: boolean;
  domain: string;
  newExpiry?: number;
  error?: string;
}

// Simulated EPP response
export interface EppRenewResponse {
  success: boolean;
  domainName: string;
  newExpiryDate: number;
  transactionId: string;
  errorCode?: string;
  errorMessage?: string;
}

// How an EPP failure should be treated (see epp-errors.ts)
export type EppErrorClass =
  | "infra"   // registry unhealthy: trip breaker, retry with backoff
  | "domain"  // this domain/request is the problem: don't trip, don't retry
  | "auth";   // our credentials rejected: trip breaker immediately, alert a human, don't retry
