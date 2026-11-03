/**
 * Provider-specific knobs: Kimi OAuth/quota hosts, the GitHub Enterprise domain
 * for the Copilot device login, and the OAuth callback URL builders built on the
 * public origin.
 */

import { CONFIG_SPEC, readInt, readOptionalText, readText } from "./spec";

/**
 * Browser-authorize redirect URI for a provider.
 *
 * Browser OAuth advertises a loopback callback, `http://127.0.0.1:59653/callback`
 * by default — the URI Codex registers with its authorization server, which is
 * why the port is the default rather than a free one. The console callback stays the exchange
 * endpoint: the dashboard dialog pastes the loopback landing URL back and
 * the server exchanges the code against the same loopback URI.
 */
export function browserAuthorizeRedirectUri(): string {
  return `http://127.0.0.1:${readInt("CARTETHYIA_OAUTH_CALLBACK_PORT", CONFIG_SPEC.CARTETHYIA_OAUTH_CALLBACK_PORT)}/callback`;
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

/**
 * How cached prompt tokens are accounted. Unknown values fall back to `real`
 * so a typo cannot silently flip every provider to simplified accounting.
 */
export function resolveCacheMode(): "simplified" | "real" {
  const raw = readText(
    "CARTETHYIA_CACHE_MODE",
    CONFIG_SPEC.CARTETHYIA_CACHE_MODE,
  ).toLowerCase();
  return raw === "simplified" ? "simplified" : "real";
}
