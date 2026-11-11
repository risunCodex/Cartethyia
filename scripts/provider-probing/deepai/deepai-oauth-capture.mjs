/**
 * DeepAI OAuth capture — desktop sign-in flow (loopback exchange).
 * Language: JavaScript (Bun), file: scripts/provider-probing/deepai/deepai-oauth-capture.mjs
 *
 * Drives the DeepAI desktop sign-in flow reconstructed from the 0.3.35
 * bundle: it prints the hosted URL, waits for the loopback callback
 * (`http://127.0.0.1:<port>/callback?code=…`), exchanges the code at
 * `/deepai_code/desktop_auth/exchange/`, and persists the resulting
 * `{ api_key, username, is_pro }` credential to a JSON file matching the
 * `ExportedAccount` shape the probes read.
 *
 * Usage:
 *   bun scripts/provider-probing/deepai/deepai-oauth-capture.mjs
 *   bun ... --out=D:/tmp/scratch/deepai-probe/accounts.json
 *   bun ... --no-browser
 *   bun ... --show-secret
 *   bun ... --timeout=300000
 */

import { createServer } from "node:http";
import { dirname } from "node:path";

import {
  arg,
  hasFlag,
  redact,
  openBrowser,
  deepaiFetch,
  persistAccount,
  makeState,
  DEEPAI_API_ORIGIN,
  PATH_SIGNIN,
  PATH_EXCHANGE,
} from "./_lib.mjs";

const outFile = arg("out", "D:/tmp/scratch/deepai-probe/accounts.json");
const timeoutMs = Number(arg("timeout", "300000"));
const label = arg("label", "deepai");

/** One-shot loopback listener. Resolves with the full callback URL. */
function listenForCallback(port, expectedState, signalMs) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
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
      res.end("<!doctype html><meta charset=utf-8><h3>DeepAI login captured</h3><p>You can close this tab.</p>");
      server.close();
      resolve(url.toString());
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[loopback] listening on http://127.0.0.1:${port}/callback`);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`loopback timed out after ${signalMs}ms`));
    }, signalMs);
    timer.unref?.();
    server.on("close", () => clearTimeout(timer));
  });
}

function pickPort() {
  return 40000 + Math.floor(Math.random() * 10000);
}

async function main() {
  const state = makeState();
  const port = pickPort();
  const signInUrl = `${PATH_SIGNIN}?state=${encodeURIComponent(state)}&port=${port}`;

  console.log(`DeepAI OAuth capture — ${DEEPAI_API_ORIGIN}`);
  console.log(`\n[login] hosted URL (open in browser):`);
  console.log(`        ${signInUrl}`);
  console.log(`\nOpening browser… (or copy the URL above)`);

  const pending = listenForCallback(port, state, timeoutMs);
  if (!hasFlag("no-browser")) openBrowser(signInUrl);
  const callbackUrl = await pending;

  console.log(`\n[callback] ${callbackUrl.replace(/(code|token)=[^&]+/gi, "$1=<redacted>")}`);
  const code = new URL(callbackUrl).searchParams.get("code");
  if (!code) throw new Error("callback has no code");

  console.log(`\n[exchange] POST ${PATH_EXCHANGE} …`);
  const res = await deepaiFetch(PATH_EXCHANGE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { code },
    timeoutMs: 20000,
  });
  const d = res.json;
  if (!d || typeof d.api_key !== "string" || !d.api_key) {
    throw new Error(`invalid sign-in response (status ${res.status}): ${res.text.slice(0, 300)}`);
  }

  const account = {
    providerId: "deepai",
    label,
    credentialKind: "deepai-api-key",
    status: "active",
    accessToken: d.api_key,
    authState: {
      userId: typeof d.username === "string" ? d.username : undefined,
      isPro: d.is_pro === true ? true : undefined,
    },
    createdAt: new Date().toISOString(),
  };
  console.log(`\n[auth] got api_key ${redact(d.api_key)} username=${d.username ?? "-"} is_pro=${d.is_pro === true}`);
  persistAccount(account, outFile);
  if (hasFlag("show-secret")) console.log(`[credential] ${d.api_key}`);
}

main().catch((err) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
