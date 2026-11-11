/**
 * Kiro OAuth flow — portal social + device OIDC.
 *
 * The portal (`app.kiro.dev/signin`) is the merged social/OIDC sign-in: the
 * authorize URL must carry no `idp`, must use the loopback origin as the
 * redirect, and must not include a path-carrying redirect (Cognito rejects it
 * with `redirect_mismatch`). The code exchange must replay the callback's
 * `login_option` in the redirect URI.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  InMemoryOAuthFlowStore,
  parseDeviceAuthStart,
  type OAuthExchangeResult,
} from "../../src/providers/authentication/oauth-flow-store";
import {
  kiroOAuthClient,
  KiroOAuthClient,
  KiroOidcPendingError,
} from "../../src/providers/integrations/kiro/kiro-oauth";
import { completeLogin, type OAuthLoginConfig } from "../../src/console/providers/oauth/routes";
import type { ProviderRegistry } from "../../src/providers/provider-registry";

describe("Kiro portal social flow", () => {
  test("browser redirect is the loopback callback the console binds", () => {
    // Host is 127.0.0.1 (not localhost): OIDC registration is portless on
    // 127.0.0.1 and authorize may only vary the port on that same host.
    expect(kiroOAuthClient.browserRedirectUri).toBe("http://127.0.0.1:3128/oauth/callback");
  });

  test("social authorize URL points at the portal with an origin-only redirect", () => {
    const url = kiroOAuthClient.buildAuthorizeUrl({
      state: "st-1",
      codeChallenge: "challenge",
      redirectUri: "http://127.0.0.1:3128/oauth/callback",
    });
    expect(url).toMatch(/^https:\/\/app\.kiro\.dev\/signin\?/);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("state")).toBe("st-1");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    // Origin only — no path. Path-carrying redirects are rejected by Cognito.
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3128");
    expect(parsed.searchParams.get("redirect_from")).toBe("KiroIDE");
    expect(parsed.searchParams.has("idp")).toBe(false);
  });

  test("every family's authorize URL is the unified portal", () => {
    // The 1.4.62 IDE has one authorize URL for every sign-in method — the
    // portal — and the callback's `login_option` names the family. Building a
    // separate OIDC-direct URL for builder-id/idc is not what the client does.
    for (const params of [{}, { authMethod: "builder-id" }, { authMethod: "idc" }, { authMethod: "google" }]) {
      const url = kiroOAuthClient.buildAuthorizeUrl({
        state: "st-x",
        codeChallenge: "challenge",
        redirectUri: "http://127.0.0.1:3128/oauth/callback",
        parameters: params,
      });
      expect(url).toMatch(/^https:\/\/app\.kiro\.dev\/signin\?/);
      const parsed = new URL(url);
      expect(parsed.searchParams.get("state")).toBe("st-x");
      expect(parsed.searchParams.get("redirect_from")).toBe("KiroIDE");
    }
  });

  test("parses the AWS SSO OIDC camelCase device-authorization response", () => {
    // `StartDeviceAuthorization` answers camelCase (`deviceCode`, `userCode`,
    // `verificationUriComplete`), not the RFC 8628 snake_case. The parser must
    // accept both shapes or the device flow fails at the very first step.
    const start = parseDeviceAuthStart({
      deviceCode: "dev-1",
      userCode: "ABCD-EFGH",
      verificationUriComplete: "https://device.example/verification?code=ABCD-EFGH",
      interval: 2,
      expiresIn: 600,
    });
    expect(start?.deviceCode).toBe("dev-1");
    expect(start?.userCode).toBe("ABCD-EFGH");
    expect(start?.verificationUri).toBe("https://device.example/verification?code=ABCD-EFGH");
    expect(start?.intervalSeconds).toBe(2);
    expect(start?.expiresInSeconds).toBe(600);
  });

  test("still parses the RFC snake_case device-authorization response", () => {
    const start = parseDeviceAuthStart({
      device_code: "dev-2",
      user_code: "WXYZ-1234",
      verification_uri: "https://device.example/verification",
      verification_uri_complete: "https://device.example/verification?code=WXYZ-1234",
      interval: 5,
      expires_in: 900,
    });
    expect(start?.deviceCode).toBe("dev-2");
    expect(start?.userCode).toBe("WXYZ-1234");
    expect(start?.verificationUriComplete).toBe("https://device.example/verification?code=WXYZ-1234");
    expect(start?.intervalSeconds).toBe(5);
    expect(start?.expiresInSeconds).toBe(900);
  });

  test("social exchange adopts the upstream email when the access token is opaque", async () => {
    // The social exchange returns an opaque (non-JWT) access token, so the JWT
    // extraction misses it; the client then asks the usage surface, which
    // answers with the account email.
    const calls: string[] = [];
    const client = new KiroOAuthClient(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url);
      calls.push(url);
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            accessToken: "opaque.social.token",
            refreshToken: "rt",
            expiresIn: 3600,
            profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/A",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/Get-Usage-Limits")) {
        return new Response(
          JSON.stringify({
            subscriptionInfo: { subscriptionTitle: "KIRO FREE" },
            usageBreakdownList: [],
            userInfo: { userId: "u", email: "user@gmail.com" },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const result = await client.exchangeSocialCode(
      "code",
      "verifier",
      "http://127.0.0.1:3128/oauth/callback",
      "google",
    );
    expect(result.accountLabel).toBe("user@gmail.com");
    expect(calls.some((url) => url.includes("/Get-Usage-Limits"))).toBe(true);
  });

  test("social exchange keeps the family fallback when the usage surface is unavailable", async () => {
    const client = new KiroOAuthClient(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url);
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            accessToken: "opaque.social.token",
            refreshToken: "rt",
            expiresIn: 3600,
            profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/A",
          }),
          { status: 200 },
        );
      }
      return new Response("upstream unavailable", { status: 503 });
    });
    const result = await client.exchangeSocialCode(
      "code",
      "verifier",
      "http://127.0.0.1:3128/oauth/callback",
      "google",
    );
    expect(result.accountLabel).toBe("Google account");
  });

  test("OIDC portal phase-1 registers the portless loopback and builds a fresh-PKCE authorize URL", async () => {
    // Mirror 1.4.62 IdC-provider.authenticate: register `http://127.0.0.1/oauth/callback`,
    // authorize with `http://127.0.0.1:<port>/oauth/callback` (host must match
    // registration — localhost here would be Invalid redirectUri), scopes
    // comma-joined, S256 of a *fresh* verifier (not the portal PKCE reused).
    let registerBody: Record<string, unknown> | undefined;
    const client = new KiroOAuthClient(async (input, init) => {
      const url = typeof input === "string" ? input : String((input as Request).url);
      if (url.includes("/client/register")) {
        registerBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ clientId: "cid", clientSecret: "csec" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    let pending: KiroOidcPendingError | undefined;
    try {
      // Pass localhost deliberately: authorize must rewrite host to 127.0.0.1.
      await client.exchangeCode("", "portal-verifier", "http://localhost:3128/oauth/callback", "st-oidc", {
        parameters: {
          login_option: "builderid",
          issuer_url: "https://view.awsapps.com/start",
          idc_region: "us-east-1",
        },
      });
    } catch (error) {
      if (error instanceof KiroOidcPendingError) pending = error;
      else throw error;
    }
    expect(pending).toBeInstanceOf(KiroOidcPendingError);
    expect(registerBody?.["redirectUris"]).toEqual(["http://127.0.0.1/oauth/callback"]);
    const authorize = new URL(pending!.authorizeUrl);
    expect(authorize.origin).toBe("https://oidc.us-east-1.amazonaws.com");
    expect(authorize.pathname).toBe("/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("cid");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3128/oauth/callback");
    expect(authorize.searchParams.get("scopes")).toBe(
      "codewhisperer:completions,codewhisperer:analysis,codewhisperer:conversations,codewhisperer:transformations,codewhisperer:taskassist",
    );
    // Phase 2 mints a fresh state (mirroring the IDE's new UUID for the IdC
    // leg) — never reuses the portal's state.
    const phase2State = authorize.searchParams.get("state") ?? "";
    expect(phase2State).not.toBe("st-oidc");
    expect(phase2State).toBeTruthy();
    expect(pending!.continueState).toBe(phase2State);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    // Challenge must be S256(fresh verifier), never the portal verifier itself.
    expect(authorize.searchParams.get("code_challenge")).not.toBe("portal-verifier");
    expect(pending!.codeVerifier).not.toBe("portal-verifier");
    const expectedChallenge = Buffer.from(
      createHash("sha256").update(pending!.codeVerifier).digest(),
    ).toString("base64url");
    expect(authorize.searchParams.get("code_challenge")).toBe(expectedChallenge);
    const stored = JSON.parse(pending!.providerState) as Record<string, unknown>;
    expect(stored["clientId"]).toBe("cid");
    expect(stored["redirectUri"]).toBe("http://127.0.0.1:3128/oauth/callback");
    expect(stored["authMethod"]).toBe("builder-id");
  });

  test("two-phase portal login completes: phase 1 mints a fresh continueState and phase 2 consumes it", async () => {
    // Regression: the phase-2 callback used to reuse the portal's state, so
    // `completeLogin` could not find the pending flow ("unknown or expired
    // state"). Mirror the IDE: phase 2 gets a fresh state, stored under the
    // new continueState, and the second callback completes against it.
    const store = new InMemoryOAuthFlowStore();
    let persisted: OAuthExchangeResult | undefined;
    let persistedLabel: string | undefined;
    let trackCalls = 0;
    const listener = {
      register() { return true; },
      release() {},
      releaseProvider() {},
      track() { trackCalls += 1; },
      stop() {},
    } as never;
    const client = new KiroOAuthClient(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url);
      if (url.includes("/client/register")) {
        return new Response(JSON.stringify({ clientId: "cid-2", clientSecret: "csec-2" }), { status: 200 });
      }
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({
            accessToken: "at-2",
            refreshToken: "rt-2",
            expiresIn: 3600,
            profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/A",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const registry = {
      resolveLoginClient: async () => client,
    } as unknown as ProviderRegistry;
    const oauthConfig: OAuthLoginConfig = {
      providerRegistry: registry,
      oauthFlowStore: store,
      accountStore: {
        async persistAccount(_tenantId, _providerId, input: { readonly label: string } & OAuthExchangeResult) {
          persisted = input;
          persistedLabel = input.label;
          return { accountId: "acc-1" };
        },
      },
      accessResolver: (() => undefined) as never,
      callbackListener: listener as never,
      deviceEgress: {
        db: {} as never,
        poolSelector: {} as never,
        networkBindingFactory: {
          fetch: () => (async () => new Response("{}", { status: 200 })) as never,
        } as never,
      },
    };

    // Phase 1: portal callback for builder-id carries no code.
    const phase1Flow = {
      providerId: "kiro",
      codeVerifier: "portal-verifier",
      accountLabel: "kiro",
      tenantId: null,
      redirectUri: "http://127.0.0.1:3128/oauth/callback",
    };
    await store.savePending("st-1", phase1Flow);
    const phase1 = await completeLogin(oauthConfig, "kiro", "", "st-1", {
      login_option: "builderid",
      issuer_url: "https://view.awsapps.com/start",
      idc_region: "us-east-1",
    });
    expect(phase1.ok).toBe(false);
    expect(phase1.redirectUrl).toMatch(/^https:\/\/oidc\.us-east-1\.amazonaws\.com\/authorize\?/);
    expect(phase1.continueState).toBeTruthy();
    const continueState = phase1.continueState!;
    expect(continueState).not.toBe("st-1");
    expect(trackCalls).toBe(1);
    // The pending flow is reachable under the fresh state with the fresh PKCE.
    const pending2 = await store.peekPending(continueState);
    expect(pending2).toBeDefined();
    expect(pending2!.codeVerifier).not.toBe("portal-verifier");

    // Phase 2: the OIDC authorize callback carries the code on the fresh state.
    const phase2 = await completeLogin(oauthConfig, "kiro", "auth-code-2", continueState);
    expect(phase2.ok).toBe(true);
    expect(persisted?.access).toBe("at-2");
    expect(persistedLabel?.length).toBeGreaterThan(0);
    // Spent: a replay cannot re-create the account.
    const phase2Replay = await completeLogin(oauthConfig, "kiro", "auth-code-2", continueState);
    expect(phase2Replay.ok).toBe(false);
    expect(phase2Replay.message).toBe("unknown or expired state");
  });

  test("OIDC phase-2 adopts the upstream email when the slash token is opaque", async () => {
    // Builder-ID / IdC access tokens are opaque — the JWT extraction misses
    // them, so the exchange must ask the usage surface for the account email
    // (same enrichment the social flow does), not fall back to "AWS Builder ID".
    const calls: string[] = [];
    const client = new KiroOAuthClient(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url);
      calls.push(url);
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({
            accessToken: "opaque.builder.token",
            refreshToken: "rt",
            expiresIn: 3600,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/Get-Usage-Limits")) {
        return new Response(
          JSON.stringify({
            subscriptionInfo: { subscriptionTitle: "KIRO FREE" },
            usageBreakdownList: [],
            userInfo: { userId: "u", email: "builder@example.com" },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const result = await client.exchangeCode("auth-code", "v", "http://127.0.0.1:3128/oauth/callback", "st-x", {
      providerState: JSON.stringify({
        clientId: "cid",
        clientSecret: "csec",
        region: "us-east-1",
        startUrl: "https://view.awsapps.com/start",
        authMethod: "builder-id",
        redirectUri: "http://127.0.0.1:3128/oauth/callback",
      }),
    });
    expect(result.accountLabel).toBe("builder@example.com");
    expect(calls.some((url) => url.includes("/Get-Usage-Limits"))).toBe(true);
  });

  test("OIDC phase-2 exchanges the code with the stored registration and PKCE verifier", async () => {
    const registration = {
      clientId: "cid",
      clientSecret: "csec",
      region: "us-east-1",
      startUrl: "https://view.awsapps.com/start",
      authMethod: "builder-id",
      redirectUri: "http://127.0.0.1:3128/oauth/callback",
    };
    let tokenBody: Record<string, unknown> | undefined;
    const client = new KiroOAuthClient(async (input, init) => {
      const url = typeof input === "string" ? input : String((input as Request).url);
      if (url.includes("/token")) {
        tokenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            accessToken: "at",
            refreshToken: "rt",
            expiresIn: 3600,
            profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/A",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const result = await client.exchangeCode(
      "auth-code",
      "phase2-verifier",
      "http://127.0.0.1:3128/oauth/callback",
      "st-oidc-2",
      { providerState: JSON.stringify(registration) },
    );
    expect(tokenBody?.["grantType"]).toBe("authorization_code");
    expect(tokenBody?.["code"]).toBe("auth-code");
    expect(tokenBody?.["codeVerifier"]).toBe("phase2-verifier");
    expect(tokenBody?.["redirectUri"]).toBe("http://127.0.0.1:3128/oauth/callback");
    expect(tokenBody?.["clientId"]).toBe("cid");
    expect(result.access).toBe("at");
    expect(result.client_secret).toBe("csec");
  });
});
