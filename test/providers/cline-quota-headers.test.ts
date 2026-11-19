/**
 * Cline's quota headers must state two different versions in two different
 * slots.
 *
 * `x-core-version` is the `@cline/sdk` version — a separate npm package with
 * its own release line. This used to send the *client* version there too, so
 * the billing surface was told our core was `4.1.23`, a VS Code extension
 * version `@cline/sdk` has never published. `src/providers/integrations/cline/
 * cline.ts` has always sent the correct pairing on the chat surface.
 *
 * Why this is not cosmetic: Cline's refusal for an implausible client identity
 * is `Unauthorized: Please make sure you're using the latest version of Cline
 * and re-authenticate your Cline account.` — the same wording it returns for a
 * dead credential. A header the upstream validates is therefore indistinguishable
 * from an auth failure at the response, which is exactly how this presented
 * before: as "the quota endpoint rejected us", pointing an operator at
 * re-authenticating an account whose chat requests were working.
 *
 * The headers are private, so this observes them where they are actually used:
 * the request `fetchClineQuota` issues. A local fetcher captures the headers and
 * returns a minimal valid shape.
 */
import { describe, expect, test } from "bun:test";
import {
  _resetClineCliVersionCache,
  getClineCliVersion,
  getClineSdkVersion,
} from "../../src/providers/operations/client-versions";
import {
  CLINE_API_KEY_PREFIX,
  fetchClineQuota,
} from "../../src/providers/integrations/cline/cline-quota";

/** Captures the headers of the first request and answers with a valid quota shape. */
function capturingFetcher(): {
  readonly fetcher: typeof fetch;
  readonly seen: () => Record<string, string> | undefined;
} {
  let captured: Record<string, string> | undefined;
  const fetcher = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    captured = normalizeHeaders(init?.headers);
    const path = String(url);
    if (path.endsWith("/users/me")) {
      return jsonResponse({ id: "u-1", displayName: "Op" });
    }
    if (path.endsWith("/plan")) {
      return jsonResponse({ plan: { displayName: "Cline Pro" } });
    }
    if (path.endsWith("/usage-limits")) {
      return jsonResponse({ limits: [] });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  return { fetcher, seen: () => captured };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** `HeadersInit` is a union; the call site always passes a plain record. */
function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {};
  const normalized = new Headers(headers);
  const result: Record<string, string> = {};
  normalized.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

describe("Cline quota headers", () => {
  test("x-core-version is the SDK version, not the client version", async () => {
    // The bug: both slots carried the client version. Asserting the two are
    // *different values* is what catches it — asserting each against its own
    // constant would pass on a regression that swapped the two.
    const clientVersion = getClineCliVersion();
    const sdkVersion = getClineSdkVersion();
    const { fetcher, seen } = capturingFetcher();
    await fetchClineQuota("workos:token", fetcher);
    const headers = seen();
    expect(headers?.["x-client-version"]).toBe(clientVersion);
    expect(headers?.["x-core-version"]).toBe(sdkVersion);
    expect(headers?.["x-core-version"]).not.toBe(headers?.["x-client-version"]);
  });

  test("the SDK version is the one @cline/sdk actually publishes", async () => {
    // A core version no release ever published is the whole defect. The SDK
    // line is 0.0.x while the CLI is 3.x, so the leading major is the property
    // that separates them — asserted structurally rather than pinned, because a
    // real release will move the number. The CLI is not the extension: the
    // extension's 4.x line must never appear in either slot here.
    const sdkVersion = getClineSdkVersion();
    const cliVersion = getClineCliVersion();
    expect(sdkVersion.startsWith("0.")).toBe(true);
    expect(cliVersion.startsWith("3.")).toBe(true);
    expect(cliVersion).not.toBe(sdkVersion);
  });

  test("the billing surface claims the reference client identity", async () => {
    // Both surfaces share `clineClientHeaders()`: the reference client's
    // request layer mirrored (`x-client-type: cline-sdk` — the SDK package is
    // the layer that builds headers even for CLI callers), with versions
    // tracked to npm latest. Pinned here because the value is shared and must
    // not drift between surfaces.
    const { fetcher, seen } = capturingFetcher();
    await fetchClineQuota("workos:token", fetcher);
    expect(seen()?.["x-client-type"]).toBe("cline-sdk");
    expect(seen()?.["x-is-multiroot"]).toBe("false");
  });

  test("a resolved version is followed, so the pooler reaches this surface too", async () => {
    // The user's report was that the quota path did not follow the version
    // pooler. It does read the resolver; this is what proves it — seeding a
    // discovered version changes what is sent. `x-platform-version` rides the
    // same CLI line and moves with it.
    _resetClineCliVersionCache("9.9.9");
    try {
      const { fetcher, seen } = capturingFetcher();
      await fetchClineQuota("workos:token", fetcher);
      expect(seen()?.["x-client-version"]).toBe("9.9.9");
      expect(seen()?.["user-agent"]).toBe("Cline/9.9.9");
      expect(seen()?.["x-platform-version"]).toBe("9.9.9");
    } finally {
      _resetClineCliVersionCache();
    }
  });

  test("an api-key account reads the billing surface with a bare bearer token", async () => {
    // It used to make no call at all and report "not available", because the
    // key was sent as `Bearer workos:sk_...` and Cline answered 401 with the
    // "update and re-authenticate" refusal. The key is its own bearer token;
    // the prefix was the whole problem.
    const seen: (string | undefined)[] = [];
    const fetcher = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push(headers?.authorization);
      const path = String(url);
      if (path.endsWith("/users/me")) return jsonResponse({ id: "u-1" });
      return jsonResponse({ limits: [] });
    }) as unknown as typeof fetch;

    const result = await fetchClineQuota(`${CLINE_API_KEY_PREFIX}sk_123`, fetcher);

    expect(seen.length).toBeGreaterThan(0);
    for (const auth of seen) expect(auth).toBe("Bearer sk_123");
    expect(result.source).toBe("cline");
  });

  test("an api-key account still sends the client identity headers", async () => {
    // The header set is shared: dropping the client identity is one of the
    // shapes an upstream "please update" refusal takes.
    let seen: Record<string, string> | undefined;
    const fetcher = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      seen = init?.headers as Record<string, string>;
      const path = String(url);
      if (path.endsWith("/users/me")) return jsonResponse({ id: "u-1" });
      return jsonResponse({ limits: [] });
    }) as unknown as typeof fetch;

    await fetchClineQuota(`${CLINE_API_KEY_PREFIX}sk_123`, fetcher);

    expect(seen?.["x-client-type"]).toBe("cline-sdk");
    expect(seen?.["x-client-version"]).toBeDefined();
    expect(seen?.["x-core-version"]).toBeDefined();
  });
});
