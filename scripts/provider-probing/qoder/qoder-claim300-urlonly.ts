/**
 * Qoder claim300 URL-only helper — builds the device-flow URL (client
 * redirect_uri, UMID-backed machine_id), opens it in the default browser,
 * and polls until approved. No cookie injection, no temp Chrome.
 *
 *   bun run scripts/provider-probing/qoder/qoder-claim300-urlonly.ts \
 *     --account "C:/.../qoder-balable-base.json" \
 *     --out "C:/.../qoder-balable-client.json" \
 *     [--open]
 */
import { parseArgs } from "node:util";
import { writeFileSync, existsSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const CLIENT_REDIRECT = "qoder://aicoding.aicoding-agent/login-success";
const DEVICE_POLL_URL = "https://openapi.qoder.sh/api/v1/deviceToken/poll";

const args = parseArgs({
  options: {
    account: { type: "string", required: true },
    out: { type: "string", default: "" },
    open: { type: "boolean", default: false },
    timeout: { type: "string", default: "300" },
  },
});

const acct = JSON.parse(await Bun.file(args.values.account!).text());
const a = acct.accounts[0];
if (!a) { console.error("no account in file"); process.exit(1); }
const machineId = a.machineId || a.authState?.machineId || "";
if (!machineId) { console.error("no machineId in account"); process.exit(1); }
const outPath = args.values.out || args.values.account!.replace(/\.json$/, "-client.json");
if (existsSync(outPath)) { console.error(`output exists: ${outPath}`); process.exit(1); }

// PKCE S256 + nonce (persis qoder_claim_trial.py)
const verifier = randomBytes(32).toString("base64url").replace(/=+$/, "");
const challenge = createHash("sha256").update(verifier).digest("base64url").replace(/=+$/, "");
const nonce = randomUUID().replaceAll("-", "");
const params = new URLSearchParams({
  nonce,
  challenge,
  challenge_method: "S256",
  redirect_uri: CLIENT_REDIRECT,
  machine_id: machineId,
});
const url = `https://qoder.com/device/selectAccounts?${params.toString()}`;

console.log("=== Qoder claim300 (URL-only) ===");
console.log(`  account: ${a.label || a.id}`);
console.log(`  machine id: ${machineId}`);
console.log(`  URL:\n  ${url}`);
console.log("  Polling…");

if (args.values.open) {
  const child = process.platform === "win32"
    ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
    : process.platform === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

const deadline = Date.now() + Number(args.values.timeout) * 1000;
while (Date.now() < deadline) {
  const res = await fetch(
    `${DEVICE_POLL_URL}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`,
    { headers: { accept: "application/json", "user-agent": "Go-http-client/2.0" } },
  );
  const status = res.status;
  if (status === 200) {
    const d = await res.json().catch(() => ({}));
    const token = d.token || d.accessToken;
    if (token) {
      const userId = d.user_id || d.userId || d.userid || "";
      const account = {
        ...a,
        accessToken: token,
        refreshToken: d.refresh_token || d.refreshToken || token,
        authState: { userId, machineId },
        createdAt: new Date().toISOString(),
      };
      writeFileSync(outPath, JSON.stringify({ exportedAt: new Date().toISOString(), accounts: [account] }, null, 2));
      console.log("==============================================");
      console.log("  Login complete ✓");
      console.log(`  Saved: ${outPath}`);
      console.log(`  userId: ${userId}`);
      console.log("==============================================");
      process.exit(0);
    }
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.error("login timed out");
process.exit(1);
