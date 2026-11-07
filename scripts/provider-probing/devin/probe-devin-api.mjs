/**
 * Devin host comparison probe — REST legacy vs shipped Connect-RPC.
 * Language: JavaScript (Bun), file: scripts/provider-probing/devin/probe-devin-api.mjs
 *
 * The desktop bundle's `api.devin.ai` REST surface only mints webapp session
 * tokens; the real model/chat surface is protobuf Connect-RPC on
 * `server.codeium.com`. This probe puts both side by side with the SAME
 * credential so the 401 "No organizations found for auth1 user" is visible
 * next to the RPC verdict.
 *
 * Usage:
 *   DEVIN_CRED=auth1_… bun scripts/provider-probing/devin/probe-devin-api.mjs
 *   DEVIN_CRED=sk-ws-… bun scripts/provider-probing/devin/probe-devin-api.mjs
 */

import {
  redact,
  requireCred,
  callDevinUnary,
  DevinMessageTypes,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_USER_JWT_PATH,
  devinCliMetadata,
} from "./_lib.mjs";

const cred = requireCred();
console.log(`credential: ${redact(cred)}`);

const restBase = "https://api.devin.ai";
const bearer = { authorization: `Bearer ${cred}`, accept: "application/json", "content-type": "application/json" };
const restProbes = [
  ["GET", "/api/user/me"],
  ["GET", "/api/me"],
  ["GET", "/api/auth1/me"],
  ["GET", "/api/organizations"],
  ["GET", "/api/v1/models"],
  ["GET", "/v1/models"],
];

console.log(`\n=== REST legacy (${restBase}) — webapp surface ===`);
for (const [method, path] of restProbes) {
  try {
    const res = await fetch(restBase + path, { method, headers: bearer, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    console.log(`[${res.status}] ${method} ${path} → ${text.slice(0, 220).replace(/\s+/g, " ")}`);
  } catch (error) {
    console.log(`[ERR] ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n=== Connect-RPC (${DEVIN_DEFAULT_BASE_URL}) — shipped adapter wire ===`);
try {
  const out = await callDevinUnary(
    DEVIN_GET_USER_JWT_PATH,
    DevinMessageTypes.GetUserJwtRequest,
    DevinMessageTypes.GetUserJwtResponse,
    { metadata: devinCliMetadata(cred) },
    { baseUrl: DEVIN_DEFAULT_BASE_URL, signal: AbortSignal.timeout(20_000) },
  );
  console.log(`[200] GetUserJwt → userJwt=${out.userJwt ? "present" : "absent"} customApiServerUrl=${out.customApiServerUrl ?? "-"}`);
  console.log("verdict: credential is a valid Cascade API key ✅");
} catch (error) {
  console.log(`[401/invalid] GetUserJwt → ${error instanceof Error ? error.message : String(error)}`);
  console.log("verdict: auth1 token is a webapp session, NOT an API key ❌ (expected)");
}
