// Console OAuth login operations: token exchange, browser/device flows, and
// credential import. The route handlers in `routes.ts` delegate here.

import type { OAuthDevicePollResult, OAuthDeviceStartResult, OAuthLoginClient } from "../../../providers/authentication/oauth-flow-store";
import { generateOAuthState, generatePkcePair, skipGithubAccountPicker } from "../../../providers/authentication/oauth-flow-store";
import type { OAuthFlowStorage } from "../../../providers/authentication/oauth-flow-store";
import type { OAuthDevicePollResponse } from "../catalog/contracts";
import { providerJwtVerification } from "../../../providers/provider-metadata";
import type { ProviderRegistry } from "../../../providers/provider-registry";
import { browserAuthorizeRedirectUri, isGatewayServedRedirectUri } from "../../../config/providers";
import { resolveDeviceEgress, type DeviceEgressDeps } from "./device-egress";
import { log } from "../../../observability/logger";
import { GatewayError } from "../../../protocol/gateway-error";
import { ConsoleDomainError, requireScope } from "../../shared/errors";
import type { OAuthAccountStore } from "./account-store";
import { escapeHtml, type OAuthCallbackListener } from "./callback-listener";
import { validateIssuedAccessToken } from "../../../providers/authentication/jwt-validator";
import { inlineScriptContentSecurityPolicy } from "../../../security/outbound-headers";
import type { AccessDecision } from "../../../security/access-control";
import type { ConsoleAccessResolver } from "../../auth/access";
import { pickDefined } from "../../shared/object";

export interface OAuthLoginConfig {
  readonly providerRegistry: ProviderRegistry;
  readonly oauthFlowStore: OAuthFlowStorage;
  readonly accountStore: OAuthAccountStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /**
   * Binds the loopback port a browser redirect names, so the callback delivers
   * itself instead of waiting for the operator to paste the URL back.
   */
  readonly callbackListener: OAuthCallbackListener;
  /** Resolves device-flow OAuth egress per the `device_flow_proxy` setting. */
  readonly deviceEgress: DeviceEgressDeps;
}

async function requireClient(
  registry: ProviderRegistry,
  providerId: string,
): Promise<OAuthLoginClient> {
  const client = await registry.resolveLoginClient(providerId);
  if (!client)
    throw new ConsoleDomainError(
      "oauth_not_supported",
      404,
      `Provider ${providerId} has no OAuth login client registered`,
      { providerId },
    );
  return client;
}

/** The result of exchanging one authorization code, as the caller should report it. */
interface OAuthCompleteOutcome {
  readonly ok: boolean;
  readonly message: string;
  /**
   * When set, the exchange is not finished: the browser must be redirected to
   * this URL to continue (Kiro's OIDC families need a second authorization
   * leg after the portal callback).
   */
  readonly redirectUrl?: string;
  /**
   * New callback state the phase-2 authorize URL carries (Kiro mints a fresh
   * state for the IdC leg; the console retains the pending flow under it).
   */
  readonly continueState?: string;
}

/**
 * Consumes the pending flow, exchanges the code, and persists the account.
 *
 * Shared by the hosted console callback and the loopback listener so both
 * report the same failures: the listener renders `message` in the browser, and
 * the hosted route turns it into a JSON or HTML page. Upstream token-endpoint
 * bodies can echo credentials, so the message stays generic unless the error
 * came from our own boundary (see {@link publicExchangeFailure}).
 */
export async function completeLogin(
  config: OAuthLoginConfig,
  providerId: string,
  code: string,
  state: string,
  callbackParams?: Readonly<Record<string, string>>,
): Promise<OAuthCompleteOutcome> {
  // An empty `state` means the authorization server does not echo one
  // (OpenRouter omits it from the callback entirely); correlate by provider in
  // that case, and by state otherwise so the stronger check stays in force
  // wherever the server supports it.
  //
  // The flow is peeked, not consumed, until the exchange succeeds: consuming
  // first means a failed exchange (a transient upstream blip, a paste that
  // missed a parameter) burns the state and every retry answers "unknown or
  // expired state". The state is deleted only after the account persists.
  const flow = state
    ? await config.oauthFlowStore.peekPending(state)
    : await config.oauthFlowStore.consumePendingByProvider(providerId);
  if (!flow || flow.providerId !== providerId) {
    return { ok: false, message: "unknown or expired state" };
  }
  // Release the listener registration for this flow. The pending state itself
  // stays available so a manual re-paste can retry the exchange. The release is
  // deferred until after the exchange for two-phase flows: Kiro's OIDC portal
  // callback (phase 1) must keep the loopback listener alive so the second
  // authorization leg can land on it.
  const client = await requireClient(config.providerRegistry, providerId);
  if (!client.exchangeCode) {
    return { ok: false, message: "provider does not support browser authorization" };
  }
  const releaseListener = () => {
    if (state.length > 0) config.callbackListener.release(flow.redirectUri, state);
    else config.callbackListener.releaseProvider(flow.redirectUri, providerId);
  };
  try {
    const result = await client.exchangeCode(code, flow.codeVerifier, flow.redirectUri, state, {
      ...pickDefined({ parameters: callbackParams }),
      ...pickDefined({ providerState: flow.providerState }),
    });
    const tokenCheck = await validateIssuedAccessToken(
      result.access,
      providerJwtVerification(providerId),
    );
    if (!tokenCheck.valid) {
      throw new ConsoleDomainError(
        "oauth_token_invalid",
        400,
        `Provider ${providerId} returned an access token that failed validation (${tokenCheck.reason})`,
        { providerId },
      );
    }
    await config.accountStore.persistAccount(flow.tenantId, providerId, {
      label: result.accountLabel ?? (flow.accountLabel.trim().toLowerCase() === providerId.trim().toLowerCase() ? "" : flow.accountLabel),
      ...result,
    });
    // The exchange succeeded and the account is persisted; now the flow is
    // spent. Consuming it here (peeked above) frees the state and the provider
    // pointer so a replayed callback cannot re-create the account.
    releaseListener();
    if (state.length > 0) await config.oauthFlowStore.consumePending(state);
    else await config.oauthFlowStore.consumePendingByProvider(providerId);
    await config.snapshotInvalidator?.invalidate();
    return { ok: true, message: `${providerId} account connected. You may close this tab.` };
  } catch (error) {
    // Kiro's OIDC families: the portal callback carries no code — only
    // `login_option` + issuer/region. The client responded with the second-leg
    // authorize URL plus a fresh PKCE verifier and the OIDC registration.
    // Rewrite the pending flow so phase 2 exchanges against that verifier, keep
    // the listener alive, and tell the caller to redirect the browser there.
    // dynamic-import: B-02 lazy graph — 58KB kiro OIDC path, only for Kiro flows.
    // The kiro-oauth graph is 58KB, so it is imported lazily here — only the
    // Kiro OIDC path needs the error class — instead of on the console boot
    // graph (B-02).
    const { KiroOidcPendingError } = await import(
      "../../../providers/integrations/kiro/kiro-oauth"
    );
    if (error instanceof KiroOidcPendingError) {
      // Phase 1 of Kiro's OIDC portal login: the portal callback carried no
      // code — only `login_option` + issuer/region. The client answered with the
      // phase-2 authorize URL, a fresh PKCE verifier, and the OIDC client
      // registration. Mirror the 1.4.62 IDE: the second leg uses a *new* state
      // (not the portal's), so mint it here, keep the pending flow reachable
      // under both states, and tell the caller which state to expect back.
      const continueState = error.continueState;
      if (state.length > 0 && continueState.length > 0) {
        await config.oauthFlowStore.savePending(continueState, {
          ...flow,
          codeVerifier: error.codeVerifier,
          providerState: error.providerState,
        });
        config.callbackListener.track(flow.redirectUri, state, continueState);
      }
      return {
        ok: false,
        message: error.message,
        redirectUrl: error.authorizeUrl,
        continueState,
      };
    }
    releaseListener();
    // Upstream token-endpoint bodies can echo credentials or sensitive
    // diagnostics — the browser gets a generic failure; the bounded detail
    // stays server-side in the console log.
    log.error(
      `[oauth] token exchange failed for ${providerId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error : undefined,
    );
    return { ok: false, message: publicExchangeFailure(error) };
  }
}

function successPage(providerId: string, wantsJson: boolean): Response {
  if (wantsJson) {
    return Response.json({
      providerId,
      message: `${providerId} account connected. You may close this tab.`,
    });
  }
  const closeScript = "window.close();";
  return new Response(
    `<!doctype html><html><body><p>${providerId} account connected. You may close this tab.</p><script>${closeScript}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": inlineScriptContentSecurityPolicy([closeScript]),
      },
    },
  );
}

/**
 * Message shown in the browser when a token exchange throws.
 *
 * `GatewayError.origin` marks which boundary produced the error, and its own
 * contract calls a non-upstream error "a safe public error". So a
 * `cartethyia`-origin message — authored by one of our integrations, already
 * sanitized — is shown as-is: without it, an actionable failure such as "MiMo
 * Desktop is running and holds its cookie store locked" reaches the operator
 * only through the server log, and the dialog says nothing they can act on.
 * Anything else (an upstream body, a network failure, an arbitrary throw) keeps
 * the generic wording, because an upstream response can echo credentials.
 */
function publicExchangeFailure(error: unknown): string {
  if (error instanceof GatewayError && error.origin === "cartethyia") return error.message;
  return "token exchange failed — check the console log for details";
}

export function failurePage(message: string, wantsJson: boolean): Response {
  if (wantsJson) {
    return Response.json(
      { error: message, code: "oauth_callback_failed" },
      { status: 400 },
    );
  }
  const escapedMessage = escapeHtml(message);
  return new Response(
    `<!doctype html><html><body><p>OAuth login failed: ${escapedMessage}</p></body></html>`,
    {
      status: 400,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": inlineScriptContentSecurityPolicy([]),
      },
    },
  );
}

export function createOAuthLoginOperations(config: OAuthLoginConfig) {
  const operations = {
    async beginAuthorize(
        access: AccessDecision | undefined,
        providerId: string,
        accountLabel: string,
        parameters?: Readonly<Record<string, string>>,
      ): Promise<{ authorizeUrl: string; state: string }> {
        const a = requireScope(access, "dashboard:write");
        const client = await requireClient(config.providerRegistry, providerId);
        if (typeof client.buildAuthorizeUrl !== "function") {
          throw new ConsoleDomainError(
            "browser_code_not_supported",
            409,
            `Provider ${providerId} only supports device-code login — use "Login with device code" instead`,
            { providerId },
          );
        }
        if (typeof client.exchangeCode !== "function") {
          throw new ConsoleDomainError(
            "browser_code_not_supported",
            409,
            `Provider ${providerId} only supports device-code login — use "Login with device code" instead`,
            { providerId },
          );
        }
        const state = client.generateState?.() ?? generateOAuthState();
        const { codeVerifier, codeChallenge } = generatePkcePair();
        /**
         * A client whose authorize URL depends on an upstream discovery runs it
         * here, before the URL is built: `buildAuthorizeUrl` is synchronous by
         * contract, so a client cannot fetch inside it.
         *
         * Trae is the reason this is wired up: its login host comes from
         * `GetLoginGuidance`, and without this step the URL was built with no
         * host and the login failed at the first click. Kiro declares the hook
         * as a no-op, so nothing that already worked changes.
         */
        const authorizeRequest = {
          state,
          codeChallenge,
          redirectUri: client.browserRedirectUri ?? browserAuthorizeRedirectUri(),
          ...pickDefined({ parameters }),
        };
        const prepared =
          typeof client.prepareAuthorize === "function"
            ? await client.prepareAuthorize(authorizeRequest)
            : authorizeRequest;
        // A client that names its own allowlisted redirect URI wins over the
        // gateway default: OpenAI registers exactly `http://localhost:1455/auth/callback`
        // for the Codex client and answers any other value with
        // `invalid_request` before consent, so the shared default cannot serve
        // every provider.
        const redirectUri = authorizeRequest.redirectUri;
        // Bind the redirect's loopback port before the flow is recorded. The
        // advertised URI names the operator's own machine, so a login that only
        // advertises it leaves the browser on a dead page and the code stranded
        // in the address bar. Binding first also means a port conflict throws
        // here — with no pending flow saved — rather than leaving a flow whose
        // callback can never arrive. A non-loopback redirect (a custom scheme, a
        // remote host) returns false and keeps the manual paste path.
        //
        // A redirect that names this gateway's own listener needs no listener:
        // the root `/callback` family is already served there, and binding the
        // port the gateway holds would fail every login with a conflict.
        if (!isGatewayServedRedirectUri(redirectUri)) {
          config.callbackListener.register(redirectUri, providerId, state);
        }
        await config.oauthFlowStore.savePending(state, {
          providerId,
          codeVerifier,
          accountLabel,
          tenantId: a.tenantId,
          redirectUri,
          ...pickDefined({ parameters }),
        });
        return {
          authorizeUrl: client.buildAuthorizeUrl(prepared),
          state,
        };
      },
    async handleCallback(
        providerId: string,
        code: string,
        state: string,
        wantsJson = false,
        callbackParams?: Readonly<Record<string, string>>,
      ): Promise<Response> {
        const outcome = await completeLogin(config, providerId, code, state, callbackParams);
        if (outcome.redirectUrl !== undefined) {
          return new Response(null, {
            status: 302,
            headers: { location: outcome.redirectUrl },
          });
        }
        return outcome.ok ? successPage(providerId, wantsJson) : failurePage(outcome.message, wantsJson);
      },
    async handleCallbackError(
        providerId: string,
        state: string,
        wantsJson = false,
      ): Promise<Response> {
        const flow = await config.oauthFlowStore.consumePending(state);
        if (!flow || flow.providerId !== providerId)
          return failurePage("unknown or expired state", wantsJson);
        // A denial settles the flow too: free its port instead of holding it
        // until TTL.
        config.callbackListener.release(flow.redirectUri, state);
        return failurePage("authorization was denied by the provider", wantsJson);
      },
    async startDevice(
        access: AccessDecision | undefined,
        providerId: string,
        accountLabel: string,
        parameters?: Readonly<Record<string, string>>,
      ): Promise<{
        verificationUri: string;
        userCode: string;
        deviceAuthId: string;
        intervalSeconds: number;
        expiresInSeconds: number;
      }> {
        const a = requireScope(access, "dashboard:write");
        const client = await requireClient(config.providerRegistry, providerId);
        if (!client.supportsDeviceCode || !client.startDeviceAuth)
          throw new ConsoleDomainError(
            "device_code_not_supported",
            409,
            `Provider ${providerId} does not support device-code login`,
            { providerId },
          );
        const egress = await resolveDeviceEgress(
          config.deviceEgress,
          providerId,
          a.tenantId,
        );
        let started: OAuthDeviceStartResult;
        try {
          started = await client.startDeviceAuth({
            providerId,
            tenantId: a.tenantId,
            accountLabel,
            fetchFn: egress.fetch,
            ...pickDefined({ parameters }),
          });
        } finally {
          // The flow has been started; the pool slot is only needed for the
          // start request. Polls re-resolve their own egress.
          egress.release();
        }
        const { providerState, ...publicStarted } = started;
        await config.oauthFlowStore.saveDevice(started.deviceAuthId, {
          providerId,
          accountLabel,
          tenantId: a.tenantId,
          ...pickDefined({ providerState }),
          ...pickDefined({ parameters }),
        });
        return { ...publicStarted, verificationUri: skipGithubAccountPicker(publicStarted.verificationUri) };
      },
    async pollDevice(
        access: AccessDecision | undefined,
        providerId: string,
        deviceAuthId: string,
      ): Promise<OAuthDevicePollResponse> {
        const a = requireScope(access, "dashboard:write");
        const correlation = await config.oauthFlowStore.getDevice(deviceAuthId);
        if (
          !correlation ||
          correlation.providerId !== providerId ||
          correlation.tenantId !== a.tenantId
        )
          throw new ConsoleDomainError("device_flow_unknown", 404, "Unknown or expired device-code flow", {
            deviceAuthId,
          });
        const client = await requireClient(config.providerRegistry, providerId);
        if (!client.pollDeviceAuth)
          throw new ConsoleDomainError(
            "device_code_not_supported",
            409,
            "Provider does not support device-code login",
          );
        const egress = await resolveDeviceEgress(
          config.deviceEgress,
          providerId,
          a.tenantId,
        );
        let polled: OAuthDevicePollResult;
        try {
          polled = await client.pollDeviceAuth(deviceAuthId, {
            providerId,
            tenantId: a.tenantId,
            accountLabel: correlation.accountLabel,
            fetchFn: egress.fetch,
            ...(correlation.providerState === undefined
              ? {}
              : { providerState: correlation.providerState }),
            ...pickDefined({ parameters: correlation.parameters }),
          });
        } finally {
          // The pool slot is only needed for the poll request itself, and a
          // thrown poll must release it exactly like `startDevice` does — a
          // leak here would permanently inflate the pool's inflight count.
          egress.release();
        }
        if (polled.status === "pending")
          return {
            status: "pending",
            ...(polled.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: polled.retryAfterSeconds }),
          };
        if (polled.status === "slow_down") {
          return {
            status: "slow_down",
            ...(polled.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: polled.retryAfterSeconds }),
          };
        }
        if (polled.status === "failed") {
          await config.oauthFlowStore.deleteDevice(deviceAuthId);
          return { status: "failed", reason: polled.reason };
        }
        const tokenCheck = await validateIssuedAccessToken(
          polled.result.access,
          providerJwtVerification(providerId),
        );
        if (!tokenCheck.valid) {
          await config.oauthFlowStore.deleteDevice(deviceAuthId);
          throw new ConsoleDomainError(
            "oauth_token_invalid",
            400,
            `Provider ${providerId} returned an access token that failed validation (${tokenCheck.reason})`,
            { providerId },
          );
        }
        // Delete only after persistAccount succeeds: a failure here (DB error)
        // must leave the device-flow state intact so the poller can retry
        // persisting the already-exchanged token instead of losing it and
        // forcing the operator through device authorization again.
        const persisted = await config.accountStore.persistAccount(
          correlation.tenantId,
          providerId,
          {
            label:
              polled.result.accountLabel ??
              (correlation.accountLabel.trim().toLowerCase() === providerId.trim().toLowerCase()
                ? ""
                : correlation.accountLabel),
            ...polled.result,
          },
        );
        await config.oauthFlowStore.deleteDevice(deviceAuthId);
        await config.snapshotInvalidator?.invalidate();
        return { status: "complete", accountId: persisted.accountId };
      },
    async importCredential(
        access: AccessDecision | undefined,
        providerId: string,
        accountLabel: string,
        credential: string,
        fields: Readonly<Record<string, string>>,
      ): Promise<{ accountId: string }> {
        const a = requireScope(access, "dashboard:write");
        const client = await requireClient(config.providerRegistry, providerId);
        if (typeof client.importCredential !== "function") {
          throw new ConsoleDomainError(
            "import_not_supported",
            409,
            `Provider ${providerId} does not accept an imported credential`,
            { providerId },
          );
        }
        // The client validates the material against the upstream before this
        // returns, so nothing that never worked reaches the account table.
        const result = await client.importCredential({ credential, fields });
        const tokenCheck = await validateIssuedAccessToken(
          result.access,
          providerJwtVerification(providerId),
        );
        if (!tokenCheck.valid) {
          throw new ConsoleDomainError(
            "oauth_token_invalid",
            400,
            `Provider ${providerId} returned an access token that failed validation (${tokenCheck.reason})`,
            { providerId },
          );
        }
        const persisted = await config.accountStore.persistAccount(a.tenantId, providerId, {
          label: result.accountLabel ?? (accountLabel.trim().toLowerCase() === providerId.trim().toLowerCase() ? "" : accountLabel),
          ...result,
        });
        await config.snapshotInvalidator?.invalidate();
        return { accountId: persisted.accountId };
      },
  };
  return operations;
}
