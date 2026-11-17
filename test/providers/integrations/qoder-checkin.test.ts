/**
 * Qoder daily check-in: legacy sash status/claim, campaign fallback, and the
 * state it reports to the shared sweep ledger.
 */
import { expect, test } from "bun:test";
import {
  buildCampaignHeaders,
  claimSashCampaign,
  fetchQoderDailyCheckin,
  isQoderCheckinProvider,
  listSashCampaigns,
} from "../../../src/providers/integrations/qoder/qoder-checkin";
import type { QoderNativeIdentityStore } from "../../../src/providers/integrations/qoder/qoder-native-identity-store";
import type { QoderNativeIdentity } from "../../../src/providers/integrations/qoder/qoder-umid";
import type { NativeIdentityRecord } from "../../../src/persistence/schema";

const BASE = "https://openapi.qoder.sh";
const STATUS_URL = `${BASE}/sash/api/v1/me/daily-check-in/status`;
const CLAIM_URL = `${BASE}/sash/api/v1/me/daily-check-in/claim`;
const CAMPAIGNS_URL = `${BASE}/sash/api/v1/me/campaigns`;
const CAMPAIGN_CLAIM_URL = `${BASE}/sash/api/v1/me/campaigns/camp-1/claim`;

function statusBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "CLAIMABLE",
    currentStreakDays: 3,
    totalClaimDays: 10,
    rewardCredits: 100,
    totalRewardCredits: 1000,
    nextClaimAt: 0,
    lastClaimedAt: 0,
    rewardExpiresAt: 0,
    ...overrides,
  });
}

function fakeFetcher(routes: Array<{ url: string; method: string; status: number; body: string }>) {
  const calls: string[] = [];
  const requests: Array<{ method: string; url: string; headers: Record<string, string> | undefined }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    requests.push({ method, url, headers: init?.headers as Record<string, string> | undefined });
    const route = routes.find((r) => r.url === url && r.method === method);
    if (!route) return new Response("unexpected request", { status: 500 });
    return new Response(route.body, { status: route.status });
  };
  return { fetcher, calls, requests };
}

test("isQoderCheckinProvider covers both realms", () => {
  expect(isQoderCheckinProvider("qoder")).toBe(true);
  expect(isQoderCheckinProvider("qodercn")).toBe(true);
  expect(isQoderCheckinProvider("cb")).toBe(false);
});

test("campaign headers carry the desktop identity, plus native UMID when provided", () => {
  const base = buildCampaignHeaders("tok");
  expect(base["Authorization"]).toBe("Bearer tok");
  expect(base["Cosy-ClientType"]).toBe("10");
  expect(base["User-Agent"]).toBe("Qoder");
  expect(base["Cosy-Version"]).toBeTruthy();
  expect(base["cosy-machinetoken"]).toBeUndefined();

  const native = buildCampaignHeaders("tok", {
    "cosy-machinetoken": "native-token",
    "cosy-machineos": "x86_64_win32",
  });
  expect(native["cosy-machinetoken"]).toBe("native-token");
  expect(native["cosy-machineos"]).toBe("x86_64_win32");
  expect(native["Cosy-ClientType"]).toBe("10");
});

test("already claimed today short-circuits before any claim POST", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const { fetcher, calls } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 200, body: statusBody({ status: "CLAIMED", lastClaimedAt: nowSec }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a1",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("already_claimed");
  expect(result.streakDays).toBe(3);
  expect(calls).toEqual([`GET ${STATUS_URL}`]);
});

test("claimable status claims and reports the 100 credit grant with streak", async () => {
  const { fetcher, calls } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 200, body: statusBody() },
    { url: CLAIM_URL, method: "POST", status: 200, body: JSON.stringify({ success: true, status: "CLAIMED" }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a2",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("claimed");
  expect(result.credit).toBe(100);
  expect(result.streakDays).toBe(3);
  expect(calls).toEqual([`GET ${STATUS_URL}`, `POST ${CLAIM_URL}`]);
});

test("a 409 from the claim resolves to already_claimed", async () => {
  const { fetcher } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 200, body: statusBody() },
    { url: CLAIM_URL, method: "POST", status: 409, body: JSON.stringify({ error: "ALREADY_CLAIMED" }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a3",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("already_claimed");
});

test("legacy 404 falls back to the CREDITS campaign claim", async () => {
  const campaignList = JSON.stringify({
    campaigns: [
      {
        campaignId: "camp-1",
        campaignKey: "daily-credits",
        claimStatus: "CLAIMABLE",
        actionType: "CLAIM_BENEFIT",
        benefit: { kind: "CREDITS", amount: 100 },
      },
    ],
  });
  const { fetcher, calls, requests } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 404, body: "" },
    { url: CAMPAIGNS_URL, method: "GET", status: 200, body: campaignList },
    { url: CAMPAIGN_CLAIM_URL, method: "POST", status: 200, body: JSON.stringify({ status: "CLAIMED", benefit: { amount: 100 } }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a4",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("claimed");
  expect(result.credit).toBe(100);
  expect(calls).toContain(`POST ${CAMPAIGN_CLAIM_URL}`);

  // The campaign surface requires the desktop client headers; without them the
  // upstream hides the list (showCampaign=false) and the grant never appears.
  const campaignGet = requests.find((r) => r.url === CAMPAIGNS_URL && r.method === "GET");
  expect(campaignGet?.headers?.["Cosy-ClientType"]).toBe("10");
  expect(campaignGet?.headers?.["User-Agent"]).toBe("Qoder");
  expect(campaignGet?.headers?.["Cosy-Version"]).toBeTruthy();
  const claimPost = requests.find((r) => r.url === CAMPAIGN_CLAIM_URL && r.method === "POST");
  expect(claimPost?.headers?.["Cosy-ClientType"]).toBe("10");
  expect(claimPost?.headers?.["Content-Type"]).toBe("application/json");
});

test("legacy 404 with no claimable campaign reports unavailable", async () => {
  const { fetcher } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 404, body: "" },
    { url: CAMPAIGNS_URL, method: "GET", status: 200, body: JSON.stringify({ campaigns: [] }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a5",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("unavailable");
});

test("a rejected credential errors without touching the claim path", async () => {
  const { fetcher, calls } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 401, body: "" },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a6",
    credential: "bad",
    fetcher,
  });
  expect(result.state).toBe("error");
  expect(calls).toEqual([`GET ${STATUS_URL}`]);
});

test("missing credential fails closed", async () => {
  const { fetcher } = fakeFetcher([]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a7",
    credential: "",
    fetcher,
  });
  expect(result.state).toBe("error");
});

/** In-memory store double recording bind calls, with a pre-seeded record. */
function fakeStore(seed?: NativeIdentityRecord): QoderNativeIdentityStore & { readonly bound: NativeIdentityRecord[] } {
  const bound: NativeIdentityRecord[] = [];
  let current = seed;
  return {
    bound,
    get: async () => current,
    occupied: async () => new Set<string>(),
    bind: async (_providerId, _accountId, record) => {
      current = record;
      bound.push(record);
    },
  };
}

const STORED_3: NativeIdentityRecord = {
  machineToken: "stored-token",
  machineType: "x86_64_linux",
  machineCode: "stored-code",
};

test("bound identity is tried first and its claim is persisted as the slot", async () => {
  // Legacy surface absent; the bare headers see no campaign, while the bound
  // identity (machine token `stored-token`) exposes the claimable CREDITS one.
  const claimable = JSON.stringify({
    campaigns: [
      {
        campaignId: "camp-1",
        campaignKey: "daily-credits",
        claimStatus: "CLAIMABLE",
        actionType: "CLAIM_BENEFIT",
        benefit: { kind: "CREDITS", amount: 100 },
      },
    ],
  });
  const calls: Array<{ method: string; url: string; headers?: Record<string, string> }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ method, url, ...(headers !== undefined ? { headers } : {}) });
    const native = headers?.["cosy-machinetoken"];
    if (url === STATUS_URL) return new Response("", { status: 404 });
    if (url === CAMPAIGNS_URL) {
      const body = native === STORED_3.machineToken ? claimable : JSON.stringify({ campaigns: [] });
      return new Response(body, { status: 200 });
    }
    if (url === CAMPAIGN_CLAIM_URL) {
      return new Response(JSON.stringify({ status: "CLAIMED", benefit: { amount: 100 } }), { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const store = fakeStore(STORED_3);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a8",
    credential: "tok",
    fetcher,
    nativeIdentity: STORED_3,
    nativeIdentityStore: store,
  });
  expect(result.state).toBe("claimed");
  expect(result.credit).toBe(100);
  // The claim was made under the stored machine token.
  const claimPost = calls.find((c) => c.method === "POST" && c.url === CAMPAIGN_CLAIM_URL);
  expect(claimPost?.headers?.["cosy-machinetoken"]).toBe("stored-token");
  // Already bound → no new bind call.
  expect(store.bound).toEqual([]);
});

test("a bound identity that already claimed today is terminal and reused", async () => {
  // Bare headers see no campaign (unavailable); the bound identity's campaign
  // is already claimed — terminal, no enumeration fallback, no re-bind.
  const claimed = JSON.stringify({
    campaigns: [
      {
        campaignId: "camp-1",
        claimStatus: "CLAIMED",
        actionType: "CLAIM_BENEFIT",
        benefit: { kind: "CREDITS", amount: 100 },
      },
    ],
  });
  const campaignGets: Array<Record<string, string> | undefined> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    if (url === STATUS_URL) return new Response("", { status: 404 });
    if (url === CAMPAIGNS_URL) {
      campaignGets.push(headers);
      const native = headers?.["cosy-machinetoken"];
      return new Response(native === STORED_3.machineToken ? claimed : JSON.stringify({ campaigns: [] }), { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const store = fakeStore(STORED_3);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a9",
    credential: "tok",
    fetcher,
    nativeIdentity: STORED_3,
    nativeIdentityStore: store,
  });
  expect(result.state).toBe("already_claimed");
  // Two probes: the basic one and the bound one. No enumeration fallback.
  expect(campaignGets.length).toBe(2);
  expect(campaignGets[1]?.["cosy-machinetoken"]).toBe("stored-token");
  expect(store.bound).toEqual([]);
});

test("a bound identity reporting unavailable is honest and does not steal another slot", async () => {
  const campaignGets: Array<Record<string, string> | undefined> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    if (url === STATUS_URL) return new Response("", { status: 404 });
    if (url === CAMPAIGNS_URL) {
      campaignGets.push(headers);
      return new Response(JSON.stringify({ campaigns: [] }), { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const store = fakeStore(STORED_3);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a10",
    credential: "tok",
    fetcher,
    nativeIdentity: STORED_3,
    nativeIdentityStore: store,
  });
  expect(result.state).toBe("unavailable");
  // Two probes: basic, then the bound identity — and no enumeration fallback,
  // so the account keeps its slot instead of stealing another's.
  expect(campaignGets.length).toBe(2);
  expect(campaignGets[1]?.["cosy-machinetoken"]).toBe("stored-token");
  expect(store.bound).toEqual([]);
});

test("a bound identity that errors falls back to the alternative identity, and the winner is persisted", async () => {
  const claimable = JSON.stringify({
    campaigns: [
      {
        campaignId: "camp-1",
        campaignKey: "daily-credits",
        claimStatus: "CLAIMABLE",
        actionType: "CLAIM_BENEFIT",
        benefit: { kind: "CREDITS", amount: 100 },
      },
    ],
  });
  const calls: Array<{ method: string; url: string; headers?: Record<string, string> }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ method, url, ...(headers !== undefined ? { headers } : {}) });
    const native = headers?.["cosy-machinetoken"];
    if (url === STATUS_URL) return new Response("", { status: 404 });
    if (url === CAMPAIGNS_URL) {
      if (native === STORED_3.machineToken) return new Response("", { status: 500 });
      if (native === "fb-token") return new Response(claimable, { status: 200 });
      return new Response(JSON.stringify({ campaigns: [] }), { status: 200 });
    }
    if (url === CAMPAIGN_CLAIM_URL) {
      return new Response(JSON.stringify({ status: "CLAIMED", benefit: { amount: 100 } }), { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const store = fakeStore(STORED_3);
  const fallbackIdentity: QoderNativeIdentity = {
    machineToken: "fb-token",
    machineType: "x86_64_linux",
    machineCode: "fb-code",
    isVm: false,
    source: "runtime-info",
  };
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a11",
    credential: "tok",
    fetcher,
    nativeIdentity: STORED_3,
    nativeIdentityStore: store,
    identities: [fallbackIdentity],
  });
  expect(result.state).toBe("claimed");
  // The fallback identity's token was used for the claim.
  const claimPost = calls.find((c) => c.method === "POST" && c.url === CAMPAIGN_CLAIM_URL);
  expect(claimPost?.headers?.["cosy-machinetoken"]).toBe("fb-token");
  // The winning fallback identity was persisted as the new device.
  expect(store.bound).toEqual([{ machineToken: "fb-token", machineType: "x86_64_linux", machineCode: "fb-code" }]);
});

// --- Shared sash client (claimSashCampaign / listSashCampaigns) ---
// These are the one owner of the campaign claim idempotence map that both the
// daily check-in and the manual credit-claim surface delegate to.

test("claimSashCampaign maps the idempotence states and carries the amount", async () => {
  const headers = buildCampaignHeaders("tok");
  const claim = (body: string, status = 200) =>
    fakeFetcher([{ url: CAMPAIGN_CLAIM_URL, method: "POST", status, body }]);

  // A fresh claim reports its granted amount.
  const claimed = claim(JSON.stringify({ status: "CLAIMED", amount: 100 }));
  const claimedResult = await claimSashCampaign(BASE, "camp-1", headers, claimed.fetcher);
  expect(claimedResult).toEqual({ state: "claimed", amount: 100, status: 200 });

  // A replay is an already-claimed grant, not an error — and keeps the amount.
  const replayed = claim(JSON.stringify({ status: "CLAIMED", failureCode: "REPLAYED", amount: 100 }), 200);
  const replayedResult = await claimSashCampaign(BASE, "camp-1", headers, replayed.fetcher);
  expect(replayedResult.state).toBe("already_claimed");
  expect(replayedResult.amount).toBe(100);

  // A bare HTTP 409 is also an already-claimed grant.
  const conflict = claim(JSON.stringify({ error: "ALREADY_CLAIMED" }), 409);
  const conflictResult = await claimSashCampaign(BASE, "camp-1", headers, conflict.fetcher);
  expect(conflictResult.state).toBe("already_claimed");

  // The same-person block is honest ineligibility, not a failure.
  const blocked = claim(JSON.stringify({ status: "BLOCKED", failureCode: "SAME_PERSON_ALREADY_CLAIMED" }), 200);
  const blockedResult = await claimSashCampaign(BASE, "camp-1", headers, blocked.fetcher);
  expect(blockedResult.state).toBe("not_eligible");
  expect(blockedResult.amount).toBeNull();

  // Any other failure is an error carrying the upstream status.
  const failed = claim("not-json", 500);
  const failedResult = await claimSashCampaign(BASE, "camp-1", headers, failed.fetcher);
  expect(failedResult.state).toBe("error");
  expect(failedResult.status).toBe(500);

  // A transport failure reports status 0 so callers can name it distinctly.
  const throwing = (async () => {
    throw new Error("offline");
  }) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  const offlineResult = await claimSashCampaign(BASE, "camp-1", headers, throwing);
  expect(offlineResult).toEqual({ state: "error", amount: null, status: 0 });
});

test("listSashCampaigns normalizes camelCase rows and returns null when the surface is absent", async () => {
  const headers = buildCampaignHeaders("tok");
  const body = JSON.stringify({
    campaigns: [
      {
        campaignId: "camp-1",
        campaignKey: "daily-credits",
        claimStatus: "CLAIMABLE",
        actionType: "CLAIM_BENEFIT",
        benefit: { kind: "CREDITS", amount: 100 },
      },
    ],
  });
  const ok = fakeFetcher([{ url: CAMPAIGNS_URL, method: "GET", status: 200, body }]);
  const campaigns = await listSashCampaigns(BASE, headers, ok.fetcher);
  expect(campaigns).not.toBeNull();
  expect(campaigns![0]).toMatchObject({
    campaign_id: "camp-1",
    campaign_key: "daily-credits",
    claim_status: "CLAIMABLE",
    action_type: "CLAIM_BENEFIT",
  });

  const missing = fakeFetcher([{ url: CAMPAIGNS_URL, method: "GET", status: 404, body: "" }]);
  expect(await listSashCampaigns(BASE, headers, missing.fetcher)).toBeNull();

  const offline = fakeFetcher([]);
  expect(await listSashCampaigns(BASE, headers, offline.fetcher)).toBeNull();
});


