/**
 * GitHub Copilot device-code login with the **OpenCode desktop client's** OAuth
 * app (`Ov23li8tweQw6odWQebz`), which is distinct from the Copilot Chat
 * extension's app used by the console's normal GitHub login.
 *
 * The OpenCode client's app is what the `opencode-copilot` wire mode presents
 * upstream; the token minted here carries the same entitlement check as the
 * console login, so an account without Copilot access is rejected before any
 * token is stored.
 *
 *   bun run scripts/provider-probing/github/github-opencode-login.ts \
 *     --out D:\tmp\scratch\github-opencode.json [--label "my account"] [--open]
 *
 * The output file matches the `ExportedAccount` shape read by the probe
 * scripts, so it can be passed straight to
 * `github-auto-multiturn-probe.ts --creds <file>`.
 */
import { parseArgs } from "node:util";
import { writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  GithubOAuthClient,
  GITHUB_OPENCODE_CLIENT_ID,
} from "../../../src/providers/integrations/github/github-oauth";

const args = parseArgs({
  options: {
    out: { type: "string", required: true },
    label: { type: "string", default: "" },
    open: { type: "boolean", default: false },
  },
});

const outPath = args.values.out!;
if (existsSync(outPath)) {
  console.error(`output file already exists: ${outPath}`);
  process.exit(1);
}

const client = new GithubOAuthClient(globalThis.fetch, GITHUB_OPENCODE_CLIENT_ID);
const started = await client.startDeviceAuth({
  providerId: "github",
  tenantId: null,
  accountLabel: args.values.label ?? "",
});

console.log("==============================================");
console.log("  GitHub Copilot device login (OpenCode client)");
console.log("==============================================");
console.log(`  OAuth app: ${GITHUB_OPENCODE_CLIENT_ID} (opencode)`);
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
    providerId: "github",
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
    id: `github-opencode-device-${Date.now()}`,
    providerId: "github",
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
  console.log(`  Expires at: ${result.expiresAt.toISOString()}`);
  console.log(`  Saved to: ${outPath}`);
  console.log("");
  console.log("Next: probe it with");
  console.log(`  bun run scripts/provider-probing/github/github-auto-multiturn-probe.ts --creds "${outPath}"`);
  process.exit(0);
}

console.error("login timed out — please retry and approve sooner");
process.exit(1);
