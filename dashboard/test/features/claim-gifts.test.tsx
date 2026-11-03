import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { ClaimGiftsButton } from "../../src/components/ClaimGiftsButton";
import type { GiftClaimResult } from "../../src/hooks/quota";
import { toast } from "../../src/lib/toast";
import { mount } from "../helpers/render";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("manual ZCode gift claim", () => {
  for (const state of ["claimed", "already_claimed", "nothing", "captcha", "partial", "error"] as const) {
    test(`reports ${state} honestly and refreshes only new entitlements`, async () => {
      const requests: string[] = [];
      const result: GiftClaimResult = {
        state,
        claimed: state === "claimed" || state === "partial" ? ["Trial gift"] : [],
        detail: state === "partial" ? "CAPTCHA required; claim in the ZCode app" : "Outcome detail",
      };
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        requests.push(`${init?.method} ${path}`);
        if (path.endsWith("/claim-gifts")) {
          return Response.json({ ok: state !== "error", data: result, message: result.detail }, { status: state === "error" ? 502 : 200 });
        }
        return Response.json({ ok: true });
      }, { preconnect: originalFetch.preconnect });
      const success = spyOn(toast, "success").mockImplementation(() => "success");
      const warning = spyOn(toast, "warning").mockImplementation(() => "warning");
      const error = spyOn(toast, "error").mockImplementation(() => "error");
      const view = await mount(createElement(ClaimGiftsButton, { accountId: "account/one", accountName: "ZCode" }));
      try {
        expect(requests).toHaveLength(0);
        await view.click('button[aria-label="Claim gifts for ZCode"]');
        await view.flush();
        await view.flush();
        expect(requests[0]).toBe("POST /console/api/accounts/account%2Fone/claim-gifts");
        expect(requests.some((request) => request.endsWith("/quota/refresh"))).toBe(result.claimed.length > 0);
        if (state === "captcha" || state === "partial") {
          expect(success).not.toHaveBeenCalled();
          expect(warning).toHaveBeenCalledTimes(1);
          expect(JSON.stringify(warning.mock.calls)).toContain(state === "captcha" ? "ZCode app" : result.detail!);
          if (state === "partial") expect(JSON.stringify(warning.mock.calls)).toContain("Trial gift");
        } else if (state === "error") {
          expect(success).not.toHaveBeenCalled();
          expect(error).toHaveBeenCalledWith("Gift claim failed", "Outcome detail");
        } else {
          const titles = { claimed: "Gift plans claimed", already_claimed: "Gift plans already claimed", nothing: "No gift plans to claim" };
          expect(success.mock.calls[0]?.[0]).toBe(titles[state]);
        }
      } finally {
        view.unmount();
        success.mockRestore();
        warning.mockRestore();
        error.mockRestore();
      }
    });
  }
});
