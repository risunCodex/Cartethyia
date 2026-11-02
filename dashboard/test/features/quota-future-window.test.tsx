import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import QuotaPage from "../../src/features/quota/QuotaPage";
import { AccountRow } from "../../src/features/provider-detail/sections/AccountRow";
import type { ProviderAccountResponse } from "../../src/data/contracts";
import type { QuotaEntry, QuotaOverview } from "../../src/hooks/quota";
import { queryKeys } from "../../src/data/query-keys";
import { mount, renderMarkup } from "../helpers/render";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("future grants show their start without a usable meter or enabling the account", async () => {
  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  const account: QuotaEntry = {
    id: "future-account", provider: "zcode-start", name: "Future account", credentialHint: "oauth",
    active: false, health: null, providerName: "ZCode", providerIcon: "",
    quota: {
      source: "zcode-start", status: "ready", plan: "Start Plan", fetchedAt: null,
      lastAttemptAt: null, lastSuccessAt: null, error: null,
      windows: [{
        label: "Future trial", accounting: "independent", remainingPercent: 100,
        resetsAt: null, startsAt, modelIds: ["glm-5.3"], used: 0, limit: 100,
      }],
    },
  };
  const data: QuotaOverview = { providers: [{ id: "zcode-start", name: "ZCode" }], accounts: [account] };
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json(data);
  }, { preconnect: originalFetch.preconnect });
  const view = await mount(createElement(QuotaPage), { seed: [{ key: queryKeys.quota.all, data }] });
  try {
    expect(view.text()).toContain("Not started yet");
    expect(view.text()).toContain(new Date(startsAt).toLocaleString());
    expect(view.text()).toContain("Models: glm-5.3");
    expect(view.find('[role="progressbar"]')).toBeNull();
    expect(view.find('button[aria-label="Claim gifts for Future account"]')).not.toBeNull();
    const available = [...view.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Turn on Available"));
    expect(available).toBeDefined();
    await view.act(() => available!.click());
    await view.flush();
    expect(requests.some((path) => path.endsWith("/accounts/batch"))).toBe(false);
  } finally {
    view.unmount();
  }
});

test("provider account rows show future model grants beside, not inside, usable quota", () => {
  const usage = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const account: ProviderAccountResponse = {
    id: "start-account", providerId: "zcode-start", tenantId: "tenant", label: "Start account",
    credentialKind: "api_key", status: "active", usageToday: usage, usageAllTime: usage,
    createdAt: "2026-01-01T00:00:00Z", sortIndex: 0,
  };
  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  const html = renderMarkup(createElement(AccountRow, {
    providerId: "zcode-start", account, selected: false,
    onToggleSelect: () => undefined, onDelete: () => undefined,
    quota: [
      { label: "Current grant", accounting: "independent", remainingPercent: 25, resetsAt: null, modelIds: ["glm-5.3"] },
      { label: "Next grant", accounting: "independent", remainingPercent: 100, resetsAt: null, startsAt, modelIds: ["glm-5.3-flash"] },
    ],
  }));
  expect(html).toContain("25% left");
  expect(html).not.toContain("100% left");
  expect(html).toContain("Next grant");
  expect(html).toContain("glm-5.3-flash");
  expect(html).toContain("Not started yet");
  expect(html).toContain(new Date(startsAt).toLocaleString());
  expect(html).toContain('aria-label="Claim gifts for Start account"');
});

test("uncapped purchased/free balance remains readable without a fabricated percentage", () => {
  const account: QuotaEntry = {
    id: "commandcode-account", provider: "commandcode", name: "Go account", credentialHint: "api_key",
    active: true, health: null, providerName: "Commandcode", providerIcon: "commandcode",
    quota: {
      source: "commandcode", status: "ready", plan: "Go", fetchedAt: null,
      lastAttemptAt: null, lastSuccessAt: null, error: null,
      windows: [{
        kind: "additional_credits", label: "Purchased/free credits", accounting: "pooled",
        remainingPercent: null, remaining: 150, limit: null, used: null, resetsAt: null,
      }],
    },
  };
  const data: QuotaOverview = { providers: [{ id: "commandcode", name: "Commandcode" }], accounts: [account] };
  const html = renderMarkup(createElement(QuotaPage), { seed: [{ key: queryKeys.quota.all, data }] });
  expect(html).toContain("Purchased/free credits");
  expect(html).toContain("150 left");
  expect(html).toContain("150 Credits remaining");
  expect(html).toContain('aria-valuetext="150 credits remaining"');
  expect(html).not.toContain('aria-valuenow="0"');
});
