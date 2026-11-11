/**
 * Per-provider proactive OAuth refresh lead.
 *
 * The lead is how long *before* expiry a token becomes eligible for the
 * scheduled refresh sweep. It exists so the sweep re-mints a token before it
 * dies — never to push refreshes any more often than that.
 *
 * Buckets are deliberately coarse. A single global "5 minutes before expiry"
 * window is wrong: some providers issue short-lived tokens that a 5-minute
 * lead can miss under a loaded sweep, while others issue very long-lived
 * tokens where re-minting days early is pointless traffic. Three buckets cover
 * both ends without a hand-tuned value per provider:
 *
 *   - daily (default): tokens that live hours to days — refresh once a day at
 *     most, or when the sweep sees the token enter its final 24h.
 *   - 3 days: multi-day tokens — refresh at most ~3 days before expiry.
 *   - 7 weeks: very long-lived tokens — refresh ~7 weeks before expiry, so a
 *     ~6-month token is touched roughly once a quarter.
 *
 * Short-lived tokens (below the daily bucket) keep tighter leads because the
 * invariant is "never let the token expire": a lead larger than the token
 * lifetime would make the token permanently due and the sweep would re-mint it
 * on every tick, which is the wasteful behavior these buckets exist to remove.
 *
 * Real expiries (from the first-party clients these providers model):
 *   - Google-backed (Antigravity): access tokens live ~1h; 5 min lead.
 *   - Claude Code: CLI session tokens live ~8h; 4h lead keeps one work
 *     session on a single token.
 *   - xAI/Grok CLI and Kimi: short-lived tokens; 5 min lead.
 *   - ChatGPT/Codex: access tokens live ~5 days; 3-day lead re-mints ~2 days
 *     before expiry.
 *   - iFlow: very long-lived tokens; 7-week lead.
 */
export const DEFAULT_REFRESH_LEAD_MS = 24 * 60 * 60 * 1000;

/** 3-day lead for multi-day tokens. */
export const REFRESH_LEAD_3DAY_MS = 3 * 24 * 60 * 60 * 1000;

/** 7-week lead for very long-lived tokens. */
export const REFRESH_LEAD_7WEEK_MS = 7 * 7 * 24 * 60 * 60 * 1000;

/**
 * Per-provider refresh lead in milliseconds. Providers absent here use
 * {@link DEFAULT_REFRESH_LEAD_MS}. Keys are provider ids as stored on
 * `provider_accounts.provider_id`.
 */
export const REFRESH_LEAD_MS: Readonly<Record<string, number>> = Object.freeze({
  // Google-backed token endpoints throttle, and the access token itself lives
  // only ~1h — a tight lead (below the token lifetime) is what keeps the
  // sweep from re-minting on every tick.
  antigravity: 5 * 60 * 1000,
  // Claude Code access tokens live ~8h; 4h keeps a full work session on one
  // token without permanent due-state.
  claude: 4 * 60 * 60 * 1000,
  // xAI/Grok CLI and Kimi re-mint on a 5-minute lead (short-lived tokens).
  grok: 5 * 60 * 1000,
  kimi: 5 * 60 * 1000,
  // ChatGPT/Codex access tokens live ~5 days; a 3-day lead re-mints ~2 days
  // before expiry — one refresh per weekend, not per request.
  codex: REFRESH_LEAD_3DAY_MS,
  // iFlow tokens are very long-lived; a 7-week lead avoids pointless churn
  // while still re-minting well before expiry.
  iflow: REFRESH_LEAD_7WEEK_MS,
});

/** The refresh lead for `providerId`, falling back to the shared default. */
export function refreshLeadMs(providerId: string): number {
  return REFRESH_LEAD_MS[providerId] ?? DEFAULT_REFRESH_LEAD_MS;
}
