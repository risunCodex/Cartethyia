/**
 * Command Code quota, read from the four billing endpoints its client reads.
 *
 * Command Code bills in credits, not in rate-limit windows, so a quota row here
 * is a credit balance rather than a 5-hour/weekly pair. The shape the console
 * renders still expects windows, so the balance is reported as one independent
 * window — the honest reading, since credits are the only thing consumed.
 *
 * The endpoints, all on `https://api.commandcode.ai` (not the Provider API
 * origin the model catalog lives on):
 *
 *   `/alpha/whoami`                  identity, and the `orgId` when one exists
 *   `/alpha/billing/credits`         the balance and any window limits
 *   `/alpha/billing/subscriptions`   the plan, when there is one
 *   `/alpha/usage/summary`           spend in the period, for context
 *
 * Every call is optional to the result: a failure reports what is still known
 * rather than failing the whole read, because an operator who can see a zero
 * balance has already got the answer even if the usage summary never came back.
 */
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";

const COMMANDCODE_API_BASE = "https://api.commandcode.ai" as const;
const REQUEST_TIMEOUT_MS = 15_000;

interface RequestOk {
  readonly ok: true;
  readonly value: unknown;
}
interface RequestFailed {
  readonly ok: false;
}
type RequestResult = RequestOk | RequestFailed;

async function readJson(
  path: string,
  credential: string,
  fetcher: FetchLike,
): Promise<RequestResult> {
  try {
    const response = await fetcher(`${COMMANDCODE_API_BASE}${path}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false };
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The credit block: three balances that are summed, plus any window limits. */
function creditWindow(credits: Record<string, unknown>): ProviderQuotaWindow | null {
  const monthly = numberOrNull(credits["monthlyCredits"]) ?? 0;
  const purchased = numberOrNull(credits["purchasedCredits"]) ?? 0;
  const free = numberOrNull(credits["freeCredits"]) ?? 0;
  const remaining = monthly + purchased + free;
  // Command Code reports no ceiling for a credit balance, so there is no
  // percentage to compute — unlike a rate-limit window, where the upstream
  // states both sides. Reporting null is the truthful answer.
  return {
    kind: "credits",
    label: "Credits",
    // These are credits in one unit that can be spent interchangeably, so
    // they are pooled like Qoder's plan/granted balances — not independent
    // rate-limit lanes. The account-row pill and the Quota page both sum
    // pooled windows, so this must be `pooled` or the balance never renders.
    accounting: "pooled",
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    remaining,
  };
}

function windowLimits(
  limits: Record<string, unknown>,
): readonly ProviderQuotaWindow[] {
  const out: ProviderQuotaWindow[] = [];
  const fiveHour = recordValue(limits["fiveHour"]);
  const weekly = recordValue(limits["weekly"]);
  const push = (source: Record<string, unknown> | undefined, kind: string, label: string) => {
    if (source === undefined) return;
    out.push({
      kind,
      label,
      accounting: "independent",
      usedPercent: numberOrNull(source["usedPercent"]),
      remainingPercent: numberOrNull(source["remainingPercent"]),
      resetsAt: typeof source["resetsAt"] === "string" ? source["resetsAt"] : null,
      remaining: numberOrNull(source["remaining"]),
    });
  };
  push(fiveHour, "five_hour", "5 Hour");
  push(weekly, "weekly", "Weekly");
  return out;
}

export async function fetchCommandCodeQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const source = "commandcode";
  const [whoami, creditsRaw, subscriptionRaw] = await Promise.all([
    readJson("/alpha/whoami", credential, fetcher),
    readJson("/alpha/billing/credits", credential, fetcher),
    readJson("/alpha/billing/subscriptions", credential, fetcher),
  ]);
  if (!whoami.ok && !creditsRaw.ok) {
    return {
      source,
      plan: null,
      windows: [],
      error: "Command Code did not answer its billing endpoints",
    };
  }

  const whoamiBody = whoami.ok ? recordValue(whoami.value) : undefined;
  const user = recordValue(whoamiBody?.["user"]);
  const accountLabel =
    (typeof user?.["email"] === "string" && user["email"]) ||
    (typeof user?.["userName"] === "string" && user["userName"]) ||
    undefined;

  const creditsBody = creditsRaw.ok ? recordValue(creditsRaw.value) : undefined;
  const windows: ProviderQuotaWindow[] = [];
  if (creditsBody !== undefined) {
    const credits = recordValue(creditsBody["credits"]);
    if (credits !== undefined) {
      const window = creditWindow(credits);
      if (window !== null) windows.push(window);
    }
    const limits = recordValue(creditsBody["windowLimits"]);
    if (limits !== undefined) windows.push(...windowLimits(limits));
  }

  const subscriptionBody = subscriptionRaw.ok ? recordValue(subscriptionRaw.value) : undefined;
  const planRecord = recordValue(subscriptionBody?.["data"]);
  const plan =
    typeof planRecord?.["name"] === "string"
      ? planRecord["name"]
      : creditsRaw.ok
        ? "Credits"
        : null;

  return {
    source,
    plan,
    windows,
    error: null,
    ...(accountLabel === undefined ? {} : { accountLabel }),
  };
}
