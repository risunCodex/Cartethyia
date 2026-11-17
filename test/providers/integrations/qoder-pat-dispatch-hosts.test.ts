/**
 * Qoder PAT dispatch host routing — the live `qoder/deepseek-v4-pro` path.
 *
 * A PAT (`pt-…`) is exchanged per request for a short-lived job token
 * (`jt-…`). `api3.qoder.sh` rejects job tokens with `403 / 105 "Login
 * expired"`, so the adapter must dial only `api2` → `api1`. Pinning just the
 * helper would let a future adapter change bypass the rule unnoticed.
 */
import { describe, expect, test } from "bun:test";
import { createQoderAdapter } from "../../../src/providers/integrations/qoder/qoder-adapter";
import { QODER_CHAT_PATH } from "../../../src/providers/integrations/qoder/qoder-realm";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../../src/providers/provider-contracts";

/** A pasted Personal Access Token, never printed. */
const PAT = new TextEncoder().encode("pt-test-token");
const API2 = `https://api2.qoder.sh${QODER_CHAT_PATH}`;
const API1 = `https://api1.qoder.sh${QODER_CHAT_PATH}`;

const TARGET: ProviderDispatchTarget = {
  provider_id: "qoder",
  model_id: "deepseek-v4-pro",
  wire_family: "chat",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

function request(): CanonicalRequest {
  return {
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  } as unknown as CanonicalRequest;
}

function streamOk(): Response {
  return new Response(
    "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function exchangeOk(): Response {
  return new Response(
    JSON.stringify({
      token: "jt-fresh-job-token",
      refresh_token: "jrt-refresh-token",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function context(fetcher: typeof fetch): ProviderDispatchContext {
  return {
    outbound_fetch: fetcher,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    credential: {
      credential_id: "c1",
      provider_id: "qoder",
      credential_kind: "api_key",
      secret: PAT,
      auth_state: {},
    },
    user_agent: "test",
    request_headers: {},
  } as unknown as ProviderDispatchContext;
}

async function collect(
  adapter: ReturnType<typeof createQoderAdapter>,
  fetcher: typeof fetch,
): Promise<void> {
  for await (const _event of adapter.dispatch(request(), TARGET, context(fetcher))) {
    void _event;
  }
}

describe("Qoder PAT dispatch host routing", () => {
  test("a PAT is exchanged to a job token and dials api2, never api3", async () => {
    const chatUrls: string[] = [];
    let exchanges = 0;
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/v1/jobToken/exchange")) {
        exchanges++;
        return exchangeOk();
      }
      chatUrls.push(url);
      return streamOk();
    }) as typeof fetch;

    await collect(createQoderAdapter(), fetcher);

    // The PAT must never be sent to COSY raw: one exchange, then exactly one
    // chat call on the job-token host.
    expect(exchanges).toBe(1);
    expect(chatUrls).toEqual([API2]);
    expect(chatUrls.some((url) => url.includes("api3.qoder.sh"))).toBe(false);
  });

  test("a job-token transport failure falls back to api1 and stops there", async () => {
    const chatUrls: string[] = [];
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/v1/jobToken/exchange")) return exchangeOk();
      chatUrls.push(url);
      if (url.startsWith("https://api2.qoder.sh")) throw new Error("connection reset");
      return streamOk();
    }) as typeof fetch;

    await collect(createQoderAdapter(), fetcher);

    expect(chatUrls).toEqual([API2, API1]);
    expect(chatUrls.some((url) => url.includes("api3.qoder.sh"))).toBe(false);
  });
});
