import { describe, expect, test } from "bun:test";
import { claimZcodeGifts } from "../../src/providers/integrations/zcode-start-plan/gifts";
import type { ValidatedFetch } from "../../src/network/outbound-fetch";

const emptyFeed = { code: 0, data: { deliveries: [] } };
const emptyPreview = { code: 0, msg: "" };

function fixture(feed: unknown, preview: unknown, codes: readonly unknown[] = []) {
  let posts = 0;
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetcher: ValidatedFetch = async (url, init) => {
    signals.push(init?.signal);
    if (init?.method === "POST") {
      const code = codes[posts++];
      return code === "not-json" ? new Response("not-json") : Response.json({ code });
    }
    const body = String(url).includes("marketing/touch") ? feed : preview;
    return body === "not-json" ? new Response("not-json") : Response.json(body);
  };
  return { fetcher, signals, posts: () => posts };
}

const preview = (count: number) => ({ code: 0, data: { plans: Array.from({ length: count }, (_, i) => ({ plan_id: `plan-${i}`, name: `Gift ${i}` })) } });
const claim = (fetcher: ValidatedFetch) => claimZcodeGifts({ accountId: "fixture", credential: "dummy-secret", fetcher });

describe("ZCode gift outcomes", () => {
  test("the documented no-data preview and valid empty feed mean nothing", async () => {
    const upstream = fixture(emptyFeed, emptyPreview);
    expect(await claim(upstream.fetcher)).toEqual({ state: "nothing", claimed: [], detail: null });
    expect(upstream.posts()).toBe(0);
  });

  for (const data of [undefined, null, {}]) {
    test(`successful omitted lists are empty: ${JSON.stringify(data)}`, async () => {
      expect((await claim(fixture({ code: 0, data }, { code: 0, data }).fetcher)).state).toBe("nothing");
    });
  }

  for (const broken of ["not-json", { success: false }, {}, { code: 999 }, { code: 0, data: [] }, { code: 0, data: { plans: {} } }, { code: 0, data: { plans: [null] } }]) {
    test(`invalid preview is failure: ${JSON.stringify(broken)}`, async () => {
      const upstream = fixture(emptyFeed, broken);
      expect((await claim(upstream.fetcher)).state).toBe("error");
      expect(upstream.posts()).toBe(0);
    });
  }

  for (const broken of ["not-json", { success: false }, { code: 0, data: [] }, { code: 0, data: { deliveries: {} } }, { code: 0, data: { deliveries: [null] } }]) {
    test(`invalid feed is failure: ${JSON.stringify(broken)}`, async () => {
      expect((await claim(fixture(broken, emptyPreview).fetcher)).state).toBe("error");
    });
  }

  for (const [code, state] of [[0, "claimed"], [1003, "already_claimed"], [3007, "captcha"], [7777, "error"], ["not-json", "error"]] as const) {
    test(`claim code ${code} means ${state} and every request is bounded`, async () => {
      const upstream = fixture(emptyFeed, preview(1), [code]);
      const result = await claim(upstream.fetcher);
      expect(result.state).toBe(state);
      expect(result.claimed).toEqual(code === 0 ? ["Gift 0"] : []);
      expect(upstream.signals).toHaveLength(3);
      expect(upstream.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    });
  }

  test("marketing banner claims are discovered and deduplicated against preview", async () => {
    const feed = { code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "plan-0" } } }], background: { args: { zcode_plan: { name: "Banner Gift" } } } } }] } };
    const upstream = fixture(feed, preview(1), [0]);
    expect(await claim(upstream.fetcher)).toEqual({ state: "claimed", claimed: ["Banner Gift"], detail: null });
    expect(upstream.posts()).toBe(1);
  });

  test("an invalid marketing claim action is not an empty feed", async () => {
    const feed = { code: 0, data: { deliveries: [{ action: { type: "claim_zcode_plan", args: {} } }] } };
    expect((await claim(fixture(feed, emptyPreview).fetcher)).state).toBe("error");
  });

  test("success false on a claim cannot override the business failure", async () => {
    const upstream = fixture(emptyFeed, preview(1));
    const fetcher: ValidatedFetch = (url, init) => init?.method === "POST"
      ? Promise.resolve(Response.json({ code: 0, success: false })) : upstream.fetcher(url, init);
    expect((await claim(fetcher)).state).toBe("error");
  });

  test("mixed claims retain grants without hiding CAPTCHA or failure", async () => {
    const result = await claim(fixture(emptyFeed, preview(4), [0, 1003, 3007, 7777]).fetcher);
    expect(result.state).toBe("partial");
    expect(result.claimed).toEqual(["Gift 0"]);
    expect(result.detail).toContain("CAPTCHA");
    expect(result.detail).toContain("failed");
  });

  test("an unread list is partial even when every discovered gift was already claimed", async () => {
    const result = await claim(fixture("not-json", preview(1), [1003]).fetcher);
    expect(result.state).toBe("partial");
    expect(result.detail).toContain("did not read");
  });

  test("transport credentials are never copied into result details", async () => {
    const result = await claim(async () => { throw new Error("Bearer dummy-secret"); });
    expect(result.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain("dummy-secret");
  });
});
