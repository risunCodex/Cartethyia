import { describe, expect, test } from "bun:test";
import {
  TRAE_REALMS,
  TRAE_REGION_CORE_HOSTS,
  TRAE_AGENT_FUNCTION,
  TRAE_AGENT_CHAT_PATH,
  TRAE_CHAT_PATH,
  traeCoreCandidates,
  traeRealmForProvider,
} from "../../src/providers/integrations/trae/trae-realm";
import { TRAE_CN_MODELS, TRAE_INTL_MODELS, traeMaxContextWindow } from "../../src/providers/integrations/trae/trae-catalog";
import { buildTraeHeaders, traeDeviceIdentity } from "../../src/providers/integrations/trae/trae-headers";
import {
  buildTraeChatBody,
  isTraeAgentEndpoint,
  parseTraeSse,
  toTraeAgentBody,
} from "../../src/providers/integrations/trae/trae-protocol";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { GatewayError } from "../../src/protocol/gateway-error";
import { createTraeAdapter } from "../../src/providers/integrations/trae/trae";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";

const AGENT_TARGET: ProviderDispatchTarget = {
  provider_id: "trae",
  model_id: "deepseek-v4-pro-0813",
  wire_family: "chat",
  endpoint_path: TRAE_AGENT_CHAT_PATH,
  capabilities: {},
};

function dispatchContext(frames: readonly Record<string, unknown>[]): ProviderDispatchContext {
  const body = frames
    .map((frame) => `event: ${frame["event"]}\ndata: ${JSON.stringify(frame["data"])}\n\n`)
    .join("");
  return {
    outbound_fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    credential: {
      credential_id: "c1",
      provider_id: "trae",
      account_id: "1",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("token"),
    },
    user_agent: "test",
  } as unknown as ProviderDispatchContext;
}

async function agentEvents(frames: readonly Record<string, unknown>[]) {
  const events = [];
  for await (const event of createTraeAdapter().dispatch(
    request(),
    AGENT_TARGET,
    dispatchContext(frames),
  )) events.push(event);
  return events;
}

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "gpt-5.5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "openai-chat",
    ...overrides,
  } as CanonicalRequest;
}

describe("trae realms", () => {
  test("provider id selects the deployment", () => {
    expect(traeRealmForProvider("traecn")).toBe("cn");
    expect(traeRealmForProvider("trae")).toBe("intl");
  });

  test("CN has exactly one core host and intl has fallbacks", () => {
    expect(traeCoreCandidates("cn")).toEqual([TRAE_REALMS.cn.core]);
    expect(traeCoreCandidates("intl").length).toBeGreaterThan(1);
  });

  test("the live model list is supported on both realms", () => {
    // The earlier claim that intl answers `403 no schema found` came from
    // asking the generic intl core. The listing is per account region: an SG
    // account is served by `coresg-normal.trae.ai`, which answers it.
    expect(TRAE_REALMS.cn.modelListSupported).toBe(true);
    expect(TRAE_REALMS.intl.modelListSupported).toBe(true);
  });

  test("a regional account is dispatched to its own core host", () => {
    // Verified live: an SG token on the US core answers 1001 "not able to
    // authenticate you", while the SG core streams normally.
    expect(TRAE_REGION_CORE_HOSTS["sg"]).toBe("https://coresg-normal.trae.ai");
    expect(TRAE_REGION_CORE_HOSTS["us"]).toBe("https://core-normal.traeapi.us");
  });

  test("intl defaults to SG, with US still reachable", () => {
    // The default is SG, not US. Region routing is a property of the account, so
    // this decides only accounts whose region was never captured — and SG
    // serves the wider international roster. US is demoted to a fallback rather
    // than removed: a genuinely US-provisioned account with no stored region
    // still needs somewhere to land.
    expect(TRAE_REALMS.intl.core).toBe("https://coresg-normal.trae.ai");
    expect(TRAE_REALMS.intl.core).toBe(TRAE_REGION_CORE_HOSTS["sg"] ?? "<missing>");
    expect(traeCoreCandidates("intl")).toContain("https://core-normal.traeapi.us");
  });

  test("an intl account with no stored region is not sent to US first", () => {
    // The behavior that actually changed: `traeCoreForAccount` falls through to
    // the realm default when the account carries no region, so the empty-region
    // case must resolve to SG.
    expect(traeCoreCandidates("intl")[0]).toBe("https://coresg-normal.trae.ai");
  });

  test("the realms do not share a core host", () => {
    // A shared host would mean one of them is dispatched to the wrong
    // deployment, which upstream refuses outright.
    expect(TRAE_REALMS.cn.core).not.toBe(TRAE_REALMS.intl.core);
  });
});

describe("trae rosters", () => {
  test("each realm keeps its own roster", () => {
    const cn = new Set(TRAE_CN_MODELS.map((m) => m.modelId));
    const intl = new Set(TRAE_INTL_MODELS.map((m) => m.modelId));
    expect(cn.size).toBeGreaterThan(0);
    expect(intl.size).toBeGreaterThan(0);
    // Distinct rosters, not disjoint ones. A few ids (minimax-m3, kimi-k3,
    // deepseek-v4.1-flash) are provisioned on both deployments, so overlap is
    // legitimate; what must hold is that neither realm is a copy of the other.
    const shared = [...intl].filter((id) => cn.has(id));
    expect(shared.length).toBeLessThan(Math.min(cn.size, intl.size));
    expect([...cn].some((id) => !intl.has(id))).toBe(true);
    expect([...intl].some((id) => !cn.has(id))).toBe(true);
  });

  test("CN advertises the selectable maximum, not the active window", () => {
    // 116k is the active window; upstream also offers 1M. Reading only the
    // active window is what made the fetcher always pick the low number.
    const deepseek = TRAE_CN_MODELS.find((m) => m.modelId === "DeepSeek-V4-Flash-Official");
    expect(deepseek?.contextLimit).toBe(1_000_000);
  });

  test("every intl row points at the agent path", () => {
    // The intl catalog is agent-only: the legacy chat ids (gpt-4o,
    // gemini_2.5_flash, deepseek-V3, …) are rejected on this surface with
    // `4001 param is invalid`, and the agent ids are rejected on the chat path
    // with `4023 model is unknown`. No row may fall back to the chat path.
    expect(TRAE_INTL_MODELS.length).toBeGreaterThan(0);
    for (const model of TRAE_INTL_MODELS) {
      expect(model.endpointPath).toBe(TRAE_AGENT_CHAT_PATH);
    }
  });

  test("the legacy chat ids are gone from intl", () => {
    // Superseded by the picker's roster, and unreachable here: none of them
    // resolve on the agent surface.
    const ids = new Set(TRAE_INTL_MODELS.map((m) => m.modelId));
    for (const gone of ["gpt-4o", "gemini_2.5_flash", "deepseek-R1", "deepseek-V3", "deepseek-V3-0324"]) {
      expect(ids.has(gone)).toBe(false);
    }
  });

  test("context windows are per model, not uniform", () => {
    // Reading a single maximum across the roster would report 1M for the GPT
    // rows, which — except `gpt-5.4` — cap at 272k, and would overstate
    // Kimi-K2.5 / MiniMax-M2.7, which offer no selectable upgrade above 200k.
    const find = (id: string): number | undefined =>
      TRAE_INTL_MODELS.find((m) => m.modelId === id)?.contextLimit ?? undefined;
    expect(find("gpt-5.4")).toBe(1_000_000);
    expect(find("gpt-5.2")).toBe(272_000);
    expect(find("deepseek-v4.1-flash")).toBe(1_000_000);
    expect(find("kimi-k2.5")).toBe(200_000);
  });
});

describe("traeMaxContextWindow", () => {
  test("prefers the largest selectable window", () => {
    expect(
      traeMaxContextWindow({
        context_window_size: { default: 116000, max: [1000000, 256000] },
      }),
    ).toBe(1_000_000);
  });

  test("falls back to the active window when no max is offered", () => {
    expect(traeMaxContextWindow({ context_window_size: { default: 256000, max: null } })).toBe(256000);
  });

  test("reads the older context_window_tokens spelling", () => {
    expect(traeMaxContextWindow({ context_window_tokens: { dev: 200000, max: 1000000 } })).toBe(1_000_000);
  });

  test("answers undefined rather than guessing", () => {
    expect(traeMaxContextWindow({})).toBeUndefined();
    expect(traeMaxContextWindow(null)).toBeUndefined();
  });
});

describe("trae device identity", () => {
  test("one account is stable and two accounts never share a device", () => {
    const a = traeDeviceIdentity("12345");
    const again = traeDeviceIdentity("12345");
    const b = traeDeviceIdentity("67890");
    expect(a.machineId).toBe(again.machineId);
    expect(a.machineId).not.toBe(b.machineId);
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  test("a numeric account id is reused verbatim as the device id", () => {
    expect(traeDeviceIdentity("1234567890123456789").deviceId).toBe("1234567890123456789");
  });

  test("a non-numeric id still yields a 19-digit numeric device id", () => {
    expect(traeDeviceIdentity("user@example.com").deviceId).toMatch(/^\d{19}$/);
  });
});

describe("buildTraeHeaders", () => {
  test("CN authenticates with Cloud-IDE-JWT and omits data-plane extra headers", () => {
    const headers = buildTraeHeaders({ realm: "cn", token: "t", uid: "1" });
    expect(headers["Authorization"]).toBe("Cloud-IDE-JWT t");
    // The canonical client does not send `x-ide-token` on the chat/agent data
    // plane (Trae 1.107.1 bundle, commit b6786417); it is an OAuth/business
    // header only. A probe with it diverged from the reference wire.
    expect(headers["x-ide-token"]).toBeUndefined();
    expect(headers["store-country-code"]).toBeUndefined();
  });

  test("intl uses the same Cloud-IDE-JWT scheme as CN", () => {
    // Trae 1.107.1 bundle: both realms send Cloud-IDE-JWT, not Bearer.
    const headers = buildTraeHeaders({ realm: "intl", token: "t", uid: "1" });
    expect(headers["Authorization"]).toBe("Cloud-IDE-JWT t");
    expect(headers["x-ide-version"]).toBeUndefined();
    expect(headers["x-app-version"]).toBeUndefined();
    expect(headers["User-Agent"]).toBe("TraeClient/TTNet");
  });

  test("a stream request takes the SSE Accept", () => {
    const headers = buildTraeHeaders({ realm: "cn", token: "t", uid: "1", stream: true });
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  test("extra headers replace case-insensitively and null deletes", () => {
    const headers = buildTraeHeaders({
      realm: "cn",
      token: "t",
      uid: "1",
      extra: { "X-App-Id": "other", "X-Request-Id": null },
    });
    expect(headers["X-App-Id"]).toBe("other");
    expect(headers["X-Request-Id"]).toBeUndefined();
  });
});

describe("buildTraeChatBody", () => {
  test("the model is sent as model_name", () => {
    // Upstream ignores `model` and silently serves its default instead.
    const body = buildTraeChatBody("gpt-5.5", request(), "intl");
    expect(body.model_name).toBe("gpt-5.5");
    expect("model" in body).toBe(false);
  });

  test("content is always a parts array", () => {
    const body = buildTraeChatBody("gpt-5.5", request(), "intl");
    for (const message of body.messages) {
      expect(Array.isArray(message.content)).toBe(true);
      expect(message.content[0]?.type).toBe("text");
    }
  });

  test("system and instructions become one leading system turn", () => {
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({
        system: [{ kind: "text", text: "A" }],
        instructions: [{ kind: "text", text: "B" }],
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      }),
      "intl",
    );
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content[0]).toEqual({ type: "text", text: "A\n\nB" });
  });

  test("a tool result becomes its own tool turn", () => {
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({
        messages: [
          {
            role: "tool",
            content: [
              { kind: "toolResult", call_id: "c1", content: [{ kind: "text", text: "42" }] },
            ],
          },
        ],
      }),
      "intl",
    );
    expect(body.messages[0]?.role).toBe("tool");
    expect(body.messages[0]?.tool_call_id).toBe("c1");
  });

  test("a tool call is emitted as tool_calls with stringified arguments", () => {
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({
        messages: [
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "c1", name: "f", arguments: { a: 1 } }],
          },
        ],
      }),
      "intl",
    );
    const call = body.messages[0]?.tool_calls?.[0];
    expect(call?.id).toBe("c1");
    // `function_call`, not OpenAI's `function`, and Name is required: an
    // assistant turn replayed with an empty name is rejected before inference
    // with `required field Name is not set`.
    expect(call?.function_call.name).toBe("f");
    expect(call?.function_call.arguments).toBe('{"a":1}');
  });

  test("tool declarations serialize parameters to a string", () => {
    // Upstream types `FunctionDefinition.tools.function.parameters` as a Go
    // string, so a schema object is rejected outright.
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({ tools: [{ name: "get_weather", jsonSchema: { type: "object", properties: { city: { type: "string" } } } }] }),
      "intl",
    );
    const tools = body["tools"] as Array<Record<string, unknown>> | undefined;
    const fn = tools?.[0]?.["function"] as Record<string, unknown> | undefined;
    expect(typeof fn?.["parameters"]).toBe("string");
    expect(JSON.parse(String(fn?.["parameters"])).properties.city.type).toBe("string");
  });

  test("no tools declared means no tools field", () => {
    // Sending an empty array still declares the field and upstream validates
    // it, so an absent declaration must stay absent.
    const body = buildTraeChatBody("gpt-5.5", request(), "intl");
    expect("tools" in body).toBe(false);
  });

  test("only declared generation fields are forwarded", () => {
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({ generation_controls: { temperature: 0.2, max_tokens: 16 } }),
      "intl",
    );
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(16);
    expect(body.top_p).toBeUndefined();
  });

  test("an empty model name is refused", () => {
    expect(() => buildTraeChatBody("", request(), "intl")).toThrow();
  });

  test("a resolved session id is carried as session_id", () => {
    const body = buildTraeChatBody("gpt-5.5", request(), "intl", "ses_abc123");
    expect(body.session_id).toBe("ses_abc123");
  });

  test("the caller's session id wins over the resolved one", () => {
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({ session_id: "caller-ses" }),
      "intl",
      "resolved-ses",
    );
    expect(body.session_id).toBe("caller-ses");
  });

  test("no session id means no session_id field", () => {
    const body = buildTraeChatBody("gpt-5.5", request(), "intl");
    expect("session_id" in body).toBe(false);
  });

  test("a huge max_tokens is clamped to the roster output limit", () => {
    const body = buildTraeChatBody(
      "gpt-5.2",
      request({ generation_controls: { max_tokens: 1_000_000_000 } }),
      "intl",
      undefined,
      128_000,
    );
    expect(body.max_tokens).toBe(128_000);
  });

  test("a caller max_tokens within the roster limit is forwarded unchanged", () => {
    const body = buildTraeChatBody(
      "gpt-5.2",
      request({ generation_controls: { max_tokens: 32_000 } }),
      "intl",
      undefined,
      128_000,
    );
    expect(body.max_tokens).toBe(32_000);
  });

  test("no max_tokens still means no max_tokens field", () => {
    const body = buildTraeChatBody("gpt-5.5", request(), "intl", undefined, 128_000);
    expect("max_tokens" in body).toBe(false);
  });
});

describe("toTraeAgentBody", () => {
  test("the model key moves to config_name and config_source is added", () => {
    // The agent surface ignores `model_name` entirely, and without
    // `config_source` it resolves the right upstream model and then streams
    // nothing — which looks like a dead model rather than a missing field.
    const body = toTraeAgentBody(buildTraeChatBody("deepseek-v4.1-flash", request(), "intl"));
    expect(body.config_name).toBe("deepseek-v4.1-flash");
    expect(body.config_source).toBe(1);
    expect("model_name" in body).toBe(false);
  });

  test("function names the roster", () => {
    // Absent, the call fails before model resolution with
    // `[LLMUtilsChat.resolveByUsage] function is empty`.
    const body = toTraeAgentBody(buildTraeChatBody("gpt-5.2", request(), "intl"));
    expect(body.function).toBe(TRAE_AGENT_FUNCTION);
  });

  test("messages and generation controls survive the rewrite", () => {
    const source = buildTraeChatBody(
      "kimi-k3",
      request({ generation_controls: { temperature: 0.3, max_tokens: 32 } }),
      "intl",
    );
    const body = toTraeAgentBody(source);
    expect(body.messages).toEqual(source.messages);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(32);
  });
});

describe("isTraeAgentEndpoint", () => {
  test("a missing route falls back to the agent surface", () => {
    // The intl catalog is agent-only, so a target with no route must not
    // silently land on the chat path, which rejects every model in it.
    expect(isTraeAgentEndpoint(undefined)).toBe(true);
    expect(isTraeAgentEndpoint(null)).toBe(true);
    expect(isTraeAgentEndpoint("")).toBe(true);
  });

  test("the chat path is not the agent path", () => {
    expect(isTraeAgentEndpoint(TRAE_CHAT_PATH)).toBe(false);
    expect(isTraeAgentEndpoint(TRAE_AGENT_CHAT_PATH)).toBe(true);
  });

  test("an absolute URL still resolves by suffix", () => {
    expect(isTraeAgentEndpoint(`https://coresg-normal.trae.ai${TRAE_AGENT_CHAT_PATH}`)).toBe(true);
    expect(isTraeAgentEndpoint(`https://coresg-normal.trae.ai${TRAE_CHAT_PATH}`)).toBe(false);
  });
});

describe("parseTraeSse", () => {
  function stream(raw: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(raw);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  test("data frames are parsed as JSON", async () => {
    const frames = [];
    for await (const f of parseTraeSse(stream('data: {"chunk":{"content":"hi"}}\n\n'))) frames.push(f);
    expect(frames.length).toBe(1);
    expect((frames[0]?.data as { chunk: { content: string } }).chunk.content).toBe("hi");
  });

  test("[DONE] becomes a done frame", async () => {
    const frames = [];
    for await (const f of parseTraeSse(stream("data: [DONE]\n\n"))) frames.push(f);
    expect(frames[0]?.event).toBe("done");
  });

  test("comment lines are heartbeats and are skipped", async () => {
    const frames = [];
    for await (const f of parseTraeSse(stream(': ping\ndata: {"a":1}\n\n'))) frames.push(f);
    expect(frames.length).toBe(1);
    expect(frames[0]?.event).toBe("message");
  });

  test("named events keep their name", async () => {
    const frames = [];
    for await (const f of parseTraeSse(stream('event: error\ndata: {"message":"bad"}\n\n'))) frames.push(f);
    expect(frames[0]?.event).toBe("error");
  });

  test("a frame split across chunks still parses", async () => {
    const bytes = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.encode('data: {"chunk"'));
        controller.enqueue(bytes.encode(':{"content":"x"}}\n\n'));
        controller.close();
      },
    });
    const frames = [];
    for await (const f of parseTraeSse(body)) frames.push(f);
    expect(frames.length).toBe(1);
    expect((frames[0]?.data as { chunk: { content: string } }).chunk.content).toBe("x");
  });
});

describe("trae stream framing", () => {
  const encoder = new TextEncoder();
  const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

  test("the flat frame layout the region host sends is parsed", async () => {
    // `event: output` with a top-level `response`, not the donor's nested
    // `chunk.content`. Reading only the nested shape made a working upstream
    // look like an empty stream.
    const frames = [
      'event: metadata\ndata: {"session_id":"s1"}\n\n',
      'event: output\ndata: {"response":"OK","reasoning_content":null}\n\n',
      'event: token_usage\ndata: {"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}\n\n',
    ];
    const parsed = [];
    for await (const frame of parseTraeSse(streamOf(frames))) parsed.push(frame);
    expect(parsed.map((f) => f.event)).toEqual(["metadata", "output", "token_usage"]);
    expect((parsed[1]?.data as { response: string }).response).toBe("OK");
    expect((parsed[2]?.data as { prompt_tokens: number }).prompt_tokens).toBe(4);
  });

  test("a frame split across chunks is reassembled", async () => {
    const frames = ['event: output\ndata: {"resp', 'onse":"OK"}\n\n'];
    const parsed = [];
    for await (const frame of parseTraeSse(streamOf(frames))) parsed.push(frame);
    expect(parsed).toHaveLength(1);
    expect((parsed[0]?.data as { response: string }).response).toBe("OK");
  });
});

describe("trae Agent tool streams", () => {
  test("an SSE 4015 is an entitlement verdict, not auth or platform", async () => {
    // Verified live (2026-11-06): identical wire, a paid-capable account
    // streams the same model fine while a Free account is refused with 4015
    // (and 1005 {"plan":N}); the refused token still answers GetUserInfo 200.
    // It must surface as `quota_exceeded` (429), never authentication_failed
    // and never platform_unavailable.
    let thrown: unknown;
    try {
      await agentEvents([{ event: "error", data: { code: 4015, message: "" } }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    const g = thrown as GatewayError;
    expect(g.code).toBe("quota_exceeded");
    expect(g.status).toBe(429);
  });

  test("an SSE 1005 is an entitlement verdict with a plan requirement", async () => {
    let thrown: unknown;
    try {
      await agentEvents([{ event: "error", data: { code: 1005, message: "", extra: '{"plan":5}' } }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    const g = thrown as GatewayError;
    expect(g.code).toBe("quota_exceeded");
    expect(g.status).toBe(429);
  });

  test("an upstream 1001 is classified as auth failure, not platform_unavailable", async () => {
    // Trae answers an unauthenticated account with `1001 "we are not able to
    // authenticate you"`. That is a credential verdict: it must surface as
    // account-scoped `authentication_failed` (parking the account for
    // re-login, failover to a sibling) — never as a 502 platform error that
    // could drag the proxy pool into the story.
    let thrown: unknown;
    try {
      await agentEvents([
        { event: "error", data: { code: 1001, message: "We're sorry, but we are not able to authenticate you." } },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    const g = thrown as GatewayError;
    expect(g.code).toBe("authentication_failed");
    expect(g.status).toBe(401);
    expect(g.details.credentialEvidence).toBe(true);
    expect(g.details.providerCode).toBe("1001");
  });

  test("an upstream 4008 is classified as quota_exceeded", async () => {
    // Free-tier quota exhausted: `4008 "Your requests have exceeded the quota."`
    // must surface as a 429 `quota_exceeded` — not a 502 platform error.
    let thrown: unknown;
    try {
      await agentEvents([
        { event: "error", data: { code: 4008, message: "Your requests have exceeded the quota." } },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    const g = thrown as GatewayError;
    expect(g.code).toBe("quota_exceeded");
    expect(g.status).toBe(429);
  });

  test("an upstream 4013 region refusal keeps its provider code for the classifier", async () => {
    // `4013 "AI service is not available in the current region now."` is a
    // durable region verdict — the classifier must turn it into a hard account
    // cooldown, so the adapter must surface it with the provider code intact
    // rather than as a bare platform fault.
    let thrown: unknown;
    try {
      await agentEvents([
        { event: "error", data: { code: 4013, message: "AI service is not available in the current region now." } },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    const g = thrown as GatewayError;
    expect(g.code).toBe("platform_unavailable");
    expect(g.details.providerCode).toBe("4013");
    expect(g.details.providerId).toBe("trae");
  });

  test("an error object in a frame body is classified too", async () => {
    // HTTP 200 frames can carry `{"code":1001,"message":"…"}` directly in the
    // body instead of a named `error` event — same verdict required.
    let thrown: unknown;
    try {
      await agentEvents([
        { event: "message", data: { code: 1001, message: "We're sorry, but we are not able to authenticate you." } },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    const g = thrown as GatewayError;
    expect(g.code).toBe("authentication_failed");
    expect(g.status).toBe(401);
  });

  test("an opening tool frame keeps arguments delivered beside the id", async () => {
    const events = await agentEvents([
      { event: "output", data: { tool_calls: [{ id: "call-1", index: 0, function_call: { name: "read", arguments: '{"path":"a.ts"}' } }] } },
    ]);
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas.map((event) => event.type === "tool_call_delta" ? event.arguments_delta : ""))
      .toEqual(["", '{"path":"a.ts"}']);
  });

  test("nested chunk tool calls use the same translation as flat frames", async () => {
    const events = await agentEvents([
      { event: "output", data: { chunk: { tool_calls: [{ id: "call-1", index: 0, function_call: { name: "read", arguments: "{}" } }] } } },
    ]);
    expect(events.some((event) => event.type === "tool_call_delta")).toBe(true);
  });

  test("the terminal event carries the assessed usage", async () => {
    // Non-streaming dispatch reads usage off the terminal event; without it the
    // request is reconciled to the estimate. The same session must hit the
    // cache estimator, so a repeated prefix reports cached tokens.
    const adapter = createTraeAdapter();
    const frames = (usage: Record<string, unknown>) => [
      { event: "output", data: { response: "hai" } },
      { event: "token_usage", data: usage },
    ];
    const session = "ses-terminal-usage";
    const requestWithSession = (content: string) =>
      request({ session_id: session, messages: [{ role: "user", content: [{ kind: "text", text: content }] }] });

    // First call: no history yet → cached unavailable, terminal usage present.
    const first = [];
    for await (const event of adapter.dispatch(
      requestWithSession("halo"),
      AGENT_TARGET,
      dispatchContext(frames({ prompt_tokens: 45, completion_tokens: 10, total_tokens: 55 })),
    )) first.push(event);
    const t1 = first.find((e) => e.type === "terminal") as { usage?: { input_tokens: number } };
    expect(t1?.usage?.input_tokens).toBe(45);
    expect((t1?.usage as { cached_input_tokens?: number | string })?.cached_input_tokens).toBe("unavailable");

    // Second call, identical prefix → cached estimate applies on the terminal.
    const second = [];
    for await (const event of adapter.dispatch(
      requestWithSession("halo"),
      AGENT_TARGET,
      dispatchContext(frames({ prompt_tokens: 45, completion_tokens: 12, total_tokens: 57 })),
    )) second.push(event);
    const t2 = second.find((e) => e.type === "terminal") as {
      usage?: { input_tokens: number; cached_input_tokens: number; uncached_input_tokens: number };
    };
    expect(t2?.usage?.cached_input_tokens).toBe(45);
    expect(t2?.usage?.uncached_input_tokens).toBe(0);
  });

  test("tool ids from one request never resolve fragments in the next request", async () => {
    const adapter = createTraeAdapter();
    const collect = async (frames: readonly Record<string, unknown>[]) => {
      const events = [];
      for await (const event of adapter.dispatch(request(), AGENT_TARGET, dispatchContext(frames))) {
        events.push(event);
      }
      return events;
    };
    await collect([
      { event: "output", data: { tool_calls: [{ id: "old-call", index: 0, function_call: { name: "read" } }] } },
    ]);
    const events = await collect([
      { event: "output", data: { tool_calls: [{ index: 0, function_call: { arguments: "stale" } }] } },
    ]);
    expect(events.some((event) => event.type === "tool_call_delta")).toBe(false);
  });
});
