/**
 * Cursor discovery: model-id pairing and roster cache policy.
 *
 * The invariants under test:
 * 1. A Run request's two model identities are never the same string:
 *    `model_details.model_id` is the variant's legacy slug and
 *    `requested_model.model_id` is the rich base id + parameter tuple. The
 *    upstream answers `BAD_MODEL_NAME` (error 5) for base-in-both and
 *    resource exhaustion (errorId 528384) for effort-sibling-in-both — both
 *    shapes are excluded by construction here.
 * 2. The roster cache serves stale lists during upstream trouble (stale-while-
 *    revalidate + 5-minute failure backoff) so a Run never waits on a known
 *    failing discovery endpoint.
 */
import { describe, expect, test } from "bun:test";
import { CURSOR_MODELS, discoverCursorModels } from "../../src/providers/integrations/cursor/cursor-catalog";
import {
  resolveCursorModelPair,
  fetchCursorDiscovery,
  CURSOR_DEFAULT_CONTEXT_TOKENS,
  type CursorModelRoute,
} from "../../src/providers/integrations/cursor/cursor-discovery";
import { CursorRosterCache } from "../../src/providers/integrations/cursor/cursor-roster";
import { encodeMessage } from "../../src/providers/integrations/cursor/cursor-protocol/messages";

function route(overrides: Partial<CursorModelRoute> = {}): CursorModelRoute {
  return {
    routeId: "claude-opus-5-high",
    legacySlug: "claude-opus-5-high",
    wireModelId: "claude-opus-5",
    parameters: [{ id: "reasoning", value: "high" }],
    maxMode: false,
    displayName: "Claude Opus 5 High",
    contextTokens: 200_000,
    accountUsable: true,
    isDefault: false,
    ...overrides,
  };
}

describe("Cursor discovery — model-id pairing", () => {
  test("the pair carries the legacy slug and the rich id in their own fields", () => {
    const pair = resolveCursorModelPair(route());
    // model_details.model_id must be the account-usable legacy slug.
    expect(pair.modelDetails.modelId).toBe("claude-opus-5-high");
    // requested_model.model_id must be the rich base id, NOT the slug.
    expect(pair.requestedModel.modelId).toBe("claude-opus-5");
    expect(pair.requestedModel.parameters).toEqual([{ id: "reasoning", value: "high" }]);
  });

  test("base id in both fields is impossible: the pair builder never shares one string", () => {
    const pair = resolveCursorModelPair(route());
    // The upstream trap: sending the base id in both fields answers
    // BAD_MODEL_NAME. Equality of the two ids is the bug shape.
    expect(pair.modelDetails.modelId).not.toBe(pair.requestedModel.modelId);
  });

  test("effort siblings stay parameters, never id suffixes", () => {
    // Sending an OpenAI-style effort sibling id in both fields answers
    // resource exhaustion (errorId 528384); effort is a parameter tuple.
    const pair = resolveCursorModelPair(route());
    for (const p of pair.requestedModel.parameters ?? []) {
      expect(pair.requestedModel.modelId).not.toContain(p.value);
    }
  });

  test("max-mode variants carry the flag, not a suffix on the id", () => {
    const pair = resolveCursorModelPair(route({ maxMode: true, routeId: "claude-opus-5-max" }));
    expect(pair.requestedModel.maxMode).toBe(true);
    expect(pair.requestedModel.modelId).toBe("claude-opus-5");
  });
});

/** A fetch that answers the three roster RPCs from in-memory builders. */
function unaryResponder(handlers: {
  usable?: () => Uint8Array;
  available?: () => Uint8Array;
  default?: () => Uint8Array;
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    let body: Uint8Array;
    if (url.endsWith("/aiserver.v1.AiService/AvailableModels")) {
      body = handlers.available?.() ?? encodeMessage("aiserver.v1.AvailableModelsResponse", {});
    } else if (url.endsWith("/agent.v1.AgentService/GetUsableModels")) {
      body = handlers.usable?.() ?? encodeMessage("agent.v1.GetUsableModelsResponse", {});
    } else if (url.endsWith("/agent.v1.AgentService/GetDefaultModelForCli")) {
      body = handlers.default?.() ?? encodeMessage("agent.v1.GetDefaultModelForCliResponse", {});
    } else {
      return new Response("not found", { status: 404 });
    }
    return new Response(Buffer.from(body), { status: 200 });
  }) as typeof fetch;
}

describe("Cursor discovery — assembly from the three RPCs", () => {

  test("variants become routes with their own legacy slug and parameter tuple", async () => {
    const fetchImpl = unaryResponder({
      usable: () =>
        encodeMessage("agent.v1.GetUsableModelsResponse", {
          models: [{ modelId: "claude-opus-5-high" }, { modelId: "claude-opus-5-low" }],
        }),
      available: () =>
        encodeMessage("aiserver.v1.AvailableModelsResponse", {
          models: [
            {
              name: "claude-opus-5",
              clientDisplayName: "Claude Opus 5",
              variants: [
                {
                  legacySlug: "claude-opus-5-high",
                  parameterValues: [{ id: "reasoning", value: "high" }],
                },
                {
                  legacySlug: "claude-opus-5-low",
                  parameterValues: [{ id: "reasoning", value: "low" }],
                },
              ],
            },
          ],
        }),
      default: () =>
        encodeMessage("agent.v1.GetDefaultModelForCliResponse", {
          model: { modelId: "default", displayName: "Auto" },
        }),
    });
    const result = await fetchCursorDiscovery("token", fetchImpl);
    expect(result.routes.length).toBe(2);
    const high = result.routes.find((r) => r.routeId === "claude-opus-5-high");
    expect(high?.wireModelId).toBe("claude-opus-5");
    expect(high?.parameters).toEqual([{ id: "reasoning", value: "high" }]);
    expect(high?.accountUsable).toBe(true);
    const pair = resolveCursorModelPair(high!);
    expect(pair.modelDetails.modelId).not.toBe(pair.requestedModel.modelId);
  });

  test("1M rows recover their context window from the display-name label", async () => {
    const fetchImpl = unaryResponder({
      available: () =>
        encodeMessage("aiserver.v1.AvailableModelsResponse", {
          models: [
            {
              name: "claude-opus-5",
              clientDisplayName: "Claude Opus 5.5 1M",
              variants: [{ legacySlug: "claude-opus-5-1m" }],
            },
          ],
        }),
    });
    const result = await fetchCursorDiscovery("token", fetchImpl);
    expect(result.routes[0]?.contextTokens).toBe(1_000_000);
  });

  test("unlabeled rows default to the 200k window", async () => {
    const fetchImpl = unaryResponder({
      available: () =>
        encodeMessage("aiserver.v1.AvailableModelsResponse", {
          models: [{ name: "grok-4.7", variants: [{ legacySlug: "grok-4.7" }] }],
        }),
    });
    const result = await fetchCursorDiscovery("token", fetchImpl);
    expect(result.routes[0]?.contextTokens).toBe(CURSOR_DEFAULT_CONTEXT_TOKENS);
  });

  test("a variant without a legacy slug is never routable", async () => {
    const fetchImpl = unaryResponder({
      available: () =>
        encodeMessage("aiserver.v1.AvailableModelsResponse", {
          models: [
            {
              name: "claude-opus-5",
              variants: [
                { parameterValues: [{ id: "reasoning", value: "high" }] }, // no legacySlug
              ],
            },
          ],
        }),
    });
    const result = await fetchCursorDiscovery("token", fetchImpl);
    // Cannot be requested: model_details.model_id has no valid value.
    expect(result.routes.length).toBe(0);
  });
});

describe("Cursor roster cache — availability policy", () => {
  function responder(behavior: "ok" | "fail"): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      if (behavior === "fail") return new Response("boom", { status: 500 });
      const url = String(input);
      let body: Uint8Array;
      if (url.endsWith("/aiserver.v1.AiService/AvailableModels")) {
        body = encodeMessage("aiserver.v1.AvailableModelsResponse", {
          models: [{ name: "claude-opus-5", variants: [{ legacySlug: "claude-opus-5-high" }] }],
        });
      } else if (url.endsWith("/agent.v1.AgentService/GetUsableModels")) {
        body = encodeMessage("agent.v1.GetUsableModelsResponse", {});
      } else {
        body = encodeMessage("agent.v1.GetDefaultModelForCliResponse", {});
      }
      return new Response(Buffer.from(body), { status: 200 });
    }) as typeof fetch;
  }

  test("a fresh roster is served without a refetch", async () => {
    const cache = new CursorRosterCache();
    const first = await cache.lookup("tok", responder("ok"), 1_000);
    expect(first.status).toBe("refetched");
    const second = await cache.lookup("tok", responder("fail"), 2_000);
    // Within TTL the cache answers directly even though the upstream is broken.
    expect(second.status).toBe("fresh");
    expect(second.result.routes.length).toBeGreaterThan(0);
  });

  test("after a failed refetch the stale roster serves under backoff", async () => {
    const cache = new CursorRosterCache();
    await cache.lookup("tok", responder("ok"), 1_000);
    // Past TTL, upstream broken: the ask fails and the stale roster is served.
    const stale = await cache.lookup("tok", responder("fail"), 1_000 + 6 * 60 * 1000);
    expect(stale.status).toBe("backoff-only");
    expect(stale.result.routes.length).toBeGreaterThan(0);
  });

  test("concurrent cold-cache lookups share one ask (single-flight)", async () => {
    let calls = 0;
    const slow = (async (input: RequestInfo | URL) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const url = String(input);
      let body: Uint8Array;
      if (url.endsWith("/aiserver.v1.AiService/AvailableModels")) {
        body = encodeMessage("aiserver.v1.AvailableModelsResponse", {
          models: [{ name: "claude-opus-5", variants: [{ legacySlug: "claude-opus-5-high" }] }],
        });
      } else if (url.endsWith("/agent.v1.AgentService/GetUsableModels")) {
        body = encodeMessage("agent.v1.GetUsableModelsResponse", {});
      } else {
        body = encodeMessage("agent.v1.GetDefaultModelForCliResponse", {});
      }
      return new Response(Buffer.from(body), { status: 200 });
    }) as unknown as typeof fetch;
    const cache = new CursorRosterCache();
    const [a, b] = await Promise.all([
      cache.lookup("tok", slow, 1_000),
      cache.lookup("tok", slow, 1_000),
    ]);
    expect(a.result.routes.length).toBe(1);
    expect(b.result.routes.length).toBe(1);
    // One discovery ask = three RPCs; two concurrent lookups share that ask.
    expect(calls).toBe(3);
  });
});

describe("Cursor catalog — model fetch", () => {
  test("the static floor is exactly the fixed-settings trio", () => {
    expect(CURSOR_MODELS.map((m) => m.modelId)).toEqual([
      "auto",
      "cursor-grok-4.6-medium",
      "grok-4.7-medium",
    ]);
    expect(CURSOR_MODELS.map((m) => m.contextLimit)).toEqual([200_000, 256_000, 256_000]);
    for (const row of CURSOR_MODELS) {
      expect(row.reasoning).toBe(true);
      expect(row.modalities.input).toContain("image");
    }
  });

  test("discovery maps every route to a catalog row", async () => {
    // Two variants become two rows, with the route's own id, context window,
    // and reasoning declared.
    const fetchImpl = unaryResponder({
      usable: () => encodeMessage("agent.v1.GetUsableModelsResponse", {}),
      available: () =>
        encodeMessage("aiserver.v1.AvailableModelsResponse", {
          models: [
            {
              name: "claude-opus-5",
              clientDisplayName: "Claude Opus 5",
              contextTokenLimit: 300_000,
              variants: [
                { legacySlug: "claude-opus-5-high", parameterValues: [{ id: "effort", value: "high" }] },
                { legacySlug: "claude-opus-5-low", parameterValues: [{ id: "effort", value: "low" }] },
              ],
            },
          ],
        }),
      default: () => encodeMessage("agent.v1.GetDefaultModelForCliResponse", {}),
    });
    const rows = await discoverCursorModels({ credential: "token", fetcher: fetchImpl });
    expect(rows).not.toBeNull();
    expect(rows?.map((row) => row.modelId)).toEqual(["claude-opus-5-high", "claude-opus-5-low"]);
    expect(rows?.map((row) => row.contextLimit)).toEqual([300_000, 300_000]);
    for (const row of rows ?? []) {
      expect(row.reasoning).toBe(true);
      expect(row.endpointPath).toBe("/agent.v1.AgentService/Run");
    }
  });

  test("an empty roster is null so the registry serves the static floor", async () => {
    const rows = await discoverCursorModels({ credential: "token", fetcher: unaryResponder({}) });
    expect(rows).toBeNull();
  });

  test("a failing roster is null, not a throw", async () => {
    const failing = (async (_input: RequestInfo | URL) => new Response("boom", { status: 500 })) as typeof fetch;
    const rows = await discoverCursorModels({ credential: "token", fetcher: failing });
    expect(rows).toBeNull();
  });

  test("an empty credential is null without touching the network", async () => {
    const rows = await discoverCursorModels({ credential: "   " });
    expect(rows).toBeNull();
  });
});
