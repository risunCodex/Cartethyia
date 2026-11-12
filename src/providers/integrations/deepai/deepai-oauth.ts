// DeepAI browser login client.
//
// DeepAI's desktop sign-in is a loopback flow: the app builds
// `https://api.deepai.org/deepai_code/desktop_auth/?state=<state>&port=<port>`,
// the operator signs in in the browser, and the server redirects to
// `http://127.0.0.1:<port>/callback?code=<code>&state=<state>`. The code is
// then exchanged at `/deepai_code/desktop_auth/exchange/` for an opaque
// `api_key`. There is no PKCE verifier and no refresh token — the key is
// long-lived and the flow is re-run when needed.
//
// Verified live 2026-11-11: the exchange answers 200 with
// `{ api_key, username, is_pro }`, and the api_key authenticates the model
// API via the `Api-Key` header (a Bearer or `x-api-key` spelling is rejected
// with 401).
import { OAuthClient } from "../../authentication/oauth-client";
import type {
  OAuthAuthorizeRequest,
  OAuthCodeExchangeContext,
  OAuthExchangeResult,
  OAuthImportInput,
} from "../../authentication/oauth-flow-store";
import {
  DEEPAI_API_ORIGIN,
  DEEPAI_EXCHANGE_PATH,
  DEEPAI_THEOS_PATH,
  deepAIBaseHeaders,
} from "./deepai-common";

const DEEPAI_LOGIN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function loopbackPortFromRedirectUri(redirectUri: string): number {
  try {
    const url = new URL(redirectUri);
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
  } catch {
    // fall through to the default below
  }
  // A deployment may pass its public-origin callback through the shared
  // default; DeepAI's hosted sign-in still requires a loopback port. Keep
  // the well-known default so the authorize URL can be built — the operator
  // pastes the resulting redirect URL back (loopback ports are not reachable
  // from a remote browser).
  return 59_653;
}

export class DeepAIOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;
  override readonly providerLabel = "deepai";
  override readonly clientId = "";
  override readonly tokenUrl = "";
  override readonly scopes = "";

  /** DeepAI's hosted sign-in URL, carrying the loopback port + state. */
  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const port = loopbackPortFromRedirectUri(request.redirectUri);
    const signIn = new URL(DEEPAI_EXCHANGE_PATH.replace("/desktop_auth/exchange/", "/desktop_auth/"), DEEPAI_API_ORIGIN);
    signIn.search = "";
    signIn.searchParams.set("state", request.state);
    signIn.searchParams.set("port", String(port));
    return signIn.toString();
  }

  /** Exchanges the callback code for the DeepAI api_key. */
  override async exchangeCode(
    code: string,
    _codeVerifier: string,
    _redirectUri: string,
    _state?: string,
    _context?: OAuthCodeExchangeContext,
  ): Promise<OAuthExchangeResult> {
    const response = await this.fetchFn(new URL(DEEPAI_EXCHANGE_PATH, DEEPAI_API_ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`deepai sign-in exchange failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    return this.parseExchangeBody(await response.json());
  }

  /** Accepts a pasted DeepAI api_key, validated against `/theos`. */
  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const apiKey = input.credential.trim();
    if (!apiKey) throw new Error("deepai: pasted API key is empty");
    const headers = await deepAIBaseHeaders(apiKey);
    const response = await this.fetchFn(new URL(DEEPAI_THEOS_PATH, DEEPAI_API_ORIGIN), {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      throw new Error(
        `deepai: API key validation failed (HTTP ${response.status}) — paste a key minted by the DeepAI sign-in flow`,
      );
    }
    return {
      access: apiKey,
      refresh: apiKey,
      expiresAt: new Date(Date.now() + DEEPAI_LOGIN_TTL_MS),
      accountLabel: input.accountLabel || "deepai",
      auth_state: { via: "import" },
    };
  }

  private parseExchangeBody(body: unknown): OAuthExchangeResult {
    const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const apiKey = typeof record?.api_key === "string" ? record.api_key.trim() : "";
    if (!apiKey || /[\r\n]/.test(apiKey)) {
      throw new Error("deepai: sign-in response did not carry a valid api_key");
    }
    const username = typeof record?.username === "string" ? record.username : "";
    return {
      access: apiKey,
      refresh: apiKey,
      expiresAt: new Date(Date.now() + DEEPAI_LOGIN_TTL_MS),
      ...(username ? { accountLabel: username, accountName: username } : {}),
      auth_state: { is_pro: record?.is_pro === true },
    };
  }
}

/** Shared DeepAI browser-login client instance (registry-facing). */
export const deepAIOAuthClient = new DeepAIOAuthClient();
