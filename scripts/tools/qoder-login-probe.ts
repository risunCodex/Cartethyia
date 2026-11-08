/**
 * Standalone Qoder device-flow login probe (intl).
 *
 * Generates the login URL, polls for approval, then prints the full poll body
 * and userinfo response so operator-facing identity fields can be inspected
 * without living under the test tree.
 *
 * Usage: bun run scripts/tools/qoder-login-probe.ts [label]
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

const base64UrlEncode = (buffer: Buffer): string => buffer.toString("base64url");

const LOGIN_URL = "https://qoder.com/device/selectAccounts";
const POLL_URL = "https://openapi.qoder.sh/api/v1/deviceToken/poll";
const USERINFO_URL = "https://openapi.qoder.sh/api/v1/userinfo";
const INTERVAL_MS = 5_000;
const EXPIRES_MS = 300_000;

const label = process.argv[2] ?? `login-${new Date().toISOString().slice(5, 16).replace("T", "-")}`;

const verifier = base64UrlEncode(randomBytes(32));
const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
const nonce = randomUUID().replaceAll("-", "");
const machineId = randomUUID();

const loginUrl = `${LOGIN_URL}?${new URLSearchParams({
  challenge,
  challenge_method: "S256",
  machine_id: machineId,
  nonce,
}).toString()}`;

console.log("=== QODER DEVICE LOGIN (intl) ===");
console.log("label      :", label);
console.log("machineId  :", machineId);
console.log("nonce      :", nonce);
console.log("\nOpen this URL in a browser and sign in:\n");
console.log(`${loginUrl}\n`);

console.log("Polling every 5 seconds (up to 5 minutes)…");
const start = Date.now();
let pollBody: Record<string, unknown> | null = null;
while (Date.now() - start < EXPIRES_MS) {
  const res = await fetch(
    `${POLL_URL}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`,
    {
      headers: { accept: "application/json", "user-agent": "Go-http-client/2.0" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (res.status === 202 || res.status === 404) {
    process.stdout.write(".");
    await Bun.sleep(INTERVAL_MS);
    continue;
  }
  const raw = await res.text();
  console.log(`\npoll HTTP ${res.status}`);
  if (!res.ok) {
    console.log("FAILED:", raw.slice(0, 300));
    process.exit(1);
  }
  pollBody = JSON.parse(raw) as Record<string, unknown>;
  break;
}

if (!pollBody) {
  console.log("\nTIMEOUT — no approval arrived within 5 minutes.");
  process.exit(1);
}

console.log("\n=== POLL RESPONSE (all fields) ===");
console.log(JSON.stringify(pollBody, null, 2));

const accessToken = String(pollBody.token ?? "");
if (!accessToken) {
  console.log("Poll completed without a token — upstream shape changed?");
  process.exit(1);
}

console.log("\n=== USERINFO (GET /api/v1/userinfo) ===");
let info: Record<string, unknown> = {};
try {
  const res = await fetch(USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": "Go-http-client/2.0",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    info = JSON.parse(raw) as Record<string, unknown>;
    console.log(JSON.stringify(info, null, 2));
  } catch {
    console.log("raw:", raw.slice(0, 500));
  }
} catch (error) {
  console.log("userinfo failed:", error instanceof Error ? error.message : String(error));
}

const userId = String(pollBody.user_id ?? info.id ?? info.userId ?? info.user_id ?? "");
console.log("\n=== IMPORT SUMMARY ===");
console.log(
  JSON.stringify(
    {
      label: String(info.name || info.email || label),
      accessToken,
      refreshToken: String(pollBody.refresh_token ?? ""),
      authState: { userId, machineId },
      extra: { userType: info.user_type ?? info.userType ?? null, email: info.email ?? null },
    },
    null,
    2,
  ),
);
