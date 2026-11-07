/**
 * Devin OAuth code exchange + credential verification probe.
 * Language: JavaScript (Bun), file: scripts/provider-probing/devin/devin-oauth-exchange.mjs
 *
 * Uses the SHIPPED auth clients for the exchange, then verifies the resulting
 * credential directly against `server.codeium.com` (GetUserJwt →
 * GetCliModelConfigs → GetUserStatus). Also supports legacy auth1 webapp
 * exchange (`--mode=auth1`) for the Google/GitHub/OpenAI connection flow that
 * the desktop bundle uses — those tokens are webapp sessions, not API keys, and
 * this probe makes that failure explicit rather than silent.
 *
 * Usage:
 *   DEVIN_CODE=4/0A… DEVIN_VERIFIER=… bun scripts/.../devin-oauth-exchange.mjs --mode=devin
 *   DEVIN_CODE=… DEVIN_VERIFIER=… bun scripts/.../devin-oauth-exchange.mjs --mode=windsurf
 *   DEVIN_CODE=… DEVIN_VERIFIER=… bun scripts/.../devin-oauth-exchange.mjs --mode=auth1 --provider=google
 *   DEVIN_CRED=sk-ws-… bun scripts/.../devin-oauth-exchange.mjs --mode=verify
 */

import {
  arg,
  hasFlag,
  redact,
  dump,
  requireCred,
  callDevinUnary,
  DevinMessageTypes,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_USER_JWT_PATH,
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  DEVIN_GET_USER_STATUS_PATH,
  devinCliMetadata,
  devinDiscoveryMetadata,
} from "./_lib.mjs";
import {
  devinOAuthClient,
  devinWindsurfOAuthClient,
} from "../../../src/providers/integrations/devin/devin-auth.ts";

const mode = arg("mode", "devin");
const code = arg("code");
const verifier = arg("verifier");
const provider = arg("provider", "google");
const redirectUri = arg("redirect-uri", "http://127.0.0.1:59653/callback");

function auth1Exchange() {
  const url = `https://app.devin.ai/api/auth1/${provider}/exchange`;
  const body = {
    code,
    mode: arg("auth1-mode", "login"),
    code_verifier: verifier,
    redirect_uri: arg("auth1-redirect-uri", "https://auth.devin.ai/login/callback"),
  };
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: (await res.text()).slice(0, 4000), url }));
}

async function verify(credential) {
  console.log(`\n=== direct upstream verification (${redact(credential)}) ===`);
  const probes = [
    {
      name: "GetUserJwt",
      path: DEVIN_GET_USER_JWT_PATH,
      req: DevinMessageTypes.GetUserJwtRequest,
      res: DevinMessageTypes.GetUserJwtResponse,
      body: { metadata: devinCliMetadata(credential) },
    },
    {
      name: "GetCliModelConfigs",
      path: DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
      req: DevinMessageTypes.GetCliModelConfigsRequest,
      res: DevinMessageTypes.GetCliModelConfigsResponse,
      body: { metadata: devinDiscoveryMetadata(credential) },
    },
    {
      name: "GetUserStatus",
      path: DEVIN_GET_USER_STATUS_PATH,
      req: DevinMessageTypes.GetUserStatusRequest,
      res: DevinMessageTypes.GetUserStatusResponse,
      body: { metadata: devinCliMetadata(credential) },
    },
  ];
  let anyOk = false;
  for (const p of probes) {
    try {
      const out = await callDevinUnary(
        p.path,
        p.req,
        p.res,
        p.body,
        { baseUrl: DEVIN_DEFAULT_BASE_URL, signal: AbortSignal.timeout(30_000) },
      );
      const summary = p.name === "GetCliModelConfigs"
        ? `${out.clientModelConfigs?.length ?? 0} configs`
        : p.name === "GetUserJwt"
          ? `userJwt=${out.userJwt ? "present" : "absent"}, customApiServerUrl=${out.customApiServerUrl ?? "-"}`
          : `plan=${out.planInfo?.planName ?? "-"}, email=${out.userStatus?.email ?? "-"}`;
      console.log(`  ${p.name}: 200 OK | ${summary}`);
      anyOk = true;
    } catch (error) {
      console.log(`  ${p.name}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\nverdict: ${anyOk ? "credential accepted by at least one RPC ✅" : "rejected everywhere (auth1 token is NOT an API key) ❌"}`);
  return anyOk;
}

if (mode === "verify") {
  await verify(requireCred());
  process.exit(0);
}

if (!code) {
  console.error("usage: DEVIN_CODE=<code> DEVIN_VERIFIER=<verifier> --mode=devin|windsurf|auth1 | DEVIN_CRED=… --mode=verify");
  process.exit(1);
}

if (mode === "auth1") {
  console.log(`POST https://app.devin.ai/api/auth1/${provider}/exchange (legacy webapp session)`);
  const result = await auth1Exchange();
  dump("auth1 exchange", result);
  let token;
  try { token = JSON.parse(result.body).token; } catch { /* opaque body */ }
  if (token) {
    console.log(`\ntoken: ${redact(token)}`);
    console.log("NOTE: this is an auth1 webapp session token, not a Cascade API key. Verifying against upstream…");
    await verify(token);
  }
  process.exit(0);
}

const client = mode === "windsurf" ? devinWindsurfOAuthClient : devinOAuthClient;
const effectiveRedirect = client.browserRedirectUri ?? redirectUri;
console.log(`[${mode}] exchanging code ${code.slice(0, 12)}… through the shipped ${mode} client`);
console.log(`  redirect_uri: ${effectiveRedirect}`);

try {
  const result = await client.exchangeCode(code, verifier, effectiveRedirect);
  dump("exchange result", {
    access: hasFlag("show-secret") ? result.access : redact(result.access),
    accountLabel: result.accountLabel ?? null,
    expiresAt: result.expiresAt,
    auth_state: result.auth_state ?? null,
  });
  await verify(result.access);
} catch (error) {
  console.error(`exchange failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
