/**
 * Area 02: provider-wide account actions + server-side batch consolidation.
 *
 * The counts are computed from the whole account list (not the selection or
 * the search box), delete-banned must pass a confirmation dialog, and the
 * existing Enable/Disable/Delete bulk paths must never fan out one request per
 * account — the server already has `PATCH /accounts/batch` and
 * `POST /accounts/batch-delete`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { AccountsList, accountHasCooldown, accountIsBanned } from "../../src/features/provider-detail/sections/Accounts";
import { auditActionLabel } from "../../src/features/logs/audit-labels";
import type { ProviderAccountResponse } from "../../src/data/contracts";
import { mount } from "../helpers/render";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const USAGE = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function account(overrides: Partial<ProviderAccountResponse> = {}): ProviderAccountResponse {
  return {
    id: "a1",
    providerId: "demo",
    tenantId: "tenant-1",
    label: "Account 1",
    credentialKind: "api_key",
    status: "active",
    usageToday: USAGE,
    usageAllTime: USAGE,
    createdAt: "2026-01-01T00:00:00.000Z",
    sortIndex: 0,
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

function stubApi() {
  const calls: Call[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ method, url, body });
      if (url.includes("actions/disable-cooldowns")) {
        return Response.json({ ok: true, updated: 2, globalSkipped: 0 });
      }
      if (url.includes("actions/delete-banned")) {
        return Response.json({ ok: true, updated: 0, deleted: ["a3"], missing: [], globalSkipped: 1 });
      }
      if (url.includes("batch-delete")) {
        const ids: string[] = JSON.parse(body || "{}").accountIds ?? [];
        return Response.json({ ok: true, deleted: ids, missing: [] });
      }
      if (url.includes("/accounts/batch")) {
        return Response.json({ ok: true, updated: 1 });
      }
      if (url.includes("/quota/overview")) {
        return Response.json({ providers: [], accounts: [] });
      }
      if (url.includes("account-inflight")) return Response.json({ accounts: [] });
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof globalThis.fetch;
  return calls;
}

function buttonByText(view: Awaited<ReturnType<typeof mount>>, text: string): HTMLElement | null {
  return (
    ([...view.container.querySelectorAll("button")].find((button) => {
      const label = button.textContent?.replace(/\s+/g, " ").trim() ?? "";
      // A menu item's count sits in its own span, so textContent is
      // "Disable cooldown2" rather than "Disable cooldown 2".
      const withoutCount = label.replace(/\d+$/, "").trim();
      return label === text || withoutCount === text;
    }) as HTMLElement | undefined) ?? null
  );
}

async function renderAccounts(accounts: readonly ProviderAccountResponse[]) {
  const calls = stubApi();
  const view = await mount(
    createElement(AccountsList, {
      providerId: "demo",
      accounts,
      onDelete: () => undefined,
    }),
  );
  await view.flush();
  return { view, calls };
}

describe("cooldown / banned predicates", () => {
  test("cooldown covers status, future deadline, and live per-model backoffs", () => {
    expect(accountHasCooldown(account({ status: "cooldown" }))).toBe(true);
    expect(
      accountHasCooldown(account({ cooldownUntil: new Date(Date.now() + 60_000).toISOString() })),
    ).toBe(true);
    expect(
      accountHasCooldown(account({ modelCooldowns: { "demo/m": new Date(Date.now() + 60_000).toISOString() } })),
    ).toBe(true);
    expect(accountHasCooldown(account({ cooldownUntil: new Date(Date.now() - 60_000).toISOString() }))).toBe(false);
    expect(accountHasCooldown(account({ kind: "pool", status: "cooldown" }))).toBe(false);
    // Disable keeps the deadline columns as evidence. Counting them would leave
    // the cleanup action claiming work after it has already done it.
    expect(
      accountHasCooldown(
        account({
          status: "disabled",
          cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
          modelCooldowns: { "demo/m": new Date(Date.now() + 60_000).toISOString() },
        }),
      ),
    ).toBe(false);
  });

  test("banned is strictly disabled + policy_blocked_banned", () => {
    expect(
      accountIsBanned(account({ status: "disabled", lastErrorCategory: "policy_blocked_banned" })),
    ).toBe(true);
    expect(
      accountIsBanned(account({ status: "disabled", lastErrorCategory: "auth_invalidated" })),
    ).toBe(false);
    expect(
      accountIsBanned(account({ status: "cooldown", lastErrorCategory: "policy_blocked_banned" })),
    ).toBe(false);
    expect(accountIsBanned(account({ kind: "pool", status: "disabled", lastErrorCategory: "policy_blocked_banned" }))).toBe(false);
  });
});

describe("AccountsList provider-wide actions", () => {
  const ACCOUNTS = [
    account({ id: "a1", status: "cooldown" }),
    account({ id: "a2", modelCooldowns: { "demo/x": new Date(Date.now() + 60_000).toISOString() } }),
    account({ id: "a3", status: "disabled", lastErrorCategory: "policy_blocked_banned" }),
    account({ id: "a4", status: "disabled", lastErrorCategory: "auth_invalidated" }),
    account({ id: "pool", kind: "pool", status: "cooldown" }),
  ];

  test("cleanup stays mounted and names both counts from the whole list", async () => {
    const { view } = await renderAccounts(ACCOUNTS);
    try {
      const cleanup = buttonByText(view, "Cleanup (3)");
      expect(cleanup).not.toBeNull();
      expect(cleanup?.hasAttribute("disabled")).toBe(false);
      await view.act(() => cleanup!.click());
      await view.flush();
      const disable = buttonByText(view, "Disable cooldown");
      const banned = buttonByText(view, "Delete banned");
      expect(disable).not.toBeNull();
      expect(banned).not.toBeNull();
      expect(disable?.textContent).toContain("2");
      expect(banned?.textContent).toContain("1");
      expect(disable?.hasAttribute("disabled")).toBe(false);
      expect(banned?.hasAttribute("disabled")).toBe(false);
    } finally {
      view.unmount();
    }
  });

  test("an empty cleanup target greys the menu out instead of unmounting it", async () => {
    const { view } = await renderAccounts([account({ id: "ok" })]);
    try {
      const cleanup = buttonByText(view, "Cleanup");
      expect(cleanup).not.toBeNull();
      expect(cleanup?.hasAttribute("disabled")).toBe(true);
    } finally {
      view.unmount();
    }
  });

  test("a disabled row that still carries cooldown evidence is not a target", async () => {
    const { view } = await renderAccounts([
      account({
        id: "parked",
        status: "disabled",
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
        modelCooldowns: { "demo/x": new Date(Date.now() + 60_000).toISOString() },
      }),
    ]);
    try {
      const cleanup = buttonByText(view, "Cleanup");
      expect(cleanup?.hasAttribute("disabled")).toBe(true);
    } finally {
      view.unmount();
    }
  });

  test("Disable cooldown posts the C3 action route once", async () => {
    const { view, calls } = await renderAccounts(ACCOUNTS);
    try {
      await view.act(() => buttonByText(view, "Cleanup (3)")!.click());
      await view.flush();
      await view.click('button[title="Disable 2 account(s) in cooldown (account-wide or per-model)"]');
      await view.flush();
      await view.flush();
      const action = calls.filter((call) => call.url.includes("actions/disable-cooldowns"));
      expect(action).toHaveLength(1);
      expect(action[0]?.method).toBe("POST");
    } finally {
      view.unmount();
    }
  });

  test("Delete banned opens a ConfirmDialog and only writes after confirmation", async () => {
    const { view, calls } = await renderAccounts(ACCOUNTS);
    try {
      await view.act(() => buttonByText(view, "Cleanup (3)")!.click());
      await view.flush();
      await view.click('button[title="Permanently delete 1 policy-banned account(s)"]');
      await view.flush();
      const dialog = view.find('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain("Delete 1 banned account?");
      expect(dialog?.textContent).toContain("This cannot be undone.");
      expect(calls.filter((call) => call.url.includes("actions/delete-banned"))).toHaveLength(0);
      const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.includes("Delete banned"),
      );
      expect(confirm).toBeDefined();
      await view.act(() => confirm!.click());
      await view.flush();
      await view.flush();
      expect(calls.filter((call) => call.url.includes("actions/delete-banned"))).toHaveLength(1);
    } finally {
      view.unmount();
    }
  });

  test("bulk Delete is one batch-delete request, not one DELETE per account", async () => {
    const { view, calls } = await renderAccounts([account({ id: "a1" }), account({ id: "a2" })]);
    try {
      // Select both rows through the toolbar's select-all checkbox.
      const all = view.find('input[aria-label="Select accounts"]') as HTMLInputElement | null;
      expect(all).not.toBeNull();
      await view.act(() => all!.click());
      await view.flush();
      await view.act(() => buttonByText(view, "Selection")!.click());
      await view.flush();
      await view.click('button[title="Delete 2 selected accounts"]');
      await view.flush();
      const dialog = view.find('[role="dialog"]');
      const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Delete",
      );
      expect(confirm).toBeDefined();
      await view.act(() => confirm!.click());
      await view.flush();
      await view.flush();
      const batches = calls.filter((call) => call.url.includes("/accounts/batch-delete"));
      expect(batches).toHaveLength(1);
      expect(JSON.parse(batches[0]?.body ?? "{}").accountIds).toEqual(["a1", "a2"]);
      expect(calls.filter((call) => call.method === "DELETE" && call.url.includes("/accounts/"))).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  test("bulk Enable/Disable is one PATCH /accounts/batch", async () => {
    const { view, calls } = await renderAccounts([account({ id: "a1" }), account({ id: "a2", status: "disabled" })]);
    try {
      const all = view.find('input[aria-label="Select accounts"]') as HTMLInputElement | null;
      await view.act(() => all!.click());
      await view.flush();
      await view.act(() => buttonByText(view, "Selection")!.click());
      await view.flush();
      const enable = buttonByText(view, "Enable");
      expect(enable).not.toBeNull();
      await view.act(() => enable!.click());
      await view.flush();
      await view.flush();
      const batches = calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/accounts/batch"));
      expect(batches).toHaveLength(1);
      expect(JSON.parse(batches[0]?.body ?? "{}")).toEqual({ ids: ["a1", "a2"], active: true });
      expect(calls.filter((call) => call.method === "PATCH" && call.url.includes("/providers/demo/accounts/"))).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });
});

describe("audit labels for the two new actions", () => {
  test("both read as curated sentences, not the fallback prettifier", () => {
    expect(auditActionLabel("provider_account.bulk_disabled_cooldowns")).toBe("Cooldown accounts disabled");
    expect(auditActionLabel("provider_account.bulk_deleted_banned")).toBe("Banned accounts deleted");
  });
});
