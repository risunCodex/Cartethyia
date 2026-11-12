/**
 * Provider-specific knobs: Kimi OAuth/quota hosts, the GitHub Enterprise domain
 * for the Copilot device login, and the OAuth callback URL builders built on the
 * public origin.
 */

import { CONFIG_SPEC, readInt, readOptionalText, readText } from "./spec";

/**
 * Browser-authorize redirect URI for a provider.
 *
 * On a host where the operator's browser can reach the gateway directly
 * (localhost dev), the callback stays a loopback URI — `http://127.0.0.1:59653/callback`
 * — which the gateway's `callback-listener` binds and completes itself.
 *
 * On a deployment (Docker/VPS, where `CARTETHYIA_PUBLIC_ORIGIN` is set), the
 * browser cannot reach the container's `127.0.0.1`: it would land on the
 * browser's own machine, not the gateway, and the callback would never be
 * delivered. There the redirect is the gateway's public origin plus the
 * hosted console callback path, so the redirect reaches a server that can
 * complete the exchange — and the loopback listener does not need to bind.
 *
 * The public origin is read from the environment (the spec requires it for the
 * app, so it is present in any real deployment); an empty value keeps the
 * loopback default for tests and local runs that never set it.
 */
/**
 * Browser-authorize redirect URI for a provider.
 *
 * On a host where the operator's browser can reach the gateway directly
 * (localhost dev), the callback stays a loopback URI — `http://127.0.0.1:59653/callback`
 * — which the gateway's `callback-listener` binds and completes itself.
 *
 * On a deployment (Docker/VPS, where `CARTETHYIA_PUBLIC_ORIGIN` names a public
 * host), the browser cannot reach the container's `127.0.0.1`: it would land on
 * the browser's own machine, not the gateway, and the callback would never be
 * delivered. There the redirect is the gateway's public origin plus the hosted
 * console callback path, so the redirect reaches a server that can complete the
 * exchange — and the loopback listener does not need to bind.
 *
 * The origin is loopback-aware: a `localhost`/`127.0.0.1` public origin (the
 * local dev default) still keeps the self-completing loopback URI; only a
 * non-loopback origin switches to the hosted callback.
 */
export function browserAuthorizeRedirectUri(): string {
  const publicOrigin = process.env.CARTETHYIA_PUBLIC_ORIGIN?.trim() ?? "";
  if (publicOrigin.length > 0 && !isLoopbackOrigin(publicOrigin)) {
    return `${publicOrigin.replace(/\/+$/, "")}/providers/oauth/callback`;
  }
  return `http://127.0.0.1:${readInt("CARTETHYIA_OAUTH_CALLBACK_PORT", CONFIG_SPEC.CARTETHYIA_OAUTH_CALLBACK_PORT)}/callback`;
}

/** Whether `browserAuthorizeRedirectUri()` currently advertises a loopback URI. */
export function browserAuthorizeUsesLoopback(): boolean {
  const publicOrigin = process.env.CARTETHYIA_PUBLIC_ORIGIN?.trim() ?? "";
  return publicOrigin.length === 0 || isLoopbackOrigin(publicOrigin);
}

/** True for a `localhost`/`127.0.0.1`/`::1` origin the browser can reach as its own loopback. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
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
