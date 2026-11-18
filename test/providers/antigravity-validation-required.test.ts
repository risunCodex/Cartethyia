/**
 * Antigravity / Google Cloud Code `VALIDATION_REQUIRED` must cool the account
 * down, never leave it active or (permanently) disabled.
 *
 * The upstream answers an unverified account with HTTP 403
 * `PERMISSION_DENIED` and a `VALIDATION_REQUIRED` reason plus a
 * `validation_url`. It is a verdict on the credential: no retry clears it, so
 * the account must be excluded while it cools and the validation URL carried in
 * the recorded reason for the dashboard pill link. It is a *timed* cooldown —
 * never a permanent `disabled` — so a machine verdict can never park a
 * credential forever.
 */
import { expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { GatewayError } from "../../src/protocol/gateway-error";

const VALIDATION_URL = "https://accounts.google.com/v3/signin/continue?plt=abc&continue=https://x";
const RAW = JSON.stringify({
  error: {
    code: 403,
    message: "Verify your account to continue.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "VALIDATION_REQUIRED",
        domain: "cloudcode-pa.googleapis.com",
        metadata: {
          validation_url_link_text: "Verify your account",
          validation_url: VALIDATION_URL,
          validation_error_message: "Verify your account to continue.",
        },
      },
    ],
  },
});

function gatewayError(): GatewayError {
  return new GatewayError(
    "authentication_failed",
    403,
    "Verify your account to continue.",
    { providerId: "antigravity", providerStatus: 403, providerCode: "PERMISSION_DENIED", raw: RAW },
    "upstream",
  );
}

test("VALIDATION_REQUIRED cools the account", () => {
  const r = classifyAccountError(gatewayError(), {
    origin: "upstream",
    scope: "provider",
    providerId: "antigravity",
    statusCode: 403,
  });
  expect(r.category).toBe("validation_required");
  expect(r.status).toBe("cooldown");
  expect(r.mutatesAccount).toBe(true);
});

test("the validation URL is carried in the recorded reason", () => {
  const r = classifyAccountError(gatewayError(), {
    origin: "upstream",
    scope: "provider",
    providerId: "antigravity",
    statusCode: 403,
  });
  expect(r.reason).toContain(VALIDATION_URL);
});

test("a plain 403 without validation evidence is not disabled as validation", () => {
  const r = classifyAccountError(
    new GatewayError("authentication_failed", 403, "permission denied", { providerId: "antigravity" }, "upstream"),
    { origin: "upstream", scope: "provider", providerId: "antigravity", statusCode: 403 },
  );
  expect(r.category).not.toBe("validation_required");
});
