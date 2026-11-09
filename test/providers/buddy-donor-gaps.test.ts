/**
 * The gap-closure ported from the `codebuddy2api` donor gateway for the
 * CodeBuddy wire. These lock the behaviors that previously diverged:
 *
 * - `X-Id-Source` / `X-Auth-Method` / `X-Userinfo` fall back to JWT claims
 *   when `auth_state` has no pinned values (the donor reads the JWT payload);
 * - the channel-check 400 detector (`11128` + explanatory text) that gates the
 *   console-endpoint retry;
 * - the RE2 schema normalization that strips `\_` escapes in tool parameter
 *   patterns, which the upstream rejects with a 400;
 * - the CodeBuddy reasoning-control validation (`thinking` shape).
 */
import { describe, expect, test } from "bun:test";
import { codebuddyHeaders } from "../../src/providers/integrations/buddy/codebuddy/shared";
import { buddyOAuthIdentityHeaders } from "../../src/providers/integrations/buddy/buddy-identity";
import { isBuddyChannelCheckError } from "../../src/providers/adapters/compatible-adapter";
import { normalizeBuddyToolNames, buddyPrePayloadCommon } from "../../src/providers/integrations/buddy/buddy-chat-shared";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

function contextWithToken(token: string): ProviderDispatchContext {
  return {
    credential: {
      account_id: "internal-1",
      secret: Buffer.from(token),
      auth_state: {},
    },
  } as unknown as ProviderDispatchContext;
}

const JWT = (claims: Record<string, unknown>): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("buddy OAuth identity JWT-claim fallback (donor client_profiles)", () => {
  test("reads id_source and token_source from JWT claims when auth_state has none", () => {
    const headers = buddyOAuthIdentityHeaders(
      contextWithToken(JWT({ sub: "uid-1", id_source: "github", token_source: "oauth" })),
    );
    expect(headers["X-User-Id"]).toBe("uid-1");
    expect(headers["X-Id-Source"]).toBe("github");
    expect(headers["X-Auth-Method"]).toBe("oauth");
    const userinfo = JSON.parse(Buffer.from(headers["X-Userinfo"]!, "base64").toString("utf8"));
    expect(userinfo).toEqual({ uin: "uid-1", id_source: "github", token_source: "oauth" });
  });

  test("falls back to auth_state when the token carries no claims", () => {
    const state = { idSource: "tencent", authMethod: "device" };
    const context = {
      credential: { account_id: "internal-1", secret: Buffer.from("sk-opaque"), auth_state: state },
    } as unknown as ProviderDispatchContext;
    const headers = buddyOAuthIdentityHeaders(context);
    expect(headers["X-Id-Source"]).toBe("tencent");
    expect(headers["X-Auth-Method"]).toBe("device");
  });

  test("omits the envelope for a pure personal account (no identity legs)", () => {
    // The donor gates the envelope on at least one identity leg (enterprise,
    // id_source, or token_source); a bare personal account sends only
    // `X-User-Id`.
    const headers = buddyOAuthIdentityHeaders(contextWithToken(JWT({ sub: "uid-9" })));
    expect(headers["X-Userinfo"]).toBeUndefined();
    expect(headers["X-User-Id"]).toBe("uid-9");
  });

  test("codebuddyHeaders still forwards the JWT-derived identity", async () => {
    const headers = await codebuddyHeaders("CLI", contextWithToken(JWT({ sub: "uid-2", id_source: "github" })), undefined, true);
    expect(headers["X-User-Id"]).toBe("uid-2");
    expect(headers["X-Id-Source"]).toBe("github");
    expect(headers["X-Userinfo"]).toBeDefined();
  });
});

describe("isBuddyChannelCheckError (donor upstream_compat)", () => {
  test("recognizes code 11128 with channel explanatory text", () => {
    expect(
      isBuddyChannelCheckError('{"error":{"code":11128,"message":"illegal api invocation from an unapproved channel"}}'),
    ).toBe(true);
    expect(
      isBuddyChannelCheckError('{"code":"11-128","message":"Channel verification failed"}'),
    ).toBe(true);
  });

  test("requires the explanatory text, not just the code", () => {
    expect(isBuddyChannelCheckError('{"error":{"code":11128,"message":"quota exhausted"}}')).toBe(false);
    expect(isBuddyChannelCheckError('{"error":{"code":11115,"message":"illegal api invocation from an unapproved channel"}}')).toBe(false);
  });
});

describe("CodeBuddy RE2 tool-schema normalization (donor upstream_compat)", () => {
  test("strips escaped underscores in pattern positions", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "find",
            parameters: {
              type: "object",
              properties: { file_name: { type: "string", pattern: "^\\_.+$" } },
            },
          },
        },
      ],
    };
    normalizeBuddyToolNames(payload);
    const tool = (payload["tools"] as Array<Record<string, unknown>>)[0]!;
    expect(tool["name"]).toBe("find");
    const params = tool["parameters"] as Record<string, unknown>;
    const props = params["properties"] as Record<string, unknown>;
    const fileSchema = props["file_name"] as Record<string, unknown>;
    expect(fileSchema["pattern"]).toBe("^_.+$");
  });

  test("keeps escaped backslash pairs before underscores", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "find",
            parameters: {
              type: "object",
              properties: { name: { type: "string", pattern: "^\\\\_.+$" } },
            },
          },
        },
      ],
    };
    normalizeBuddyToolNames(payload);
    const tool = (payload["tools"] as Array<Record<string, unknown>>)[0]!;
    const params = tool["parameters"] as Record<string, unknown>;
    const props = params["properties"] as Record<string, unknown>;
    const nameSchema = props["name"] as Record<string, unknown>;
    expect(nameSchema["pattern"]).toBe("^\\\\_.+$");
  });
});

describe("CodeBuddy reasoning-control validation (donor reasoning.py)", () => {
  const request = { model: "glm-5.2", messages: [] } as unknown as CanonicalRequest;
  const candidate = {} as unknown as ProviderDispatchTarget;

  test("rejects thinking.budget_tokens below 1024", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 128 },
    };
    expect(() => buddyPrePayloadCommon(payload, request)).toThrow(/budget_tokens/);
  });

  test("rejects thinking.display other than summarized", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "full" },
    };
    expect(() => buddyPrePayloadCommon(payload, request)).toThrow(/display/);
  });

  test("rejects budget_tokens without enabled mode", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", budget_tokens: 4096 },
    };
    expect(() => buddyPrePayloadCommon(payload, request)).toThrow(/requires thinking.type/);
  });

  test("accepts a valid thinking shape", () => {
    const payload: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096, display: "summarized" },
    };
    expect(() => buddyPrePayloadCommon(payload, request)).not.toThrow();
    expect(payload["thinking"]).toBeDefined();
    void candidate;
  });
});
