/**
 * The endpoint-quota collector added for Trae.
 *
 * Trae had no collector at all, so the console showed no balance — and "no
 * balance" is indistinguishable from "no quota left" to anything reading the
 * account. The properties pinned here are the ones that decide whether the
 * account gets parked:
 *
 * 1. **A partial read is still a read.** Trae's two surfaces live on different
 *    hosts, and the pay host is the first thing a region-blocked account loses.
 *    If a dead pay host failed the whole call, a perfectly healthy account
 *    would report no quota and be parked.
 * 2. **The current surface outranks the legacy one.** A legacy `/auth/usage`
 *    reports a permanently-zero bucket on exactly the plans that have a dollar
 *    cap, so letting it win would publish "no usage" for a spending account.
 */
import { describe, expect, test } from "bun:test";
import { fetchTraeQuota } from "../../src/providers/integrations/trae/trae-quota";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetcher that routes on a URL substring, 404-ing anything unrouted. */
function routedFetcher(
  routes: readonly (readonly [string, Response | (() => Response)])[],
): typeof fetch {
  return (async (url: unknown) => {
    const target = String(url);
    for (const [fragment, response] of routes) {
      if (target.includes(fragment)) {
        return typeof response === "function" ? response() : response;
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("Trae quota — the two surfaces are independent", () => {
  const routes = [
    [
      "get_session_usage",
      jsonResponse({
        remain_usage: { advanced_model: 40, premium_model_fast_request: 9 },
        usage: { advanced_model: { limit: 100 }, premium_model_fast_request: { limit: 50 } },
      }),
    ],
    [
      "ide_user_ent_usage",
      jsonResponse({
        billing_version: 3,
        user_entitlement_pack_list: [
          {
            display_desc: "Free plan",
            entitlement_base_info: {
              end_time: 1796083199,
              quota: {
                advanced_model_request_limit: 1000,
                premium_model_fast_request_limit: 10,
              },
            },
            usage: { basic_usage_amount: 0 },
            status: 1,
          },
        ],
      }),
    ],
  ] as const;

  test("remaining is read from remain_usage and the cap from usage", async () => {
    // `remain_usage` carries a bare number per bucket, not a nested object; the
    // caps are on the sibling `usage` object. Reading the wrong side leaves a
    // limit with no remaining — a window that cannot say how much is left.
    const result = await fetchTraeQuota("token", routedFetcher(routes), {
      auth_state: { realm: "intl", uid: "u1" },
    });

    expect(result.error).toBeNull();
    const advanced = result.windows.find((w) => w.kind === "trae:Advanced model requests");
    expect(advanced?.used).toBe(60); // 100 - 40
    expect(advanced?.limit).toBe(100);
    const fast = result.windows.find((w) => w.kind === "trae:Premium fast requests");
    expect(fast?.used).toBe(41); // 50 - 9

    // The entitlement surface contributes its own windows from the pack list:
    // caps from `entitlement_base_info.quota`, no consumption count in the v1
    // shape, and the plan name from `display_desc`.
    const entAdv = result.windows.find((w) => w.kind === "trae:advanced_model");
    expect(entAdv).toBeDefined();
    expect(entAdv?.limit).toBe(1000);
    expect(entAdv?.used).toBeNull();
    const entFast = result.windows.find((w) => w.kind === "trae:premium_model_fast_request");
    expect(entFast).toBeDefined();
    expect(entFast?.limit).toBe(10);
    expect(result.plan).toBe("Free plan");
  });

  test("a dead pay host does not erase a readable meter", async () => {
    // The pay host is the first thing a region-blocked account loses. Failing
    // the whole read here would report no quota and park a healthy account.
    const fetcher = routedFetcher([
      [
        "get_session_usage",
        jsonResponse({
          remain_usage: { advanced_model: 40 },
          usage: { advanced_model: { limit: 100 } },
        }),
      ],
      ["ide_user_ent_usage", () => new Response("upstream down", { status: 500 })],
    ]);

    const result = await fetchTraeQuota("token", fetcher, {
      auth_state: { realm: "intl", uid: "u1" },
    });

    expect(result.windows.length).toBeGreaterThan(0);
    // The quiet surface is logged, not returned: `error` is what flags the
    // account quota_fetch_failed and cools it.
    expect(result.error).toBeNull();
  });

  test("both surfaces unavailable without auth evidence leave account health alone", async () => {
    const fetcher = routedFetcher([]);
    const result = await fetchTraeQuota("token", fetcher, {
      auth_state: { realm: "intl", uid: "u1" },
    });

    expect(result.windows).toHaveLength(0);
    expect(result.error).toBeNull();
    expect(result.authInvalidated).toBeUndefined();
  });

  test("all four realm/surface responses with 401 code 1001 invalidate auth", async () => {
    const fetcher = (async () => jsonResponse({
      code: 1001,
      message: "We're sorry, but we are not able to authenticate you.",
    }, 401)) as unknown as typeof fetch;

    const result = await fetchTraeQuota("token", fetcher, {
      auth_state: { realm: "intl", uid: "u1" },
    });

    expect(result.windows).toHaveLength(0);
    expect(result.authInvalidated).toBe(true);
    expect(result.error).toContain("HTTP 401");
    expect(result.error).toContain('"code":1001');
  });

  test("one successful realm/surface prevents auth invalidation", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ code: 1001, message: "unauthorized" }, 401);
      if (calls === 2) return jsonResponse({
        remain_usage: { advanced_model: 40 },
        usage: { advanced_model: { limit: 100 } },
      });
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    const result = await fetchTraeQuota("token", fetcher, {
      auth_state: { realm: "intl", uid: "u1" },
    });

    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.authInvalidated).toBeUndefined();
    expect(result.error).toBeNull();
  });

  test("an sg account uses the sg pay host, not the us default", async () => {
    // The pay surface is region-correlated like the core surface: an `sg`
    // account sent to the US pay host is answered 401 code 1001. The collector
    // must hit the region's pay host.
    const urls: string[] = [];
    const fetcher = (async (url: unknown) => {
      const target = String(url);
      urls.push(target);
      if (target.includes("get_session_usage")) {
        return jsonResponse({
          remain_usage: { advanced_model: 40 },
          usage: { advanced_model: { limit: 100 } },
        });
      }
      if (target.includes("ide_user_ent_usage")) {
        return jsonResponse({
          user_entitlement_pack_list: [
            {
              display_desc: "Free plan",
              entitlement_base_info: { quota: { advanced_model_request_limit: 1000 } },
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchTraeQuota("token", fetcher, {
      auth_state: { realm: "intl", uid: "u1", region: "sg" },
    });

    expect(result.error).toBeNull();
    expect(urls.some((u) => u.includes("grow-normal.trae.ai"))).toBe(true);
    expect(urls.some((u) => u.includes("grow-normal.traeapi.us"))).toBe(false);
    expect(result.windows.some((w) => w.kind === "trae:advanced_model")).toBe(true);
  });

  test("a cn realm uses the v2 entitlement path, intl uses v1", async () => {
    const targetUrls: string[] = [];
    const run = async (realm: string): Promise<string[]> => {
      const urls: string[] = [];
      const fetcher = (async (url: unknown) => {
        const target = String(url);
        urls.push(target);
        if (target.includes("get_session_usage")) {
          return jsonResponse({
            remain_usage: { advanced_model: 40 },
            usage: { advanced_model: { limit: 100 } },
          });
        }
        if (target.includes("ide_user_ent_usage")) {
          return jsonResponse({
            usage_summary: { total_amount: 900, consumed_amount: 0.39 },
          });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;
      await fetchTraeQuota("token", fetcher, {
        auth_state: { realm, uid: "u1", region: realm === "cn" ? "CN" : "sg" },
      });
      return urls;
    };

    targetUrls.push(...(await run("intl")));
    targetUrls.push(...(await run("cn")));

    // v1 for intl, v2 for CN.
    expect(targetUrls.filter((u) => u.includes("api/v1/pay/ide_user_ent_usage"))).toHaveLength(1);
    expect(targetUrls.filter((u) => u.includes("api/v2/pay/ide_user_ent_usage"))).toHaveLength(1);
  });

  test("a cn account's dead token invalidates auth even though the intl host 404s v2", async () => {
    // The cn realm's entitlement surface is v2; the intl pay host answers v2
    // with 404 (its surface is v1). Asking the cross-realm fallback for the
    // believed realm's path version produced a 404 error that broke the 4x1001
    // signature — so a dead cn token was never auth-invalidated. The fallback
    // must ask each realm its own path version.
    const fetcher = (async (url: unknown) => {
      const target = String(url);
      if (
        target.includes("ide_user_ent_usage") &&
        target.includes("/api/v2/") &&
        !target.includes("api.trae.com.cn")
      ) {
        // The intl pay host's v2 surface does not exist.
        return new Response("not found", { status: 404 });
      }
      return jsonResponse(
        { code: 1001, message: "we are not able to authenticate you" },
        401,
      );
    }) as unknown as typeof fetch;

    const result = await fetchTraeQuota("token", fetcher, {
      auth_state: { realm: "cn", uid: "u1", region: "CN" },
    });

    expect(result.windows).toHaveLength(0);
    expect(result.authInvalidated).toBe(true);
    expect(result.error).toContain("HTTP 401");
    expect(result.error).toContain('"code":1001');
  });

  test("a lowercase cn region without a realm field still selects the cn realm", async () => {
    // Realm inference compared `region === "CN"` case-sensitively, so a stored
    // `cn` region fell through to the intl realm. The candidate order is the
    // observable: the believed realm's core host is asked first.
    const urls: string[] = [];
    const fetcher = (async (url: unknown) => {
      urls.push(String(url));
      return jsonResponse({
        remain_usage: { advanced_model: 40 },
        usage: { advanced_model: { limit: 100 } },
      });
    }) as unknown as typeof fetch;

    const result = await fetchTraeQuota("token", fetcher, {
      auth_state: { uid: "u1", region: "cn" },
    });

    expect(result.error).toBeNull();
    expect(urls[0]).toContain("trae-api-cn.mchost.guru");
  });
});
