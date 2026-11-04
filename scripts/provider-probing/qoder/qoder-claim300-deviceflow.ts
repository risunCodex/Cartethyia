/**
 * Qoder claim300 device-flow login (UMID-backed).
 *
 * Target: Pro Trial 300 credits. This script performs the *login* half of
 * the claim: it builds the Qoder device-flow URL from the genuine vendor UMID
 * (`runtime-info` bridge, via `qoder-umid.ts`), polls until the operator
 * approves, and saves the account **together with the UMID identity and its
 * seed** so the next step (CLI login -> Pro Trial grant) can replay the exact
 * same device identity. Saving the seed is what makes the identity reusable —
 * losing it changes the device fingerprint and revokes the binding.
 *
 * Machine id sent to the device flow is derived deterministically from the
 * UMID machine token (sha256 hex, 32 chars); `machine_token` carries the
 * genuine `P1gA…` token. This ties the approved device to a real vendor
 * identity instead of a random/spoofed one.
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/qoder-claim300-deviceflow.ts \
 *     --out "D:\tmp\scratch\qoder-claim300-1.json" \
 *     [--label "acc-1"] [--realm intl|cn] [--open] \
 *     [--seed "<stored seed>"] [--account-id "<id>"]
 *
 * Output shape (compatible with `probe-qoder.ts --creds <file>`):
 *   { exportedAt, accounts: [ {
 *       id, providerId, label, credentialKind, status,
 *       accessToken, refreshToken, authState, expiresAt, createdAt,
 *       nativeIdentity: { machineToken, machineType, machineCode, source },
 *       nativeSeed, machineId
 *     } ] }
 *
 * Next step after login (claim Pro Trial):
 *   login Qoder CLI with a PAT minted for this account (web session), then run
 *   the high-quality injector (`qoder_injector.py` / `qoder_claim_trial.py`)
 *   reusing the stored seed. The seed is required to replay the same UMID.
 */
import { parseArgs } from "node:util";
import { writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  QoderOAuthClient,
} from "../../../src/providers/integrations/qoder/qoder-oauth";
import type { QoderRealm } from "../../../src/providers/integrations/qoder/qoder-realm";
import {
  mintQoderNativeIdentity,
  replayQoderNativeIdentity,
  type QoderNativeIdentity,
} from "../../../src/providers/integrations/qoder/qoder-umid";
import { maskSecret } from "../lib/accounts";

const args = parseArgs({
  options: {
    out: { type: "string", required: true },
    label: { type: "string", default: "" },
    realm: { type: "string", default: "intl" },
    open: { type: "boolean", default: false },
    seed: { type: "string", default: "" },
    "account-id": { type: "string", default: "" },
  },
});

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
const accountId = args.values["account-id"] || `claim300-${randomUUID()}`;
const label = args.values.label || accountId;

// ---- 1. UMID: mint or replay (must keep the seed!) ---------------------
let identity: QoderNativeIdentity;
let nativeSeed: string;
if (args.values.seed) {
  const replayed = replayQoderNativeIdentity(args.values.seed, accountId);
  if (!replayed) {
    console.error("UMID replay failed — seed may be invalid for this host");
    process.exit(1);
  }
  identity = replayed;
  nativeSeed = args.values.seed;
} else {
  const minted = mintQoderNativeIdentity(accountId);
  if (!minted) {
    console.error(
      "no native UMID bridge available on this host; refusing to fall back to a " +
        "generated identity (claim300 must be backed by a genuine vendor identity)",
    );
    process.exit(1);
  }
  identity = minted.identity;
  nativeSeed = minted.seed;
}
if (!nativeSeed) {
  console.warn("! seed empty — on this host the identity is not replayable; keep the account on this machine");
}

// Machine id derived from the UMID token (stable, genuine-backed).
const machineId = createHash("sha256").update(identity.machineToken).digest("hex").slice(0, 32);

console.log("=== Qoder claim300 device login (UMID-backed) ===");
console.log(`  account id: ${accountId}`);
console.log(`  label: ${label}`);
console.log(`  realm: ${realm}`);
console.log(`  umid source: ${identity.source}`);
console.log(`  machine token: ${maskSecret(identity.machineToken, 6)}`);
console.log(`  machine type: ${identity.machineType} (len ${identity.machineType.length})`);
console.log(`  machine code: ${identity.machineCode} (len ${identity.machineCode.length})`);
console.log(`  derived machine id: ${machineId}`);
console.log(`  seed stored: ${nativeSeed ? `yes (${nativeSeed.length} B)` : "no"}`);

// ---- 2. Build device flow with the UMID-backed machine identity ----------
const client = new QoderOAuthClient(globalThis.fetch, realm);
const started = await client.startDeviceAuth({
  providerId: realm === "cn" ? "qodercn" : "qoder",
  tenantId: null,
  accountLabel: label,
  parameters: {
    machine_id: machineId,
    machine_token: identity.machineToken,
  },
});

console.log("==============================================");
console.log("  Open the URL, sign in, approve the device.");
console.log("==============================================");
console.log(`  URL: ${started.verificationUri}`);
console.log(`  Expires in: ${started.expiresInSeconds}s`);
console.log("  Polling…");

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
    accountLabel: label,
    providerState: started.providerState,
  });
  if (polled.status === "pending") {
    const wait = polled.retryAfterSeconds ?? started.intervalSeconds;
    await new Promise((r) => setTimeout(r, Math.max(1, wait) * 1000));
    continue;
  }
  if (polled.status === "slow_down") {
    const wait = polled.retryAfterSeconds ?? 5;
    await new Promise((r) => setTimeout(r, Math.max(1, wait) * 1000));
    continue;
  }
  if (polled.status === "failed") {
    console.error(`  login failed: ${polled.reason}`);
    process.exit(1);
  }

  // complete
  const result = polled.result;
  const account = {
    id: `qoder-claim300-${Date.now()}`,
    providerId: realm === "cn" ? "qodercn" : "qoder",
    label,
    credentialKind: "oauth",
    status: "active",
    accessToken: result.access,
    refreshToken: result.refresh,
    authState: result.auth_state,
    expiresAt: result.expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    nativeIdentity: {
      machineToken: identity.machineToken,
      machineType: identity.machineType,
      machineCode: identity.machineCode,
      source: identity.source,
    },
    nativeSeed,
    machineId,
  };

  writeFileSync(outPath, JSON.stringify({ exportedAt: new Date().toISOString(), accounts: [account] }, null, 2));

  console.log("");
  console.log("==============================================");
  console.log("  Login complete ✓");
  console.log("==============================================");
  console.log(`  Label: ${label}`);
  console.log(`  Expires at: ${result.expiresAt.toISOString()}`);
  console.log(`  Saved (account + UMID info + seed): ${outPath}`);
  console.log("");
  console.log("Next (claim 300): mint a PAT for this account via the web session,");
  console.log("  then login the Qoder CLI with it and run the high-quality injector");
  console.log("  — replaying the stored seed so the same UMID is used:");
  console.log(`  bun run scripts/provider-probing/qoder/qoder-claim300-deviceflow.ts --out <next> --seed "<the stored seed>"`);
  console.log(`  # then: QODER_PERSONAL_ACCESS_TOKEN="pt-…" qodercli-wake --list-models`);
  process.exit(0);
}

console.error("login timed out — retry and approve sooner");
process.exit(1);
