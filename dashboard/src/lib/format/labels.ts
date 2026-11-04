/**
 * Operator-facing label for an account error category.
 *
 * The raw category is a machine value (`quota_fetch_failed`) that tells an
 * operator nothing about what to do. The label says what is wrong; the raw
 * category stays in the tooltip.
 */

/** One credential kind; mirrors `CREDENTIAL_KINDS` in the catalog contracts. */
type CredentialKind = "api_key" | "oauth" | "none";

const ACCOUNT_ERROR_LABELS: Readonly<Record<string, string>> = {
  quota_fetch_failed: "Quota unreachable",
  quota_exhausted: "Quota exhausted",
  policy_blocked: "Policy blocked",
  policy_blocked_banned: "Account banned",
  policy_blocked_invalid_request: "Request refused",
  rate_limit_transient: "Rate limited",
  missing_credential: "No credential",
  validation_required: "Verification required",
  model_unreachable: "Model unavailable",
};

/**
 * Categories that describe a check that will be retried, not a state of the
 * account.
 *
 * `quota_fetch_failed` says the quota *endpoint* did not answer this pass. The
 * account is still routable — the sweep tries again, and a transient timeout is
 * already excluded from `consecutiveFailures` on the write side. Rendering it
 * as a pill told the operator the account could not be routed, which is the
 * opposite of true: it routes fine, and only its allowance is unknown.
 *
 * A real refusal is not in here. `quota_exhausted` means the allowance is spent
 * and the account genuinely cannot serve; that stays visible.
 */
const RETRYABLE_ERROR_CATEGORIES: ReadonlySet<string> = new Set(["quota_fetch_failed"]);

/**
 * Whether an error category should be shown as a status pill.
 *
 * The write side records a category even for a failure it deliberately does not
 * count (see `recordAccountCheck`), because the raw value is still useful in a
 * tooltip. This is what keeps that distinction from becoming a false alarm on
 * the row.
 */
export function showsErrorPill(category: string | undefined): category is string {
  if (category === undefined || category.length === 0) return false;
  return !RETRYABLE_ERROR_CATEGORIES.has(category);
}

/**
 * What the operator must actually do about a rejected credential.
 *
 * "Re-login required" is only true of an OAuth account: a BYOK API key has no
 * login to return to, and telling an operator to re-login sends them hunting
 * for a sign-in button their provider does not have. The fix for an API key is
 * to paste a different one.
 */
export function authInvalidatedLabel(credentialKind: string | undefined): string {
  return credentialKind === "oauth" ? "Re-login required" : "Replace API key";
}

export function accountErrorLabel(category: string, credentialKind?: CredentialKind): string {
  if (category === "auth_invalidated") return authInvalidatedLabel(credentialKind);
  return ACCOUNT_ERROR_LABELS[category] ?? category;
}

const VALIDATION_URL_RE = /https?:\/\/[^\s"'\\]+/;

/**
 * Extracts the actionable verification URL from the recorded account error.
 *
 * The backend appends the upstream `validation_url` to the reason for
 * `validation_required`, so a plain URL scan of the raw text is enough — no
 * extra API surface needed.
 */
export function validationTargetUrl(lastError: string | null | undefined): string | undefined {
  if (!lastError) return undefined;
  const m = VALIDATION_URL_RE.exec(lastError);
  return m?.[0];
}