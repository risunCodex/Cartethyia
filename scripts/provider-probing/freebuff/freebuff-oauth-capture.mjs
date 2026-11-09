/**
 * Freebuff OAuth capture — code login + poll → token.
 * Language: JavaScript (Bun), file: scripts/provider-probing/freebuff/freebuff-oauth-capture.mjs
 *
 * Drives the Freebuff code-login flow (reconstructed from the Desktop
 * 0.0.201 bundle): `POST /api/auth/cli/code` issues a hosted login URL and a
 * fingerprint; the operator signs in in the browser; polling
 * `/api/auth/cli/status` returns the `authToken`. The token is written to a
 * scratch file (redacted unless `--show-secret`).
 *
 * Usage:
 *   bun scripts/provider-probing/freebuff/freebuff-oauth-capture.mjs
 *   bun scripts/provider-probing/freebuff/freebuff-oauth-capture.mjs --out=D:/tmp/scratch/freebuff-probe/credential.txt
 *   bun scripts/provider-probing/freebuff/freebuff-oauth-capture.mjs --no-browser
 *   bun scripts/provider-probing/freebuff/freebuff-oauth-capture.mjs --poll=5000 --timeout=300000
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AUTH_HOST, fbFetch, redact, arg, hasFlag, openBrowser, base64UrlEncode } from "./_lib.mjs";

const outFile = arg("out", "D:/tmp/scratch/freebuff-probe/credential.txt");
const pollIntervalMs = Number(arg("poll", "2000"));
const timeoutMs = Number(arg("timeout", "300000"));
const CODE_PATH = "/api/auth/cli/code";
const STATUS_PATH = "/api/auth/cli/status";

async function issueCode() {
  const fingerprintId = randomUUID();
  const res = await fbFetch(`${AUTH_HOST}${CODE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fingerprintId }),
    timeoutMs: 15000,
  });
  const data = res.json;
  if (!data || typeof data !== "object") throw new Error("login code response is invalid");
  const loginUrl = typeof data.loginUrl === "string" ? data.loginUrl : null;
  const fingerprintHash = typeof data.fingerprintHash === "string" ? data.fingerprintHash : "";
  const expiresAt = Number(data.expiresAt);
  const expiresInMs = Number(data.expiresInMs);
  if (!loginUrl) throw new Error("login code response missing loginUrl");
  if (!fingerprintHash) throw new Error("login code response missing fingerprintHash");
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw new Error("login code response has invalid expiresAt");
  return { fingerprintId, fingerprintHash, expiresAt, expiresInMs, loginUrl };
}

async function pollStatus({ fingerprintId, fingerprintHash, expiresAt }, deadline) {
  while (Date.now() < deadline) {
    const url = `${AUTH_HOST}${STATUS_PATH}?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(fingerprintHash)}&expiresAt=${expiresAt}`;
    let user = null;
    try {
      const res = await fbFetch(url, { timeoutMs: 10000, allowNonOk: true });
      if (res.ok && res.json?.user) user = res.json.user;
    } catch {
      // transient poll failure — keep polling
    }
    if (user?.authToken) {
      return {
        token: user.authToken,
        user: {
          ...(typeof user.id === "string" ? { id: user.id } : {}),
          ...(typeof user.email === "string" ? { email: user.email } : {}),
          ...(typeof user.name === "string" ? { name: user.name } : {}),
        },
      };
    }
    await Bun.sleep(pollIntervalMs);
  }
  throw new Error("sign-in timed out — no token within the deadline");
}

function persistCredential(cred) {
  mkdirSync(dirname(outFile), { recursive: true });
  const lines = [
    `# freebuff captured ${new Date().toISOString()}`,
    `FREEBUFF_TOKEN=${cred.token}`,
    ...(cred.user?.id ? [`FREEBUFF_USER_ID=${cred.user.id}`] : []),
    ...(cred.user?.email ? [`FREEBUFF_USER_EMAIL=${cred.user.email}`] : []),
  ];
  writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
  console.log(`\n[credential] written to ${outFile}`);
  if (hasFlag("show-secret")) console.log(`[credential] ${cred.token}`);
  else console.log(`[credential] ${redact(cred.token)} (use --show-secret to print)`);
}

async function main() {
  console.log(`Freebuff OAuth capture — ${AUTH_HOST}`);
  const code = await issueCode();
  console.log(`\n[code] issued fingerprintId=${code.fingerprintId}`);
  console.log(`[code] expiresAt=${new Date(code.expiresAt).toISOString()} expiresInMs=${code.expiresInMs ?? "n/a"}`);

  const launchPath = `/auth/login/launch/${base64UrlEncode(new TextEncoder().encode(code.loginUrl)).slice(0, 8)}…`;
  console.log(`[login] hosted URL (open in browser):`);
  console.log(`        ${code.loginUrl}`);
  console.log(`\nOpening browser… (or copy the URL above); launch path hint: ${launchPath}`);
  if (!hasFlag("no-browser")) openBrowser(code.loginUrl);

  const deadline = Math.min(Date.now() + timeoutMs, Number(code.expiresAt));
  console.log(`\n[poll] waiting for sign-in (until ${new Date(deadline).toISOString()})…`);
  const cred = await pollStatus(code, deadline);

  console.log(`\n[auth] got token ${redact(cred.token)} user=${JSON.stringify(cred.user)}`);
  persistCredential(cred);
}

main().catch((err) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
