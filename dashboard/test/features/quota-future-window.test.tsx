import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import QuotaPage from "../../src/features/quota/QuotaPage";
import { AccountRow } from "../../src/features/provider-detail/sections/AccountRow";
import type { ProviderAccountResponse } from "../../src/data/contracts";
import type { QuotaEntry, QuotaOverview } from "../../src/hooks/quota";
import { queryKeys } from "../../src/data/query-keys";
import { mount, renderMarkup } from "../helpers/render";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });

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
  Date.now = () => Date.parse("2026-11-02T12:00:00Z");
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
      { label: "Expired referral", accounting: "independent", remainingPercent: 90, remaining: 90, recurring: true, resetsAt: new Date(Date.now()).toISOString(), modelIds: ["glm-5.3"] },
    ],
  }));
  expect(html).toContain("1 of 1 models available");
  expect(html).not.toContain("100% left");
  expect(html).not.toContain("90% left");
  expect(html).toContain("Expired referral");
  expect(html).toContain("Expired");
  expect(html).not.toContain('data-tone="warn"');
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

test("expired scoped grants are history and never enable an account, including at the expiry boundary", async () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  Date.now = () => now;
  const data: QuotaOverview = {
    providers: [{ id: "zcode-start", name: "ZCode" }],
    accounts: [{
      id: "expired", provider: "zcode-start", name: "Expired account", credentialHint: "oauth",
      active: false, health: null, providerName: "ZCode", providerIcon: "",
      quota: {
        source: "zcode-start", status: "ready", plan: null, fetchedAt: null,
        lastAttemptAt: null, lastSuccessAt: null, error: null,
        windows: [{ label: "Old referral", accounting: "independent", remainingPercent: 80,
          remaining: 80, resetsAt: new Date(now).toISOString(), recurring: true, modelIds: ["glm-5.3"] }],
      },
    }],
  };
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json(data);
  }, { preconnect: originalFetch.preconnect });
  const view = await mount(createElement(QuotaPage), { seed: [{ key: queryKeys.quota.all, data }] });
  try {
    expect(view.text()).toContain("Expired");
    expect(view.text()).toContain("Old referral");
    expect(view.find('[role="progressbar"]')).toBeNull();
    const available = [...view.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Turn on Available"));
    await view.act(() => available!.click());
    await view.flush();
    expect(requests.some((path) => path.endsWith("/accounts/batch"))).toBe(false);
  } finally { view.unmount(); }
});

test("bulk actions use current model alternatives and account-wide constraints, not future balances", async () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  Date.now = () => now;
  const grant = { label: "Current", accounting: "independent" as const, remainingPercent: 0, resetsAt: null, modelIds: ["glm-5.3"] };
  const future = { ...grant, label: "Next", remainingPercent: 100, startsAt: new Date(now + 1).toISOString() };
  const entry = (id: string, active: boolean, windows: NonNullable<QuotaEntry["quota"]>["windows"]): QuotaEntry => ({
    id, provider: "zcode-start", name: id, credentialHint: "oauth", active, health: null, providerName: "ZCode", providerIcon: "",
    quota: { source: "zcode-start", status: "ready", plan: null, fetchedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null, windows },
  });
  const data: QuotaOverview = { providers: [{ id: "zcode-start", name: "ZCode" }], accounts: [
    entry("spent-and-future", true, [grant, future]),
    entry("future-only", true, [future]),
    entry("future-disabled", false, [future]),
    entry("alternative", false, [grant, { ...grant, label: "Referral", remainingPercent: 50 }]),
    entry("sibling", false, [grant, { ...grant, modelIds: ["glm-5.3-flash"], remainingPercent: 50 }]),
    entry("rate-limited", false, [{ ...grant, remainingPercent: 50 }, { ...grant, modelIds: [], label: "Rate", remainingPercent: 0 }]),
  ] };
  const batches: { ids: string[]; active: boolean }[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/accounts/batch")) batches.push(JSON.parse(String(init?.body)));
    return Response.json(data);
  }, { preconnect: originalFetch.preconnect });
  const view = await mount(createElement(QuotaPage), { seed: [{ key: queryKeys.quota.all, data }] });
  try {
    const off = [...view.container.querySelectorAll("button")].find((item) => item.textContent?.includes("Turn off Empty"))!;
    await view.act(() => off.click());
    await view.flush();
    expect(batches).toEqual([{ ids: ["spent-and-future"], active: false }]);
    const on = [...view.container.querySelectorAll("button")].find((item) => item.textContent?.includes("Turn on Available"))!;
    await view.act(() => on.click());
    await view.flush();
    expect(batches[1]).toEqual({ ids: ["alternative", "sibling"], active: true });
  } finally { view.unmount(); }
});
