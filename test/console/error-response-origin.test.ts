/**
 * Console error envelopes preserve the upstream/network origin of a GatewayError
 * so the dashboard's `maybeSignalSessionTransition` can tell a provider
 * rejection (401 upstream) from a console-session expiry (401 cartethyia).
 * Without the preserved origin a freebuff device-poll failure — e.g. the
 * device-key registration being refused upstream — bounced the operator to
 * /login as if the console session had expired.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import {
  ConsoleDomainError,
  errorResponse,
} from "../../src/console/shared/errors";

describe("errorResponse origin preservation", () => {
  test("a GatewayError keeps an upstream origin in the envelope", () => {
    const set: { status?: number | string } = {};
    const body = errorResponse(
      new GatewayError(
        "authentication_failed",
        401,
        "freebuff device-key registration failed",
        {},
        "upstream",
      ),
      set,
      "OAuth login operation failed",
    );
    expect(set.status).toBe(401);
    expect(body.code).toBe("authentication_failed");
    expect(body.origin).toBe("upstream");
  });

  test("a GatewayError keeps a network origin in the envelope", () => {
    const set: { status?: number | string } = {};
    const body = errorResponse(
      new GatewayError("transport_unavailable", 502, "socket drop", {}, "network"),
      set,
      "OAuth login operation failed",
    );
    expect(set.status).toBe(502);
    expect(body.origin).toBe("network");
  });

  test("a console-origin GatewayError omits the origin field", () => {
    const set: { status?: number | string } = {};
    const body = errorResponse(
      new GatewayError("route_unavailable", 503, "no route"),
      set,
      "OAuth login operation failed",
    );
    expect(body.origin).toBeUndefined();
  });

  test("a ConsoleDomainError keeps its shape and no origin", () => {
    const set: { status?: number | string } = {};
    const body = errorResponse(
      new ConsoleDomainError("insufficient_scope", 403, "dashboard:write scope required"),
      set,
      "OAuth login operation failed",
    );
    expect(set.status).toBe(403);
    expect(body.code).toBe("insufficient_scope");
    expect(body.origin).toBeUndefined();
  });
});
