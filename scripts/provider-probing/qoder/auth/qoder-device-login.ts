/**
 * Qoder device-code login (1:1 with the desktop IDE flow).
 *
 * Starts the device flow using the same client id, PKCE alphabet, and nonce
 * shape the desktop IDE uses, prints the login URL, then polls until the
 * operator approves. The resulting account (access token, refresh token,
 * identity) is written to the requested JSON file — tokens are never printed.
 *
 *   bun run scripts/provider-probing/qoder/auth/qoder-device-login.ts \
 *     --out D:\tmp\scratch\qoder-new.json [--label "my account"] \
 *     [--realm intl|cn] [--open]
 *
 * The output file matches the `ExportedAccount` shape read by the probe
 * scripts, so it can be passed straight to `probe-qoder.ts --creds <file>`.
 */
import { parseArgs } from "node:util";
import { writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  QoderOAuthClient,
  qoderHardwareMachineId,
} from "../../../../src/providers/integrations/qoder/qoder-oauth";
import type { QoderRealm } from "../../../../src/providers/integrations/qoder/qoder-realm";

const args = parseArgs({
  options: {
    out: { type: "string", required: true },
    label: { type: "string", default: "" },
    realm: { type: "string", default: "intl" },
    open: { type: "boolean", default: false },
    machineId: { type: "string", default: "" },
    machineToken: { type: "string", default: "" },
  },
});

const machineIdArg = args.values.machineId || process.env.QODER_IDE_MACHINE_ID || "";
const machineTokenArg = args.values.machineToken || process.env.QODER_IDE_MACHINE_TOKEN || "";

const realm = (args.values.realm ?? "intl") as QoderRealm;
if (realm !== "intl" && realm !== "cn") {
  console.error(`unknown realm: ${realm} (use intl or cn)`);
  process.exit(1);
}
const outPath = args.values.out!;
if (existsSync(outPath)) {
  console.error(`output file already exists: ${outPath}`);
  process.exit(1);
}

const client = new QoderOAuthClient(globalThis.fetch, realm);
const hardwareMachineId = qoderHardwareMachineId();
const usingOverride = machineIdArg !== "";
console.log(`machine id: ${usingOverride ? "override (" + machineIdArg.slice(0, 8) + "…)" : hardwareMachineId ? "hardware (" + hardwareMachineId.slice(0, 8) + "…)" : "random (hardware unreadable)"}`);
const started = await client.startDeviceAuth({
  providerId: realm === "cn" ? "qodercn" : "qoder",
  tenantId: null,
  accountLabel: args.values.label ?? "",
  parameters: {
    ...(machineIdArg ? { machine_id: machineIdArg } : {}),
    ...(machineTokenArg ? { machine_token: machineTokenArg } : {}),
  },
});

console.log("==============================================");
console.log("  Qoder device login (IDE wire)");
console.log("==============================================");
console.log(`  URL: ${started.verificationUri}`);
if (started.userCode) console.log(`  Code: ${started.userCode}`);
console.log(`  Expires in: ${started.expiresInSeconds}s`);
console.log("");
console.log("Open that URL, sign in, and approve the device.");
console.log("Polling…");

if (args.values.open) {
  const url = started.verificationUri;
  const child = process.platform === "win32"
    ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
    : process.platform === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

const deadline = Date.now() + started.expiresInSeconds * 1000;

while (Date.now() < deadline) {
  const polled = await client.pollDeviceAuth(started.deviceAuthId, {
    providerId: realm === "cn" ? "qodercn" : "qoder",
    tenantId: null,
    accountLabel: args.values.label ?? "",
    providerState: started.providerState,
  });
  if (polled.status === "pending") {
    const wait = polled.retryAfterSeconds ?? started.intervalSeconds;
    await new Promise((r) => setTimeout(r, Math.max(1, wait) * 1000));
    continue;
  }
  if (polled.status === "slow_down") {
    const wait = polled.retryAfterSeconds ?? 5;
    console.log("  (slow down, waiting)");
    await new Promise((r) => setTimeout(r, Math.max(1, wait) * 1000));
    continue;
  }
  if (polled.status === "failed") {
    console.error(`  login failed: ${polled.reason}`);
    process.exit(1);
  }
  // complete
  const result = polled.result;
  const label = result.accountLabel ?? args.values.label ?? "";
  const account = {
    id: `qoder-device-${Date.now()}`,
    providerId: realm === "cn" ? "qodercn" : "qoder",
    label,
    credentialKind: "oauth",
    status: "active",
    accessToken: result.access,
    refreshToken: result.refresh,
    authState: result.auth_state,
    expiresAt: result.expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(outPath, JSON.stringify({ accounts: [account] }, null, 2));
  console.log("");
  console.log("==============================================");
  console.log("  Login complete ✓");
  console.log("==============================================");
  console.log(`  Label: ${label || "(no label)"}`);
  const id = result.auth_state && "userId" in result.auth_state
    ? String(result.auth_state.userId)
    : "(unknown)";
  console.log(`  User id: ${id}`);
  console.log(`  Expires at: ${result.expiresAt.toISOString()}`);
  console.log(`  Saved to: ${outPath}`);
  console.log("");
  console.log("Next: probe it with");
  console.log(`  bun run scripts/provider-probing/qoder/chat/probe-qoder.ts --creds "${outPath}" --model qfmodel`);
  process.exit(0);
}

console.error("login timed out — please retry and approve sooner");
process.exit(1);
