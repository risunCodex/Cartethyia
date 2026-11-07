// Devin quota collector tests: fake Connect transport, no network.
// Guards the Free/QUOTA plan behaviour — legacy credit buckets must stay
// hidden — and the int64 Long decoding that used to render "0 / 2,500".

import { describe, expect, test } from "bun:test";
import { fetchDevinQuota } from "../../src/providers/integrations/devin/devin-quota";
import { DevinMessageTypes } from "../../src/providers/integrations/devin/protocol/devin-proto";
import { DevinEnums } from "../../src/providers/integrations/devin/protocol/devin-proto";

function statusResponse(overrides: {
  billingStrategy?: number;
  hideDaily?: boolean;
  hideWeekly?: boolean;
} = {}): Buffer {
  const payload = {
    userStatus: {
      teamId: "devin-team$account-test",
      email: "test@example.com",
      teamsTier: DevinEnums.TeamsTier.DEVIN_FREE,
      planStatus: {
        // Legacy credit buckets are present and non-zero on QUOTA plans too.
        availablePromptCredits: 2500,
        usedPromptCredits: 0,
        availableFlowCredits: 500,
        usedFlowCredits: 0,
        dailyQuotaRemainingPercent: 95,
        weeklyQuotaRemainingPercent: 98,
        dailyQuotaResetAtUnix: 1794124800,
        weeklyQuotaResetAtUnix: 1794124800,
        planStart: 0,
        planEnd: 0,
      },
    },
    planInfo: {
      planName: "Free",
      teamsTier: DevinEnums.TeamsTier.DEVIN_FREE,
      billingStrategy: overrides.billingStrategy ?? DevinEnums.BillingStrategy.QUOTA,
      hideDailyQuota: overrides.hideDaily ?? false,
      hideWeeklyQuota: overrides.hideWeekly ?? false,
      monthlyPromptCredits: 2500,
      monthlyFlowCredits: 500,
      monthlyFlexCreditPurchaseAmount: 0,
    },
  };
  return Buffer.from(DevinMessageTypes.GetUserStatusResponse.encode(payload).finish());
}

function fakeFetch(body: Buffer): typeof fetch {
  return (async () => new Response(new Uint8Array(body), { status: 200 })) as unknown as typeof fetch;
}

describe("Devin quota collector", () => {
  test("QUOTA plan shows only daily + weekly windows", async () => {
    const result = await fetchDevinQuota("devin-session-token$test", fakeFetch(statusResponse()));
    expect(result.error).toBeNull();
    expect(result.plan).toBe("Free");
    expect(result.windows.map((w) => w.label)).toEqual(["Daily Quota", "Weekly Quota"]);
    expect(result.windows[0]!.remainingPercent).toBe(95);
    expect(result.windows[1]!.remainingPercent).toBe(98);
    expect(result.windows[0]!.resetsAt).toBe("2026-11-08T08:00:00.000Z");
  });

  test("hidden quota flags drop the corresponding window", async () => {
    const result = await fetchDevinQuota("devin-session-token$test", fakeFetch(statusResponse({ hideDaily: true })));
    expect(result.windows.map((w) => w.label)).toEqual(["Weekly Quota"]);
  });

  test("CREDITS plan shows legacy buckets, not quota rows", async () => {
    const result = await fetchDevinQuota(
      "devin-session-token$test",
      fakeFetch(statusResponse({ billingStrategy: DevinEnums.BillingStrategy.CREDITS as number })),
    );
    const labels = result.windows.map((w) => w.label);
    expect(labels).toContain("Prompt Credits");
    expect(labels).toContain("Flow Credits");
    expect(labels).not.toContain("Daily Quota");
    expect(labels).not.toContain("Weekly Quota");
    // int64 Long decoding: available credits must read 2500, not 0.
    const prompt = result.windows.find((w) => w.kind === "prompt");
    expect(prompt?.remaining).toBe(2500);
    expect(prompt?.limit).toBe(2500);
    expect(prompt?.usedPercent).toBe(0);
  });

  test("failed upstream is non-fatal", async () => {
    const failing = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const result = await fetchDevinQuota("bad", failing);
    expect(result.windows).toEqual([]);
    expect(result.error).not.toBeNull();
  });
});
