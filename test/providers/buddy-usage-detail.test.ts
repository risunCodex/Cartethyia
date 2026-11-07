/**
 * The buddy usage-detail read.
 *
 * `POST {billingHost}/billing/meter/get-user-request-usage` answers what an
 * account actually spent — per day, per model, in credits — which is the figure
 * the reference gateways show as real usage. Until this existed the console's
 * usage view was built from synthetic activity events we report ourselves.
 *
 * The property that matters most is the one that is easy to get wrong: **a
 * usage read must never fail a request**. It is a display concern on a
 * different endpoint from the dispatch path, so a 500, a malformed body, or an
 * unreachable host has to yield whatever was collected and say `partial`,
 * rather than throwing into a quota refresh — which would park a perfectly
 * working account for a billing-page problem.
 *
 * A stubbed fetcher stands in for the upstream: what is under test is the
 * request shape and the agreement about what counts as "no data".
 */
import { describe, expect, test } from "bun:test";
import { fetchBuddyRequestUsage } from "../../src/providers/integrations/buddy/buddy-usage-shared";
import { fetchCodeBuddyRequestUsage } from "../../src/providers/integrations/buddy/codebuddy/quota";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";

interface Seen {
  readonly url: string;
  readonly init?: RequestInit;
  readonly body: Record<string, unknown>;
}

/** Records every call and answers from `responder`. */
function recordingFetcher(
  responder: (seen: Seen) => Response,
): { fetcher: FetchLike; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const seen: Seen = { url: String(url), ...(init ? { init } : {}), body };
    calls.push(seen);
    return responder(seen);
  }) as unknown as FetchLike;
  return { fetcher, calls };
}

function ok(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

const BASE = {
  url: "https://copilot.tencent.com/billing/meter/get-user-request-usage",
  headers: { "X-Product": "SaaS" },
  credential: "secret-token",
  days: 7,
} as const;

describe("fetchBuddyRequestUsage — the happy path", () => {
  test("parses per-day, per-model credits and totals them", async () => {
    const { fetcher, calls } = recordingFetcher((seen) =>
      ok({
        code: 0,
        data: seen.body["pageNum"] === 1
          ? {
              total: 3,
              data: [
                { requestTime: "2026-10-14 09:12:00", model: "glm-5.2", credit: 1.5 },
                { requestTime: "2026-10-14 10:00:00", model: "glm-5.2", credit: 0.25 },
                { requestTime: "2026-10-15 08:00:00", model: "hy3", credit: 2 },
              ],
            }
          : { total: 3, data: [] },
      }),
    );
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher });

    // Same day + same model collapses into one row rather than being listed
    // once per request.
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ day: "2026-10-14", model: "glm-5.2", credit: 1.75 });
    expect(result.rows[1]).toEqual({ day: "2026-10-15", model: "hy3", credit: 2 });
    expect(result.totalCredits).toBe(3.75);
    expect(result.partial).toBe(false);

    // The wire shape the reference gateway sends.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body["pageSize"]).toBe(200);
    expect(calls[0]!.body["pageNum"]).toBe(1);
    expect(calls[0]!.body["days"]).toBe(7);
    expect(typeof calls[0]!.body["startTime"]).toBe("string");
    expect(typeof calls[0]!.body["endTime"]).toBe("string");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  test("sends a Bearer credential resolved out of an OAuth envelope", async () => {
    const { fetcher, calls } = recordingFetcher(() => ok({ code: 0, data: { total: 0, data: [] } }));
    await fetchBuddyRequestUsage({
      ...BASE,
      fetcher,
      credential: JSON.stringify({ accessToken: "from-envelope", refreshToken: "r" }),
    });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer from-envelope");
  });

  test("stops as soon as a page comes back short", async () => {
    // Two pages of data, but the first is short — the second call would only
    // re-request an empty page.
    const { fetcher, calls } = recordingFetcher((seen) =>
      ok({
        code: 0,
        data: { total: 1, data: seen.body["pageNum"] === 1 ? [{ requestTime: "2026-10-14 09:00:00", model: "m", credit: 1 }] : [] },
      }),
    );
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher });
    expect(calls).toHaveLength(1);
    expect(result.partial).toBe(false);
    expect(result.totalCredits).toBe(1);
  });
});

describe("fetchBuddyRequestUsage — a read that cannot fail the caller", () => {
  test("a 500 yields empty rows and partial, never a throw", async () => {
    const { fetcher } = recordingFetcher(() => new Response("boom", { status: 500 }));
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher });
    expect(result.rows).toEqual([]);
    expect(result.totalCredits).toBe(0);
    expect(result.partial).toBe(true);
  });

  test("a transport throw is contained too", async () => {
    const { fetcher } = recordingFetcher(() => {
      throw new Error("network down");
    });
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher });
    expect(result.rows).toEqual([]);
    expect(result.partial).toBe(true);
  });

  test("invalid JSON is not an error, but it is partial", async () => {
    const { fetcher } = recordingFetcher(() => new Response("<html>", { status: 200 }));
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher });
    expect(result.rows).toEqual([]);
    expect(result.partial).toBe(true);
  });

  test("a non-zero business code is a refusal, not zero usage", async () => {
    // Reading this as "spent nothing" would show an account that has been
    // billed as an idle one.
    const { fetcher } = recordingFetcher(() => ok({ code: 14018, msg: "not authorized" }));
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher });
    expect(result.rows).toEqual([]);
    expect(result.partial).toBe(true);
  });

  test("a missing data list is the same: no data, not zero data", async () => {
    const { fetcher } = recordingFetcher(() => ok({ code: 0, data: {} }));
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher });
    expect(result.rows).toEqual([]);
    expect(result.partial).toBe(true);
  });

  test("a genuinely empty payload is not an error", async () => {
    // An account that spent nothing must not render as a failed read. The
    // difference from the case above is exactly the `data.data` array.
    const { fetcher } = recordingFetcher(() => ok({ code: 0, data: { total: 0, data: [] } }));
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher });
    expect(result.rows).toEqual([]);
    expect(result.totalCredits).toBe(0);
    expect(result.partial).toBe(false);
  });

  test("a later page failing keeps the rows already collected", async () => {
    const { fetcher } = recordingFetcher((seen) =>
      seen.body["pageNum"] === 1
        ? ok({
            code: 0,
            // A full page, so the walk continues to the next one — which is the
            // one that fails. A short page would end the walk legitimately and
            // would not exercise the "keep what was collected" path.
            data: {
              total: 400,
              data: Array.from({ length: 200 }, () => ({
                requestTime: "2026-10-14 09:00:00",
                model: "glm-5.2",
                credit: 4,
              })),
            },
          })
        : new Response("boom", { status: 500 }),
    );
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher });
    expect(result.rows).toHaveLength(1);
    expect(result.totalCredits).toBe(800);
    expect(result.partial).toBe(true);
  });

  test("a credential with no secret at all is reported as incomplete", async () => {
    const { fetcher, calls } = recordingFetcher(() => ok({ code: 0, data: { total: 0, data: [] } }));
    const result = await fetchBuddyRequestUsage({ ...BASE, fetcher, credential: "   " });
    expect(result.rows).toEqual([]);
    expect(result.partial).toBe(true);
    // Nothing to authenticate with, so nothing is sent.
    expect(calls).toHaveLength(0);
  });
});

describe("the per-provider wrappers", () => {
  test("CodeBuddy reads its own billing host with a Bearer credential", async () => {
    const { fetcher, calls } = recordingFetcher(() => ok({ code: 0, data: { total: 0, data: [] } }));
    await fetchCodeBuddyRequestUsage("token-abc", fetcher, "cbcn", 14);
    expect(calls[0]!.url).toContain("/billing/meter/get-user-request-usage");
    expect(calls[0]!.url).toContain("copilot.tencent.com");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer token-abc");
    expect(calls[0]!.body["days"]).toBe(14);
  });
});
