/**
 * The shared native JSON response serializer (`native-shared.jsonResponse`) is
 * what generation/embedding/audio responses are serialized with.
 *
 * Generation used to carry a local copy of this helper that had drifted: it
 * omitted `cache-control: no-store`, so per-request media responses were the
 * one JSON surface a shared cache could store. Migrating to the shared helper
 * closes that drift; this pins the header set so a future copy cannot lose it
 * again. The body serialization is trivial, so the headers are the contract.
 */
import { describe, expect, test } from "bun:test";
import { jsonResponse } from "../../src/transport/dispatch/native-shared";

describe("native JSON response headers", () => {
  test("every native JSON response is no-store and carries the request id", () => {
    const response = jsonResponse({ ok: true }, 200, "req-test-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe("req-test-1");
    // Body round-trips untouched.
    return response.json().then((body: unknown) => expect(body).toEqual({ ok: true }));
  });

  test("a non-200 status keeps the same header set", () => {
    const response = jsonResponse({ error: "no" }, 400, "req-test-2");
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe("req-test-2");
  });
});
