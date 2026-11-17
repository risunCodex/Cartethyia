/**
 * Qoder daily claim with the generated native identity.
 *
 * Identity is derived in-process (SHA-256 of the account id) through
 * `mintQoderGeneratedIdentity` / `qoderMachineHeaders`. The script keeps its
 * account JSON fresh by writing refreshed access/refresh tokens back to the
 * input file after a successful refresh.
 *
 * Usage:
 *   bun run scripts/tools/qoder-native-claim.ts <accounts.json> [proxy] [labelFilter]
 */
import {
  mintQoderGeneratedIdentity,
  qoderMachineHeaders,
} from "../../src/providers/integrations/qoder/qoder-umid";

const BASE = "https://openapi.qoder.sh";

const jsonPath = process.argv[2] ?? "";
const proxy = process.argv[3] || undefined;
const onlyLabel = process.argv[4];

if (!jsonPath) {
  console.log("usage: scripts/tools/qoder-native-claim.ts <accounts.json> [proxy] [labelFilter]");
  process.exit(1);
}

const doc = JSON.parse(await Bun.file(jsonPath).text()) as {
  accounts: Array<{
    id?: string;
    label: string;
    status?: string;
    accessToken: string;
    refreshToken?: string;
    authState?: { userId?: string; machineId?: string };
    lastClaimAt?: string;
    lastClaimAmount?: number;
    lastClaimCampaignKey?: string;
  }>;
};

const targets = doc.accounts.filter((account) => !onlyLabel || account.label === onlyLabel);
console.log(`native-claim: ${targets.length} account(s) | proxy=${proxy ?? "DIRECT"} | mint=generated`);

function headersFor(
  credential: string,
  identity: ReturnType<typeof mintQoderGeneratedIdentity>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: "application/json",
    "User-Agent": "Qoder",
    "Cosy-ClientType": "10",
    "Cosy-Version": "1.1.64",
    ...qoderMachineHeaders(identity),
  };
}

async function persistAccounts(): Promise<void> {
  await Bun.write(jsonPath, JSON.stringify(doc, null, 2));
}

async function refresh(
  account: (typeof doc.accounts)[number],
  identity: ReturnType<typeof mintQoderGeneratedIdentity>,
): Promise<string | null> {
  if (!account.refreshToken) return null;
  try {
    const res = await fetch(`${BASE}/api/v1/deviceToken/refresh`, {
      method: "POST",
      headers: { ...headersFor("", identity), "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: account.refreshToken,
        machine_id: account.authState?.machineId ?? identity.machineToken,
        machine_token: identity.machineToken,
      }),
      ...(proxy === undefined ? {} : { proxy }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as Record<string, unknown>;
    const deviceToken = String(json.device_token ?? "");
    if (!res.ok || !deviceToken) return null;
    account.accessToken = deviceToken;
    if (json.refresh_token) account.refreshToken = String(json.refresh_token);
    await persistAccounts();
    return deviceToken;
  } catch {
    return null;
  }
}

function classify(result: Record<string, unknown> | null): "CLAIMED" | "SAME_PERSON" | "REPLAYED" | "FAILED" {
  const status = String(result?.status ?? "").toUpperCase();
  const failure = String(result?.failureCode ?? "").toUpperCase();
  if (result?.success !== false && ["CLAIMED", "GRANTED", "SUCCESS"].includes(status)) return "CLAIMED";
  if (failure === "SAME_PERSON_ALREADY_CLAIMED" || status === "BLOCKED") return "SAME_PERSON";
  if (status === "CLAIMED") return "REPLAYED";
  return "FAILED";
}

async function attempt(account: (typeof doc.accounts)[number]): Promise<void> {
  const identity = mintQoderGeneratedIdentity(account.id ?? account.label);

  let credential = account.accessToken;
  const fresh = await refresh(account, identity);
  if (fresh) credential = fresh;

  const campaigns = await fetch(`${BASE}/sash/api/v1/me/campaigns`, {
    headers: headersFor(credential, identity),
    ...(proxy === undefined ? {} : { proxy }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await campaigns.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  const credits = ((parsed?.campaigns as unknown[]) ?? []).filter((entry) => {
    const record = entry as { benefit?: { kind?: string }; actionType?: string };
    return record.actionType === "CLAIM_BENEFIT" || record.benefit?.kind === "CREDITS";
  });

  if (credits.length === 0) {
    console.log(`[${account.label}] GET ${campaigns.status} → NO CREDITS`);
    return;
  }
  const credit = credits[0] as Record<string, unknown>;
  const claimStatus = String(credit.claimStatus ?? "").toUpperCase();
  const campaignId = String(credit.campaignId ?? "");
  console.log(`[${account.label}] GET ${campaigns.status} → ${String(credit.campaignKey ?? "unknown")} ${claimStatus}`);

  if (claimStatus === "CLAIMED") {
    account.lastClaimCampaignKey = String(credit.campaignKey ?? "");
    if (!account.lastClaimAt) {
      account.lastClaimAt = new Date().toISOString();
      account.lastClaimAmount = 100;
    }
    await persistAccounts();
    console.log(`[${account.label}] already claimed in this window`);
    return;
  }
  if (claimStatus !== "CLAIMABLE") return;

  const claimRes = await fetch(`${BASE}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`, {
    method: "POST",
    headers: { ...headersFor(credential, identity), "Content-Type": "application/json" },
    body: "{}",
    ...(proxy === undefined ? {} : { proxy }),
    signal: AbortSignal.timeout(20_000),
  });
  const claimRaw = await claimRes.text();
  let parsedClaim: Record<string, unknown> | null = null;
  try {
    parsedClaim = JSON.parse(claimRaw) as Record<string, unknown>;
  } catch {
    parsedClaim = null;
  }
  const verdict = classify(parsedClaim);

  if (verdict === "CLAIMED") {
    account.lastClaimAt = new Date().toISOString();
    account.lastClaimAmount = Number((parsedClaim?.benefit as { amount?: number } | undefined)?.amount ?? 100);
    account.lastClaimCampaignKey = String(parsedClaim?.campaignKey ?? credit.campaignKey ?? "");
    await persistAccounts();
    console.log(`[${account.label}] CLAIMED +${account.lastClaimAmount}`);
  } else if (verdict === "SAME_PERSON") {
    account.lastClaimAt = new Date().toISOString();
    account.lastClaimAmount = 100;
    await persistAccounts();
    console.log(`[${account.label}] SAME_PERSON`);
  } else if (verdict === "REPLAYED") {
    console.log(`[${account.label}] replayed`);
  } else {
    console.log(`[${account.label}] CLAIM HTTP ${claimRes.status}: ${claimRaw.slice(0, 160)}`);
  }
}

for (const account of targets) {
  await attempt(account);
}
