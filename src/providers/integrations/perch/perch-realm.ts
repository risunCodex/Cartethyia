// Perch realm constants.
//
// Perch (perchai.app) is an AI operator platform. Accounts authenticate via
// Supabase OAuth (Google/GitHub) with PKCE; the data-plane surface for the
// CLI is `perch run` (the official CLI, spawned per request). Free starter
// accounts route through Roost (auto) or the pinned Standard / Standard 1M
// tiers.
//
// Wire facts (probed live 2026-11-08 on a Google OAuth account):
//   - Supabase project host: zlfuvsfjtgsdtqcaykia.supabase.co
//   - Publishable key used as `apikey` for OAuth flows (Raw JWT anon key is
//     not shipped to the bundle; `sb_publishable_...` works for authorize +
//     token exchange).
//   - Authorize: GET /auth/v1/authorize?provider=google&redirect_to=...
//     &client_id=<publishable>&code_challenge=...&code_challenge_method=S256
//   - Token: POST /auth/v1/token?grant_type=pkce with `auth_code`
//     (NOT `code` — GoTrue v2.197.0 rejects `authorization_code`), plus
//     `code_verifier`.
//   - Refresh: POST /auth/v1/token?grant_type=refresh_token.
//   - Plan selection (Starter free): GET/POST /api/perch-terminal/cli-plan
//     (POST body {plan:"starter", noticeVersion}).
//   - Inference: the hosted model-call API is surface-gated
//     (`perch_surface_required` for direct calls — see perch.ts), so the
//     transport is the official CLI: `perch run <task> --mode ask --json`.

/** Default Supabase project host for Perch accounts. */
export const PERCH_SUPABASE_HOST = "zlfuvsfjtgsdtqcaykia.supabase.co";

/** Supabase publishable key (used as `apikey`; not a JWT). */
export const PERCH_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO";

/** Hosted app origin (the CLI's `appUrl`). */
export const PERCH_APP_URL = "https://app.perchai.app";

/** Provider id used by the registry. */
export const PERCH_PROVIDER_ID = "perch";

/** Default CLI binary name; `PERCH_CLI_BIN` overrides it. */
export const PERCH_CLI_BIN = "perch";

/** CLI session directory (matches the official CLI). */
export const PERCH_CLI_AUTH_DIR_ENV = "PERCH_CLI_AUTH_DIR";

/** Context windows reported for the Roost tiers (client claims). */
export const PERCH_CONTEXT_STANDARD = 200_000;
export const PERCH_CONTEXT_STANDARD_1M = 1_000_000;


