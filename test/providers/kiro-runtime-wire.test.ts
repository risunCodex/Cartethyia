/**
 * Kiro adapter — 1.4.x new-service wire protocol.
 *
 * The unpacked IDE (agent v1.1.641) talks to the Kiro control plane and runtime
 * services, not the legacy `q.{region}.amazonaws.com` / `codewhisperer.*` AWS
 * surfaces:
 *   - generation → `https://runtime.{region}.kiro.dev/generateAssistantResponse`
 *     (plain JSON on the REST path — no `x-amz-target`; the `api/kiroruntime`
 *     UA carries the `KiroIDE-{version}-{machineId}-KAS/<agent>
 *     acp-client/kiro-ide` device marker)
 *   - discovery/quota → `https://management.{region}.kiro.dev/List-Available-Models`
 *     (`KiroControlPlaneBearerService.*`) and `/getUsageLimits` (the
 *     CodeWhisperer-runtime usage read, measured on the management host
 *     2026-11-15; the 1.4.62-era `/Get-Usage-Limits` spelling is refused)
 *   - device identity → the `KiroIDE-{version}-{machineId}` UA marker
 *   - auth labelling → `TokenType` header (`API_KEY`/`EXTERNAL_IDP`/`SSO_OIDC`)
 */
import { describe, expect, test } from "bun:test";
import { kiroEndpoint, kiroHeaders } from "../../src/providers/integrations/kiro/kiro";
import { fetchKiroModels } from "../../src/providers/integrations/kiro/kiro-discovery";
import { fetchKiroQuota } from "../../src/providers/integrations/kiro/kiro-quota";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";

describe("Kiro generation endpoint (runtime service)", () => {
  test("uses the runtime host for the default region", () => {
    expect(kiroEndpoint(undefined)).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse");
  });

  test("uses the account region", () => {
    expect(kiroEndpoint({ authMethod: "idc", region: "eu-central-1" })).toBe(
      "https://runtime.eu-central-1.kiro.dev/generateAssistantResponse",
    );
  });

  test("falls back to us-east-1 on a malformed region", () => {
    expect(kiroEndpoint({ authMethod: "builder-id", region: "not-a-region" })).toBe(
      "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    );
  });
});

describe("Kiro generation headers (new runtime service)", () => {
  test("addresses the REST path without the awsJson target header", () => {
    // The official 1.4.x IDE identity frames the conversation as plain JSON on
    // the REST path — no `x-amz-target`, no awsJson content type.
    const headers = kiroHeaders("tok", undefined, "m".repeat(64), "vibe");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-amz-target"]).toBeUndefined();
    expect(headers["accept"]).toBeUndefined();
    expect(headers["x-amzn-kiro-attempt"]).toBe("1;max=3");
  });

  test("carries the device identity in the runtime UA, not a header", () => {
    const machineId = "ab".repeat(32);
    const headers = kiroHeaders("tok", undefined, machineId, "vibe");
    // The new service path sends no machine-id header; the marker lives in
    // the UA tail together with the bundled agent runtime and the client
    // affiliation.
    expect(headers["x-kiro-machineid"]).toBeUndefined();
    expect(headers["user-agent"]).toContain(`KiroIDE-1.4.178-${machineId}-KAS/0.66.102-hotfix.1 acp-client/kiro-ide`);
    expect(headers["user-agent"]).toContain("api/kiroruntime#1.0.0 m/N");
    expect(headers["x-amz-user-agent"]).toContain(`KiroIDE-1.4.178-${machineId}-KAS/0.66.102-hotfix.1 acp-client/kiro-ide`);
  });

  test("labels API-key and enterprise credentials with TokenType", () => {
    const apiKey = kiroHeaders("tok", { authMethod: "api_key", region: "us-east-1" }, "m", "vibe");
    expect(apiKey["TokenType"]).toBe("API_KEY");

    const ext = kiroHeaders("tok", { authMethod: "external_idp", region: "us-east-1" }, "m", "vibe");
    expect(ext["TokenType"]).toBe("EXTERNAL_IDP");

    const idc = kiroHeaders("tok", { authMethod: "idc", region: "us-east-1" }, "m", "vibe");
    expect(idc["TokenType"]).toBe("SSO_OIDC");
  });

  test("omits TokenType for social/Builder-ID sessions", () => {
    const social = kiroHeaders("tok", { authMethod: "google", region: "us-east-1" }, "m", "vibe");
    expect(social["TokenType"]).toBeUndefined();
  });

  test("sends the profile in the body only — no profile-arn header", () => {
    // The measured conversation carries `payload.profileArn`; the
    // `x-amzn-kiro-profile-arn` header is the web-search surface's shape.
    const headers = kiroHeaders(
      "tok",
      { authMethod: "idc", region: "us-east-1", profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/A" },
      "m",
      "vibe",
    );
    expect(headers["x-amzn-kiro-profile-arn"]).toBeUndefined();
  });
});

describe("Kiro model discovery (control plane)", () => {
  test("talks to the management host", async () => {
    let url = "";
    const fetcher: FetchLike = (async (input) => {
      url = typeof input === "string" ? input : new URL((input as Request).url).toString();
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as FetchLike;
    const result = await fetchKiroModels({
      credential: "tok",
      fetcher,
      authState: { region: "us-east-1", authMethod: "api_key" },
    });
    expect(url).toContain("https://management.us-east-1.kiro.dev/List-Available-Models");
    expect(url).toContain("origin=AI_EDITOR");
    expect(result).toBeNull(); // empty models —> null is the soft no-op
  });

  test("lists models from the control-plane payload", async () => {
    const fetcher: FetchLike = ((async () =>
      new Response(
        JSON.stringify({
          models: [
            { modelId: "claude-opus-5", tokenLimits: { maxInputTokens: 1_000_000 } },
            { modelId: "gpt-5.6-sol", tokenLimits: { maxInputTokens: 272_000 } },
          ],
        }),
        { status: 200 },
      )) as unknown) as FetchLike;
    const result = await fetchKiroModels({ credential: "tok", fetcher });
    expect(result).not.toBeNull();
    const ids = result?.map((m) => m.modelId) ?? [];
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("gpt-5.6-sol");
  });
});

describe("Kiro quota (control plane)", () => {
  test("talks to the management host via GET with the profile in the query", async () => {
    let url = "";
    let method = "";
    const fetcher: FetchLike = (async (input, init) => {
      url = typeof input === "string" ? input : new URL((input as Request).url).toString();
      method = init?.method ?? "GET";
      return new Response(JSON.stringify({ usageBreakdownList: [] }), { status: 200 });
    }) as FetchLike;
    const result = await fetchKiroQuota(
      "tok",
      fetcher,
      { auth_state: { region: "us-east-1", authMethod: "idc", profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/A" } } as never,
    );
    expect(method).toBe("GET");
    // Measured on the management host 2026-11-15: the CodeWhisperer-runtime
    // usage read lives at `/getUsageLimits`; the 1.4.62-era
    // `/Get-Usage-Limits` spelling is refused outright.
    expect(url).toContain("https://management.us-east-1.kiro.dev/getUsageLimits");
    expect(url).toContain(encodeURIComponent("arn:aws:codewhisperer:us-east-1:1:profile/A"));
    expect(url).toContain("origin=AI_EDITOR");
    expect(url).toContain("resourceType=AGENTIC_REQUEST");
    expect(result.source).toBe("kiro");
  });

  test("uses the family default profileArn for a Builder-ID account", async () => {
    let url = "";
    const fetcher: FetchLike = (async (input) => {
      url = typeof input === "string" ? input : new URL((input as Request).url).toString();
      return new Response(JSON.stringify({ usageBreakdownList: [] }), { status: 200 });
    }) as FetchLike;
    await fetchKiroQuota("tok", fetcher, {
      auth_state: { region: "us-east-1", authMethod: "builder-id" },
    } as never);
    // resolveKiroProfileArn falls back to the Builder-ID public default.
    expect(url).toContain(encodeURIComponent("arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"));
  });

  test("adopts the account email from userInfo.email", async () => {
    const fetcher: FetchLike = ((async () =>
      new Response(
        JSON.stringify({
          subscriptionInfo: { subscriptionTitle: "KIRO FREE" },
          usageBreakdownList: [],
          userInfo: { userId: "d-…", email: "akunytpremm8j@gmail.com" },
        }),
        { status: 200 },
      )) as unknown) as FetchLike;
    const result = await fetchKiroQuota("tok", fetcher, {
      auth_state: { region: "us-east-1", authMethod: "google" },
    } as never);
    expect(result.accountLabel).toBe("akunytpremm8j@gmail.com");
    expect(result.plan).toBe("KIRO FREE");
  });

  test("omits accountLabel when the payload has no userInfo.email", async () => {
    const fetcher: FetchLike = ((async () =>
      new Response(
        JSON.stringify({
          subscriptionInfo: { subscriptionTitle: "KIRO FREE" },
          usageBreakdownList: [],
          userInfo: { userId: "d-…" },
        }),
        { status: 200 },
      )) as unknown) as FetchLike;
    const result = await fetchKiroQuota("tok", fetcher, {
      auth_state: { region: "us-east-1", authMethod: "google" },
    } as never);
    expect(result.accountLabel).toBeUndefined();
  });
});
