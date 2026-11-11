import { describe, expect, test } from "bun:test";
import { ValidatedNetworkBindingFactory } from "../../src/network/egress/factory";
import { QODER_APP_TLS_PROFILE } from "../../src/network/egress/tls-profile";

describe("ValidatedNetworkBindingFactory", () => {
  test("direct fetch dials through the injected fetch", async () => {
    const fetchFn = (async (_input: unknown, _init?: RequestInit): Promise<Response> => {
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const factory = new ValidatedNetworkBindingFactory({}, fetchFn, undefined, "default");
    const dial = factory.fetch();
    expect(dial).toBeFunction();
    const res = await dial("https://example.com/", { method: "GET" });
    expect(res.status).toBe(200);
  });

  test("the qoder-app TLS profile is registered and carries the desktop fingerprint", () => {
    expect(QODER_APP_TLS_PROFILE.id).toBe("qoder-app");
    expect(QODER_APP_TLS_PROFILE.alpn).toEqual(["http/1.1"]);
  });
});
