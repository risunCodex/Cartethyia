import { describe, expect, test } from "bun:test";
import { ValidatedNetworkBindingFactory } from "../../src/network/egress/factory";

describe("ValidatedNetworkBindingFactory", () => {
  test("direct fetch dials through the injected fetch", async () => {
    const fetchFn = (async (_input: unknown, _init?: RequestInit): Promise<Response> => {
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    // Inject a resolver so this offline test never depends on host DNS: a real
    // `example.com` lookup stalls or fails under full-suite load, which made an
    // otherwise deterministic seam test flake. Only the injected fetch matters
    // here — it must be used for a validated direct dial.
    const resolver = async () => ["93.184.216.34"];
    const factory = new ValidatedNetworkBindingFactory({}, fetchFn, undefined, "default", resolver);
    const dial = factory.fetch();
    expect(dial).toBeFunction();
    const res = await dial("https://example.com/", { method: "GET" });
    expect(res.status).toBe(200);
  });
});
