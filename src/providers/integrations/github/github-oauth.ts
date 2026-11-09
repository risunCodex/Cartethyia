/**
 * GitHub Copilot device-code OAuth client.
 *
 * Two tokens, and the difference matters: GitHub issues an **access token**
 * through the device flow, and that token is then exchanged for a short-lived
 * **Copilot token** at `/copilot_internal/v2/token`. Only the Copilot token is
 * accepted by the inference API, and it carries the `proxy-ep` claim that names
 * the per-account API host — an Individual account and an enterprise account
 * are served from different hosts, so the base URL is derived from the token
 * rather than fixed.
 *
 * The GitHub token is stored as the refresh value because it is what re-mints
 * the Copilot token; the Copilot token expires on the order of half an hour and
 * would otherwise force a fresh device authorization every time.
 */
import {
  devicePollBackoff,
  nonEmptyTrimmedString,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthRefreshContext,
  OAuthTokenRefresher,
  OAuthTokenRefreshResult,
} from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../authentication/oauth-client";
import { resolveGithubCopilotMode, resolveGithubEnterpriseDomain } from "../../../config/providers";
import { randomUUID, createHash } from "node:crypto";
import { getOrCreateInstallId } from "../shared/install-id";


/** Public GitHub OAuth app id the Copilot clients use; not a secret. */
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98" as const;
/** The OpenCode desktop client's own GitHub OAuth app id (used by its Copilot integration). */
export const GITHUB_OPENCODE_CLIENT_ID = "Ov23li8tweQw6odWQebz" as const;
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token" as const;
/** Default API host when a token carries no `proxy-ep` claim. */
export const GITHUB_DEFAULT_API_HOST = "api.individual.githubcopilot.com" as const;
/**
 * The Copilot API host OpenCode's integration uses. The reference plugin always
 * dials `api.githubcopilot.com` for GitHub.com (never the per-claim
 * `api.individual.*` host the VS Code minted tokens carry), so an OpenCode
 * login pins this host rather than falling back to the VS Code default.
 */
export const GITHUB_OPENCODE_API_HOST = "api.githubcopilot.com" as const;
/**
 * How long an OpenCode login's credential is treated as valid before the
 * refresh sweep revisits it. The raw GitHub OAuth token has no Copilot token
 * expiry (there is no minted token), so this is a far-future safeguard, not a
 * real lifetime: a re-login or upstream expiry is what actually rotates it.
 */
const GITHUB_OPENCODE_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export type GithubCopilotCredentialProfile = "opencode-copilot" | "vscode-client-real";

export function githubCopilotProfileForClientId(clientId: string): GithubCopilotCredentialProfile {
  return clientId === GITHUB_OPENCODE_CLIENT_ID ? "opencode-copilot" : "vscode-client-real";
}

export function githubCopilotClientIdForProfile(profile: GithubCopilotCredentialProfile): string {
  return profile === "opencode-copilot" ? GITHUB_OPENCODE_CLIENT_ID : GITHUB_CLIENT_ID;
}

export function githubCopilotApiHostForProfile(
  profile: GithubCopilotCredentialProfile,
  domain: string,
): string {
  if (profile === "opencode-copilot") {
    return domain === "github.com" ? GITHUB_OPENCODE_API_HOST : `copilot-api.${domain}`;
  }
  return GITHUB_DEFAULT_API_HOST;
}

/**
 * Headers every Copilot inference and policy request must carry.
 *
 * The API rejects a request that does not identify a Copilot client, so these
 * are a protocol requirement rather than cosmetic fingerprinting — unlike the
 * Codex/Claude CLI identities elsewhere in this repository, which exist to look
 * like a first-party client. The version pair is the Copilot Chat extension's
 * (0.72.0 on VS Code 1.144), which is what the upstream expects for this
 * client id.
 */
export const GITHUB_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "user-agent": "GitHubCopilotChat/0.72.0",
  "editor-version": "vscode/1.144.0",
  "editor-plugin-version": "copilot-chat/0.72.0",
  "copilot-integration-id": "vscode-chat",
  "x-github-api-version": "2026-08-01",
});

/**
 * Stable per-process Copilot session id.
 *
 * The reference extension (`_mixinHeaders`) stamps `VScode-SessionId` with the
 * VS Code window session and `VScode-MachineId` with the machine id. There is
 * no VS Code window here, so the closest 1:1 shapes are: a session id minted
 * once per gateway process (a new window = a new process in the reference), and
 * a stable per-installation identity for the machine id.
 */
export const GITHUB_COPILOT_SESSION_ID = randomUUID();

/**
 * Resolves the Copilot client identity headers shared by chat/auto/discovery.
 *
 * The machine id is derived deterministically from the persisted install id and
 * an account fingerprint when one is provided. The reference extension uses one
 * machine id per VS Code installation for every account, but this gateway pools
 * many accounts on one host — sharing one id across all of them makes every
 * account look like a single device (an easy clustering/abuse signal). A
 * per-account machine id keeps each account looking like its own device while
 * staying stable across restarts for the same account. Without an account key
 * (e.g. credential could not be parsed) the raw install id is used.
 */
export async function githubCopilotClientIds(
  accountKey?: string,
): Promise<{
  readonly sessionId: string;
  readonly machineId: string;
}> {
  const installId = await getOrCreateInstallId("github");
  const machineId =
    accountKey === undefined || accountKey.length === 0
      ? installId
      : deterministicMachineId(installId, accountKey);
  return {
    sessionId: GITHUB_COPILOT_SESSION_ID,
    machineId,
  };
}

/** Stable UUID-shaped machine id derived from the install id and an account key. */
export function deterministicMachineId(installId: string, accountKey: string): string {
  const digest = createHash("sha256").update(`${installId}:${accountKey}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

const DEVICE_INTERVAL_SECONDS = 5;
const DEVICE_EXPIRY_SECONDS = 900;
/** Copilot tokens are short-lived; a missing `expires_at` falls back to 25 minutes. */
const COPILOT_TOKEN_FALLBACK_MS = 25 * 60 * 1000;

/** The GitHub host that serves the device flow. */
export function copilotGitHubDomain(): string {
  return resolveGithubEnterpriseDomain() || "github.com";
}

/** Persisted credential shape: token, upstream host, and OAuth app origin. */
export function encodeGithubCredential(
  access: string,
  apiHost: string,
  githubToken: string | undefined,
  profile: GithubCopilotCredentialProfile,
): string {
  return JSON.stringify({
    access,
    apiHost,
    profile,
    // The GitHub token is carried beside the minted token for quota reads.
    ...(githubToken === undefined || githubToken.length === 0 ? {} : { github: githubToken }),
  });
}

export interface GithubCredential {
  readonly access: string;
  readonly apiHost: string;
  readonly profile: GithubCopilotCredentialProfile;
  /** The long-lived GitHub token, when the envelope carries it. */
  readonly github?: string;
}

export interface ImportedGithubCredential {
  readonly credential: string;
  readonly profile: GithubCopilotCredentialProfile;
  readonly refreshToken?: string;
  /** True when a raw GitHub token should be minted on first use in VS Code mode. */
  readonly expiresAt: Date;
  readonly requiresRefresh: boolean;
  /** Non-fatal facts an importer must surface: the credential is usable, but its origin is not fully verified. */
  readonly warnings: readonly string[];
}

/**
 * Binds an exported/imported GitHub credential to the currently selected wire
 * profile. This is a local normalization only; it never contacts GitHub.
 */
export function bindImportedGithubCredential(
  value: string,
  refreshValue: string | null | undefined,
  profile: GithubCopilotCredentialProfile,
  domain: string,
  expiresAt?: Date,
): ImportedGithubCredential {
  const parsed = (() => {
    try {
      return parseGithubCredential(value);
    } catch {
      return undefined;
    }
  })();
  const access = parsed?.access ?? nonEmptyTrimmedString(value);
  if (access === undefined) throw new Error("GitHub Copilot import credential is empty");
  const refresh = nonEmptyTrimmedString(refreshValue);
  const rawToken = parsed?.github ?? refresh;
  const isMinted =
    access.includes("proxy-ep=") ||
    (parsed !== undefined && rawToken !== undefined && access !== rawToken);
  const githubToken = rawToken ?? (isMinted ? undefined : access);
  if (profile === "opencode-copilot") {
    if (isMinted && githubToken === undefined) {
      throw new Error("a VS Code Copilot export needs its raw GitHub refresh token to import as opencode-copilot");
    }
    const token = githubToken ?? access;
    return {
      credential: encodeGithubCredential(
        token,
        githubCopilotApiHostForProfile(profile, domain),
        token,
        profile,
      ),
      profile,
      refreshToken: token,
      expiresAt: new Date(Date.now() + GITHUB_OPENCODE_TOKEN_LIFETIME_MS),
      requiresRefresh: false,
      warnings: [],
    };
  }
  if (isMinted) {
    const apiHost = parsed?.apiHost ?? apiHostFromGithubToken(access);
    return {
      credential: encodeGithubCredential(access, apiHost, githubToken, profile),
      profile,
      ...(githubToken === undefined ? {} : { refreshToken: githubToken }),
      expiresAt: expiresAt ?? new Date(Date.now() + COPILOT_TOKEN_FALLBACK_MS),
      requiresRefresh: false,
      warnings: githubToken === undefined
        ? ["the minted Copilot token has no raw GitHub refresh token; it will expire without a way to mint a replacement"]
        : [],
    };
  }
  const token = githubToken ?? access;
  return {
    credential: encodeGithubCredential(token, GITHUB_DEFAULT_API_HOST, token, profile),
    profile,
    refreshToken: token,
    expiresAt: new Date(0),
    requiresRefresh: true,
    warnings: [
      "the imported token has no Copilot mint metadata; its GitHub OAuth app origin could not be verified",
    ],
  };
}

/**
 * Parses a stored Copilot credential.
 *
 * Fails closed: only this module writes the secret, so a value that is not the
 * JSON envelope means the row was corrupted or written by another tool, and
 * dispatching with a guessed token and host would send an unusable request.
 */
export function parseGithubCredential(value: string): GithubCredential {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("GitHub Copilot credential is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("GitHub Copilot credential is not a JSON envelope");
  }
  const root = record(parsed);
  const access = root === undefined ? undefined : nonEmptyTrimmedString(root.access);
  if (root === undefined || access === undefined) {
    throw new Error("GitHub Copilot credential is missing access");
  }
  const apiHost = nonEmptyTrimmedString(root.apiHost) ?? GITHUB_DEFAULT_API_HOST;
  const github = nonEmptyTrimmedString(root.github);
  const rawProfile = nonEmptyTrimmedString(root.profile);
  const profile: GithubCopilotCredentialProfile =
    rawProfile === "opencode-copilot" || rawProfile === "vscode-client-real"
      ? rawProfile
      : github !== undefined && access === github && apiHost === GITHUB_OPENCODE_API_HOST
        ? "opencode-copilot"
        : "vscode-client-real";
  return {
    access,
    apiHost,
    profile,
    ...(github === undefined ? {} : { github }),
  };
}

/**
 * Reads the API host out of a Copilot token.
 *
 * The token is a `key=value;` list; `proxy-ep` names the proxy host and the API
 * host is the same name with `proxy.` swapped for `api.`. A token without the
 * claim falls back to the Individual host rather than failing — the request
 * then fails closed upstream with a typed error instead of at credential parse.
 */
export function apiHostFromGithubToken(token: string): string {
  const match = token.match(/proxy-ep=([^;]+)/);
  const proxyHost = match?.[1]?.trim();
  if (!proxyHost) return GITHUB_DEFAULT_API_HOST;
  const apiHost = proxyHost.replace(/^proxy\./, "api.");
  return apiHost.length > 0 ? apiHost : GITHUB_DEFAULT_API_HOST;
}

interface CopilotTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

/** Mints a Copilot token from a GitHub access token. */
export async function mintGithubToken(
  githubAccessToken: string,
  domain: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<{ access: string; apiHost: string; expiresAt: Date }> {
  const response = await fetchFn(`https://api.${domain}/copilot_internal/v2/token`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${githubAccessToken}`,
      ...GITHUB_REQUEST_HEADERS,
    },
    ...(signal === undefined ? {} : { signal }),
  });
  const body = (await readJsonResponse(response, "GitHub Copilot token mint")) as CopilotTokenResponse;
  const access = nonEmptyTrimmedString(body.token);
  if (access === undefined) {
    throw new Error("GitHub Copilot token mint returned no token");
  }
  const expiresAtSeconds =
    typeof body.expires_at === "number" && Number.isFinite(body.expires_at) ? body.expires_at : undefined;
  return {
    access,
    apiHost: apiHostFromGithubToken(access),
    expiresAt:
      expiresAtSeconds === undefined
        ? new Date(Date.now() + COPILOT_TOKEN_FALLBACK_MS)
        : new Date(expiresAtSeconds * 1000),
  };
}

/** Reads the GitHub login for the account label, so a re-login replaces one row. */
async function fetchGitHubLogin(
  githubAccessToken: string,
  domain: string,
  profile: GithubCopilotCredentialProfile,
  fetchFn: FetchLike,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(`https://api.${domain}/user`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${githubAccessToken}`,
        // The GitHub account API only needs the selected client's user-agent.
        "user-agent": githubCopilotUserAgent(profile),
      },
      signal,
    });
    if (!response.ok) return undefined;
    return nonEmptyTrimmedString(record(await response.json())?.login);
  } catch {
    // The label is an enrichment. Losing it costs the friendly name and falls
    // back to the refresh-token fingerprint for identity, not the login.
    return undefined;
  }
}

interface CopilotUserProfile {
  readonly chat_enabled?: boolean;
  readonly can_signup_for_limited?: boolean;
}

/**
 * Reads the Copilot entitlement profile for a freshly approved GitHub token.
 *
 * OAuth itself succeeds for any GitHub account; entitlement is the only signal
 * that the account can chat. Mirrors the reference OpenCode provider: an
 * explicit `chat_enabled: false` is a denial (the account is not signed up or
 * has no seat), and a failed/malformed lookup must not turn a GitHub hiccup
 * into a denial — only an explicit answer blocks login.
 */
async function fetchGitHubCopilotEntitlement(
  githubAccessToken: string,
  domain: string,
  profile: GithubCopilotCredentialProfile,
  fetchFn: FetchLike,
  signal: AbortSignal,
): Promise<{ denied: string } | { denied?: undefined }> {
  try {
    const endpoint =
      domain === "github.com"
        ? "https://api.github.com/copilot_internal/user"
        : `https://api.${domain}/copilot_internal/user`;
    const response = await fetchFn(endpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${githubAccessToken}`,
        "user-agent": githubCopilotUserAgent(profile),
        "x-github-api-version": "2025-04-01",
      },
      signal,
    });
    if (!response.ok) return { denied: undefined };
    const userProfile = record(await response.json()) as CopilotUserProfile | undefined;
    if (userProfile?.chat_enabled === false) {
      if (userProfile.can_signup_for_limited) {
        return {
          denied:
            "This GitHub account is not signed up for GitHub Copilot. Sign up for Copilot Free at https://github.com/features/copilot/plans and connect again.",
        };
      }
      return {
        denied:
          "This GitHub account does not have GitHub Copilot access. It needs an active Copilot subscription or a seat assigned by an organization.",
      };
    }
    return { denied: undefined };
  } catch {
    // Entitlement is a gate, not a reliability dependency: a network glitch
    // here must not lock out an account that did approve the login.
    return { denied: undefined };
  }
}

function parseGithubDeviceProviderState(value: string | undefined): { domain?: string; clientId?: string; profile?: GithubCopilotCredentialProfile } | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    const state = record(parsed);
    const domain = nonEmptyTrimmedString(state?.domain);
    const clientId = nonEmptyTrimmedString(state?.clientId);
    const rawProfile = nonEmptyTrimmedString(state?.profile);
    const profile = rawProfile === "opencode-copilot" || rawProfile === "vscode-client-real"
      ? rawProfile
      : undefined;
    if (domain !== undefined) {
      return {
        domain,
        ...(clientId === undefined ? {} : { clientId }),
        ...(profile === undefined ? {} : { profile }),
      };
    }
  } catch {
    // Older in-flight logins persisted the bare GitHub domain as providerState.
  }
  return { domain: value };
}

function githubCopilotUserAgent(profile: GithubCopilotCredentialProfile): string {
  return profile === "opencode-copilot" ? "opencode/0.1.0" : GITHUB_REQUEST_HEADERS["user-agent"]!;
}

function readGithubCopilotProfile(
  authState: Readonly<Record<string, unknown>> | undefined,
): GithubCopilotCredentialProfile | undefined {
  const value = authState?.["github_copilot_profile"];
  return value === "opencode-copilot" || value === "vscode-client-real" ? value : undefined;
}

export class GithubOAuthClient extends OAuthDeviceFlow implements OAuthTokenRefresher {
  readonly requiresAccessToken = true;
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "GitHub Copilot";
  protected override readonly tokenUrl = GITHUB_ACCESS_TOKEN_URL;
  protected override readonly scopes = "read:user";

  /** Which GitHub OAuth app this flow presents. Defaults to the Copilot Chat
   *  extension's app; OpenCode's own app differs (`GITHUB_OPENCODE_CLIENT_ID`). */
  protected override readonly clientId: string;

  constructor(
    fetchFn: FetchLike = globalThis.fetch,
    clientId: string = githubCopilotClientIdForProfile(resolveGithubCopilotMode()),
  ) {
    super(fetchFn);
    this.clientId = clientId;
  }

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const domain = copilotGitHubDomain();
    const response = await this.fetchFn(`https://${domain}/login/device/code`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": githubCopilotUserAgent(githubCopilotProfileForClientId(this.clientId)),
      },
      body: new URLSearchParams({ client_id: this.clientId, scope: "read:user" }),
    });
    const body = record(await readJsonResponse(response, "GitHub device authorization"));
    const deviceCode = nonEmptyTrimmedString(body?.device_code);
    const userCode = nonEmptyTrimmedString(body?.user_code);
    const verificationUri = nonEmptyTrimmedString(body?.verification_uri);
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
      throw new Error("GitHub device authorization returned an invalid response");
    }
    // The verification URI comes from the provider and is handed to an operator
    // to open, so it is validated as an absolute http(s) URL before being
    // published — a `file:`/`javascript:` value must never reach the dialog.
    let parsed: URL;
    try {
      parsed = new URL(verificationUri);
    } catch {
      throw new Error("GitHub device authorization returned an untrusted verification URI");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("GitHub device authorization returned an untrusted verification URI");
    }
    const interval =
      typeof body?.interval === "number" && Number.isFinite(body.interval)
        ? Math.max(0, body.interval)
        : DEVICE_INTERVAL_SECONDS;
    const expiresIn =
      typeof body?.expires_in === "number" && Number.isFinite(body.expires_in)
        ? Math.max(0, body.expires_in)
        : DEVICE_EXPIRY_SECONDS;
    return {
      verificationUri: parsed.href,
      userCode,
      deviceAuthId: deviceCode,
      intervalSeconds: interval,
      expiresInSeconds: expiresIn,
      // Pin the OAuth app and host across the complete device flow, even if
      // process configuration changes before the user finishes authorization.
      providerState: JSON.stringify({
        domain,
        clientId: this.clientId,
        profile: githubCopilotProfileForClientId(this.clientId),
      }),
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const providerState = parseGithubDeviceProviderState(context?.providerState);
    const domain = providerState?.domain ?? copilotGitHubDomain();
    const clientId = providerState?.clientId ?? this.clientId;
    const profile = providerState?.profile ?? githubCopilotProfileForClientId(clientId);
    const response = await this.fetchFn(`https://${domain}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": githubCopilotUserAgent(profile),
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceAuthId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    // GitHub answers 200 with an `error` field for the pending state, so the
    // body decides — but a non-2xx response or an unparseable body is a real
    // failure, and reading it through the throwing helper would surface the
    // raw status as an unhandled error instead of a poll verdict. The body is
    // therefore read first and classified below.
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
    } catch {
      parsed = undefined;
    }
    const body = record(parsed);
    const githubToken = nonEmptyTrimmedString(body?.access_token);
    if (githubToken === undefined) {
      const error = nonEmptyTrimmedString(body?.error) ?? "";
      // GitHub answers 200 with an `error` field for both the pending state
      // and `slow_down`; `slow_down` must widen the cadence or every later
      // poll is rejected the same way and the flow never completes.
      const verdict = devicePollBackoff(error, body?.interval);
      if (verdict !== undefined) return verdict;
      if (error === "expired_token") {
        return { status: "failed", reason: "GitHub device authorization expired" };
      }
      if (error === "access_denied") {
        return { status: "failed", reason: "GitHub authorization was denied" };
      }
      // Any other verdict — an unrecognized `error`, a non-2xx status, or an
      // unparseable body — is a failure, not a pending state. Returning
      // "pending" here made a permanent upstream rejection look like a login
      // that simply never finished: the dialog polled until its own expiry and
      // the operator saw a spinner with no reason.
      const reason =
        error.length > 0
          ? `GitHub device polling failed: ${error}`
          : `GitHub device polling failed (${response.status})`;
      return { status: "failed", reason };
    }
    let minted: Awaited<ReturnType<typeof mintGithubToken>> | undefined;
    try {
      // OAuth succeeds for any GitHub account; the entitlement profile is the
      // only signal that the account can actually chat. An explicit denial is
      // surfaced as a failed verdict before any token is minted or stored,
      // mirroring the reference OpenCode provider.
      const entitlement = await fetchGitHubCopilotEntitlement(
        githubToken,
        domain,
        profile,
        this.fetchFn,
        AbortSignal.timeout(10_000),
      );
      if (entitlement.denied !== undefined) {
        return { status: "failed", reason: entitlement.denied };
      }
      // OpenCode's OAuth app is the client the `opencode-copilot` wire mode
      // presents upstream, and that mode uses the raw GitHub token directly —
      // no minted Copilot token. The VS Code mint endpoint
      // (`/copilot_internal/v2/token`) rejects non-VS-Code client ids with 403
      // (GitHub's anti-scraping gate), so an OpenCode login must not mint.
      if (profile === "vscode-client-real") {
        minted = await mintGithubToken(githubToken, domain, this.fetchFn);
      }
    } catch (error) {
      // The mint runs after approval: surface its reason as a failed verdict,
      // not an exception that escapes the dashboard's poll request.
      return { status: "failed", reason: error instanceof Error ? error.message : "GitHub Copilot token mint failed" };
    }
    const label = await fetchGitHubLogin(githubToken, domain, profile, this.fetchFn, AbortSignal.timeout(10_000));
    const access = minted === undefined ? githubToken : minted.access;
    const apiHost = minted === undefined ? githubCopilotApiHostForProfile(profile, domain) : minted.apiHost;
    const expiresAt =
      minted === undefined
        ? new Date(Date.now() + GITHUB_OPENCODE_TOKEN_LIFETIME_MS)
        : minted.expiresAt;
    const result: OAuthExchangeResult = {
      access: encodeGithubCredential(access, apiHost, githubToken, profile),
      // The raw GitHub token is the refresh value for the selected profile.
      refresh: githubToken,
      expiresAt,
      auth_state: { github_copilot_profile: profile },
      ...(label === undefined ? {} : { accountLabel: label }),
    };
    return { status: "complete", result };
  }


  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
    context?: OAuthRefreshContext,
  ): Promise<OAuthTokenRefreshResult> {
    const profile = githubCopilotProfileForClientId(this.clientId);
    const storedProfile =
      readGithubCopilotProfile(context?.auth_state) ??
      (context?.access_token === undefined
        ? undefined
        : parseGithubCredential(context.access_token).profile);
    if (storedProfile !== undefined && storedProfile !== profile) {
      throw new Error("github_copilot_profile_mismatch: reconnect this GitHub account under the selected CARTETHYIA_GITHUB_COPILOT_MODE");
    }
    if (profile === "opencode-copilot") {
      return {
        access: encodeGithubCredential(
          refreshToken,
          githubCopilotApiHostForProfile(profile, copilotGitHubDomain()),
          refreshToken,
          profile,
        ),
        refresh: refreshToken,
        expiresAt: new Date(Date.now() + GITHUB_OPENCODE_TOKEN_LIFETIME_MS),
        auth_state: { github_copilot_profile: profile },
      };
    }
    const minted = await mintGithubToken(
      refreshToken,
      copilotGitHubDomain(),
      this.fetchFn,
      signal,
    );
    return {
      access: encodeGithubCredential(minted.access, minted.apiHost, refreshToken, profile),
      // The GitHub token is unchanged by a re-mint, so it stays the refresh value.
      refresh: refreshToken,
      expiresAt: minted.expiresAt,
      auth_state: { github_copilot_profile: profile },
    };
  }
}

export const githubOAuthClient = new GithubOAuthClient();
