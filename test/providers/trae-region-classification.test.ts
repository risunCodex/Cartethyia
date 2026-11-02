/**
 * Trae's `4013` "AI service is not available in the current region now." must
 * cool the account hard for a day, never run the 30s transient `server_error`
 * path that left the account in rotation re-dialling the refusal on every
 * request.
 */
import { expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { GatewayError } from "../../src/protocol/gateway-error";

const REGION_MESSAGE = "AI service is not available in the current region now.";
const ONE_DAY = 24 * 60 * 60 * 1000;
const UPSTREAM = { origin: "upstream" as const, scope: "provider" as const };

test("Trae 4013 cools the account hard for a day", () => {
  const classification = classifyAccountError(new Error(REGION_MESSAGE), {
    ...UPSTREAM,
    providerId: "trae",
    providerCode: "4013",
    statusCode: 502,
  });
  expect(classification.category).toBe("quota_exhausted");
  expect(classification.status).toBe("cooldown");
  expect(classification.cooldownMs).toBe(ONE_DAY);
  expect(classification.mutatesAccount).toBe(true);
});

test("Trae 4013 arriving as a GatewayError still classifies", () => {
  const gateway = new GatewayError(
    "platform_unavailable",
    502,
    REGION_MESSAGE,
    { providerId: "trae", providerStatus: 502, providerCode: "4013" },
    "upstream",
  );
  const classification = classifyAccountError(gateway, { ...UPSTREAM, providerId: "trae" });
  expect(classification.category).toBe("quota_exhausted");
  expect(classification.cooldownMs).toBe(ONE_DAY);
  expect(classification.mutatesAccount).toBe(true);
});

test("Trae cn is covered by the same arm", () => {
  const classification = classifyAccountError(new Error(REGION_MESSAGE), {
    ...UPSTREAM,
    providerId: "traecn",
    providerCode: "4013",
    statusCode: 502,
  });
  expect(classification.category).toBe("quota_exhausted");
  expect(classification.mutatesAccount).toBe(true);
});

test("the phrase alone is recognised without the numeric code", () => {
  // The probe path may deliver only the message text.
  const classification = classifyAccountError(new Error(REGION_MESSAGE), {
    ...UPSTREAM,
    providerId: "trae",
    statusCode: 502,
  });
  expect(classification.category).toBe("quota_exhausted");
  expect(classification.cooldownMs).toBe(ONE_DAY);
});

test("the same code on another provider does not hard-cool the account", () => {
  const classification = classifyAccountError(new Error(REGION_MESSAGE), {
    ...UPSTREAM,
    providerId: "openai",
    providerCode: "4013",
    statusCode: 502,
  });
  expect(classification.category).not.toBe("quota_exhausted");
});

test("a plain Trae 502 transport fault still uses the transient window", () => {
  const classification = classifyAccountError(new Error("upstream blew up"), {
    ...UPSTREAM,
    providerId: "trae",
    statusCode: 502,
  });
  expect(classification.category).toBe("server_error");
  expect(classification.cooldownMs).toBeLessThan(ONE_DAY);
});
