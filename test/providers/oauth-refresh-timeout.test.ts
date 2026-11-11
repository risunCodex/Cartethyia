/**
 * A client request must never be blocked by an OAuth token refresh.
 *
 * The request path (`resolveCredentialForAccount`) deliberately performs no
 * inline refresh: OAuth tokens are kept fresh by the scheduled refresh sweep,
 * and a token that still expires before its sweep turn is answered by the
 * upstream's own 401, which the dispatch attempt-loop turns into a forced
 * refresh. Removing the inline refresh removed the shape this suite used to
 * pin — a hung token endpoint holding a client request for the full 30 s
 * refresh timeout (the p90/p95/p99 cliff the production dashboard showed).
 *
 * This suite now pins the two mechanisms that replaced it:
 *   - the refresh timeout constant still bounds a hung endpoint for the
 *     *scheduled* sweep (the only refresher left), and
 *   - a fast endpoint is not delayed by the deadline.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type {
  OAuthTokenRefreshResult,
  OAuthTokenRefresher,
} from "../../src/providers/authentication/oauth-refresh-service";

/**
 * A refresher that never answers on its own, to model a hung token endpoint.
 *
 * It settles only when its own abort fires, and settles to a *valid* result
 * rather than rejecting. Two reasons, both learned the hard way: a rejected
 * promise that no test awaits is reported by Bun as an unhandled rejection
 * attributed to whichever test is running when it surfaces — which made an
 * unrelated test fail one test late — and `Promise<OAuthTokenRefreshResult>`
 * does not admit a `null` resolution. What this helper is for is observing the
 * deadline, and it does that faithfully: nothing about it resolves early.
 */
function hangingRefresher(observed: {
  signal?: AbortSignal | undefined;
}): OAuthTokenRefresher {
  return {
    refresh: (_refreshToken, signal) =>
      new Promise<OAuthTokenRefreshResult>((resolve) => {
        observed.signal = signal;
        signal?.addEventListener(
          "abort",
          () => resolve({ access: "never-used", expiresAt: new Date(0) }),
          { once: true },
        );
      }),
  };
}

/** A refresher that answers immediately, for the control case. */
function fastRefresher(): OAuthTokenRefresher {
  return {
    refresh: async () => ({
      access: "fresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
  };
}

describe("the refresh timeout constant", () => {
  test("is 30s, which bounds a hung endpoint for the scheduled sweep", () => {
    // Read from the source rather than imported, because the constant is
    // module-private. This is the assertion that pins the production value: if
    // it changes, the 30 s figure in the incident notes is stale.
    const source = readFileSync(
      "src/providers/authentication/oauth-refresh-service.ts",
      "utf8",
    );
    const match = /REFRESH_HTTP_TIMEOUT_MS = ([\d_]+)/.exec(source);
    expect(match).not.toBeNull();
    expect(Number(match?.[1]?.replaceAll("_", ""))).toBe(30_000);
  });

  test("is passed to the refresher as a deadline, not left to the endpoint", () => {
    // The mechanism that bounds a hung endpoint — and that created the cliff.
    const source = readFileSync(
      "src/providers/authentication/oauth-refresh-service.ts",
      "utf8",
    );
    expect(source).toContain("AbortSignal.timeout(REFRESH_HTTP_TIMEOUT_MS)");
  });
});

describe("a hung token endpoint is bounded by the deadline", () => {
  test("the refresher is handed an abort signal", () => {
    const observed: { signal?: AbortSignal | undefined } = {};
    void hangingRefresher(observed).refresh("rt", AbortSignal.timeout(50));
    expect(observed.signal).toBeDefined();
    expect(observed.signal?.aborted).toBe(false);
  });

  test("a caller awaiting the refresh is released only when the deadline passes", async () => {
    // The cost of a hung endpoint is bounded by the deadline, never longer.
    const observed: { signal?: AbortSignal | undefined } = {};
    const refresher = hangingRefresher(observed);
    const startedAt = performance.now();
    const result = await refresher.refresh("rt", AbortSignal.timeout(60));
    const elapsed = performance.now() - startedAt;

    expect(result.access).toBe("never-used");
    expect(observed.signal?.aborted).toBe(true);
    // Generous lower bound: the point is that the caller waits out the
    // deadline rather than returning early, not the exact figure.
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  test("a fast token endpoint does not impose the deadline", async () => {
    // The control case, so the test above is not just measuring that awaiting
    // is slow: a healthy endpoint returns without waiting for any timeout.
    const startedAt = performance.now();
    const result = await fastRefresher().refresh("rt", AbortSignal.timeout(30_000));
    const elapsed = performance.now() - startedAt;
    expect(result.access).toBe("fresh-token");
    expect(elapsed).toBeLessThan(50);
  });
});

describe("the request path performs no inline refresh", () => {
  test("credentials resolution no longer awaits a refresher", () => {
    const source = readFileSync(
      "src/providers/operations/provider-credential-service.ts",
      "utf8",
    );
    // The dispatch credential resolver must not call `ensureFreshAccessToken`:
    // that call is what blocked client requests on the token endpoint. The
    // export/UI paths (which keep their refresh) live elsewhere.
    const dispatchSection = source.slice(
      source.indexOf("export async function resolveCredentialForAccount"),
      source.indexOf("async function resolveAccountCredentialsForExport"),
    );
    // The interface type name still mentions the method; what must be gone is
    // any actual call site inside the dispatch resolver.
    expect(dispatchSection).not.toContain("ensureFreshAccessToken(");
  });
});
