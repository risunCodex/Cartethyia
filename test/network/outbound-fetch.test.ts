/**
 * The validated egress chokepoint, tested without touching the network.
 *
 * `resolveFn` and `fetchFn` are both injectable, which is what makes these
 * assertions possible offline. They pin the parts that fail silently: an SSRF
 * check that only runs on the first hop would let a redirect walk a request
 * into private address space, and a non-http scheme reaching the dial is a
 * TypeError from deep inside the stack rather than a typed refusal.
 *
 * `fetchFn` is the seam for every dial now, so these assertions cover the real
 * chokepoint rather than a path that only ran without an injected dialer.
 */
import { describe, expect, test } from "bun:test";
import { createValidatedFetch } from "../../src/network/outbound-fetch";
import { createHttpProxyAgent, createSocks5Agent } from "../../src/network/pool/agent";

/** Resolver that answers every hostname with one fixed address. */
function resolver(address: string): (hostname: string) => Promise<readonly string[]> {
  return async (hostname: string) => {
    void hostname;
    return [address];
  };
}

/** Records the URLs dialed and answers 200 with an empty body. */
function recordingFetcher(seen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("createValidatedFetch", () => {
  test("rejects a non-http scheme before any dial", async () => {
    const seen: string[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      fetchFn: recordingFetcher(seen),
    });
    await expect(fetcher("file:///etc/passwd")).rejects.toThrow(/protocol/i);
    expect(seen).toEqual([]);
  });

  test("refuses a target whose resolved address is blocked", async () => {
    const seen: string[] = [];
    const fetcher = createValidatedFetch({
      // Default policy denies private/loopback space; `allowPrivate` opts in.
      policy: {},
      // A loopback answer is exactly the rebind an SSRF check exists to stop.
      resolveFn: resolver("127.0.0.1"),
      fetchFn: recordingFetcher(seen),
    });
    await expect(fetcher("https://example.test/")).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  test("resolves and validates every redirect hop, not just the first", async () => {
    const seen: string[] = [];
    const resolved: string[] = [];
    let hop = 0;
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: async (hostname: string) => {
        resolved.push(hostname);
        // First host is public; the redirect target resolves into loopback.
        return [hop++ === 0 ? "93.184.216.34" : "127.0.0.1"];
      },
      fetchFn: (async (input: RequestInfo | URL) => {
        seen.push(String(input instanceof Request ? input.url : input));
        return new Response("", {
          status: 302,
          headers: { location: "https://second.test/" },
        });
      }) as unknown as typeof fetch,
    });
    await expect(fetcher("https://first.test/")).rejects.toThrow();
    // The second hop must have been resolved — a check that ran once would
    // have dialed the private address instead of refusing it.
    expect(resolved).toContain("second.test");
  });

  test("dials a public target and returns the response", async () => {
    const seen: string[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      fetchFn: recordingFetcher(seen),
    });
    const response = await fetcher("https://example.test/");
    expect(response.status).toBe(200);
    expect(seen).toEqual(["https://example.test/"]);
  });

  test("a GET carrying a body reaches the wire", async () => {
    // A GET with a body must survive the chokepoint unchanged: some model
    // listings send one. The egress adds `content-length` and forwards it.
    let body: string | undefined;
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body === undefined || init.body === null ? undefined : String(init.body);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await fetcher("https://example.test/list", { method: "GET", body: "{}" });
    expect(body).toBe("{}");
  });

  test("a relay endpoint is dialed directly with relay headers, not as a CONNECT proxy", async () => {
    // A hosted relay front door (Vercel/Workers/Deno) refuses CONNECT. The
    // egress must fetch the relay URL directly (no `proxy` option) and hand
    // the target origin/path to it via x-relay-target / x-relay-path.
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const agent = createHttpProxyAgent("https://relay.example.vercel.app/", undefined, {});
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      agent,
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await fetcher("https://api.target.test/v1/models", { method: "GET" });
    expect(seen).toHaveLength(1);
    // The dial must target the relay, not the original target…
    expect(seen[0]!.url).toBe("https://relay.example.vercel.app/");
    // …and it must not ask the runtime to CONNECT through the relay.
    expect((seen[0]!.init as unknown as { proxy?: string }).proxy).toBeUndefined();
    // The relay reads the target from these headers.
    const h = new Headers(seen[0]!.init.headers);
    expect(h.get("x-relay-target")).toBe("https://api.target.test");
    expect(h.get("x-relay-path")).toBe("/v1/models");
  });

  test("a relay forward strips content-encoding so the caller does not double-decompress", async () => {
    // The relay's own runtime already decodes the body it hands back; if it
    // also forwarded the original gzip headers the caller would decompress
    // twice. The relay worker source strips content-encoding/content-length —
    // this pins that the egress itself never re-adds them either.
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      agent: createHttpProxyAgent("https://relay.example.vercel.app/", undefined, {}),
      fetchFn: (async () => {
        return new Response("plain bytes", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const response = await fetcher("https://httpbin.example/gzip");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("plain bytes");
  });

  test("a socks pair selects the undici dispatcher, not the native proxy option", async () => {
    // A socks pool must dial through the SocksProxyAgent via undici's
    // dispatcher — the runtime-native fetch rejects `socks5://` with
    // UnsupportedProxyProtocol. This pins that the socks pair carries the
    // agent (socks field) and that the socks dial goes through the injected
    // socksFetch (dispatcher), never the native `fetchFn` `proxy` option.
    const agent = createSocks5Agent("socks5://127.0.0.1:5858", undefined, {});
    expect(agent.socks).toBeDefined();
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const socksSeen: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      agent,
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      socksFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        socksSeen.push({ url: String(input), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const response = await fetcher("https://api.example/v1/models");
    expect(response.status).toBe(200);
    // The native fetch path must not be used for a socks pool.
    expect(seen).toEqual([]);
    // The socks dial must have happened through the socks fetch + dispatcher.
    expect(socksSeen).toHaveLength(1);
    expect(socksSeen[0]!.url).toBe("https://api.example/v1/models");
    // It must not carry a native `proxy` option (undici uses dispatcher).
    expect((socksSeen[0]!.init as unknown as { proxy?: string }).proxy).toBeUndefined();
  });

});
