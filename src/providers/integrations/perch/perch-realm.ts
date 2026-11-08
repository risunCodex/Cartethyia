// Perch realm constants.
//
// Perch (perchai.app) is an AI operator platform. Accounts authenticate via
// Supabase OAuth (Google/GitHub) with PKCE; the data plane is direct HTTP
// (`POST /api/perch-terminal/model-call`) with a CLI turn ticket — no CLI
// process, desktop app, MCP, or ACP transport. Free Starter accounts route
// through the Roost `standard` / `standard_max` tiers.
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
//     (`perch_surface_required`) and requires the full CLI turn envelope:
//     turn ticket, attribution, Roost tier, and the Saffron system-prompt
//     prefix (see perch.ts / perch-protocol.ts).

/** Default Supabase project host for Perch accounts. */
export const PERCH_SUPABASE_HOST = "zlfuvsfjtgsdtqcaykia.supabase.co";

/** Supabase publishable key (used as `apikey`; not a JWT). */
export const PERCH_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO";

/** Hosted app origin (the CLI's `appUrl`). */
export const PERCH_APP_URL = "https://app.perchai.app";

/** Provider id used by the registry. */
export const PERCH_PROVIDER_ID = "perch";

/** Context windows reported for the Roost tiers (client claims, 2.4.125). */
export const PERCH_CONTEXT_STANDARD = 200_000;
export const PERCH_CONTEXT_STANDARD_1M = 1_000_000;

/**
 * Starter-pool model pins.
 *
 * Perch surfaces a fixed set of "Starter" model options on the free plan
 * (bundle `k8e` / `zre`). A pin is selected by sending the upstream *backing*
 * model id as `manualModelOptionId` (+ `preferredModelId`) with
 * `strictManual: true` — verified live 2026-11-08: `glm-5.3-flash-starter`
 * answered `model=z-ai/glm-5.3-flash`, `crouton-alpha` answered
 * `model=stealth/crouton-alpha`, `deepseek-flash-starter` answered
 * `model=deepseek-v4.1-flash-1017`. Sending only `preferredModelId` is
 * ignored by the server (it falls back to the Roost default). `beam` and the
 * slot backings were not verified (turn rate limit).
 */
export interface PerchStarterPin {
  /** Roost tier to send alongside the pin. */
  readonly roostTier: string;
  /** The upstream backing model id (openrouter/…). */
  readonly preferredModelId: string;
}

export const PERCH_STARTER_PINS: Readonly<Record<string, PerchStarterPin>> = {
  "glm-5.3-flash-starter": {
    roostTier: "standard",
    preferredModelId: "openrouter-z-ai-glm-5-3-flash-crusoe",
  },
  "deepseek-flash-starter": {
    roostTier: "standard",
    preferredModelId: "openrouter-deepseek-deepseek-v4-1-flash-crusoe",
  },
  "crouton-alpha": {
    roostTier: "standard",
    preferredModelId: "openrouter-stealth-crouton-alpha",
  },
  "beam-1.0-starter": {
    roostTier: "standard",
    preferredModelId: "openrouter-reflection-beam-1-0-501b-a23b",
  },
};


