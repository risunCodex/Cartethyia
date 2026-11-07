/**
 * Devin OAuth capture + login → live upstream smoke.
 * Language: JavaScript (Bun), file: scripts/provider-probing/devin/devin-oauth-capture.mjs
 *
 * Drives the SHIPPED auth clients (src/providers/integrations/devin/devin-auth.ts)
 * through a real browser PKCE login on the loopback callback, captures the
 * code, exchanges it, persists the resulting credential to scratch, then
 * immediately probes the Connect-RPC upstream with that credential.
 *
 * Modes:
 *   --mode=devin       app.devin.ai/auth/cli/continue  (loopback :59653)
 *   --mode=windsurf    windsurf.com/editor/signin      (loopback :59654)
 *   --mode=cli         adopt %APPDATA%/devin/credentials.toml (no browser)
 *   --mode=paste       paste a full redirect URL (headless)
 *   --mode=import      import a raw sk-ws-/JWT credential (DEVIN_CRED)
 *
 * Flags:
 *   --no-smoke         skip the post-login upstream probes
 *   --show-secret      print the credential (default: redacted + scratch file)
 *   --out=<path>       credential output file (default D:/tmp/scratch/devin-probe/credential.txt)
 *   --timeout=<ms>     loopback wait (default 300000)
 *   --no-browser       print the URL without opening a browser
 *
 * Usage:
 *   bun scripts/provider-probing/devin/devin-oauth-capture.mjs --mode=devin
 *   bun scripts/provider-probing/devin/devin-oauth-capture.mjs --mode=windsurf
 *   bun scripts/provider-probing/devin/devin-oauth-capture.mjs --mode=cli
 *   DEVIN_CRED=sk-ws-… bun scripts/provider-probing/devin/devin-oauth-capture.mjs --mode=import
 */

import { randomUUID, createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

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
  devinCliMetadata,
  devinDiscoveryMetadata,
  decodeUnary,
} from "./_lib.mjs";
import {
  devinOAuthClient,
  devinWindsurfOAuthClient,
  generatePKCE,
  loginDevinCliHook,
  readDevinCliCredentials,
  devinCliCredentialPaths,
  WINDSURF_CALLBACK_PORT,
  WINDSURF_PREFERRED_HOSTNAME,
} from "../../../src/providers/integrations/devin/devin-auth.ts";

const mode = arg("mode", "devin");
const outFile = arg("out", "D:/tmp/scratch/devin-probe/credential.txt");
const timeoutMs = Number(arg("timeout", "300000"));

function openBrowser(url) {
  if (hasFlag("no-browser")) return;
  const platform = process.platform;
  const cmd = platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : platform === "darwin" ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.log("[browser] could not auto-open; open the URL manually.");
  }
}

/** One-shot loopback listener. Resolves with the full callback URL. */
function listenForCallback(port, hostname, expectedState, signalMs) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${hostname}:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const params = Object.fromEntries(url.searchParams);
      if (params.error) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(`<h3>login failed</h3><pre>${params.error}: ${params.error_description ?? ""}</pre>`);
        server.close();
        reject(new Error(`oauth error: ${params.error} ${params.error_description ?? ""}`));
        return;
      }
      if (params.state && params.state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end("<h3>state mismatch — refusing</h3>");
        server.close();
        reject(new Error("state mismatch (possible CSRF)"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><h3>Devin login captured</h3><p>You can close this tab.</p>");
      server.close();
      resolve(url.toString());
    });
    server.on("error", reject);
    server.listen(port, hostname, () => {
      console.log(`[loopback] listening on http://${hostname}:${port}/callback`);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`loopback timed out after ${signalMs}ms`));
    }, signalMs);
    timer.unref?.();
    server.on("close", () => clearTimeout(timer));
  });
}

async function pasteUrl() {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const url = await new Promise((resolve) => rl.question("redirect URL> ", resolve));
  rl.close();
  return url.trim();
}

function codeFromUrl(raw) {
  const u = new URL(raw.trim());
  const params = { ...Object.fromEntries(u.searchParams), ...Object.fromEntries(new URLSearchParams(u.hash.slice(1))) };
  const code = params.code ?? params.devin_code;
  const token = params.access_token ?? params.token;
  if (!code && !token) throw new Error(`no code/token in callback: ${JSON.stringify(params)}`);
  return { code, token, state: params.state, params };
}

async function exchangeAndCapture(client, authorizeRequest, verifier, redirectUri, label) {
  const url = client.buildAuthorizeUrl(authorizeRequest);
  dump(`${label} authorize URL`, url);
  console.log(`\nPKCE verifier (keep secret):\n${verifier}`);
  console.log(`\nstate: ${authorizeRequest.state}`);

  let callbackUrl;
  if (hasFlag("paste")) {
    callbackUrl = await pasteUrl();
  } else {
    const port = Number(new URL(redirectUri).port);
    const hostname = new URL(redirectUri).hostname;
    const pending = listenForCallback(port, hostname, authorizeRequest.state, timeoutMs);
    console.log("\nOpening browser… (or copy the URL above into a browser)");
    openBrowser(url);
    callbackUrl = await pending;
  }
  console.log(`\n[callback] ${callbackUrl.replace(/(code|access_token|token)=[^&]+/gi, "$1=<redacted>")}`);

  const captured = codeFromUrl(callbackUrl);
  if (captured.state && captured.state !== authorizeRequest.state) {
    throw new Error("state mismatch (possible CSRF)");
  }
  if (captured.token && !captured.code) {
    return { access: captured.token, refresh: "", expiresAt: new Date(Date.now() + 365 * 864e5), via: "callback-token" };
  }
  console.log(`\n[exchange] POST through the shipped client (${label})…`);
  const result = await client.exchangeCode(captured.code, verifier, redirectUri, authorizeRequest.state);
  return { ...result, via: "code-exchange" };
}

async function runBrowserFlow(client, port, label) {
  const { verifier, challenge } = generatePKCE();
  const state = randomUUID();
  const redirectUri = client.browserRedirectUri ?? `http://${WINDSURF_PREFERRED_HOSTNAME}:${port}/callback`;
  return exchangeAndCapture(
    client,
    { state, codeChallenge: challenge, redirectUri },
    verifier,
    redirectUri,
    label,
  );
}

function persist(credential, result) {
  mkdirSync(dirname(outFile), { recursive: true });
  const payload = [
    `# captured ${new Date().toISOString()}`,
    `DEVIN_CRED=${credential}`,
    `VIA=${result.via ?? "unknown"}`,
    result.accountLabel ? `ACCOUNT=${result.accountLabel}` : "",
    result.expiresAt ? `EXPIRES_AT=${result.expiresAt.toISOString?.() ?? String(result.expiresAt)}` : "",
  ].filter(Boolean).join("\n") + "\n";
  writeFileSync(outFile, payload, "utf8");
  console.log(`\n[credential] written to ${outFile}`);
  if (hasFlag("show-secret")) console.log(`[credential] ${credential}`);
  else console.log(`[credential] ${redact(credential)} (use --show-secret to print)`);
}

/** Post-login upstream smoke: GetUserJwt then GetCliModelConfigs. */
async function smokeUpstream(credential) {
  console.log("\n=== upstream smoke (direct Connect-RPC) ===");
  console.log(`host: ${DEVIN_DEFAULT_BASE_URL}`);

  try {
    const jwt = await callDevinUnary(
      DEVIN_GET_USER_JWT_PATH,
      DevinMessageTypes.GetUserJwtRequest,
      DevinMessageTypes.GetUserJwtResponse,
      { metadata: devinCliMetadata(credential) },
      { baseUrl: DEVIN_DEFAULT_BASE_URL, signal: AbortSignal.timeout(30_000) },
    );
    console.log(`GetUserJwt: OK | userJwt=${jwt.userJwt ? "present" : "absent"} | customApiServerUrl=${jwt.customApiServerUrl ?? "-"}`);
  } catch (error) {
    console.log(`GetUserJwt: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  try {
    const cfg = await callDevinUnary(
      DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
      DevinMessageTypes.GetCliModelConfigsRequest,
      DevinMessageTypes.GetCliModelConfigsResponse,
      { metadata: devinDiscoveryMetadata(credential) },
      { baseUrl: DEVIN_DEFAULT_BASE_URL, signal: AbortSignal.timeout(30_000) },
    );
    const configs = cfg.clientModelConfigs ?? [];
    console.log(`GetCliModelConfigs: OK | ${configs.length} configs | default=${cfg.defaultOverrideModelConfig?.modelUid ?? "-"}`);
    const sample = configs.slice(0, 25).map((c) => `${c.modelUid} | ${c.label} | d=${c.disabled} | disp=${c.modelInfo?.displayOption ?? 0}`);
    for (const line of sample) console.log(`  ${line}`);
    if (configs.length > 25) console.log(`  … (${configs.length - 25} more)`);
    return true;
  } catch (error) {
    console.log(`GetCliModelConfigs: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// ── main ──

let result;
switch (mode) {
  case "devin":
    result = await runBrowserFlow(devinOAuthClient, 59653, "Devin CLI OAuth (app.devin.ai)");
    break;
  case "windsurf":
    result = await runBrowserFlow(devinWindsurfOAuthClient, WINDSURF_CALLBACK_PORT, "Windsurf Enterprise OAuth");
    break;
  case "cli": {
    console.log("probing Devin CLI credentials.toml:");
    for (const p of devinCliCredentialPaths()) console.log(`  ${p}`);
    const credential = await loginDevinCliHook();
    result = { access: credential, refresh: "", expiresAt: new Date(8640000000000000), via: "cli-adopt" };
    break;
  }
  case "paste": {
    const raw = await pasteUrl();
    const captured = codeFromUrl(raw);
    dump("captured callback params", captured.params);
    if (captured.token) {
      result = { access: captured.token, refresh: "", expiresAt: new Date(8640000000000000), via: "paste-token" };
    } else {
      const verifier = arg("verifier");
      if (!verifier) throw new Error("--verifier is required to exchange a pasted code");
      const client = arg("client", "devin") === "windsurf" ? devinWindsurfOAuthClient : devinOAuthClient;
      const redirectUri = client.browserRedirectUri ?? `http://127.0.0.1:${WINDSURF_CALLBACK_PORT}/callback`;
      result = { ...(await client.exchangeCode(captured.code, verifier, redirectUri, captured.state)), via: "paste-exchange" };
    }
    break;
  }
  case "import": {
    const credential = requireCred();
    result = { ...(await devinOAuthClient.importCredential({ credential, fields: {} })), via: "import" };
    break;
  }
  default:
    console.error(`unknown --mode=${mode} (devin|windsurf|cli|paste|import)`);
    process.exit(1);
}

dump("login result", {
  via: result.via,
  access: hasFlag("show-secret") ? result.access : redact(result.access),
  accountLabel: result.accountLabel ?? null,
  expiresAt: result.expiresAt,
  auth_state: result.auth_state ?? null,
});

persist(result.access, result);

if (!hasFlag("no-smoke")) {
  const ok = await smokeUpstream(result.access);
  console.log(`\n[smoke] ${ok ? "credential accepted by upstream ✅" : "credential NOT yet accepted (see error above) ❌"}`);
}
