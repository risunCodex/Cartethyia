/**
 * Shared CLI-client kit: the quota null-result, the upstream-error wrapper,
 * the JSON probe, and the finish-reason map every CLI-client integration
 * (freepi, perch) now shares.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../../src/protocol/gateway-error";
import {
  mapChatFinishReason,
  quotaUnreadable,
  readJsonOk,
  upstreamGatewayError,
} from "../../../src/providers/integrations/shared/cli-client-kit";
import type { FetchLike } from "../../../src/providers/quota/quota-contracts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readJsonOk", () => {
  test("returns the parsed object on a 2xx JSON body", async () => {
    const fetcher = (async () => jsonResponse({ hello: "world" })) as unknown as FetchLike;
    expect(await readJsonOk(fetcher, "https://x.test/me", {})).toEqual({ hello: "world" });
  });

  test("returns null on non-2xx, non-JSON, and network failure", async () => {
    const bad = (async () => new Response("nope", { status: 500 })) as unknown as FetchLike;
    expect(await readJsonOk(bad, "https://x.test/me", {})).toBeNull();
    const notJson = (async () => new Response("<html>", { status: 200 })) as unknown as FetchLike;
    expect(await readJsonOk(notJson, "https://x.test/me", {})).toBeNull();
    const dead = (async () => {
      throw new Error("offline");
    }) as unknown as FetchLike;
    expect(await readJsonOk(dead, "https://x.test/me", {})).toBeNull();
  });
});

describe("quotaUnreadable", () => {
  test("carries the source and an operator-readable reason, never a fake plan", () => {
    const result = quotaUnreadable("freepi", "free-pi /me unavailable");
    expect(result.source).toBe("freepi");
    expect(result.plan).toBeNull();
    expect(result.windows).toEqual([]);
    expect(result.error).toBe("free-pi /me unavailable");
  });
});

describe("upstreamGatewayError", () => {
  test("marks the error upstream and folds providerCode/details into details", () => {
    const error = upstreamGatewayError("perch", "platform_unavailable", 502, "boom", {
      providerCode: "pc-1",
      details: { freepi_session_mismatch: true },
    });
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.origin).toBe("upstream");
    expect(error.code).toBe("platform_unavailable");
    expect(error.status).toBe(502);
    expect(error.details["providerCode"]).toBe("pc-1");
    expect(error.details["freepi_session_mismatch"]).toBe(true);
  });

  test("omits absent optional keys rather than stamping undefined", () => {
    const error = upstreamGatewayError("cline", "policy_rejected", 403, "no");
    // providerId is always stamped; the optional keys are not.
    expect(error.details).toEqual({ providerId: "cline" });
  });
});

describe("mapChatFinishReason", () => {
  test("maps the OpenAI finish_reason vocabulary onto canonical reasons", () => {
    expect(mapChatFinishReason("stop")).toBe("stop");
    expect(mapChatFinishReason("length")).toBe("length");
    expect(mapChatFinishReason("tool_calls")).toBe("tool_use");
    expect(mapChatFinishReason("function_call")).toBe("tool_use");
    expect(mapChatFinishReason("content_filter")).toBe("content_filter");
    expect(mapChatFinishReason("error")).toBe("error");
    expect(mapChatFinishReason("refusal")).toBe("refusal");
  });

  test("returns undefined for unknown or non-string values so surfaces pick their default", () => {
    expect(mapChatFinishReason("whatever")).toBeUndefined();
    expect(mapChatFinishReason(undefined)).toBeUndefined();
    expect(mapChatFinishReason(null)).toBeUndefined();
    expect(mapChatFinishReason(42)).toBeUndefined();
  });
});
