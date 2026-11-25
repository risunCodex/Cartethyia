/**
 * A console 403 either means "this client is locked out" or "this client is
 * signed in but not allowed to do that here". The first bounces the whole shell
 * to the lockout page; the second has to stay on the page that asked, or the
 * explanation is never read.
 *
 * Driven through `consoleRequest`, which is the only place that decides.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  consoleRequest,
  setSessionTransitionListener,
  type SessionTransitionKind,
} from "../../src/data/api";

const originalFetch = globalThis.fetch;

let transitions: SessionTransitionKind[] = [];

function stubResponse(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  transitions = [];
  setSessionTransitionListener((kind) => transitions.push(kind));
});

afterEach(() => {
  setSessionTransitionListener(undefined);
  globalThis.fetch = originalFetch;
});

describe("console 403 handling", () => {
  test("a scope denial stays on the page", async () => {
    stubResponse(403, { code: "insufficient_scope", message: "platform:admin scope required" });
    await expect(consoleRequest("/tray/visibility", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(transitions).toEqual([]);
  });

  test("a tray refusal from another machine stays on the page", async () => {
    stubResponse(403, {
      code: "tray_control_local_only",
      message: "Tray control is only available from the machine running the gateway",
    });
    const error = await consoleRequest("/tray/visibility", { method: "POST", body: "{}" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "tray_control_local_only" });
    expect(transitions).toEqual([]);
  });

  test("an unrecognized 403 still bounces to the lockout page", async () => {
    stubResponse(403, { code: "ip_banned", message: "This client IP is locked out" });
    await expect(consoleRequest("/tray/visibility", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(transitions).toEqual(["banned"]);
  });

  test("an expired session still signals expiry", async () => {
    stubResponse(401, { code: "unauthorized", message: "Authentication required" });
    await expect(consoleRequest("/tray/status")).rejects.toThrow();
    expect(transitions).toEqual(["expired"]);
  });
});
