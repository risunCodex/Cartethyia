/**
 * DeviceCodeDialog failure handling: an OAuth device poll that fails server-side
 * (e.g. Freebuff device-key registration refused upstream) must surface the
 * error and close the dialog — it must NOT silently reschedule another poll,
 * which left the dialog on "Waiting for authorization…" forever.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createElement } from "react";
import { DeviceCodeDialog } from "../../src/features/provider-detail/sections/OAuthDialogs";
import { toast } from "../../src/lib/toast";
import { mount, stubFetch } from "../helpers/render";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function renderDialog() {
  const fetchStub = stubFetch([
    {
      match: "POST /providers/freebuff/oauth/device/start",
      json: {
        verificationUri: "https://www.codebuff.com/login?auth_code=TEST",
        userCode: "abcdef12",
        deviceAuthId: "fp-1",
        intervalSeconds: 1,
        expiresInSeconds: 3600,
      },
    },
    {
      match: "POST /providers/freebuff/oauth/device/poll",
      json: {
        error: "Your account has been suspended.",
        code: "policy_rejected",
        origin: "upstream",
      },
      status: 403,
    },
  ]);
  const onClose = mock(() => {});
  return {
    onClose,
    async mountView() {
      const view = await mount(
        createElement(DeviceCodeDialog, {
          providerId: "freebuff",
          parameters: {},
          onClose,
        }),
      );
      return view;
    },
    restore() {
      fetchStub.restore();
    },
  };
}

describe("DeviceCodeDialog", () => {
  test("a failed poll shows the error and closes, instead of rescheduling forever", async () => {
    const ctx = renderDialog();
    const view = await ctx.mountView();
    try {
      const errorToast = spyOn(toast, "error").mockImplementation(() => "error");
      // The first poll fires after intervalMs (1s) + 1s. Wait for it.
      await view.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2600));
      });
      await view.flush();
      expect(errorToast).toHaveBeenCalledWith("Device login failed", expect.stringContaining("suspended"));
      expect(ctx.onClose).toHaveBeenCalled();
    } finally {
      view.unmount();
      ctx.restore();
    }
  });
});
