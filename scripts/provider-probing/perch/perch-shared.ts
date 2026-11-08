/**
 * Perch upstream wire helpers for probe scripts.
 *
 * Source of truth: the official CLI (`perchai-cli` 2.4.125, bundled
 * `dist/perch.mjs`) plus a live OAuth capture (2026-11-08). Perch accounts
 * authenticate via Supabase GoTrue (project `zlfuvsfjtgsdtqcaykia.supabase.co`):
 *
 *   - GET  https://zlfuvsfjtgsdtqcaykia.supabase.co/auth/v1/authorize
 *          ?provider=google&redirect_to=http://127.0.0.1:<port>/callback
 *          &client_id=<publishable>&code_challenge=...&code_challenge_method=S256
 *   - POST https://zlfuvsfjtgsdtqcaykia.supabase.co/auth/v1/token?grant_type=pkce
 *          { auth_code, redirect_to, code_verifier }   (GoTrue v2.197.0)
 *   - POST .../auth/v1/token?grant_type=refresh_token  { refresh_token }
 *   - GET/POST https://app.perchai.app/api/perch-terminal/cli-plan
 *          (POST { plan:"starter", noticeVersion } selects Starter free)
 *   - GET  https://app.perchai.app/api/perchai/account  (Bearer; quota)
 *
 * Hosted inference is surface-gated: direct `model-call` HTTP answers
 * `perch_surface_required`, so probes invoke the official CLI
 * (`perch run "<task>" --mode ask --json --model <tier>`) with the session
 * written to `PERCH_CLI_AUTH_DIR`.
 *
 * Tokens are never printed by these helpers; callers own masking.
 */

import { maskSecret } from "../lib/accounts";

/** Supabase project host (from the shipped bundle). */
export const PERCH_SUPABASE_HOST =
  process.env.PERCH_SUPABASE_HOST?.trim() ?? "zlfuvsfjtgsdtqcaykia.supabase.co";

/** Publishable key used as `apikey` (the bundle ships no raw anon JWT). */
export const PERCH_SUPABASE_PUBLISHABLE_KEY =
  process.env.PERCH_SUPABASE_PUBLISHABLE_KEY?.trim() ??
  "sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO";

/** Hosted app origin the CLI writes into its session file. */
export const PERCH_APP_URL = process.env.PERCH_APP_URL?.trim() ?? "https://app.perchai.app";

/** CLI version the probes speak (npm latest as of capture). */
export const PERCH_CLI_VERSION = "2.4.125";

/** Starter notice version required to select the free plan (captured). */
export const PERCH_STARTER_NOTICE_VERSION = "2026-09-13";

/** Roost tiers: free Starter tiers vs paid Pro tiers. */
export const PERCH_TIERS = {
  standard: "standard",
  standard1m: "standard 1m",
  pro: "pro",
  pro1m: "pro 1m",
} as const;

export const PERCH_FREE_TIERS = [PERCH_TIERS.standard, PERCH_TIERS.standard1m] as const;
export const PERCH_PRO_TIERS = [PERCH_TIERS.pro, PERCH_TIERS.pro1m] as const;

/**
 * Supabase authorize path. Google validates the requested scopes for
 * accounts that have not approved this client before — a missing `scope`
 * answers `Error 400: invalid_request / Missing required parameter: scope`
 * (flowName=GeneralOAuthFlow). Always send the explicit GoTrue Google
 * scopes (`openid email profile`), matching what Supabase's own SDK sends.
 */
export function perchAuthorizeUrl(redirectTo: string, challenge: string, state: string): string {
  const url = new URL(`https://${PERCH_SUPABASE_HOST}/auth/v1/authorize`);
  url.searchParams.set("provider", "google");
  url.searchParams.set("redirect_to", redirectTo);
  url.searchParams.set("client_id", PERCH_SUPABASE_PUBLISHABLE_KEY);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchange the authorization code for a session (GoTrue grant_type=pkce). */
export async function perchExchangeCode(
  code: string,
  redirectTo: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const url = new URL(`https://${PERCH_SUPABASE_HOST}/auth/v1/token`);
  url.searchParams.set("grant_type", "pkce");
  const res = await fetcher(url.toString(), {
    method: "POST",
    headers: {
      apikey: PERCH_SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ auth_code: code, redirect_to: redirectTo, code_verifier: verifier }),
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Refresh a session. */
export async function perchRefreshToken(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const url = new URL(`https://${PERCH_SUPABASE_HOST}/auth/v1/token`);
  url.searchParams.set("grant_type", "refresh_token");
  const res = await fetcher(url.toString(), {
    method: "POST",
    headers: {
      apikey: PERCH_SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Reads plan status; `chooseStarter` selects the free plan. */
export async function perchPlanStatus(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const res = await fetcher(`${PERCH_APP_URL}/api/perch-terminal/cli-plan`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function perchChooseStarter(
  accessToken: string,
  noticeVersion = PERCH_STARTER_NOTICE_VERSION,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const res = await fetcher(`${PERCH_APP_URL}/api/perch-terminal/cli-plan`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ plan: "starter", noticeVersion }),
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Reads account/quota envelope (Bearer). */
export async function perchAccount(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const res = await fetcher(`${PERCH_APP_URL}/api/perchai/account`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export { maskSecret };
