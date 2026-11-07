/**
 * Free-pi OAuth capture — device flow → token → scratch credential.
 *
 * Reproduces the shipped 0.6.14 client flow:
 *
 *   1. POST /auth/github/device  -> print verification URI + user code
 *   2. POST /auth/consent (consent_version "4") — unless --no-consent
 *   3. POST /auth/token in a loop until issued (or consent_required)
 *   4. Persist the JWT as a console-shaped account export to --out
 *      (never printed; only a masked prefix is shown)
 *
 * Usage:
 *   bun run scripts/provider-probing/freepi/freepi-oauth-capture.ts
 *     --out D:/tmp/scratch/freepi-probe/accounts.json
 *   bun run ... --no-consent --timeout-ms 600000
 *
 * The operator completes the login in the browser; the script polls until the
 * token is issued or the deadline passes.
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  FREEPI_BASE_URL,
  maskJwt,
  pollDeviceToken,
  startDeviceFlow,
  submitConsent,
} from "./freepi-shared";

const args = parseArgs({
  options: {
    out: { type: "string", default: "D:/tmp/scratch/freepi-probe/accounts.json" },
    "no-consent": { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "300000" },
    "interval-ms": { type: "string", default: "5000" },
  },
});
const v = args.values;
const baseUrl = FREEPI_BASE_URL;

console.log(`free-pi device login @ ${baseUrl}`);
const device = await startDeviceFlow(baseUrl);
console.log(`\nOpen: ${device.verification_uri}`);
console.log(`Enter code: ${device.user_code}`);
if (device.verification_uri_complete) console.log(`\nDirect link: ${device.verification_uri_complete}`);
console.log(`\nWaiting for browser login (timeout ${Number(v["timeout-ms"]) / 1000}s)…`);

if (!v["no-consent"]) {
  await submitConsent(baseUrl, device.session_id);
  console.log("consent submitted (consent_version 4)");
} else {
  console.log("--no-consent: skipping consent submission");
}

const token = await pollDeviceToken(baseUrl, device.session_id, {
  intervalMs: Number(v["interval-ms"]),
  deadlineMs: Number(v["timeout-ms"]),
  onPending: (body) => {
    const status = String(body["status"] ?? "pending");
    const opened = body["opened"] === true;
    if (status === "pending" && opened) console.log("login in progress… (browser opened)");
    else if (status === "pending") console.log("login in progress…");
  },
});

console.log(`\nJWT issued: ${maskJwt(token)}`);

const account = {
  providerId: "freepi",
  label: "freepi-device",
  credentialKind: "oauth",
  status: "active",
  accessToken: token,
  refreshToken: undefined,
  authState: {},
};

mkdirSync(dirname(v.out!), { recursive: true });
writeFileSync(v.out!, JSON.stringify({ exportedAt: new Date().toISOString(), accounts: [account] }, null, 2), "utf8");
console.log(`credential written to ${v.out} (never printed)`);
