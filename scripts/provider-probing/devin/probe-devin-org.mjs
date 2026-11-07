/**
 * Devin organization / seat-identity probe.
 * Language: JavaScript (Bun), file: scripts/provider-probing/devin/probe-devin-org.mjs
 *
 * The old REST `/api/organizations*` grid burned calls and proved nothing
 * (401 "No organizations found for auth1 user"). The real identity lives in
 * `GetUserStatus` on the seat-management service: email, userId, teamId,
 * orgId, planName, tier. This probe decodes that response with the shipped
 * protobuf schema, and optionally still sweeps the REST grid with --legacy.
 *
 * Usage:
 *   DEVIN_CRED=sk-ws-… bun scripts/provider-probing/devin/probe-devin-org.mjs
 *   DEVIN_CRED=auth1_… bun scripts/provider-probing/devin/probe-devin-org.mjs --legacy
 */

import {
  hasFlag,
  redact,
  requireCred,
  dump,
  callDevinUnary,
  DevinMessageTypes,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_USER_STATUS_PATH,
  devinCliMetadata,
} from "./_lib.mjs";

const cred = requireCred();
console.log(`credential: ${redact(cred)}`);
console.log(`POST ${DEVIN_DEFAULT_BASE_URL}${DEVIN_GET_USER_STATUS_PATH}`);

try {
  const out = await callDevinUnary(
    DEVIN_GET_USER_STATUS_PATH,
    DevinMessageTypes.GetUserStatusRequest,
    DevinMessageTypes.GetUserStatusResponse,
    { metadata: devinCliMetadata(cred) },
    { baseUrl: DEVIN_DEFAULT_BASE_URL, signal: AbortSignal.timeout(20_000) },
  );
  const u = out.userStatus ?? {};
  const p = out.planInfo ?? {};
  dump("seat identity", {
    email: u.email ?? null,
    userId: u.userId ?? null,
    teamId: u.teamId ?? null,
    orgId: p.devinInfo?.orgId ?? null,
    accountDisplayName: p.devinInfo?.accountDisplayName ?? null,
    planName: p.planName ?? null,
    teamsTier: p.teamsTier ?? null,
    billingStrategy: p.billingStrategy ?? null,
    canUseCascade: p.devinInfo?.canUseCascade ?? null,
    canUseCli: p.devinInfo?.canUseCli ?? null,
  });
  const ps = u.planStatus ?? {};
  dump("plan status", {
    availablePromptCredits: ps.availablePromptCredits ?? null,
    usedPromptCredits: ps.usedPromptCredits ?? null,
    dailyQuotaRemainingPercent: ps.dailyQuotaRemainingPercent ?? null,
    weeklyQuotaRemainingPercent: ps.weeklyQuotaRemainingPercent ?? null,
    overageBalanceMicros: ps.overageBalanceMicros ?? null,
  });
} catch (error) {
  console.log(`GetUserStatus FAILED: ${error instanceof Error ? error.message : String(error)}`);
}

if (hasFlag("legacy")) {
  console.log("\n=== legacy REST org grid (expected 401/404) ===");
  const paths = ["/api/organizations/eligible", "/api/eligible-organizations", "/api/auth1/orgs", "/api/user"];
  for (const path of paths) {
    try {
      const res = await fetch(`https://api.devin.ai${path}`, {
        headers: { authorization: `Bearer ${cred}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      console.log(`[${res.status}] ${path} → ${(await res.text()).slice(0, 180).replace(/\s+/g, " ")}`);
    } catch (error) {
      console.log(`[ERR] ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
