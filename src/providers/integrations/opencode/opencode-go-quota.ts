import {
  getJson,
  isoDate,
  type FetchLike,
  type ProviderQuotaResult,
  type ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";

const SOURCE = "opencode-go";

/**
 * The Go plan's `/v1/usage` answer.
 *
 * `usage` carries exactly three windows in the reference implementation —
 * `rolling`, `weekly`, `monthly` — each with a `percent` and a `resetsAt`.
 * The shape is read defensively: an unknown window name is still reported
 * rather than dropped, since a new window is more useful to an operator than
 * a silently narrower view.
 */
interface GoUsageWindow {
  readonly percent?: number | null;
  readonly resetsAt?: string | null;
  readonly status?: string | null;
}

interface GoUsagePayload {
  readonly usage?: Readonly<Record<string, GoUsageWindow | undefined>> | null;
  readonly plan?: string | null;
}

/** Windows whose meaning the reference names, in the order it lists them. */
const KNOWN_WINDOWS: readonly (readonly [string, string])[] = [
  ["rolling", "Rolling"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
];

function labelFor(kind: string): string {
  for (const [name, label] of KNOWN_WINDOWS) {
    if (name === kind) return label;
  }
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * One window, or `undefined` when the upstream omitted what makes it usable.
 *
 * A window with no percentage is not a zero-percent window — it is an absent
 * measurement, and reporting it as `0` would tell the operator the plan is
 * exhausted when the upstream simply did not say.
 */
function windowFor(
  kind: string,
  raw: GoUsageWindow | undefined,
): ProviderQuotaWindow | undefined {
  if (!raw) return undefined;
  const percent = typeof raw.percent === "number" && Number.isFinite(raw.percent)
    ? Math.min(100, Math.max(0, raw.percent))
    : null;
  if (percent === null) return undefined;
  return {
    kind,
    label: labelFor(kind),
    // The endpoint reports subscription-wide percentages, never per-key or
    // per-model balances. Every window of one subscription reads the same
    // budget, so adding them would double-count: they are independent, and
    // the lowest gates the account.
    accounting: "independent",
    usedPercent: percent,
    remainingPercent: 100 - percent,
    resetsAt: isoDate(raw.resetsAt),
  };
}

function parseWindows(payload: GoUsagePayload): readonly ProviderQuotaWindow[] {
  const usage = payload.usage;
  if (!usage) return [];
  const windows: ProviderQuotaWindow[] = [];
  const seen = new Set<string>();
  // Known windows first, in their documented order, so the dashboard is
  // stable across refreshes; anything novel is appended.
  for (const [name] of KNOWN_WINDOWS) {
    seen.add(name);
    const window = windowFor(name, usage[name]);
    if (window) windows.push(window);
  }
  for (const [name, raw] of Object.entries(usage)) {
    if (seen.has(name)) continue;
    const window = windowFor(name, raw);
    if (window) windows.push(window);
  }
  return windows;
}

/**
 * Fetches the OpenCode Go plan's subscription quota from `/v1/usage`.
 *
 * The anonymous free tier has no usage surface — it is rate-limited by egress
 * IP, not by an account balance — so this is the keyed `opencode-go` tier
 * only. The endpoint reports percentages for a *shared* subscription: several
 * Go keys can draw on one plan, so no window here may be summed against
 * another account's.
 */
export async function fetchOpenCodeGoQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  const token = credential.trim();
  const payload = (await getJson(
    `https://opencode.ai/zen/go/v1/usage`,
    {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "x-opencode-client": "cli",
    },
    fetcher,
  )) as GoUsagePayload;
  const windows = parseWindows(payload);
  const plan =
    (typeof payload.plan === "string" && payload.plan.trim()) || "OpenCode Go";
  return { source: SOURCE, plan, windows, error: null };
}
