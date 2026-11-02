import { describe, expect, test } from "bun:test";
import {
  applyBuddySystemPrompt,
  buddyPrePayloadCommon,
  buildBuddyPromptCacheKey,
  dropEmptyBuddyMessages,
  scrubBuddyChannelIdentityText,
} from "../../src/providers/integrations/buddy/buddy-chat-shared";
import { CODEBUDDY_SYSTEM_PROMPT } from "../../src/providers/integrations/buddy/codebuddy/provider";
import {
  workbuddyPrePayload,
  WORKBUDDY_SYSTEM_PROMPT,
} from "../../src/providers/integrations/buddy/workbuddy/provider";
import { codeBuddyCnPrePayload } from "../../src/providers/integrations/buddy/codebuddy/cn-provider";
import { readBuddyDeviceToken, workbuddyHeaders } from "../../src/providers/integrations/buddy/workbuddy/shared";
import { resolveBuddyDeviceBinding } from "../../src/providers/integrations/buddy/buddy-identity";
import { fetchTencentBillingQuota } from "../../src/providers/integrations/buddy/buddy-quota-shared";
import { fetchWorkBuddyCnQuota } from "../../src/providers/integrations/buddy/workbuddy/quota";
import { parseDsmlToolCalls } from "../../src/protocol/dsml";
import { parseChatResponseToEvents } from "../../src/protocol/response/chat";
import { decodeChatSseStream } from "../../src/protocol/response/chat";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const candidate = {
  provider_id: "cbcn",
  model_id: "glm-5.2",
  wire_family: "openai-chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
} as unknown as ProviderDispatchTarget;
const request = { model: "glm-5.2", messages: [] } as unknown as CanonicalRequest;
const context = {
  credential: { account_id: "abcdef123456", auth_state: { deviceToken: "desktop-token" } },
} as unknown as ProviderDispatchContext;

describe("Buddy upstream protocol alignment", () => {
  test("injects an account-isolated cache key when the client sent none", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "run_shell" } }],
      tool_choice: "none",
    };
    buddyPrePayloadCommon(payload, request);
    expect(payload["tool_choice"]).toBe("none");
    expect(payload["tools"]).toHaveLength(1);
    // No credential and no conversation: the anonymous segment, still injected
    // so two such requests do not silently share a client-less key shape.
    expect(payload["prompt_cache_key"]).toBe(buildBuddyPromptCacheKey("", ""));
  });

  test("clamps an unsupported international effort to the nearest served level", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [],
      reasoning_effort: "max",
      prompt_cache_key: "client-key",
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["reasoning_effort"]).toBe("high");
    expect(payload["prompt_cache_key"]).toBe("client-key");
  });

  test("raising the effort also lifts a max_tokens sized for the lower one", () => {
    const payload: Record<string, unknown> = {
      model: "hy4-preview-f",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
      max_tokens: 2048,
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["reasoning_effort"]).toBe("high");
    expect(payload["max_tokens"]).toBe(32_000);
  });

  test("a supported effort leaves the caller's max_tokens alone", () => {
    // Nothing was raised, so nothing is owed a bigger budget: a caller who
    // deliberately asked for a small answer still gets one.
    const payload: Record<string, unknown> = {
      model: "hy4-preview-f",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      max_tokens: 2048,
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["reasoning_effort"]).toBe("high");
    expect(payload["max_tokens"]).toBe(2048);
  });

  test("clamps a max_tokens above the catalog output limit down to it", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 200_000,
    };
    buddyPrePayloadCommon(payload, request, "intl");
    // 48,000 is what /v3/config publishes for glm-5.2. The catalog carried
    // 131,072, which no endpoint reports; the clamp is only as correct as the
    // limit it clamps to, so this pins the live number.
    expect(payload["max_tokens"]).toBe(48_000);
  });

  test("an effort the ladder serves as asked leaves max_tokens alone", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
      max_tokens: 2048,
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["reasoning_effort"]).toBe("low");
    expect(payload["max_tokens"]).toBe(2048);
  });

  test("a model with no ladder is not refused for its effort", () => {
    const payload: Record<string, unknown> = {
      model: "claude-opus-4.6",
      messages: [],
      reasoning_effort: "max",
    };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["reasoning_effort"]).toBe("max");
  });

  test("uses the CN effort ladder for the same model", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [],
      reasoning_effort: "max",
    };
    buddyPrePayloadCommon(payload, request, "cn");
    expect(payload["reasoning_effort"]).toBe("max");
  });

  test("CodeBuddy CN keeps an effort the international ladder would clamp away", () => {
    // The CN realm was never threaded: every call site passed two arguments, so
    // `realm` defaulted to "intl" and BUDDY_CN_EFFORTS was dead code. The same
    // model id served at `max` by the CN backend was silently downgraded to
    // `high`, which is what the international backend accepts.
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [],
      reasoning_effort: "max",
    };
    codeBuddyCnPrePayload(payload, request, candidate);
    expect(payload["reasoning_effort"]).toBe("max");
  });

  test("CodeBuddy CN keeps a mid-ladder effort that is unsupported everywhere else", () => {
    // `medium` is the only level CN's glm-5.1 serves. No other ladder lists it,
    // so before the realm was threaded this request was rewritten to `high`.
    const payload: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [],
      reasoning_effort: "medium",
    };
    codeBuddyCnPrePayload(payload, request, candidate);
    expect(payload["reasoning_effort"]).toBe("medium");
  });

  test("a CN effort the ladder does not serve is clamped, and the budget is lifted", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "max",
      max_tokens: 2048,
    };
    codeBuddyCnPrePayload(payload, request, candidate);
    expect(payload["reasoning_effort"]).toBe("xhigh");
    // The floor is half the model's catalog output limit. deepseek-v4-pro's CN
    // output was recorded as 384,000 (making the floor 192,000); /v3/config
    // publishes 128,000, so the correct floor is 64,000. A clamp is only as
    // right as the limit it reads, which is what this pins.
    expect(payload["max_tokens"]).toBe(64_000);
  });

  test("intl `auto` resolves to the intl backend-selected id (`default-model`)", () => {
    // Live CLI session logs send `model=default-model` for the intl auto path,
    // and `default-model` is a served catalog row. The rewrite is what makes
    // eligibility, cooldowns and the catalog all key on one id.
    const viaAuto: Record<string, unknown> = { model: "auto", messages: [] };
    buddyPrePayloadCommon(viaAuto, request, "intl");
    expect(viaAuto["model"]).toBe("default-model");
  });

  test("injects `cache_retention` (long) and honors the disable-caching env", () => {
    const payload: Record<string, unknown> = { model: "hy3", messages: [] };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["cache_retention"]).toBe("long");
    // A caller-supplied value is never overwritten.
    const explicit: Record<string, unknown> = { model: "hy3", messages: [], cache_retention: "short" };
    buddyPrePayloadCommon(explicit, request, "intl");
    expect(explicit["cache_retention"]).toBe("short");
  });

  test("CN `auto` resolves to the CN backend-selected id, not the intl one", () => {
    const payload: Record<string, unknown> = { model: "auto", messages: [] };
    codeBuddyCnPrePayload(payload, request, candidate);
    expect(payload["model"]).toBe("default");
  });

  test("a qualified model name that merely contains `auto` is left alone", () => {
    // `auto` is a real model name on other providers, and a prefix or suffix
    // makes a different request — only the bare id is the alias.
    const payload: Record<string, unknown> = { model: "auto-turbo", messages: [] };
    buddyPrePayloadCommon(payload, request, "intl");
    expect(payload["model"]).toBe("auto-turbo");
  });

  test("two accounts with the same conversation get different cache keys", () => {
    const token = (uid: string) =>
      `h.${Buffer.from(JSON.stringify({ sub: uid })).toString("base64url")}.s`;
    const forAccount = (uid: string): string => {
      const payload: Record<string, unknown> = {
        model: "glm-5.2",
        messages: [],
        conversation_id: "conv-shared",
      };
      const account = {
        credential: { secret: new TextEncoder().encode(token(uid)) },
        request_headers: { "x-conversation-id": "conv-shared" },
      } as unknown as ProviderDispatchContext;
      buddyPrePayloadCommon(payload, request, "intl", account);
      return payload["prompt_cache_key"] as string;
    };
    const first = forAccount("account-one-uid");
    const second = forAccount("account-two-uid");
    expect(first).not.toBe(second);
    expect(first.startsWith("wb2a-account-")).toBe(true);
    expect(second.startsWith("wb2a-account-")).toBe(true);
    // Same account and conversation is stable across calls.
    expect(forAccount("account-one-uid")).toBe(first);
  });

  test("a client-supplied cache key is never overwritten", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [],
      prompt_cache_key: "caller-knows-best",
      conversation_id: "conv-1",
    };
    const account = {
      credential: { secret: new TextEncoder().encode("h.e30.s") },
    } as unknown as ProviderDispatchContext;
    buddyPrePayloadCommon(payload, request, "intl", account);
    expect(payload["prompt_cache_key"]).toBe("caller-knows-best");
  });

  test("the body conversation id wins over the inbound header", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [],
      conversation_id: "from-body",
    };
    const account = {
      request_headers: { "x-conversation-id": "from-header" },
    } as unknown as ProviderDispatchContext;
    buddyPrePayloadCommon(payload, request, "intl", account);
    const fromHeaderOnly: Record<string, unknown> = { model: "glm-5.2", messages: [] };
    buddyPrePayloadCommon(fromHeaderOnly, request, "intl", account);
    expect(payload["prompt_cache_key"]).not.toBe(fromHeaderOnly["prompt_cache_key"]);
    expect(payload["prompt_cache_key"]).toBe(buildBuddyPromptCacheKey("", "from-body"));
  });

  test("rewrites a quoted 11128 so the upstream does not block the request for mentioning it", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [
        { role: "user", content: "the last call failed with code 11128" },
        {
          role: "assistant",
          content: [{ type: "text", text: "saw 11128" }],
          reasoning_content: "code 11128 again",
          tool_calls: [{ id: "c1", function: { name: "note", arguments: "{\"code\":11128}" } }],
        },
      ],
    };
    buddyPrePayloadCommon(payload, request);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    const user = messages.find((m) => m["role"] === "user");
    const text = JSON.stringify(user?.["content"]);
    expect(text).toContain("11-128");
    expect(text).not.toContain("11128");
    const assistant = messages.find((m) => m["role"] === "assistant");
    expect(JSON.stringify(assistant)).not.toContain("11128");
    expect(JSON.stringify(assistant)).toContain("11-128");
  });

  test("leaves neighbouring codes untouched", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "11148 and 11101 are different codes" }],
    };
    buddyPrePayloadCommon(payload, request);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(JSON.stringify(messages)).toContain("11148");
    expect(JSON.stringify(messages)).toContain("11101");
  });

  test("keeps the first 16 images and replaces the rest with a note", () => {
    const images = Array.from({ length: 18 }, (_, i) => ({
      type: "image_url",
      image_url: { url: `https://example.test/${i}.png` },
    }));
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: images }],
    };
    buddyPrePayloadCommon(payload, request);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    const content = JSON.stringify(messages);
    const kept = content.match(/example\.test/g)?.length ?? 0;
    expect(kept).toBe(16);
    expect(content).toContain("[Image omitted by request image limit.]");
  });

  test("sends the desktop device token only when the account has one", async () => {
    // If the bundled Turing SDK is loadable it wins (real token), otherwise the
    // captured auth_state token is the fallback. Both are valid outcomes; what
    // must never happen is neither a token nor an error header.
    const headers = await workbuddyHeaders(context, request);
    const token = headers["x-device-token"];
    const err = headers["x-device-token-error"];
    expect(token !== undefined || err !== undefined).toBe(true);
    if (token === undefined) expect(err).toBe("sdk_not_initialized");
    expect(readBuddyDeviceToken({ credential: { auth_state: {} } } as unknown as ProviderDispatchContext)).toBeUndefined();
  });

  test("resolves a stable, per-account device binding (qimei36)", () => {
    // Deterministic from the account id: stable across restarts, and distinct
    // between accounts — so each account in a pool presents its own device.
    const accountA = { credential: { account_id: "acc-A", auth_state: {} } } as unknown as ProviderDispatchContext;
    const accountB = { credential: { account_id: "acc-B", auth_state: {} } } as unknown as ProviderDispatchContext;
    const a1 = resolveBuddyDeviceBinding(accountA);
    const a2 = resolveBuddyDeviceBinding(accountA);
    const b = resolveBuddyDeviceBinding(accountB);
    expect(a1).toBeDefined();
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^[0-9a-f]{32}$/);
  });

  test("an explicit auth_state qimei36 wins over derivation", () => {
    const account = {
      credential: { account_id: "acc-A", auth_state: { qimei36: "manual-binding-123" } },
    } as unknown as ProviderDispatchContext;
    expect(resolveBuddyDeviceBinding(account)).toBe("manual-binding-123");
  });

  test("the desktop request carries X-Device-Id-List with the account binding", async () => {
    const headers = await workbuddyHeaders(context, request);
    const list = headers["x-device-id-list"];
    expect(list).toBeDefined();
    const parsed = JSON.parse(list as string) as { qimei36?: string };
    expect(parsed.qimei36).toBeDefined();
    expect(parsed.qimei36).toMatch(/^[0-9a-f]{32}$/);
  });

  test("an account with no captured token and no SDK mirrors the failure placeholder", async () => {
    // When the SDK cannot produce a token (unavailable, or a device that cannot
    // complete the exchange) the desktop contract is token || error — never
    // neither. Here the captured token is absent; if the bundled SDK is active
    // it will produce a real token instead, which is fine.
    const headers = await workbuddyHeaders(
      { credential: { auth_state: {} } } as unknown as ProviderDispatchContext,
      request,
    );
    expect(headers["x-device-token"] !== undefined || headers["x-device-token-error"] !== undefined).toBe(true);
  });

  test("WorkBuddy CN changes only the host identity in the shared headers", async () => {
    const cnHeaders = await workbuddyHeaders(context, request, "www.workbuddy.cn", "5.7.7.40774747");
    const intlHeaders = await workbuddyHeaders(context, request);
    expect(cnHeaders["origin"]).toBe("https://www.workbuddy.cn");
    expect(cnHeaders["referer"]).toBe("https://www.workbuddy.cn/");
    expect(cnHeaders["x-domain"]).toBe("www.workbuddy.cn");
    // The WorkBuddy profile: brand, then the wire token `workbuddy-ai` (NOT
    // the display brand "WorkBuddy AI" — the gateway 403s on the branded
    // spelling), then the CLI suffix. Versions come from the monitor rather
    // than a pinned build.
    expect(cnHeaders["user-agent"]).toMatch(/^WorkBuddy\/\S+ workbuddy-ai\/\S+ CLI\/\S+$/);
    // CN and international differ only in host identity, so the profile is the same.
    expect(intlHeaders["user-agent"]).toMatch(/^WorkBuddy\/\S+ workbuddy-ai\/\S+ CLI\/\S+$/);
    expect(cnHeaders["x-product"]).toBe(intlHeaders["x-product"]);
  });

  test("recovers a complete DSML block as a tool call", () => {
    const pipe = "\uFF5C\uFF5C";
    const text = `<${pipe}DSML${pipe} calls><${pipe}DSML${pipe} invoke name="run_shell"><${pipe}DSML${pipe} parameter name="command" string="true">ls</${pipe}DSML${pipe} parameter></${pipe}DSML${pipe} invoke></${pipe}DSML${pipe} calls>`;
    const recovered = parseDsmlToolCalls(text);
    expect(recovered?.calls[0]?.name).toBe("run_shell");
    expect(JSON.parse(recovered?.calls[0]?.arguments ?? "{}")).toEqual({ command: "ls" });
    const events = parseChatResponseToEvents({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    }, request);
    expect(events.some((event) => event.type === "tool_call_delta" && event.name === "run_shell")).toBe(true);
  });

  test("recovers declared calls from donor DSML variants without exposing markup", async () => {
    const singlePipe = "|";
    const block = `<${singlePipe}DSML${singlePipe} function_calls><${singlePipe}DSML${singlePipe} invoke name="run_shell"><${singlePipe}DSML${singlePipe} parameter name="command" string="true">ls -la</${singlePipe}DSML${singlePipe} parameter></${singlePipe}DSML${singlePipe} invoke></${singlePipe}DSML${singlePipe} function_calls>`;
    const callRequest = {
      ...request,
      tools: [{ name: "run_shell", description: "", schema: { type: "object", properties: {} } }],
    } as unknown as CanonicalRequest;
    const events = parseChatResponseToEvents({
      choices: [{ message: { role: "assistant", content: block }, finish_reason: "stop" }],
    }, callRequest);
    expect(events.some((event) => event.type === "tool_call_delta" && event.name === "run_shell")).toBe(true);
    expect(events.some((event) => event.type === "content_delta" && event.content.kind === "text" && event.content.text.includes("DSML"))).toBe(false);

    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunks = [block.slice(0, 18), block.slice(18, 59), block.slice(59)];
        for (const content of chunks) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`));
        }
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const streamEvents = [];
    for await (const event of decodeChatSseStream(streamBody, callRequest)) streamEvents.push(event);
    expect(streamEvents.some((event) => event.type === "tool_call_delta" && event.name === "run_shell")).toBe(true);
    expect(streamEvents.some((event) => event.type === "content_delta" && event.content.kind === "text" && event.content.text.includes("DSML"))).toBe(false);
  });

  test("does not execute undeclared DSML tool names", () => {
    const pipe = "｜｜";
    const text = `<${pipe}DSML${pipe} calls><${pipe}DSML${pipe} invoke name="unlisted_tool"><${pipe}DSML${pipe} parameter name="x">1</${pipe}DSML${pipe} parameter></${pipe}DSML${pipe} invoke></${pipe}DSML${pipe} calls>`;
    const callRequest = {
      ...request,
      tools: [{ name: "run_shell", description: "", schema: { type: "object", properties: {} } }],
    } as unknown as CanonicalRequest;
    const events = parseChatResponseToEvents({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    }, callRequest);
    expect(events.some((event) => event.type === "tool_call_delta")).toBe(false);
    expect(events.some((event) => event.type === "content_delta" && event.content.kind === "text" && event.content.text === text)).toBe(true);
  });

  test("drops a replayed tool call whose function name is empty, and its orphan result", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "search this" },
        {
          role: "assistant",
          content: "on it",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "", arguments: '{"query":"x"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "<tool_use_error>No such tool available: </tool_use_error>" },
      ],
    };
    buddyPrePayloadCommon(payload, request);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.some((m) => m["role"] === "tool" && m["tool_call_id"] === "call_1")).toBe(false);
    const assistant = messages.find((m) => m["role"] === "assistant") as Record<string, unknown> | undefined;
    expect(assistant?.["tool_calls"]).toBeUndefined();
  });

  test("keeps a named call on the same turn when a sibling name is empty", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "working",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "run_shell", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
        { role: "tool", tool_call_id: "call_2", content: "err" },
      ],
    };
    buddyPrePayloadCommon(payload, request);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m["role"] === "assistant") as Record<string, unknown>;
    const kept = (assistant["tool_calls"] ?? []) as Array<Record<string, unknown>>;
    expect(kept).toHaveLength(1);
    expect((kept[0]?.["function"] as Record<string, unknown> | undefined)?.["name"]).toBe("run_shell");
    expect(messages.some((m) => m["tool_call_id"] === "call_2")).toBe(false);
  });

  test("does not remove an assistant turn that keeps content after dropping a nameless call", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "  ", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "err" },
      ],
    };
    buddyPrePayloadCommon(payload, request);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    // The turn said something before calling, so it survives without its call.
    expect(messages.some((m) => m["role"] === "assistant" && m["content"] === "checking")).toBe(true);
  });

  test("reads enterprise usage when the personal package list is empty", async () => {
    const fetcher = (async (url: string) => new Response(JSON.stringify(
      String(url).endsWith("/get-user-resource")
        ? { code: 0, data: { Response: { Data: { Accounts: [] } } } }
        : { code: 0, data: { credit: 200, limitNum: 1000, cycleEndTime: "2026-10-26 23:59:59" } },
    ), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchTencentBillingQuota({
      source: "workbuddy",
      display: "WorkBuddy",
      url: "https://www.workbuddy.ai/v2/billing/meter/get-user-resource",
      headers: { "X-Enterprise-Id": "ent-1" },
      credential: "token",
      fetcher,
      defaultPlan: "WorkBuddy",
    });

    expect(result.plan).toBe("Enterprise");
    expect(result.windows[0]?.remaining).toBe(800);
    expect(result.windows[0]?.limit).toBe(1000);
  });

  test("WorkBuddy CN quota uses its own host and client version", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [{
                PackageName: "WorkBuddy CN",
                CapacityUsed: 10,
                CapacitySize: 100,
                CycleEndTime: "2026-11-01T00:00:00.000Z",
              }],
            },
          },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchWorkBuddyCnQuota("token", fetcher);

    expect(result.source).toBe("workbuddycn");
    // The reference bills the CN realm on `www.codebuddy.cn`; `X-Domain` stays
    // the domain recorded at login, so changing the host must not move it.
    expect(capturedUrl).toBe("https://www.codebuddy.cn/v2/billing/meter/get-user-resource");
    expect(capturedHeaders?.get("x-domain")).toBe("www.workbuddy.cn");
    // WorkBuddy profile shape; the version comes from the monitor, not a pin.
    // The second token is the wire spelling `workbuddy-ai`.
    expect(capturedHeaders?.get("user-agent")).toMatch(/^WorkBuddy\/\S+ workbuddy-ai\/\S+ CLI\/\S+$/);
  });

  test("classifies refill and bonus packages into the same spendable credit pool", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                PackageName: "Monthly",
                CycleCapacityUsedPrecise: "0",
                CycleCapacitySizePrecise: "100",
                CycleEndTime: "2030-11-01 00:00:00",
                DeductionEndTime: "2030-12-01 00:00:00",
              },
              {
                PackageName: "Bonus",
                CapacityUsedPrecise: "30",
                CapacitySizePrecise: "30",
                CycleEndTime: "2030-11-15 00:00:00",
              },
            ],
          },
        },
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchTencentBillingQuota({
      source: "cb",
      display: "CodeBuddy",
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
      headers: {},
      credential: "token",
      fetcher,
      defaultPlan: "CodeBuddy",
    });

    expect(result.windows.map((entry) => entry.accounting)).toEqual(["pooled", "pooled"]);
  });
});

describe("Buddy empty-reasoning drop (upstream 11151 'history not found')", () => {
  // Reproduction: a client switches from one thinking model to another
  // (Claude Opus 4.7 1M → Kimi K3.1 Pro observed), and the second request
  // carries a canonical `reasoning` input item with no `.summary` and a
  // `null` `.payload` — a signature-less thinking block that was already
  // stripped on an earlier hop. The chat encoder produced
  // `{role:"assistant", content:"", reasoning_content:""}`; the previous
  // `dropEmptyBuddyMessages` guard treated `reasoning_content` of ANY
  // string length as load-bearing and kept the stub. WorkBuddy / Kimi then
  // rejected the whole request with code 11151 ("history not found").

  test("drops an assistant turn whose reasoning_content is the empty string", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: "hi" },
      // The exact shape the chat encoder emits for a reasoning-only canonical
      // turn with no summary and a non-string payload. Empty `content`, empty
      // `reasoning_content`, no tool_calls, no tool_call_id.
      { role: "assistant", content: "", reasoning_content: "" },
      { role: "user", content: "next turn" },
    ];
    dropEmptyBuddyMessages(messages);
    expect(messages.map((m) => m["role"])).toEqual(["user", "user"]);
  });

  test("also drops a bare assistant stub carrying only an unverifiable placeholder trace", () => {
    // The OMP client's observed sentinel: when the client switches thinking
    // models mid-conversation, every historical reasoning item in the
    // Responses `input` is replaced with
    // `{summary: [], content: [{type: "reasoning_text",
    // text: "reasoning unavailable"}]}`. The chat encoder dutifully forwards
    // that text as `reasoning_content: "reasoning unavailable"`, but no model
    // in the receiving install issued that signature — so forwarding it to
    // WorkBuddy/Kimi gets rejected with the same 11151 as the empty case.
    // A `content: ""` assistant turn with no `tool_calls` and no
    // `tool_call_id` is unverifiable regardless of `reasoning_content` value
    // and must be dropped.
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", reasoning_content: "reasoning unavailable" },
      { role: "user", content: "next turn" },
    ];
    dropEmptyBuddyMessages(messages);
    expect(messages.map((m) => m["role"])).toEqual(["user", "user"]);
  });

  test("keeps an assistant tool_calls turn even with empty reasoning_content", () => {
    // Tool-call turns are kept by the `tool_calls.length > 0` guard, not by
    // reasoning_content. An `omitted`-display thinking block that still
    // carried a signature-less reasoning side channel on a tool_calls turn
    // must still ride through: the chat encoder deliberately emits the
    // empty string there because the upstream demands the FIELD back on a
    // thinking turn, even when its text is empty.
    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }],
        reasoning_content: "",
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    dropEmptyBuddyMessages(messages);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.["role"]).toBe("assistant");
  });

  test("full WorkBuddy envelope still drops the stub after applyBuddySystemPrompt runs", () => {
    // The real pipeline the production bug followed: the WorkBuddy
    // pre-payload hook calls `applyBuddySystemPrompt`, which installs the
    // fixed system prompt, rebuilds user content shapes, then runs
    // `finalizeBuddyMessages` → `dropEmptyBuddyMessages`. The stub must be
    // gone before the request leaves the gateway.
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: "halo" },
      // Assistant tool-call turn (real) — must survive.
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { name: "read", arguments: "{\"path\":\"x\"}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "file contents" },
      // The problem child: reasoning-only turn with no payload text.
      { role: "assistant", content: "", reasoning_content: "" },
      { role: "user", content: "berikutnya" },
    ];
    applyBuddySystemPrompt(messages, "You are a pragmatic and direct software engineering assistant.");
    // The system prompt is prepended, the tool-call turn is kept, and the
    // empty assistant stub is dropped. No message with content === "" and
    // reasoning_content === "" survives.
    const roles = messages.map((m) => m["role"]);
    expect(roles[0]).toBe("system");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
    for (const m of messages) {
      const content = m["content"];
      const reasoning = m["reasoning_content"];
      const hasToolCalls = Array.isArray(m["tool_calls"]) && (m["tool_calls"] as unknown[]).length > 0;
      const hasToolCallId = typeof m["tool_call_id"] === "string" && (m["tool_call_id"] as string).length > 0;
      const emptyContent =
        content === null ||
        content === undefined ||
        (typeof content === "string" && content.length === 0) ||
        (Array.isArray(content) && content.length === 0);
      const emptyReasoning = reasoning === undefined || (typeof reasoning === "string" && reasoning.length === 0);
      if (emptyContent && emptyReasoning) {
        expect(hasToolCalls || hasToolCallId).toBe(true);
      }
    }
  });
});

describe("Buddy client-identity hardening", () => {
  const wbCandidate = {
    provider_id: "workbuddy",
    model_id: "m",
    wire_family: "openai-chat",
    endpoint_path: "/v2/chat/completions",
    capabilities: {},
  } as unknown as ProviderDispatchTarget;
  const wbRequest = { model: "m", messages: [] } as unknown as CanonicalRequest;
  const wbContext = {
    credential: { account_id: "acct123456", auth_state: {} },
  } as unknown as ProviderDispatchContext;

  test("the intl variants install a neutral helpful-assistant prompt", () => {
    // The leading system turn is a wire contract, but its text is deliberately
    // neutral: a simple helpful-assistant persona with no client/CLI branding.
    expect(CODEBUDDY_SYSTEM_PROMPT).toBe("You are a helpful assistant.");
    expect(WORKBUDDY_SYSTEM_PROMPT).toBe("You are a helpful assistant.");
    expect(CODEBUDDY_SYSTEM_PROMPT).not.toMatch(/CodeBuddy|CLI|tool/i);
    expect(WORKBUDDY_SYSTEM_PROMPT).not.toMatch(/WorkBuddy|assistant\.\n/i);
  });

  test("a replayed DeepSeek Harness history is rewritten to the WorkBuddy identity", () => {
    const payload: Record<string, unknown> = {
      model: "m",
      messages: [
        { role: "system", content: "You are DeepSeek Harness" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "You are DeepSeek Harness. Understood." },
        { role: "assistant", reasoning_content: "You are a coding agent powered by the deepseek-v4 model" },
      ],
    };
    workbuddyPrePayload(payload, wbRequest, wbCandidate, wbContext);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    // The caller's DSH system turn is dropped and the official prompt installed.
    expect(messages[0]?.["role"]).toBe("system");
    expect(messages[0]?.["content"]).toBe(WORKBUDDY_SYSTEM_PROMPT);
    // Assistant identity and the coding-persona reasoning are scrubbed; the
    // named model survives in the rewrite.
    const assistantText = messages
      .filter((m) => m["role"] === "assistant")
      .map((m) => `${typeof m["content"] === "string" ? m["content"] : ""}${typeof m["reasoning_content"] === "string" ? m["reasoning_content"] : ""}`)
      .join(" ");
    expect(assistantText).toContain("You are a helpful assistant");
    expect(assistantText).not.toContain("DeepSeek Harness");
    expect(assistantText).toContain("deepseek-v4");
  });

  test("the DSH identity scrub tolerates zero-width-space splitting", () => {
    // Upstream can interleave U+200B between characters; the match must still
    // fire so a normalized-away identity cannot slip through.
    const scrubbed = scrubBuddyChannelIdentityText("You\u200bare DeepSeek\u200b Harness");
    expect(scrubbed).toBe("You are a helpful assistant");
    const gui = scrubBuddyChannelIdentityText("Open the DeepSeek Harness Web GUI");
    expect(gui).toBe("Open the WorkBuddy Web GUI");
  });

  test("the scrub leaves unrelated text untouched", () => {
    const plain = "Let us harness the power of deepseek models by reading docs.";
    expect(scrubBuddyChannelIdentityText(plain)).toBe(plain);
  });

  test("CodeBuddy CN keeps its own neutral prompt", () => {
    // Regression guard: CN neutralizes agent identities rather than adopting the
    // intl CodeBuddy Code prompt, so the CN path must not pick up the official
    // identity from the shared constant.
    const payload: Record<string, unknown> = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    };
    codeBuddyCnPrePayload(payload, wbRequest, wbCandidate, wbContext);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("system");
    expect(messages[0]?.["content"]).toBe("You are a helpful assistant.");
    expect(messages[0]?.["content"]).not.toContain("CodeBuddy Code");
  });
});
