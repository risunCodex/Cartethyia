/**
 * The root OAuth callback routes deliver a browser redirect to the gateway's
 * own listener.
 *
 * Providers whose redirect port the gateway owns (DeepAI, Trae) advertise
 * `http://127.0.0.1:<gateway port>/<path>` and bind nothing: the root routes
 * are the delivery target. These tests pin the delivery contract — the state
 * names the provider, the exchange gets the code and every extra query param,
 * a denial consumes the flow, and a Trae-shaped callback (no `code`, the
 * payload riding in the query) is handed to the client whole.
 */
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  InMemoryOAuthFlowStore,
  type OAuthLoginClient,
  type OAuthExchangeResult,
} from "../../src/providers/authentication/oauth-flow-store";
import { createOAuthRootCallbackRoutes } from "../../src/console/providers/oauth/root-callback";
import type { OAuthLoginConfig } from "../../src/console/providers/oauth/operations";
import type { OAuthCallbackListener } from "../../src/console/providers/oauth/callback-listener";
import type { ProviderRegistry } from "../../src/providers/provider-registry";
import type { OAuthAccountStore } from "../../src/console/providers/oauth/account-store";

interface Harness {
  /** Structural: the tests only ever `handle` requests against the app. */
  readonly app: { handle(request: Request): Promise<Response> };
  readonly flowStore: InMemoryOAuthFlowStore;
  /** The exchanges the stub client performed, one entry per callback. */
  readonly exchanges: { code: string; state: string; redirectUri: string }[];
  readonly port: number;
}

/** The config's listener type is a concrete class; the routes never call it. */
function stubListener(): OAuthCallbackListener {
  return {
    register: () => true,
    release: () => {},
    releaseProvider: () => {},
    track: () => {},
    stop: () => {},
  } as unknown as OAuthCallbackListener;
}

function createHarness(port = 12_800): Harness {
  const exchanges: { code: string; state: string; redirectUri: string }[] = [];
  const client: OAuthLoginClient = {
    supportsDeviceCode: false,
    supportsBrowserCode: true,
    exchangeCode: async (code, _verifier, redirectUri, state) => {
      exchanges.push({ code, state: state ?? "", redirectUri });
      const result: OAuthExchangeResult = {
        access: "at-1",
        refresh: "rt-1",
        expiresAt: new Date(Date.now() + 60_000),
      };
      return result;
    },
  };
  const flowStore = new InMemoryOAuthFlowStore();
  const config: OAuthLoginConfig = {
    providerRegistry: {
      resolveLoginClient: async () => client,
    } as unknown as ProviderRegistry,
    oauthFlowStore: flowStore,
    accountStore: {
      persistAccount: async () => ({ accountId: "acc-1" }),
    } as unknown as OAuthAccountStore,
    accessResolver: () => undefined,
    callbackListener: stubListener(),
    deviceEgress: {} as OAuthLoginConfig["deviceEgress"],
  };
  const app = new Elysia().use(createOAuthRootCallbackRoutes(config));
  return { app, flowStore, exchanges, port };
}

async function savePending(
  harness: Harness,
  state: string,
  redirectUri = `http://127.0.0.1:${harness.port}/callback`,
): Promise<void> {
  await harness.flowStore.savePending(state, {
    providerId: "deepai",
    codeVerifier: "verifier-1",
    accountLabel: "deepai",
    tenantId: "tenant-1",
    redirectUri,
  });
}

describe("oauth root callback routes", () => {
  test("a browser redirect on /callback completes the exchange", async () => {
    const harness = createHarness();
    await savePending(harness, "state-1");
    const response = await harness.app.handle(
      new Request("http://localhost/callback?code=code-1&state=state-1"),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("deepai account connected");
    expect(harness.exchanges).toEqual([
      { code: "code-1", state: "state-1", redirectUri: `http://127.0.0.1:${harness.port}/callback` },
    ]);
    // Success spends the flow: a replayed callback finds nothing.
    expect(await harness.flowStore.peekPending("state-1")).toBeUndefined();
  });

  test("a denial consumes the flow and says so", async () => {
    const harness = createHarness();
    await savePending(harness, "state-2");
    const response = await harness.app.handle(
      new Request("http://localhost/auth-callback?error=access_denied&state=state-2"),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("denied");
    expect(harness.exchanges).toEqual([]);
    expect(await harness.flowStore.peekPending("state-2")).toBeUndefined();
  });

  test("a callback with no code hands the query to the client whole", async () => {
    // Trae's login page redirects with the refresh token in the query and no
    // `code` — the payload itself is the redeemable material.
    const harness = createHarness();
    await savePending(harness, "state-3", `http://127.0.0.1:${harness.port}/authorize`);
    const response = await harness.app.handle(
      new Request(
        "http://localhost/authorize?refreshToken=rt-9&isRedirect=true&state=state-3",
      ),
    );
    expect(response.status).toBe(200);
    expect(harness.exchanges).toHaveLength(1);
    expect(harness.exchanges[0]!.code).toContain("refreshToken=rt-9");
    expect(harness.exchanges[0]!.code).toContain("state=state-3");
  });

  test("an unknown or missing state is refused without an exchange", async () => {
    const harness = createHarness();
    const unknown = await harness.app.handle(
      new Request("http://localhost/callback?code=code-2&state=absent"),
    );
    expect(unknown.status).toBe(400);
    const stateless = await harness.app.handle(
      new Request("http://localhost/callback?code=code-2"),
    );
    expect(stateless.status).toBe(400);
    expect(harness.exchanges).toEqual([]);
  });

  test("a failed exchange keeps the flow so a paste can retry", async () => {
    const exchanges: { code: string }[] = [];
    const client: OAuthLoginClient = {
      supportsDeviceCode: false,
      supportsBrowserCode: true,
      exchangeCode: async (code) => {
        exchanges.push({ code });
        throw new Error("upstream down");
      },
    };
    const flowStore = new InMemoryOAuthFlowStore();
    const config: OAuthLoginConfig = {
      providerRegistry: {
        resolveLoginClient: async () => client,
      } as unknown as ProviderRegistry,
      oauthFlowStore: flowStore,
      accountStore: {
        persistAccount: async () => ({ accountId: "acc-1" }),
      } as unknown as OAuthAccountStore,
      accessResolver: () => undefined,
      callbackListener: stubListener(),
      deviceEgress: {} as OAuthLoginConfig["deviceEgress"],
    };
    const app = new Elysia().use(createOAuthRootCallbackRoutes(config));
    await flowStore.savePending("state-4", {
      providerId: "deepai",
      codeVerifier: "verifier-1",
      accountLabel: "deepai",
      tenantId: "tenant-1",
      redirectUri: "http://127.0.0.1:12800/callback",
    });
    const response = await app.handle(
      new Request("http://localhost/callback?code=code-3&state=state-4"),
    );
    // The generic wording is deliberate: upstream bodies can echo credentials.
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("token exchange failed");
    // Peeking, not consuming: the operator can re-paste the same state.
    expect(await flowStore.peekPending("state-4")).toBeDefined();
  });
});
