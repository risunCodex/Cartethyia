/**
 * Pure ban dropdown constants (reasons + durations), kept free of any `node:*`
 * import so the dashboard can import them without evaluating Node-only modules.
 *
 * The dashboard mirrors these into its UI; the console API validates against
 * the same lists. They used to live in `contracts.ts`, which also imports
 * `hashSecret` (→ `security/crypto` → `node:crypto`) and `randomBytes` — so a
 * browser bundle that imported any value from `contracts.ts` dragged the whole
 * Node crypto chain along and blew up in the client (module externalized).
 * Moving the pure lists here keeps one source of truth for the values while
 * keeping the browser bundle clean.
 */

/** Ban reasons offered by the console dropdown. The first two are the operator's
 * own: "Instant Ban — Suka suka Gw" for the arbitrary ban, and a template for
 * suspicious traffic. The rest are generic, and an operator can still type a
 * custom reason — the dropdown is a convenience, not a closed set. */
export const API_KEY_BAN_REASONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "instant_arbitrary", label: "Instant Ban — Suka suka Gw" },
  { value: "traffic_suspicious", label: "Your traffic looks suspicious" },
  { value: "abuse", label: "Abuse of the gateway" },
  { value: "policy_violation", label: "Policy violation" },
  { value: "compromised", label: "Key may be compromised" },
  { value: "quota_exceeded", label: "Quota abused" },
  { value: "other", label: "Other / custom" },
] as const;

/** Ban durations the console offers, in whole minutes. `null` is permanent.
 * Mirrored by the dashboard (`dashboard/src/lib/ban-durations.ts`) so the UI
 * and the API agree on one list. */
export const BAN_DURATION_CHOICES: readonly { readonly minutes: number | null; readonly label: string }[] = [
  { minutes: 60, label: "1 hour" },
  { minutes: 6 * 60, label: "6 hours" },
  { minutes: 12 * 60, label: "12 hours" },
  { minutes: 24 * 60, label: "1 day" },
  { minutes: 7 * 24 * 60, label: "7 days" },
  { minutes: null, label: "Permanent" },
] as const;
