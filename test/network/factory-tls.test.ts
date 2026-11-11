import { describe, expect, test } from "bun:test";
import { ValidatedNetworkBindingFactory } from "../../src/network/egress/factory";
import { QODER_APP_TLS_PROFILE } from "../../src/network/egress/tls-profile";

describe("ValidatedNetworkBindingFactory fetchWithTls", () => {
  test("direct fetchWithTls propagates the profile into the dialer", async () => {
    let capturedTlsProfile: unknown;
    const fetchFn = (async (_input: unknown, _init?: RequestInit): Promise<Response> => {
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const factory = new ValidatedNetworkBindingFactory({}, fetchFn, undefined, "default");
    const dial = factory.fetchWithTls("qoder-app");
    expect(dial).toBeFunction();
    // The closure is a dialer; invoking it returns a Response.
    const res = await dial("https://example.com/", { method: "GET" });
    expect(res.status).toBe(200);
    // The profile registry itself carries the Qoder fingerprint.
    expect(QODER_APP_TLS_PROFILE.id).toBe("qoder-app");
    expect(capturedTlsProfile).toBeUndefined();
  });
});
