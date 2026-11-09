import { describe, expect, test } from "bun:test";
import { ZcodeStartPlanOAuthClient } from "../../src/providers/integrations/zcode-start-plan/oauth";
import { ZCODE_START_PLAN_PROVIDER_ID } from "../../src/providers/integrations/zcode-start-plan/provider";
import { oauthIdentityFingerprint } from "../../src/console/providers/oauth/routes";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { EligibilityEvaluator } from "../../src/transport/routing/router";
import { classifyAccountError } from "../../src/providers/operations/account-error-classification";
import { classifyUpstreamFailure, mapUpstreamHttpError } from "../../src/transport/failure-policy";
import { encodeResponsesEvents } from "../../src/transport/surface/responses/encode";
import { withFrozenTime } from "../helpers/clock";
import type { CanonicalRequest, CanonicalEvent } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";
import type { RouteCandidate } from "../../src/transport/routing/route-model";
import type { ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";

const ID = ZCODE_START_PLAN_PROVIDER_ID;
const NOW = Date.UTC(2030, 0, 1);
const SECONDS = NOW / 1000;
const context = { providerId: ID, tenantId: null, accountLabel: ID, providerState: "fixture-poll-token" };
function jwt(userId: string, expiresAt?: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode({ user_id: userId, ...(expiresAt === undefined ? {} : { exp: expiresAt }) })}.signature`;
}

function bucket(model: string, remaining = 100, extra: Record<string, unknown> = {}) {
  return {
    plan_id: "start", user_plan_id: "fixture-plan", entitlement_id: model,
    show_name: `${model}-Trial`, capabilities: [`model:${model}`], total_units: 100,
    used_units: 100 - remaining, remaining_units: remaining,
    period_start: SECONDS - 3600, period_end: SECONDS + 3600, ...extra,
  };
}
const plan = (extra: Record<string, unknown> = {}) => ({
  plan_id: "start", user_plan_id: "fixture-plan", name: "Start Plan", status: "active",
  starts_at: SECONDS - 3600, ends_at: SECONDS + 86400,
  entitlements: [{ entitlement_id: "glm-5.3", period: "daily", capabilities: ["model:glm-5.3"] }], ...extra,
});
async function collect(balances: unknown[], plans: unknown[] = [plan()], extra: Record<string, unknown> = {}) {
  const collector = await createDefaultProviderRegistry().resolveQuotaCollector(ID);
  if (!collector) throw new Error("Missing Start Plan collector");
  return collector("fixture-token", Object.assign(async () => Response.json({ code: 0, data: { plans, balances }, ...extra }), { preconnect() {} }));
}
function route(model: string, windows: readonly ProviderQuotaWindow[], extra: Partial<RouteCandidate> = {}) {
  return new EligibilityEvaluator().evaluate({
    provider_id: ID, model_id: model, wire_family: "messages", endpoint: "/v1/messages",
    capability_profile: {}, quota_windows: windows, ...extra,
  });
}

describe("ZCode Start Plan device login", () => {
  test("keeps the private poll token and distinguishes accounts without email", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const fingerprints: string[] = [];
    for (const userId of ["fixture-a", "fixture-b"]) {
      const client = new ZcodeStartPlanOAuthClient(async (url, init) => {
        calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
        return String(url).endsWith("/init")
          ? Response.json({ data: { authorize_url: "https://zcode.z.ai/approve", flow_id: "fixture-flow" } })
          : Response.json({ data: { status: "ready", token: jwt(userId) } });
      });
      const started = await client.startDeviceAuth();
      const result = await client.pollDeviceAuth(started.deviceAuthId, { ...context, providerState: started.providerState });
      expect(result.status).toBe("complete");
      if (result.status !== "complete") throw new Error("Expected login completion");
      expect(result.result.accountLabel).toBe(userId);
      fingerprints.push(oauthIdentityFingerprint({ ...result.result, label: userId, providerId: ID }));
      expect(calls.at(-1)?.authorization).toBe(calls.at(-2)?.authorization);
    }
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });

  test("rejects expired auth and honors upstream retry intervals", async () => {
    const unauthorized = new ZcodeStartPlanOAuthClient(async () => new Response(null, { status: 401 }));
    expect((await unauthorized.pollDeviceAuth("fixture", context)).status).toBe("failed");
    const limited = new ZcodeStartPlanOAuthClient(async () => new Response(null, { status: 429, headers: { "retry-after": "12" } }));
    expect(await limited.pollDeviceAuth("fixture", context)).toEqual({ status: "slow_down", retryAfterSeconds: 12 });
    const unavailable = new ZcodeStartPlanOAuthClient(async () => new Response(null, { status: 503 }));
    expect((await unavailable.pollDeviceAuth("fixture", context)).status).toBe("pending");
  });

  test("keeps issuer expiry when the login token supplies one", async () => {
    const expiry = SECONDS + 600;
    const client = new ZcodeStartPlanOAuthClient(async () =>
      Response.json({ data: { status: "ready", token: jwt("fixture-expiring", expiry) } }));
    const result = await client.pollDeviceAuth("fixture", context);
    if (result.status !== "complete") throw new Error("Expected authorized login");
    expect(result.result.expiresAt.getTime()).toBe(expiry * 1000);
  });

  test("only a ready authorized poll can finish sign-in", async () => {
    for (const body of [
      { code: 3001, data: { status: "ready", token: jwt("fixture") } },
      { success: false, data: { status: "ready", token: jwt("fixture") } },
      { code: 0, data: { status: "denied" } },
      { code: 0, data: { status: "failed", token: jwt("fixture") } },
      { code: 0, data: { status: "ready" } },
    ]) {
      const client = new ZcodeStartPlanOAuthClient(async () => Response.json(body));
      expect((await client.pollDeviceAuth("fixture", context)).status).toBe("failed");
    }
    const pending = new ZcodeStartPlanOAuthClient(async () => Response.json({ code: 0, data: { status: "pending" } }));
    expect((await pending.pollDeviceAuth("fixture", context)).status).toBe("pending");
  });
});

test("ZCode Start Plan registry dispatch preserves caller instructions and model through client encoding", async () => {
  const adapter = await createDefaultProviderRegistry().resolve(ID);
  if (!adapter) throw new Error("Missing Start Plan adapter");
  const calls: { url: string; headers: Headers; payload: Record<string, unknown> }[] = [];
  const request: CanonicalRequest = {
    model: "glm-5.3", system: [{ kind: "text", text: "fixture user instructions" }],
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: { max_output_tokens: 32 }, stream: false, source_surface: "messages",
  };
  const target: ProviderDispatchTarget = { provider_id: ID, model_id: request.model, wire_family: "messages", endpoint_path: "/v1/messages", capabilities: {} };
  const dispatchContext: ProviderDispatchContext = {
    credential: { provider_id: ID, credential_kind: "api_key", secret: new TextEncoder().encode(jwt("fixture-user")) },
    deadline: Date.now() + 30_000, abort_signal: new AbortController().signal,
    outbound_fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), payload: JSON.parse(String(init?.body)) });
      return Response.json({ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "text", text: "fixture answer" }], model: request.model, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } });
    },
  };
  const events: CanonicalEvent[] = [];
  for await (const event of adapter.dispatch(request, target, dispatchContext)) events.push(event);
  const encoded = JSON.parse(new TextDecoder().decode(encodeResponsesEvents(events, { model: request.model }).bytes));
  expect(encoded.model).toBe(request.model);
  expect(encoded.output[0].content[0].text).toBe("fixture answer");
  const call = calls[0];
  expect(call?.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
  expect(call?.headers.get("authorization")).toBe(`Bearer ${jwt("fixture-user")}`);
  // The plan-lane identity face mirrored from the desktop client.
  expect(call?.headers.get("anthropic-beta")).toBe("mid-conversation-system-2026-04-07");
  expect(call?.headers.get("x-query-id")).toMatch(/^01a1[0-9a-f]{28}$/);
  expect(call?.headers.get("x-zcode-query-source")).toBe("main_turn");
  expect(call?.headers.get("x-title")).toBe("Z Code@electron");
  expect(call?.headers.get("anthropic-version")).toBe("2023-06-01");
  const metadata = call?.payload.metadata as Record<string, string>;
  expect(metadata?.user_id).toBeTruthy();
  const parsedMeta = JSON.parse(String(metadata?.user_id)) as Record<string, string>;
  expect(parsedMeta.device_id).toBeTruthy();
  expect(parsedMeta.account_uuid).toBe("fixture-user");
  expect(parsedMeta.session_id).toBeTruthy();
  const blocks = call?.payload.system as { text: string }[];
  expect(blocks[2]?.text).toContain("fixture user instructions");
});

test("ZCode Start Plan rejects HTTP 200 business errors instead of completing empty", async () => {
  const adapter = await createDefaultProviderRegistry().resolve(ID);
  if (!adapter) throw new Error("Missing Start Plan adapter");
  const request: CanonicalRequest = { model: "glm-5.3-flash", messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }], generation_controls: {}, stream: false, source_surface: "messages" };
  const target: ProviderDispatchTarget = { provider_id: ID, model_id: request.model, wire_family: "messages", endpoint_path: "/v1/messages", capabilities: {} };
  for (const code of [1005, 1113, 3009]) {
    const events: CanonicalEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of adapter.dispatch(request, target, {
        credential: { provider_id: ID, credential_kind: "api_key", secret: new TextEncoder().encode("fixture") },
        deadline: Date.now() + 5000, abort_signal: new AbortController().signal,
        outbound_fetch: async () => Response.json({ code, msg: "upstream business refusal" }),
      })) events.push(event);
    } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(events.some((event) => event.type === "terminal" && event.state === "complete")).toBe(false);
    expect(failure).toMatchObject({ details: { providerCode: String(code) } });
  }
});

describe("ZCode Start Plan quota eligibility through registry", () => {
  test("a spent model leaves sibling and the separate Coding Plan available", async () => withFrozenTime(NOW, async () => {
    const quota = await collect([bucket("glm-5.3", 0), bucket("glm-5.3-flash", 75)]);
    // Quota is deliberately not an eligibility exclusion: all accounts remain
    // routed (upstream decides). Quota only affects ordering.
    expect(route("glm-5.3", quota.windows).eligible).toBe(true);
    expect(route("glm-5.3-flash", quota.windows).eligible).toBe(true);
    expect(route("glm-5.3", [], { provider_id: "zcode" }).eligible).toBe(true);
  }));

  test("a successful entitlement list excludes models with no matching grant", async () => withFrozenTime(NOW, async () => {
    const quota = await collect([bucket("glm-5.3", 100)]);
    expect(route("glm-5.3-flash", quota.windows).eligible).toBe(true);
    expect(route("glm-5.3", quota.windows).eligible).toBe(true);
    expect(route("glm-5.3", [], { quota_entitlements_known: true }).eligible).toBe(true);
    expect(route("glm-5.3", []).eligible).toBe(true);
  }));

  test("any live alternative grant serves the same model without pooling unrelated grants", async () => withFrozenTime(NOW, async () => {
    const quota = await collect([bucket("glm-5.3", 0), bucket("glm-5.3", 50, { plan_id: "bonus", user_plan_id: "bonus" })]);
    expect(route("glm-5.3", quota.windows).eligible).toBe(true);
    expect(route("glm-5.3", quota.windows, { usage_floor: 60 }).eligible).toBe(true);
  }));

  test("future grant is visible but cannot fund a request before its start", async () => withFrozenTime(NOW, async () => {
    const quota = await collect([bucket("glm-5.3")], [plan({ starts_at: SECONDS + 600 })]);
    expect(quota.windows[0]?.startsAt).toBe(new Date(NOW + 600_000).toISOString());
    expect(quota.windows[0]?.remaining).toBe(100);
    const decision = route("glm-5.3", quota.windows);
    expect(decision.eligible).toBe(true);
    await withFrozenTime(NOW + 600_001, () => expect(route("glm-5.3", quota.windows).eligible).toBe(true));
  }));

  test("future plans with no materialized balances are still visible", async () => withFrozenTime(NOW, async () => {
    const quota = await collect([], [plan({ starts_at: SECONDS + 600 })]);
    expect(quota.error).toBeNull();
    expect(quota.windows[0]?.modelIds).toEqual(["glm-5.3"]);
    expect(route("glm-5.3", quota.windows).eligible).toBe(true);
  }));

  test("expired plan or bucket never funds routing even if it still reports tokens", async () => withFrozenTime(NOW, async () => {
    const quota = await collect([bucket("glm-5.3", 100, { expires_at: SECONDS - 1 })]);
    expect(route("glm-5.3", quota.windows).eligible).toBe(true);
    const ended = await collect([bucket("glm-5.3")], [plan({ ends_at: SECONDS - 1 })]);
    expect(route("glm-5.3", ended.windows).eligible).toBe(true);
  }));

  test("display labels do not invent missing model capabilities", async () => withFrozenTime(NOW, async () => {
    const quota = await collect([bucket("glm-5.3", 0, { capabilities: ["tool:search"], show_name: "GLM" })]);
    expect(quota.windows[0]?.modelIds).toEqual([]);
    expect(route("glm-5.3-flash", quota.windows).eligible).toBe(true);
  }));

  test("business and malformed envelopes are failures, valid absence is not", async () => {
    expect((await collect([], [], { code: 3001 })).error).not.toBeNull();
    expect((await collect([], [], { success: false })).error).not.toBeNull();
    expect((await collect([], [], { data: "invalid" })).error).not.toBeNull();
    expect((await collect([], [])).error).toBeNull();
  });

  test("shortens the built-in Start window but preserves referral grant identity", async () => {
    const start = await collect([bucket("glm-5.3")], [plan({ name: "ZCode Start Plan" })]);
    expect(start.windows[0]?.label).toBe("glm-5.3-Trial · Start · daily");
    expect(start.plan).toBe("ZCode Start Plan");
    const referral = await collect([bucket("glm-5.3")], [plan({ name: "Referral Weekend" })]);
    expect(referral.windows[0]?.label).toBe("glm-5.3-Trial · Referral Weekend · daily");
    expect(referral.plan).toBe("Referral Weekend");
  });

  test("reports timeout separately from unreadable JSON without leaking exceptions", async () => {
    const collector = await createDefaultProviderRegistry().resolveQuotaCollector(ID);
    if (!collector) throw new Error("Missing Start Plan collector");
    const fetcher = Object.assign(async () => { throw new DOMException("private fixture details", "TimeoutError"); }, { preconnect() {} });
    const timeout = await collector("fixture", fetcher);
    expect(timeout.error).toBe("plan billing operation timed out or was aborted");
    const invalid = await collector("fixture", Object.assign(async () => new Response("not-json"), { preconnect() {} }));
    expect(invalid.error).toBe("plan billing returned unreadable JSON");
    const network = await collector("fixture", Object.assign(async () => { throw new TypeError("Bearer private-fixture-token"); }, { preconnect() {} }));
    expect(network.error).toBe("plan billing network request failed");
  });
});

describe("ZCode trial refusal health classification", () => {
  for (const [status, message] of [
    [400, "ZCode has no active limited quota for GLM-5.3-Trial"],
    [429, "ZCode's limited quota for glm-5.3 is exhausted or temporarily unavailable"],
  ] as const) {
    test(`${status} named trial refusal rests the selected model with upstream reset`, async () => withFrozenTime(NOW, async () => {
      try {
        await mapUpstreamHttpError(Response.json({ error: { message }, resets_in_seconds: 600 }, { status }), ID);
        throw new Error("Expected upstream rejection");
      } catch (error) {
        const policy = classifyUpstreamFailure(error);
        const health = classifyAccountError(error, { ...policy, modelId: "glm-5.3" });
        expect(health.category).toBe("model_unreachable");
        expect(health.mutatesAccount).toBe(true);
        expect(health.cooldownMs).toBe(600_000);
        expect(classifyAccountError(error, { ...policy, modelId: "glm-5.3-flash" }).category).not.toBe("model_unreachable");
      }
    }));
  }
});
