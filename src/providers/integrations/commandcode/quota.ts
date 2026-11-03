/**
 * Command Code quota, read from the billing endpoints its client reads.
 *
 * Monthly allowance and purchased/free credits are separate pooled windows:
 * the monthly cap and reset do not limit or expire the additional balance.
 *
 * The endpoints, all on `https://api.commandcode.ai` (not the Provider API
 * origin the model catalog lives on):
 *
 *   `/alpha/whoami`                  identity, and the `orgId` when one exists
 *   `/alpha/billing/credits`         the balance and any window limits
 *   `/alpha/billing/subscriptions`   the plan, when there is one
 *
 * Identity resolves the organization before billing is read. Billing reads are
 * independent: retain the balance or subscription when the other is unavailable.
 */
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";

const COMMANDCODE_API_BASE = "https://api.commandcode.ai" as const;
const REQUEST_TIMEOUT_MS = 15_000;

const PLAN_CAPS: Readonly<Record<string, number>> = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};

const PLAN_CAP_OVERRIDES: Readonly<Record<string, number>> = {
  "individual-pro-v1": 80,
};

function commandCodePlan(planId: string): { readonly label: string; readonly cap: number | null } {
  const [scope, tier] = planId.toLowerCase().split("-");
  if ((scope !== "individual" && scope !== "teams") || !tier) {
    return { label: planId, cap: PLAN_CAP_OVERRIDES[planId] ?? PLAN_CAPS[planId] ?? null };
  }
  const tierLabel = tier === "goat" ? "GOAT" : `${tier[0]?.toUpperCase() ?? ""}${tier.slice(1)}`;
  const normalizedId = `${scope}-${tier}`;
  return {
    label: `CommandCode ${scope === "teams" ? "Teams " : ""}${tierLabel}`,
    cap: PLAN_CAP_OVERRIDES[planId] ?? PLAN_CAPS[normalizedId] ?? null,
  };
}

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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function isoTimestamp(value: unknown): string | null {
  const numeric = numberOrNull(value);
  if (numeric !== null) {
    if (numeric <= 0) return null;
    const date = new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function withQuery(path: string, params: Readonly<Record<string, string | null>>): string {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== null),
  ).toString();
  return query ? `${path}?${query}` : path;
}

/** Only monthly credits share the subscription allowance and reset. */
function creditWindows(
  credits: Record<string, unknown>,
  planCap: number | null,
  resetsAt: string | null,
): readonly ProviderQuotaWindow[] {
  const monthly = numberOrNull(credits["monthlyCredits"]) ?? 0;
  const purchased = numberOrNull(credits["purchasedCredits"]) ?? 0;
  const free = numberOrNull(credits["freeCredits"]) ?? 0;
  const used = planCap === null ? null : Math.max(0, planCap - monthly);
  const usedPercent = planCap !== null && planCap > 0 && used !== null
    ? Math.min(100, Math.max(0, (used / planCap) * 100))
    : null;
  const windows: ProviderQuotaWindow[] = [{
    kind: "credits",
    label: "Monthly credits",
    accounting: "pooled",
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt,
    used,
    limit: planCap,
    remaining: monthly,
  }];
  if (purchased + free > 0) {
    windows.push({
      kind: "additional_credits",
      label: "Purchased/free credits",
      accounting: "pooled",
      usedPercent: null,
      remainingPercent: null,
      resetsAt: null,
      used: null,
      limit: null,
      remaining: purchased + free,
    });
  }
  return windows;
}

function windowLimits(
  limits: Record<string, unknown>,
): readonly ProviderQuotaWindow[] {
  const out: ProviderQuotaWindow[] = [];
  const fiveHour = recordValue(limits["fiveHour"]);
  const weekly = recordValue(limits["weekly"]);
  const push = (source: Record<string, unknown> | undefined, kind: string, label: string) => {
    if (source === undefined) return;
    const used = numberOrNull(source["used"]) ?? 0;
    const limit = numberOrNull(source["cap"]);
    if ((limit === null || limit <= 0) && used <= 0) return;
    const usedPercent = limit !== null && limit > 0
      ? Math.min(100, Math.max(0, (used / limit) * 100))
      : null;
    out.push({
      kind,
      label,
      accounting: "independent",
      usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      resetsAt: isoTimestamp(source["resetAt"]),
      used,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used),
    });
  };
  push(fiveHour, "five_hour", "Session (5h)");
  push(weekly, "weekly", "Weekly");
  return out;
}

export async function fetchCommandCodeQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const source = "commandcode";
  const whoami = await readJson(withQuery("/alpha/whoami", { limits: "1" }), credential, fetcher);
  if (!whoami.ok) {
    return {
      source,
      plan: null,
      windows: [],
      error: "Command Code did not answer its billing endpoints",
    };
  }

  const whoamiBody = whoami.ok ? recordValue(whoami.value) : undefined;
  const user = recordValue(whoamiBody?.["user"]);
  const organization = recordValue(whoamiBody?.["org"]);
  const orgId = typeof organization?.["id"] === "string" ? organization["id"] : null;
  const accountLabel =
    (typeof user?.["email"] === "string" && user["email"]) ||
    (typeof user?.["userName"] === "string" && user["userName"]) ||
    (typeof user?.["name"] === "string" && user["name"]) ||
    undefined;

  const [creditsRaw, subscriptionRaw] = await Promise.all([
    readJson(withQuery("/alpha/billing/credits", { orgId }), credential, fetcher),
    readJson(withQuery("/alpha/billing/subscriptions", { orgId }), credential, fetcher),
  ]);
  if (!creditsRaw.ok && !subscriptionRaw.ok) {
    return {
      source,
      plan: null,
      windows: [],
      error: "Command Code did not answer its billing endpoints",
      ...(accountLabel === undefined ? {} : { accountLabel }),
    };
  }

  const subscriptionBody = subscriptionRaw.ok ? recordValue(subscriptionRaw.value) : undefined;
  const planRecord = recordValue(subscriptionBody?.["data"]);
  const planId = typeof planRecord?.["planId"] === "string" ? planRecord["planId"] : null;
  const parsedPlan = planId === null ? null : commandCodePlan(planId);
  const plan =
    parsedPlan?.label ??
    (typeof planRecord?.["name"] === "string" ? planRecord["name"] : null) ??
    (creditsRaw.ok ? "Credits" : null);
  const periodEnd = isoTimestamp(planRecord?.["currentPeriodEnd"]);

  const creditsBody = creditsRaw.ok ? recordValue(creditsRaw.value) : undefined;
  const windows: ProviderQuotaWindow[] = [];
  if (creditsBody !== undefined) {
    const credits = recordValue(creditsBody["credits"]);
    if (credits !== undefined) windows.push(...creditWindows(credits, parsedPlan?.cap ?? null, periodEnd));
    const limits = recordValue(creditsBody["windowLimits"]);
    if (limits !== undefined) windows.push(...windowLimits(limits));
  }

  return {
    source,
    plan,
    windows,
    error: null,
    ...(accountLabel === undefined ? {} : { accountLabel }),
  };
}
