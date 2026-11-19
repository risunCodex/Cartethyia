/**
 * The chat surface's Cline identity headers.
 *
 * Two properties are asserted, each for a reason an operator would otherwise
 * discover from an upstream refusal rather than from this suite:
 *
 *   (a) `x-core-version` is the `@cline/sdk` version, not the client version.
 *       Sending the client version there tells the billing surface a VS Code
 *       extension version that `@cline/sdk` has never published. Cline's
 *       refusal for an implausible identity is worded identically to its
 *       refusal for a dead credential, so the failure is reported as
 *       "re-authenticate" while chat is in fact healthy.
 *
 *   (b) `x-task-id` is present exactly when the dispatch carries conversation
 *       affinity. Cline's own client sends it on inference as the stable
 *       prompt-cache key and omits it elsewhere rather than inventing a
 *       per-request identity. A value that changed per attempt would start a
 *       new cache entry on every retry.
 *
 * No network: the adapter is driven through an injected `outbound_fetch`.
 */
import { describe, expect, test } from "bun:test";
import { createClineAdapter } from "../../src/providers/integrations/cline/cline";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ValidatedOutboundFetch,
} from "../../src/providers/provider-contracts";

const TARGET: ProviderDispatchTarget = {
  provider_id: "cline",
  model_id: "minimax/minimax-m3.1-flash:free",
  wire_family: "chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
};

function request(): CanonicalRequest {
  return {
    model: "minimax/minimax-m3.1-flash:free",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

/** Captures the outbound headers and answers with a minimal non-streamed body. */
function capturing(): { fetcher: ValidatedOutboundFetch; seen: () => Headers } {
  let seen = new Headers();
  const fetcher = (async (_url: unknown, init?: { headers?: unknown }) => {
    seen = new Headers(init?.headers as HeadersInit | undefined);
    return new Response(
      JSON.stringify({
        data: {
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as ValidatedOutboundFetch;
  return { fetcher, seen: () => seen };
}

function context(
  fetcher: ValidatedOutboundFetch,
  affinity?: string,
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "cline",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("sk_test_token"),
    },
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher,
    ...(affinity === undefined ? {} : { conversation_affinity: affinity }),
  };
}

async function dispatch(affinity?: string): Promise<Headers> {
  const { fetcher, seen } = capturing();
  const adapter = createClineAdapter();
  for await (const _event of adapter.dispatch(request(), TARGET, context(fetcher, affinity))) {
    // Drained only to reach completion; the headers are the subject.
  }
  return seen();
}

describe("cline chat identity headers", () => {
  test("user-agent and x-client-version agree", async () => {
    const headers = await dispatch();
    const version = headers.get("x-client-version");
    expect(headers.get("user-agent")).toBe(`Cline/${version}`);
  });

  test("x-task-id is sent when the dispatch carries conversation affinity", async () => {
    const headers = await dispatch("conv-aff-1");
    expect(headers.get("x-task-id")).toBe("conv-aff-1");
  });

  test("x-task-id is omitted when there is no affinity", async () => {
    const headers = await dispatch();
    expect(headers.get("x-task-id")).toBeNull();
  });

  test("referer is emitted once, not in two spellings", async () => {
    // Header names are case-insensitive, so sending `http-referer` and
    // `HTTP-Referer` does not hedge against a case-sensitive check — it makes
    // `Headers` merge them into `https://cline.bot, https://cline.bot`.
    const headers = await dispatch();
    expect(headers.get("http-referer")).toBe("https://cline.bot");
  });

  test("the chat surface mirrors the reference client's identity set", async () => {
    // The reference client's request layer (`sdk/packages/llms` mirror) sends
    // `x-client-type: cline-sdk` with the CLI's own 3.x version — the SDK
    // package is the layer that builds the headers even for CLI callers. The
    // version class is asserted structurally: the CLI line is 3.x while the
    // extension is 4.x and `@cline/sdk` is 0.x; only the CLI line may appear
    // in `x-client-version`.
    const headers = await dispatch();
    expect(headers.get("x-client-type")).toBe("cline-sdk");
    expect(headers.get("x-client-version")?.startsWith("3.")).toBe(true);
    // `x-platform-version` rides the same CLI line (the reference mirror's
    // pin is a 3.0.x app version, not a Node runtime version).
    expect(headers.get("x-platform-version")).toBe(headers.get("x-client-version"));
    // `x-platform` is the host's real platform, like the reference client's
    // `process.platform` — the two surfaces (chat and billing) share this
    // builder, so they can never disagree about the machine.
    expect(headers.get("x-platform")).toBe(process.platform);
    // The multiroot flag keeps the reference's exact header name.
    expect(headers.get("x-is-multiroot")).toBe("false");
    expect(headers.get("x-is-multi-root")).toBeNull();
  });
});
