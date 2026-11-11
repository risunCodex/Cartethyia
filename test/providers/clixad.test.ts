/**
 * Clixad provider tests: catalog rows, quota collector, device-flow OAuth.
 */
import { describe, expect, test } from "bun:test";
import { CLIXAD_DEFAULT_MODELS, CLIXAD_SPEC } from "../../src/providers/integrations/clixad/provider";
import { fetchClixadQuota } from "../../src/providers/integrations/clixad/clixad-quota";
import { ClixadOAuthClient } from "../../src/providers/integrations/clixad/clixad-oauth";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";

const TOKEN = "adg_test_token";

describe("Clixad catalog", () => {
  test("spec targets the chat wire", () => {
    expect(CLIXAD_SPEC.provider_id).toBe("clixad");
    expect(CLIXAD_SPEC.endpoint_paths_by_wire_family?.chat).toBe("/chat/completions");
  });

  test("free tier rows bill zero and carry the freeTier marker", () => {
    expect(CLIXAD_DEFAULT_MODELS.length).toBe(5);
    for (const model of CLIXAD_DEFAULT_MODELS) {
      expect(model.freeTier).toBe(true);
      expect(model.cost.input).toBe(0);
      expect(model.cost.output).toBe(0);
      expect(model.cost.pricing_model).toBe("pay-per-use");
      expect(model.endpointPath).toBe("/chat/completions");
    }
  });

  test("all five live-verified free rows are present", () => {
    const ids = CLIXAD_DEFAULT_MODELS.map((m) => m.modelId).sort();
    expect(ids).toEqual([
      "claude-haiku-5.5",
      "deepseek-v4-flash",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash-lite",
      "gpt-5-nano",
    ]);
  });
});

describe("fetchClixadQuota", () => {
  function fetcher(wallet: unknown): FetchLike {
    return (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/v1/wallet")) {
        return new Response(JSON.stringify(wallet), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as FetchLike;
  }

  test("reads balance, daily free tier, and reward cap", async () => {
    const result = await fetchClixadQuota(
      TOKEN,
      fetcher({
        balance: 85200,
        ads_today: 0,
        earned_usd_today: 0.6,
        max_reward_usd_per_day: 5,
        free_tier: {
          models: ["gpt-5-nano", "gemini-2.5-flash-lite", "claude-haiku-5.5", "deepseek-v4-flash", "gemini-3.5-flash-lite"],
          daily_credits: 120000,
          credits_left: 119963,
          turns_left: { "gpt-5-nano": 499, "gemini-2.5-flash-lite": 307, "claude-haiku-5.5": 290, "deepseek-v4-flash": 247, "gemini-3.5-flash-lite": 82 },
          recommended: "deepseek-v4-flash",
        },
      }),
    );
    expect(result.error).toBeNull();
    const kinds = result.windows.map((w) => w.kind);
    expect(kinds).toContain("credits");
    expect(kinds).toContain("free_daily");
    expect(kinds).toContain("earn_usd_daily");

    const credits = result.windows.find((w) => w.kind === "credits");
    expect(credits?.remaining).toBe(85200);
    expect(credits?.accounting).toBe("pooled");

    const free = result.windows.find((w) => w.kind === "free_daily");
    expect(free?.limit).toBe(120000);
    expect(free?.used).toBe(37);
    expect(free?.usedPercent).toBeCloseTo(37 / 120000 * 100, 5);
    expect(free?.accounting).toBe("pooled");
    expect(free?.resetsAt).not.toBeNull();

    const earn = result.windows.find((w) => w.kind === "earn_usd_daily");
    expect(earn?.limit).toBe(5);
    expect(earn?.used).toBeCloseTo(0.6, 5);
    expect(earn?.accounting).toBe("independent");
  });

  test("returns empty windows when wallet read fails", async () => {
    const result = await fetchClixadQuota(TOKEN, fetcher(null));
    expect(result.plan).toBeNull();
    expect(result.windows).toEqual([]);
    expect(result.error).not.toBeNull();
  });

  test("returns an error on 401", async () => {
    const result = await fetchClixadQuota(
      TOKEN,
      (async () => new Response("unauthorized", { status: 401 })) as unknown as FetchLike,
    );
    expect(result.error).not.toBeNull();
    expect(result.windows).toEqual([]);
  });
});

describe("ClixadOAuthClient", () => {
  function stubFetch() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes("/v1/auth/device/start")) {
        return new Response(
          JSON.stringify({
            session: "sess-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 899,
            interval: 5,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/auth/device/poll")) {
        return new Response(
          JSON.stringify({
            status: "complete",
            token: "adg_complete",
            userId: "u1",
            email: "a@b.c",
            login: "github-user",
            default_model: "deepseek-v4-flash",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  test("device start surfaces the GitHub verification URL", async () => {
    const { fetchImpl } = stubFetch();
    const client = new ClixadOAuthClient(fetchImpl);
    const start = await client.startDeviceAuth();
    expect(start.verificationUri).toBe("https://github.com/login/device");
    expect(start.userCode).toBe("ABCD-EFGH");
    expect(start.deviceAuthId).toBe("sess-1");
    expect(start.intervalSeconds).toBe(5);
    expect(start.expiresInSeconds).toBe(899);
  });

  test("poll complete returns the bearer token with identity", async () => {
    const { fetchImpl, calls } = stubFetch();
    const client = new ClixadOAuthClient(fetchImpl);
    const poll = await client.pollDeviceAuth("sess-1", {
      providerId: "clixad",
      tenantId: null,
      accountLabel: "a@b.c",
      providerState: JSON.stringify({ session: "sess-1" }),
    });
    expect(poll.status).toBe("complete");
    if (poll.status === "complete") {
      expect(poll.result.access).toBe("adg_complete");
      expect(poll.result.accountLabel).toBe("a@b.c");
      expect(poll.result.auth_state?.["userId"]).toBe("u1");
      expect(poll.result.auth_state?.["login"]).toBe("github-user");
    }
    const pollCall = calls.find((c) => c.url.includes("/v1/auth/device/poll"));
    expect(pollCall).toBeDefined();
    expect(JSON.parse(String(pollCall?.init?.body))).toEqual({ session: "sess-1" });
  });

  test("poll pending returns pending", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/v1/auth/device/poll")) {
        return new Response(JSON.stringify({ status: "pending" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const client = new ClixadOAuthClient(fetchImpl);
    const poll = await client.pollDeviceAuth("sess-1");
    expect(poll.status).toBe("pending");
  });
});
