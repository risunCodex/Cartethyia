/**
 * Qoder dispatch surface: modern `/model/v1` by default, legacy COSY fallback
 * when the modern surface refuses the account on entitlement grounds.
 *
 * Live verification (2026-11-02): the modern surface answers HTTP 402 +
 * `{"code":116,"error":"quota exceeded"}` for free-tier accounts that stream
 * fine over the legacy COSY surface, while entitled accounts stream on the
 * modern surface with the real model echoed. Dispatch therefore tries `ide`
 * first (default) and only falls back to `cosy` on that entitlement refusal —
 * a 401/403/model error is surfaced as-is so a real auth failure is not
 * masked by a legacy retry.
 */
import { describe, expect, test } from "bun:test";
import { createQoderAdapter } from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../../src/providers/provider-contracts";

/** A device-token credential secret (`dt-...`), never printed. */
const SECRET = new TextEncoder().encode("dt-test-token");
const MACHINE_ID = "00000000-0000-0000-0000-000000000000";

const TARGET: ProviderDispatchTarget = {
  provider_id: "qoder",
  model_id: "qfmodel",
  wire_family: "chat",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

function request(): CanonicalRequest {
  return {
    model: "qfmodel",
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

function context(fetcher: typeof fetch): ProviderDispatchContext {
  return {
    outbound_fetch: fetcher,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    credential: {
      credential_id: "c1",
      provider_id: "qoder",
      credential_kind: "oauth",
      secret: SECRET,
      auth_state: { userId: "u1", machineId: MACHINE_ID },
    },
    user_agent: "test",
    request_headers: {},
  } as unknown as ProviderDispatchContext;
}

async function collect(adapter: ReturnType<typeof createQoderAdapter>, fetcher: typeof fetch): Promise<void> {
  for await (const _event of adapter.dispatch(request(), TARGET, context(fetcher))) {
    void _event;
  }
}

describe("Qoder dispatch surface", () => {
  test("default surface is the modern `/model/v1` (ide), not legacy", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      calls++;
      urls.push(String(input));
      return streamOk();
    }) as typeof fetch;
    const adapter = createQoderAdapter();
    await collect(adapter, fetcher);
    expect(calls).toBe(1);
    expect(urls[0]).toContain("/model/v1/chat/completions");
  });

  test("falls back to legacy COSY when the modern surface answers 402/116", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      calls++;
      urls.push(String(input));
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 116, error: "quota exceeded" }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      return streamOk();
    }) as typeof fetch;
    const adapter = createQoderAdapter();
    await collect(adapter, fetcher);
    expect(calls).toBe(2);
    expect(urls[0]).toContain("/model/v1/chat/completions");
    expect(urls[1]).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });

  test("does not fall back on a 401 (auth failure surfaces as-is)", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      calls++;
      urls.push(String(input));
      return new Response(JSON.stringify({ code: 401, error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const adapter = createQoderAdapter();
    await expect(collect(adapter, fetcher)).rejects.toThrow();
    expect(calls).toBe(1);
    expect(urls[0]).toContain("/model/v1/chat/completions");
  });

  test("explicit `cosy` surface uses legacy directly, no modern attempt", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      calls++;
      urls.push(String(input));
      return streamOk();
    }) as typeof fetch;
    const adapter = createQoderAdapter({ surface: "cosy" });
    await collect(adapter, fetcher);
    expect(calls).toBe(1);
    expect(urls[0]).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });
});
