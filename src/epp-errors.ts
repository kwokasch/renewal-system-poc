/**
 * EPP response-code classification (RFC 5730 result codes).
 *
 * The circuit breaker is shared by every domain in a TLD, so only failures that
 * say something about the REGISTRY's health may count against it. A rejection
 * of one domain's request means the registry is up and answering.
 *
 * Exact semantics vary by registry (e.g. Nominet's 2400 covers its nightly
 * maintenance window) — in production this mapping would be per-registry config.
 */

import type { EppErrorClass } from "./types";

const INFRA_CODES = new Set(["2400", "2500", "2502"]); // command failed, server error, session limit
const AUTH_CODES = new Set(["2501"]);                  // authentication error, server closing connection

export function classifyEppError(code: string | undefined): EppErrorClass {
  if (code && AUTH_CODES.has(code)) return "auth";
  if (code && INFRA_CODES.has(code)) return "infra";
  // 2201 authorization, 2302 exists, 2303 not found, 2304 status prohibits,
  // 2306 parameter policy, and anything unrecognised: treat as a domain-level
  // error so an unknown code can never take down a whole TLD.
  return "domain";
}
