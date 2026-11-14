/**
 * Provider-specific knobs: Kimi OAuth/quota hosts, the GitHub Enterprise domain
 * for the Copilot device login, and the OAuth callback URL builders built on the
 * public origin.
 */

import { CONFIG_SPEC, readOptionalText, readText } from "./spec";
import { resolvePort } from "./runtime";

/** Loopback hosts that name the machine the browser runs on. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Browser-authorize redirect URI for a provider whose redirect port this
 * gateway owns.
 *
 * It names this gateway's own HTTP listener — `http://127.0.0.1:<port>/callback`
 * — the same process that serves the dashboard and `/v1`. The browser redirect
 * therefore arrives without any ephemeral socket: on the machine the browser
 * runs on, which for a local operator is this gateway and for a remote
 * operator is nothing (their browser refuses to connect, and the console
 * dialog's paste path completes the login). The root paths `/callback`,
 * `/auth-callback` (DeepAI's desktop sign-in), and `/authorize` (Trae's login
 * page) are served for exactly this delivery.
 */
export function browserAuthorizeRedirectUri(): string {
  return `http://127.0.0.1:${resolvePort()}/callback`;
}

/**
 * Whether a browser redirect URI lands on this process's own listener.
 *
 * A redirect naming the gateway's port is delivered by the root OAuth callback
 * routes, so no loopback listener may be bound for it — binding the port the
 * gateway itself holds would fail every login with a port conflict. Providers
 * that pin their own port (Codex 1455, Kiro 3128, …) are not gateway-served
 * and keep the ephemeral listener; a custom scheme or a remote host is not a
 * loopback URI at all and keeps the manual paste path.
 */
export function isGatewayServedRedirectUri(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return false;
  const port = url.port.length > 0 ? Number(url.port) : 80;
  return port === resolvePort();
}

/**
 * Kimi OAuth origin host, overridable for self-hosted or regional gateways.
 * Read here so the only literal `process.env` for this value stays in config.
 */
export function resolveKimiOAuthHost(): string {
  return readText("CARTETHYIA_KIMI_OAUTH_HOST", CONFIG_SPEC.CARTETHYIA_KIMI_OAUTH_HOST);
}

/** Reads Kimi Code's quota/billing base URL. */
export function resolveKimiQuotaBaseUrl(): string {
  return readText(
    "CARTETHYIA_KIMI_QUOTA_BASE_URL",
    CONFIG_SPEC.CARTETHYIA_KIMI_QUOTA_BASE_URL,
  );
}

/**
 * Operator override for the directory installation identities are persisted in.
 * Read here so the only literal `process.env` for this value stays in config;
 * the providers that stamp an install id consume the resolver instead.
 */
export function resolveInstallIdDir(): string | undefined {
  return readOptionalText(
    "CARTETHYIA_INSTALL_ID_DIR",
    CONFIG_SPEC.CARTETHYIA_INSTALL_ID_DIR,
  );
}

/**
 * Operator override for the OpenCode free-tier ids upstream refuses, or
 * `undefined` when unset — meaning the bundled, measured list stands.
 *
 * The single token `none` is distinct from unset and from an empty string: it
 * means "trust the listing completely", which is the reference gateway's whole
 * approach. Collapsing it into "no override" would silently re-block models
 * the operator just asked to unblock.
 */
export function resolveOpenCodeUnavailableFree():
  | readonly string[]
  | "none"
  | undefined {
  const raw = process.env.CARTETHYIA_OPENCODE_UNAVAILABLE_FREE?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (raw.toLowerCase() === "none") return "none";
  // Separators only: dropping empties and yielding nothing. Treating
  // that as "trust everything" would un-block every refused model on a typo,
  // so it falls back to the bundled list instead.
  const entries = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return entries.length === 0 ? undefined : entries;
}

/**
 * GitHub Enterprise domain for the Copilot device login, or `""` for github.com.
 *
 * Normalized to a bare hostname: an operator may reasonably paste a URL, and
 * every call site interpolates this into `https://<domain>/...`, so a scheme or
 * trailing slash left in place would produce an unreachable URL.
 */
export function resolveGithubEnterpriseDomain(): string {
  const raw = readText(
    "CARTETHYIA_GITHUB_ENTERPRISE_DOMAIN",
    CONFIG_SPEC.CARTETHYIA_GITHUB_ENTERPRISE_DOMAIN,
  ).trim();
  if (raw.length === 0) return "";
  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname;
  } catch {
    return "";
  }
}

export type GithubCopilotMode = "opencode-copilot" | "vscode-client-real";

/**
 * Selects the complete GitHub Copilot profile for OAuth login/refresh,
 * inference, discovery, and quota identity. `opencode-copilot` is the default
 * and uses the raw GitHub OAuth token with OpenCode identity. `vscode-client-real`
 * uses the VS Code OAuth app and a minted Copilot token. Existing accounts must
 * be re-authenticated after changing profiles; the upstream OAuth app binding
 * prevents converting credentials between profiles.
 */
export function resolveGithubCopilotMode(): GithubCopilotMode {
  const raw = readText(
    "CARTETHYIA_GITHUB_COPILOT_MODE",
    CONFIG_SPEC.CARTETHYIA_GITHUB_COPILOT_MODE,
  ).trim().toLowerCase();
  if (raw === "vscode-client-real") return "vscode-client-real";
  return "opencode-copilot";
}
