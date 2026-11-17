/**
 * Account tier derivation from the plan string the quota collector reported.
 *
 * The plan string (`provider_accounts.quota_plan`) is a raw, per-provider
 * label; this module normalizes it to the three-tier taxonomy the cooldown
 * rules consume (`free | paid | pro | null`, D14). It is a pure function of
 * the provider id and the plan text — no database access, no state.
 *
 * The mapping is deliberately conservative, following the same posture as
 * `plan-gate.ts`: a tier is only claimed when the string proves it. "free"
 * requires the shared free marker set (exported there), "pro" requires a
 * team/enterprise/org signal, and "paid" is only assigned for providers whose
 * plan strings are evidenced (Trae, the buddy family, Cursor). Everything else
 * — an unknown provider, an unrecognized plan, a `null` plan — resolves to
 * `null`, which keeps the legacy behavior intact (unknown tier ⇒ no rule
 * applies ⇒ the old constants drive the cooldown).
 */

import { FREE_PLAN_MARKERS } from "../../transport/routing/plan-gate";
import { BUDDY_PROVIDER_IDS } from "../provider-metadata";
import { QODER_CHECKIN_PROVIDER_IDS } from "../integrations/qoder/qoder-checkin";
import { TRAE_PROVIDER_IDS } from "../integrations/trae/trae-realm";

/** The three-tier taxonomy for cooldown rules. `null` = unknown. */
export type AccountTier = "free" | "paid" | "pro" | null;

/** Team/enterprise/org signals that prove a "pro" tier. */
const PRO_PLAN_MARKERS: readonly string[] = ["team", "enterprise", "org", "pro"];

/**
 * Maps a provider's plan string to a tier.
 *
 * `providerId` is normalized case-insensitively; a `null`/empty plan is
 * unknown (`null`). The "free" check runs before any provider branch because a
 * proven-free label is the strongest signal (e.g. CodeBuddy's
 * `personal_free_user`, Trae's `"Free Plan Subscription"`).
 */
export function mapPlanToTier(providerId: string, plan: string | null): AccountTier {
  const lower = (plan ?? "").trim().toLowerCase();
  if (lower.length === 0) return null;
  // Free is only claimed when the string proves it — the same marker set the
  // routing plan-gate uses (imported, not copied), so the two cannot disagree
  // about an account.
  if (FREE_PLAN_MARKERS.some((marker) => lower.includes(marker))) return "free";

  if ((QODER_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId.toLowerCase())) {
    // Qoder's `userType` is `personal_standard` by default; team/enterprise/
    // org suffixes prove a higher tier. `personal_standard` itself is not
    // verified against the taxonomy, so it stays unknown rather than guessed.
    if (PRO_PLAN_MARKERS.some((marker) => lower.includes(marker))) return "pro";
    return null;
  }

  if (BUDDY_PROVIDER_IDS.has(providerId.toLowerCase())) {
    if (lower.includes("enterprise") || lower.includes("team")) return "pro";
    return "paid";
  }

  // Trae (paid plans other than the free subscription) and Cursor (a non-free
  // `membershipType`/`planName` is a paying plan by construction).
  if (TRAE_PROVIDER_IDS.has(providerId.toLowerCase())) return "paid";
  if (providerId.toLowerCase() === "cursor") return "paid";

  // Unknown provider: no claim. Legacy behavior applies.
  return null;
}
