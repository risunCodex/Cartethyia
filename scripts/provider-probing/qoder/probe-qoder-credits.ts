/**
 * Live Qoder daily-credits probe (sash campaign surface).
 *
 * Reads exported accounts from a JSON file, queries the campaign list on the
 * openapi host, prints every campaign with its structured status/benefit, and
 * — only when `--claim` is passed — attempts to claim campaigns that are
 * explicitly `CLAIMABLE` with a CREDITS benefit. Tokens are never printed.
 *
 *   bun run scripts/provider-probing/qoder/probe-qoder-credits.ts \
 *     --creds "C:\Users\...\qoder-accounts-<ts>.json"
 *
 *   # Also attempt the claim for CLAIMABLE CREDITS campaigns:
 *   bun run scripts/provider-probing/qoder/probe-qoder-credits.ts \
 *     --creds <file> --claim
 *
 *   # Probe the /reward grant endpoint for each campaign too:
 *   bun run scripts/provider-probing/qoder/probe-qoder-credits.ts \
 *     --creds <file> --reward
 *
 *   # Hunt: re-poll the campaign list until a CLAIMABLE CREDITS campaign
 *   # appears, then claim it immediately (list visibility flutters).
 *   # --wait is the max seconds to hunt (default 0 = single pass).
 *   bun run scripts/provider-probing/qoder/probe-qoder-credits.ts \
 *     --creds <file> --claim --wait 300
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  maskSecret,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
  type ExportedAccount,
} from "../lib/accounts";
import { formatProbe, probeGet, probePost } from "../lib/http";
import { buildCosyHeaders, type QoderProbeAuth } from "./cosy-signer";

const VERSION = "1.1.81";
const BASE = "https://openapi.qoder.sh";
const INFER = "https://api2.qoder.sh";
const CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
const CLAIM_PATH = "/sash/api/v1/me/campaigns";
const REWARD_PATH = "/sash/api/v1/me/campaigns";

interface Campaign {
  campaignKey?: string;
  actionType?: string;
  claimStatus?: string;
  benefit?: { kind?: string; amount?: number; modelScope?: string; durationDays?: number } | null;
  failureCode?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Desktop identity headers for the sash surface. Later same-account controls
 * showed the daily CREDITS campaign does not gate on machine identity, but the
 * sash surface still expects the desktop header set; we send a stable
 * per-account derived machineId (no tokens, no SG bridge).
 */
function sashHeaders(account: ExportedAccount): Record<string, string> {
  const machineId = account.authState?.machineId ?? randomUUID();
  return {
    Authorization: `Bearer ${requireAccountToken(account)}`,
    "User-Agent": "Qoder",
    "Content-Type": "application/json",
    Accept: "application/json",
    "Cosy-ClientType": "10",
    "Cosy-Version": VERSION,
    "cosy-machineid": machineId,
    "cosy-machinetoken": machineId,
    "cosy-machinetype": "18",
    "cosy-machinecode": "machine",
    "cosy-machineos": "x86_64_linux",
    "cosy-machinehostname": "desktop",
  };
}

function summarizeCampaign(c: Campaign): string {
  const parts: string[] = [];
  if (c.campaignKey) parts.push(`key=${c.campaignKey}`);
  if (c.actionType) parts.push(`action=${c.actionType}`);
  if (c.claimStatus) parts.push(`claim=${c.claimStatus}`);
  const b = c.benefit;
  if (b && typeof b === "object") {
    const fields: string[] = [];
    if (b.kind) fields.push(`kind=${b.kind}`);
    if (b.amount !== undefined) fields.push(`amount=${b.amount}`);
    if (b.modelScope) fields.push(`scope=${b.modelScope}`);
    if (b.durationDays !== undefined) fields.push(`days=${b.durationDays}`);
    if (fields.length > 0) parts.push(`benefit{${fields.join(",")}}`);
  }
  if (c.failureCode) parts.push(`failure=${c.failureCode}`);
  if (c.status) parts.push(`status=${c.status}`);
  return parts.join("  ");
}

function isCreditsClaimable(c: Campaign): boolean {
  return (
    c.claimStatus === "CLAIMABLE" &&
    c.actionType === "CLAIM_BENEFIT" &&
    c.benefit?.kind === "CREDITS"
  );
}

function proseAuth(account: ExportedAccount): QoderProbeAuth {
  return {
    userId: account.authState?.userId ?? "",
    userName: "",
    userType: "personal_standard",
    securityOauthToken: requireAccountToken(account),
    refreshToken: account.refreshToken ?? "",
  };
}

function bearerHeaders(account: ExportedAccount): Record<string, string> {
  return {
    Authorization: `Bearer ${requireAccountToken(account)}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Validates the activity-claim family from the trial research note:
 * the /algo activity list (COSY signed empty body) plus the openapi
 * eligibility / quota-reset / quota-usage endpoints.
 */
async function probeActivity(account: ExportedAccount): Promise<void> {
  const auth = proseAuth(account);
  console.log("\n== activity-claim family ==");

  const algo = `${INFER}/algo/api/v2/activity`;
  const signed = buildCosyHeaders(algo, "", auth, VERSION);
  const resAlgo = await probeGet(algo, signed, { timeoutMs: 25_000, bodyCap: 20_000 });
  console.log(formatProbe("activity COSY-signed GET", resAlgo));
  console.log(`  body: ${resAlgo.body.slice(0, 900)}`);

  const openapi = [
    { label: "eligibility", path: "/api/v2/activity/claim/eligibility" },
    { label: "quota-reset-latest", path: "/api/v2/activity/quota/reset/latest" },
    { label: "quota-usage", path: "/api/v2/quota/usage" },
  ] as const;

  for (const ep of openapi) {
    const url = `${BASE}${ep.path}`;
    const signedHeaders = buildCosyHeaders(url, "", auth, VERSION);
    const resSigned = await probeGet(url, signedHeaders, { timeoutMs: 20_000 });
    console.log(formatProbe(`${ep.label} COSY-signed GET`, resSigned));
    const resBearer = await probeGet(url, bearerHeaders(account), { timeoutMs: 20_000 });
    console.log(formatProbe(`${ep.label} Bearer GET`, resBearer));
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      creds: { type: "string", required: true },
      claim: { type: "boolean", default: false },
      reward: { type: "boolean", default: false },
      activity: { type: "boolean", default: false },
      wait: { type: "string", default: "0" },
    },
  });
  const accounts = readAccountsFile(values.creds!);
  const account = pickAccount(accounts, { providerId: "qoder" });
  const label = account.label ?? account.id ?? "account";
  console.log(`account: ${label} (${maskSecret(requireAccountToken(account), 3)})`);

  if (values.activity) {
    await probeActivity(account);
    return;
  }

  // 1. Campaign list on the /sash surface (GET). List visibility flutters,
  // so when hunting we re-poll every 5s until a CLAIMABLE CREDITS campaign
  // appears (or the wait budget is exhausted).
  const waitMs = Math.max(0, Number.parseInt(values.wait ?? "0", 10) * 1000);
  const deadline = Date.now() + waitMs;
  const intervalMs = 5_000;

  let campaigns: Campaign[] = [];
  let claimed = false;

  const fetchList = async (): Promise<Campaign[]> => {
    const listUrl = `${BASE}${CAMPAIGNS_PATH}`;
    const listRes = await probeGet(listUrl, sashHeaders(account), { timeoutMs: 25_000, bodyCap: 40_000 });
    const parsed = JSON.parse(listRes.body) as { data?: unknown; campaigns?: unknown };
    const data = parsed.data ?? parsed.campaigns;
    if (Array.isArray(data)) return data as Campaign[];
    if (Array.isArray(parsed)) return parsed as Campaign[];
    return [];
  };

  // 2. Optional /reward grant probe per campaign.
  if (values.reward) {
    const listUrl = `${BASE}${CAMPAIGNS_PATH}`;
    const listRes = await probeGet(listUrl, sashHeaders(account), { timeoutMs: 25_000, bodyCap: 40_000 });
    console.log(formatProbe("campaigns GET", listRes));
    campaigns = await fetchList();
    console.log(`\ncampaigns parsed: ${campaigns.length}`);
    for (const c of campaigns) console.log(`  - ${summarizeCampaign(c)}`);
    for (const c of campaigns) {
      const id = c.campaignId as string | undefined ?? c.campaignKey;
      if (!id) continue;
      const label = c.campaignKey ?? id;
      const url = `${BASE}${REWARD_PATH}/${encodeURIComponent(id)}/reward`;
      const res = await probeGet(url, sashHeaders(account), { timeoutMs: 20_000 });
      console.log(formatProbe(`reward ${label}`, res));
    }
  }

  // 3. Optional claim for CLAIMABLE CREDITS campaigns. Hunt: when the list
  // does not currently show a CREDITS campaign, re-poll until one appears or
  // the wait budget runs out.
  if (values.claim) {
    let targets = campaigns.filter(isCreditsClaimable);
    while (targets.length === 0 && Date.now() < deadline) {
      const remaining = Math.max(1, Math.round((deadline - Date.now()) / 1000));
      console.log(`\nno CREDITS campaign visible; re-polling in ${intervalMs / 1000}s (${remaining}s left)`);
      await new Promise((r) => setTimeout(r, intervalMs));
      campaigns = await fetchList();
      for (const c of campaigns) console.log(`  - ${summarizeCampaign(c)}`);
      targets = campaigns.filter(isCreditsClaimable);
    }
    if (targets.length === 0) {
      console.log("\nno CLAIMABLE CREDITS campaign appeared within the wait budget");
    }
    for (const c of targets) {
      const id = c.campaignId as string | undefined ?? c.campaignKey;
      if (!id) continue;
      const label = c.campaignKey ?? id;
      const url = `${BASE}${CLAIM_PATH}/${encodeURIComponent(id)}/claim`;
      const res = await probePost(url, sashHeaders(account), "{}", { timeoutMs: 25_000 });
      console.log(formatProbe(`claim ${label}`, res));
      console.log(`  body: ${res.head}`);
      if (res.status >= 200 && res.status < 300) claimed = true;
    }
    if (claimed) console.log("\nclaim attempted — see result above");
  }
}

void main();
