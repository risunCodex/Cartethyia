/**
 * The per-row "Refresh token" action (area 04).
 *
 * The button exists for every real OAuth, non-static account — including
 * `disabled` ones — and never for api_key rows or pool rows. Its POST hits
 * `/providers/:providerId/accounts/:accountId/refresh-token`, which the server
 * guarantees never re-enables an account; the toast for a disabled account
 * says "remains disabled".
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { AccountRow } from "../../src/features/provider-detail/sections/AccountRow";
import type { ProviderAccountResponse } from "../../src/data/contracts";
import { toast } from "../../src/lib/toast";
import { mount } from "../helpers/render";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function account(overrides: Partial<ProviderAccountResponse> = {}): ProviderAccountResponse {
  return {
    id: "account-1",
    providerId: "oa-provider",
    tenantId: "tenant-1",
    label: "OAuth account",
    credentialKind: "oauth",
    status: "disabled",
    usageToday: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageAllTime: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    sortIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function stubFetchRoutes() {
  let calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/refresh-token")) {
        return Response.json(
          { ok: true, statusAfter: "disabled", tokenRefreshed: true },
          { status: 200 },
        );
      }
      return Response.json({ ok: true }, { status: 200 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function renderRow(acct: ProviderAccountResponse) {
  const view = await mount(
    createElement(AccountRow, {
      providerId: acct.providerId,
      account: acct,
      selected: false,
      onToggleSelect: () => {},
      onDelete: () => {},
    }),
  );
  return view;
}

describe("AccountRow refresh-token action", () => {
  test("shows the Refresh token button for a disabled OAuth non-static account", async () => {
    const view = await renderRow(account());
    try {
      const button = view.find('button[title="Refresh OAuth token only — status unchanged"]');
      expect(button).not.toBeNull();
      expect(button?.getAttribute("aria-label")).toBe("Refresh token for OAuth account");
    } finally {
      view.unmount();
    }
  });

  test("does not show the button for an api_key account", async () => {
    const view = await renderRow(account({ credentialKind: "api_key" }));
    try {
      expect(view.find('button[title="Refresh OAuth token only — status unchanged"]')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("does not show the button for a pool row", async () => {
    const view = await renderRow(
      account({ kind: "pool", networkPoolId: "pool-1", credentialKind: "api_key" }),
    );
    try {
      expect(view.find('button[title="Refresh OAuth token only — status unchanged"]')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("does not show the button for a static OAuth account", async () => {
    const view = await renderRow(account({ staticToken: true }));
    try {
      expect(view.find('button[title="Refresh OAuth token only — status unchanged"]')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("shows the button for an active OAuth non-static account", async () => {
    const view = await renderRow(account({ status: "active" }));
    try {
      expect(view.find('button[title="Refresh OAuth token only — status unchanged"]')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("clicking it POSTs refresh-token and toasts 'remains disabled' for a disabled account", async () => {
    const fetchStub = stubFetchRoutes();
    const success = spyOn(toast, "success").mockImplementation(() => "success");
    try {
      const view = await renderRow(account());
      await view.click('button[title="Refresh OAuth token only — status unchanged"]');
      await view.flush();
      await view.flush();
      expect(fetchStub.calls[0]).toBe(
        "POST /console/api/providers/oa-provider/accounts/account-1/refresh-token",
      );
      expect(JSON.stringify(success.mock.calls)).toContain(
        "Token refreshed — account remains disabled",
      );
    } finally {
      success.mockRestore();
      fetchStub.restore();
    }
  });

  test("clicking it toasts a plain success for an active account", async () => {
    const fetchStub = stubFetchRoutes();
    const success = spyOn(toast, "success").mockImplementation(() => "success");
    try {
      const view = await renderRow(account({ status: "active" }));
      await view.click('button[title="Refresh OAuth token only — status unchanged"]');
      await view.flush();
      await view.flush();
      expect(JSON.stringify(success.mock.calls)).toContain("Token refreshed");
    } finally {
      success.mockRestore();
      fetchStub.restore();
    }
  });
});
