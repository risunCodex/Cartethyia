/**
 * Cursor OAuth, API-key import, catalog mapping, and Run-origin validation.
 *
 * The properties asserted here are the ones an operator would otherwise discover
 * from a failed login or a refused Run:
 *
 *   (a) the PKCE verifier never leaves the server (it is the flow's private
 *       half, and publishing it lets a reader mint the tokens);
 *   (b) a poll answer is classified rather than thrown, so a pending login is
 *       not reported as a dead credential;
 *   (c) an imported `crsr_` key is exchanged before it is stored, and the raw
 *       key rides in the refresh field so it can be renewed;
 *   (d) a `shouldLogout` answer and a sign-in policy block are terminal, while
 *       a transport failure is transient;
 *   (e) the Run origin fails closed — a non-Cursor or non-HTTPS host never
 *       receives a credentialed connection.
 *
 * No network: every call goes through an injected fetch.
 */
import { describe, expect, test } from "bun:test";
import { CursorOAuthClient } from "../../src/providers/integrations/cursor/cursor-auth";
import {
  CURSOR_MODELS,
  cursorModelDefinition,
  defaultParameterValues,
  fetchCursorModels,
  fetchCursorRunOrigin,
  mapAvailableModelsResponse,
  parseCursorContextLimit,
  type CursorModelInfo,
} from "../../src/providers/integrations/cursor/cursor-catalog";
import { normalizeAgentRunOrigin } from "../../src/providers/integrations/cursor/cursor-shared";
import type { OAuthDeviceFlowContext } from "../../src/providers/authentication/oauth-flow-store";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetcher: Fetcher): CursorOAuthClient {
  return new CursorOAuthClient(fetcher as typeof fetch);
}

/** A device-flow context carrying the private verifier, as the console passes it. */
function contextWith(providerState: string): OAuthDeviceFlowContext {
  return { providerId: "cursor", tenantId: "t1", accountLabel: "a", providerState };
}

describe("Cursor device flow start", () => {
  test("opens the browser login and keeps the verifier off the wire", async () => {
    const client = clientWith(async () => {
      throw new Error("start must not touch the network");
    });
    const started = await client.startDeviceAuth();
    expect(started.verificationUri.startsWith("https://cursor.com/loginDeepControl?")).toBe(true);
    expect(started.verificationUri).toContain("redirectTarget=cli");
    expect(started.verificationUri).toContain("mode=login");
    // No user code: approval is bound to the browser session.
    expect(started.userCode).toBe("");
    expect(started.deviceAuthId.length).toBeGreaterThan(0);

    const state = JSON.parse(started.providerState ?? "{}") as Record<string, unknown>;
    const verifier = state["verifier"];
    expect(typeof verifier).toBe("string");
    // The verifier must not appear anywhere the browser sees.
    expect(started.verificationUri).not.toContain(verifier as string);
  });
});

describe("Cursor device flow poll", () => {
  test("404 is pending, not a failure", async () => {
    const client = clientWith(async () => jsonResponse({}, 404));
    const result = await client.pollDeviceAuth("uuid", contextWith(JSON.stringify({ verifier: "v" })));
    expect(result.status).toBe("pending");
  });

  test("429 asks the dashboard to slow down rather than failing the login", async () => {
    const client = clientWith(async () => jsonResponse({ error: "slow down" }, 429));
    const result = await client.pollDeviceAuth("uuid", contextWith(JSON.stringify({ verifier: "v" })));
    expect(result.status).toBe("slow_down");
  });

  test("a 200 without tokens is still pending", async () => {
    const client = clientWith(async () => jsonResponse({}));
    const result = await client.pollDeviceAuth("uuid", contextWith(JSON.stringify({ verifier: "v" })));
    expect(result.status).toBe("pending");
  });

  test("a completed poll exchanges into tokens and records the method", async () => {
    const client = clientWith(async () =>
      jsonResponse({ accessToken: "jwt-access", refreshToken: "jwt-refresh" }),
    );
    const result = await client.pollDeviceAuth("uuid", contextWith(JSON.stringify({ verifier: "v" })));
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.result.access).toBe("jwt-access");
    expect(result.result.refresh).toBe("jwt-refresh");
    expect(result.result.auth_state).toEqual({ method: "login" });
  });

  test("an unknown device authorization fails without a request", async () => {
    const client = clientWith(async () => {
      throw new Error("must not poll without provider state");
    });
    const result = await client.pollDeviceAuth("uuid");
    expect(result.status).toBe("failed");
  });

  test("a server error is reported as a failure", async () => {
    const client = clientWith(async () => jsonResponse({ message: "nope" }, 500));
    const result = await client.pollDeviceAuth("uuid", contextWith(JSON.stringify({ verifier: "v" })));
    expect(result.status).toBe("failed");
  });
});

describe("Cursor API key import", () => {
  test("exchanges a raw key and keeps it in the refresh field", async () => {
    let seenBody: string | undefined;
    let seenAuth: string | undefined;
    const client = clientWith(async (_url, init) => {
      seenBody = init?.body as string;
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      seenAuth = headers.get("authorization") ?? undefined;
      return jsonResponse({ accessToken: "jwt-access", refreshToken: "ignored" });
    });
    const result = await client.importCredential({
      credential: "crsr_test_key",
      fields: {},
    });
    expect(seenBody).toBe("{}");
    expect(seenAuth).toBe("Bearer crsr_test_key");
    // The exchanged JWT is the dispatch secret; the raw key is what renews it.
    expect(result.access).toBe("jwt-access");
    expect(result.refresh).toBe("crsr_test_key");
    expect(result.auth_state).toEqual({ method: "api_key" });
  });

  test("refuses a credential that is not a Cursor API key", async () => {
    const client = clientWith(async () => jsonResponse({ accessToken: "x" }));
    await expect(
      client.importCredential({ credential: "sk-not-cursor", fields: {} }),
    ).rejects.toThrow(/crsr_/);
  });

  test("refuses an empty credential", async () => {
    const client = clientWith(async () => jsonResponse({ accessToken: "x" }));
    await expect(client.importCredential({ credential: "   ", fields: {} })).rejects.toThrow(
      /required/,
    );
  });
});

describe("Cursor session refresh", () => {
  test("re-exchanges an API-key account instead of posting a grant", async () => {
    let seenUrl = "";
    const client = clientWith(async (url) => {
      seenUrl = url;
      return jsonResponse({ accessToken: "jwt-new", refreshToken: "ignored" });
    });
    const refreshed = await client.refresh("crsr_test_key");
    expect(seenUrl).toContain("/auth/exchange_user_api_key");
    expect(refreshed.access).toBe("jwt-new");
    expect(refreshed.refresh).toBe("crsr_test_key");
  });

  test("a browser session posts the IDE refresh grant", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> | undefined;
    const client = clientWith(async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({ access_token: "jwt-new" });
    });
    const refreshed = await client.refresh("session-refresh");
    expect(seenUrl).toContain("/oauth/token");
    expect(seenBody?.["grant_type"]).toBe("refresh_token");
    expect(seenBody?.["client_id"]).toBe("KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB");
    expect(refreshed.access).toBe("jwt-new");
    // The grant issues no new refresh token; the access token stands as both.
    expect(refreshed.refresh).toBe("session-refresh");
  });

  test("shouldLogout is terminal for this credential", async () => {
    const client = clientWith(async () =>
      jsonResponse({ access_token: "", shouldLogout: true }),
    );
    await expect(client.refresh("session-refresh")).rejects.toThrow(/shouldLogout/);
  });

  test("a sign-in policy block is classified as a policy refusal", async () => {
    const client = clientWith(async () =>
      jsonResponse({
        access_token: "",
        shouldLogout: true,
        error: "sign_in_policy_violation",
      }),
    );
    await expect(client.refresh("session-refresh")).rejects.toThrow(
      /sign_in_policy_violation/,
    );
  });

  test("a 401 is terminal while a transport failure is transient", async () => {
    const rejected = clientWith(async () => jsonResponse({ message: "no" }, 401));
    await expect(rejected.refresh("session-refresh")).rejects.toThrow(/rejected/);
    const transport = clientWith(async () => {
      throw new Error("socket hang up");
    });
    await expect(transport.refresh("session-refresh")).rejects.toThrow(/socket hang up/);
  });
});

describe("Cursor Run origin validation", () => {
  test("accepts a Cursor HTTPS subdomain", () => {
    expect(normalizeAgentRunOrigin("https://agentn.us.api5.cursor.sh")).toBe(
      "https://agentn.us.api5.cursor.sh",
    );
  });

  test("adds a scheme to a bare host", () => {
    expect(normalizeAgentRunOrigin("agent.cursor.sh")).toBe("https://agent.cursor.sh");
  });

  test("rejects non-Cursor, non-HTTPS, malformed, and credentialed origins", () => {
    expect(normalizeAgentRunOrigin("https://evil.example.com")).toBeNull();
    expect(normalizeAgentRunOrigin("http://agent.cursor.sh")).toBeNull();
    expect(normalizeAgentRunOrigin("https://cursor.sh")).toBeNull();
    expect(normalizeAgentRunOrigin("https://user:pw@agent.cursor.sh")).toBeNull();
    expect(normalizeAgentRunOrigin(undefined)).toBeNull();
    expect(normalizeAgentRunOrigin("   ")).toBeNull();
    expect(normalizeAgentRunOrigin("not a url at all")).toBeNull();
  });

  test("a missing agentnUrl fails closed instead of falling back", async () => {
    const fetcher = (async () =>
      jsonResponse({ agentUrlConfig: {} })) as unknown as typeof fetch;
    await expect(fetchCursorRunOrigin({ credential: "jwt", fetcher })).rejects.toThrow(
      /missing agentUrlConfig/,
    );
  });

  test("an invalid agentnUrl fails closed", async () => {
    const fetcher = (async () =>
      jsonResponse({ agentUrlConfig: { agentnUrl: "https://evil.example.com" } })) as unknown as typeof fetch;
    await expect(fetchCursorRunOrigin({ credential: "jwt", fetcher })).rejects.toThrow(
      /invalid Cursor agent URL/,
    );
  });

  test("resolves the declared agentnUrl", async () => {
    const fetcher = (async () =>
      jsonResponse({
        agentUrlConfig: { agentnUrl: "https://agentn.us.api5.cursor.sh" },
      })) as unknown as typeof fetch;
    await expect(fetchCursorRunOrigin({ credential: "jwt", fetcher })).resolves.toBe(
      "https://agentn.us.api5.cursor.sh",
    );
  });
});

describe("Cursor catalog mapping", () => {
  test("maps capabilities and limits only from Cursor's declarations", () => {
    const models = mapAvailableModelsResponse({
      model_names: ["gpt-5.6", "vision-model"],
      models: [
        {
          name: "gpt-5.6",
          client_display_name: "GPT-5.6",
          supports_thinking: true,
          supports_images: false,
          variants: [
            {
              display_name: "High",
              is_default_non_max_config: true,
              parameter_values: [
                { id: "effort", value: "high" },
                { id: "context", value: "200k" },
              ],
            },
          ],
        },
        {
          name: "vision-model",
          supports_images: true,
          supports_thinking: false,
          context_token_limit: 128000,
          variants: [
            {
              display_name: "Default",
              is_default_non_max_config: true,
              parameter_values: [{ id: "context", value: "128k" }],
            },
          ],
        },
      ],
    });
    const [first, second] = models;
    expect(first?.id).toBe("gpt-5.6");
    expect(first?.displayName).toBe("GPT-5.6");
    expect(first?.supportsThinking).toBe(true);
    expect(first?.supportsImages).toBe(false);
    // The 200k variant parameter is the authoritative context window.
    expect(first?.maxContext).toBe(200_000);
    expect(second?.supportsImages).toBe(true);
    expect(second?.maxContext).toBe(128_000);
  });

  test("an undeclared model has no image capability", () => {
    const models = mapAvailableModelsResponse({
      models: [{ name: "plain", variants: [] }],
    });
    expect(models[0]?.supportsImages).toBeUndefined();
    const row = cursorModelDefinition(models[0] as CursorModelInfo);
    // Capability never falls back: undeclared means not offered.
    expect(row.modalities.input).not.toContain("image");
  });

  test("a declared image model advertises vision on the catalog row", () => {
    const models = mapAvailableModelsResponse({
      models: [{ name: "v", supports_images: true, variants: [] }],
    });
    const row = cursorModelDefinition(models[0] as CursorModelInfo);
    expect(row.modalities.input).toContain("image");
    expect(row.toolCall).toBe(true);
  });

  test("the default tuple is Cursor's declared default variant", () => {
    const models = mapAvailableModelsResponse({
      models: [
        {
          name: "m",
          variants: [
            {
              display_name: "Other",
              is_default_non_max_config: false,
              parameter_values: [{ id: "effort", value: "low" }],
            },
            {
              display_name: "Declared",
              is_default_non_max_config: true,
              parameter_values: [{ id: "effort", value: "high" }],
            },
          ],
        },
      ],
    });
    expect(defaultParameterValues(models[0])).toEqual([{ id: "effort", value: "high" }]);
    expect(defaultParameterValues(undefined)).toEqual([]);
  });

  test("CURSOR_MODELS static fallback exposes one id per model, not the wire ids", () => {
    const ids = new Set(CURSOR_MODELS.map((m) => m.modelId));
    expect([...ids].sort()).toEqual(["auto", "grok-4.6", "grok-4.7"]);
    // `default` and `cursor-grok-4.6` are the upstream wire ids `auto` and
    // `grok-4.6` map onto (see `resolveCursorWireModelId`), not separate
    // models: seeding them would list the same model twice.
    expect(ids.has("default")).toBe(false);
    expect(ids.has("cursor-grok-4.6")).toBe(false);
    // Output is stated, not inherited from the base catalog's 256k: a cap
    // equal to the whole window is not a limit Cursor serves.
    for (const model of CURSOR_MODELS) {
      expect(model.outputLimit).toBe(64_000);
      expect(model.contextLimit).toBe(256_000);
    }
  });

  test("parses Cursor's k/m context spelling", () => {
    expect(parseCursorContextLimit("200k")).toBe(200_000);
    expect(parseCursorContextLimit("1m")).toBe(1_000_000);
    expect(parseCursorContextLimit("128000")).toBe(128_000);
    expect(parseCursorContextLimit("nonsense")).toBeUndefined();
    expect(parseCursorContextLimit(undefined)).toBeUndefined();
  });

  test("a malformed variant is rejected rather than coerced", () => {
    expect(() =>
      mapAvailableModelsResponse({
        models: [{ name: "m", variants: [{ parameter_values: "not-an-array" }] }],
      }),
    ).toThrow(/invalid parameter values/);
  });

  test("unary catalog calls carry the CLI identity headers", async () => {
    let seenHeaders: Headers | undefined;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers as HeadersInit | undefined);
      return jsonResponse({ models: [] });
    }) as unknown as typeof fetch;
    await fetchCursorModels({ credential: "jwt", fetcher });
    expect(seenHeaders?.get("authorization")).toBe("Bearer jwt");
    expect(seenHeaders?.get("x-cursor-client-type")).toBe("cli");
    expect(seenHeaders?.get("x-cursor-client-version")).toBe("cli-3.29.15-86776fc");
    expect(seenHeaders?.get("x-ghost-mode")).toBe("true");
    expect(seenHeaders?.get("x-request-id")).toBeTruthy();
    // The CLI sends its resolved timezone on every request (IANA name; the
    // test runner's environment is commonly `UTC`, which has no slash).
    const zone = seenHeaders?.get("x-cursor-timezone");
    expect(zone).toBeTruthy();
    expect(zone).not.toBe("");
  });
});
