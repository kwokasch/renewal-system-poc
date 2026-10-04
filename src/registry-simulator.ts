/**
 * Registry Simulator
 *
 * Simulates EPP registry operations for the POC.
 * In production, this would be an EPP client over TLS to the registry.
 *
 * Includes realistic failure modes:
 * - Random latency (50-500ms)
 * - Occasional timeouts
 * - Domain-specific error simulation
 */

import type { EppRenewResponse } from "./types";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export async function eppRenew(
  domainName: string,
  years: number = 1,
  currentExpiry: number = Date.now()
): Promise<EppRenewResponse> {
  // Simulate network latency (50-500ms)
  const latency = Math.floor(Math.random() * 450) + 50;
  await new Promise((r) => setTimeout(r, latency));

  const transactionId = `EPP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 5% chance of registry timeout (simulates real-world flakiness)
  if (Math.random() < 0.05) {
    throw new Error(`Registry timeout after ${latency}ms for ${domainName} [${transactionId}]`);
  }

  // Simulate domain-specific failures for testing
  if (domainName.includes("registry-error")) {
    return {
      success: false,
      domainName,
      newExpiryDate: 0,
      transactionId,
      errorCode: "2304",
      errorMessage: "Object status prohibits operation",
    };
  }

  // Test hooks: domain names containing these strings simulate specific EPP results
  const simulated: Array<[string, string, string]> = [
    ["registry-down", "2400", "Command failed"],
    ["registry-auth", "2501", "Authentication error; server closing connection"],
  ];
  for (const [marker, errorCode, errorMessage] of simulated) {
    if (domainName.includes(marker)) {
      return { success: false, domainName, newExpiryDate: 0, transactionId, errorCode, errorMessage };
    }
  }

  // Success: extend expiry by requested years
  // Registries add the term to the CURRENT expiry (remaining days aren't lost)
  const newExpiryDate = currentExpiry + years * ONE_YEAR_MS;

  return {
    success: true,
    domainName,
    newExpiryDate,
    transactionId,
  };
}

/**
 * EPP info command — check current domain state at registry.
 * Critical for the "unknown is a real state" pattern:
 * when a renew response is lost, query info before retrying.
 */
export async function eppInfo(domainName: string, knownExpiry: number = Date.now()): Promise<{
  exists: boolean;
  expiryDate: number | null;
  status: string[];
}> {
  const latency = Math.floor(Math.random() * 200) + 50;
  await new Promise((r) => setTimeout(r, latency));

  // Test hook: simulates "a previous renew succeeded but we crashed before
  // recording it" — the registry already shows an extended expiry.
  if (domainName.includes("already-renewed")) {
    return { exists: true, expiryDate: knownExpiry + ONE_YEAR_MS, status: ["ok"] };
  }

  // Normally the registry agrees with our records: same expiry we have on file.
  return {
    exists: true,
    expiryDate: knownExpiry,
    status: ["ok", "clientTransferProhibited"],
  };
}
