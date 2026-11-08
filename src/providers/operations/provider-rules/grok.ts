import type { AccountErrorSignals } from "../account-error-classification";

/**
 * xAI Grok Build's free tier resets on a rolling 24-hour window, so its
 * exhaustion is a full-day quota cooldown — never the generic 1h fallback,
 * which let the account re-enter rotation inside the window.
 */
export const GROK_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Detects whether a quota failure belongs to Grok's free tier or spending limit.
 */
export function isGrokFreeTierExhaustion(s: AccountErrorSignals): boolean {
  if (s.providerId !== undefined && s.providerId !== "grok") {
    // If providerId is known and not grok, only match if the providerCode is explicitly grok subscription
    if (!s.providerCode.startsWith("subscription:")) return false;
  }
  return (
    s.providerCode === "subscription:free-usage-exhausted" ||
    s.providerCode.startsWith("subscription:") ||
    s.providerCode.includes("spending") ||
    s.providerCode.includes("credits") ||
    s.lower.includes("free-usage") ||
    s.lower.includes("free usage") ||
    s.lower.includes("included free usage") ||
    s.lower.includes("rolling 24-hour") ||
    s.lower.includes("rolling 24 hour") ||
    s.lower.includes("spending limit") ||
    s.lower.includes("out of credits") ||
    s.lower.includes("run out of credits") ||
    s.lower.includes("need a grok subscription")
  );
}
