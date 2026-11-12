/**
 * The buddy media path, against the shape cb actually answers.
 *
 * Image and video are the two generation surfaces the buddy family serves, and
 * both are easy to get subtly wrong, so these assertions are about the
 * *contract* rather than string output:
 *
 * - **CodeBuddy image generation is native.** The request must use
 *   `/images/generations` and preserve size/count; its nested response envelope
 *   must be normalized to the gateway's image outcome.
 * - **cb refuses over HTTP 200.** Exhausted credits arrive as a 200 JSON
 *   envelope `{error:{data:{code,msg}}}`, not a 4xx. Surfacing `msg` verbatim is
 *   the difference between "top up" and a meaningless "no image".
 * - **video is an async task.** A submit returns `{data:{id,status:queued}}`;
 *   the clip is fetched from a sibling task endpoint, so the adapter has to poll
 *   until it stops being queued.
 *
 * The upstream is a mock: these run without credits, and they lock the request
 * shape and the poll loop, which is the part under our control.
 */
import { describe, expect, test } from "bun:test";
import {
  BuddyMediaAdapter,
  buddyErrorOf,
  extractChatImages,
} from "../../src/providers/integrations/buddy/media";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const IMAGE_TARGET = {
  provider_id: "cb",
  model_id: "gemini-3.1-flash-image",
  wire_family: "chat",
  endpoint_path: "/images/generations",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

const VIDEO_TARGET = {
  provider_id: "cb",
  model_id: "seedance-2.5",
  wire_family: "chat",
  endpoint_path: "/videos/generations",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

function context(fetcher: typeof fetch): ProviderDispatchContext {
  return {
    credential: { provider_id: "cb", credential_kind: "api_key", secret: new TextEncoder().encode("sk-cb") },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher as never,
  } as unknown as ProviderDispatchContext;
}

interface Captured {
  readonly url: string;
  readonly body: Record<string, unknown> | null;
  readonly headers: Record<string, string>;
}

function capture(responder: (call: Captured, index: number) => Response): { fetcher: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    const call: Captured = {
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      headers,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function adapter(): BuddyMediaAdapter {
  // Use the CodeBuddy adapter settings with a mocked native image endpoint.
  const cfg = {
    provider_id: "cb" as const,
    base_url: "https://www.codebuddy.ai/v2",
    authentication_header_shape: "authorization_bearer" as const,
  };
  return new BuddyMediaAdapter(cfg as never, {
    variant: "IDE",
    systemPrompt: "SYSTEM",
    baseUrl: "https://www.codebuddy.ai/v2",
    imageGenerationPath: "/images/generations",
  });
}

describe("buddyGenerateImage — CodeBuddy native image endpoint", () => {
  test("sends size and count and normalizes the nested success envelope", async () => {
    const { fetcher, calls } = capture(() => new Response(
      JSON.stringify({
        code: 0,
        msg: "OK",
        data: {
          created: 1_700_000_000,
          data: [{ url: "https://cdn.example/a.png" }],
          usage: { total_tokens: 10 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const result = await adapter().generateImage(
      { model: "gemini-3.1-flash-image", prompt: "a red apple", size: "1024x1024", n: 2 },
      IMAGE_TARGET,
      context(fetcher),
    );
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body!;
    expect(calls[0]!.url).toBe("https://www.codebuddy.ai/v2/images/generations");
    expect(body).toMatchObject({ model: "gemini-3.1-flash-image", prompt: "a red apple", size: "1024x1024", n: 2 });
    expect(result).toEqual({
      created: 1_700_000_000,
      data: [{ url: "https://cdn.example/a.png" }],
      usage: { total_tokens: 10 },
    });
  });

  test("surfaces provider error envelopes instead of a generic no-image", async () => {
    const { fetcher } = capture(() =>
      new Response(
        JSON.stringify({ error: { data: { code: 14018, msg: "Credits exhausted. Please top up." } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      adapter().generateImage({ prompt: "a red apple" }, IMAGE_TARGET, context(fetcher)),
    ).rejects.toThrow(/Credits exhausted/);
  });

  test("an empty image array is a failure, not an empty success", async () => {
    const { fetcher } = capture(() => new Response(
      JSON.stringify({ code: 0, data: { created: 1, data: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    await expect(
      adapter().generateImage({ prompt: "x" }, IMAGE_TARGET, context(fetcher)),
    ).rejects.toThrow(/no image/i);
  });
});

describe("buddyGenerateVideo — submit then poll to completion", () => {
  test("submits and polls the mocked sibling task URL, returning the clip URL", async () => {
    const { fetcher, calls } = capture((call, index) => {
      // First call: submit → queued task. Second call: status → finished clip.
      if (index === 0) {
        return new Response(
          JSON.stringify({ data: { id: "task-1", status: "queued" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(call.url).toBe("https://www.codebuddy.ai/v2/videos/generations/task-1");
      return new Response(
        JSON.stringify({ data: { id: "task-1", status: "succeeded", content: { video_url: "https://cdn.example/v.mp4" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await adapter().generateVideo(
      { model: "seedance-2.5", prompt: "a paper boat", size: "720p", n: 2 },
      VIDEO_TARGET,
      context(fetcher),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ model: "seedance-2.5", prompt: "a paper boat", size: "720p", n: 2 });
    expect(result).toEqual({ data: [{ url: "https://cdn.example/v.mp4" }], task_id: "task-1" });
  });

  test("a submit cb refuses over HTTP 200 surfaces its reason", async () => {
    const { fetcher } = capture(() =>
      new Response(
        JSON.stringify({ error: { data: { code: 14018, msg: "Credits exhausted." } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      adapter().generateVideo({ prompt: "x" }, VIDEO_TARGET, context(fetcher)),
    ).rejects.toThrow(/Credits exhausted/);
  });
});

describe("chat image extraction", () => {
  test("pulls a markdown image link", () => {
    expect(extractChatImages("here you go ![x](https://cdn.example/a.png) done")).toEqual([
      { url: "https://cdn.example/a.png" },
    ]);
  });

  test("pulls an inline base64 data URI with its mime type", () => {
    const row = extractChatImages("data:image/png;base64,QUJD")[0]!;
    expect(row).toEqual({ b64_json: "QUJD", mime_type: "image/png" });
  });

  test("text with no image yields nothing", () => {
    expect(extractChatImages("just words")).toEqual([]);
  });
});

describe("buddyErrorOf", () => {
  test("reads the nested cb envelope", () => {
    expect(buddyErrorOf({ error: { data: { code: 14018, msg: "Credits exhausted." } } })).toBe("Credits exhausted.");
  });

  test("falls back to the code when no message", () => {
    expect(buddyErrorOf({ error: { data: { code: 11128 } } })).toBe("CodeBuddy error 11128");
  });

  test("a body with no error yields undefined", () => {
    expect(buddyErrorOf({ data: { id: "x" } })).toBeUndefined();
  });
});
