export interface QuotaBarTone {
  bar: string;
  text: string;
}

interface QuotaSummaryWindow {
  readonly accounting: "pooled" | "independent";
  readonly remainingPercent: number | null;
  readonly remaining?: number | null;
  readonly used?: number | null;
  readonly limit?: number | null;
  readonly startsAt?: string | null;
  readonly resetsAt?: string | null;
  readonly recurring?: boolean;
  readonly modelIds?: readonly string[];
}

/** A scoped reset ends that grant, even when the provider calls it recurring. */
export function quotaWindowState(window: Pick<QuotaSummaryWindow, "startsAt" | "resetsAt" | "recurring" | "modelIds">): "current" | "future" | "expired" {
  const now = Date.now();
  if (window.resetsAt && (window.modelIds?.length || window.recurring === false) && new Date(window.resetsAt).getTime() <= now) return "expired";
  if (window.startsAt && new Date(window.startsAt).getTime() > now) return "future";
  return "current";
}

export function formatResetDistance(value: string | null, recurring = true): string {
  if (!value) return "";
  const remaining = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return recurring ? "Resetting soon" : "Expired";
  const prefix = recurring ? "Resets in" : "Expires in";
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${prefix} ${totalMinutes}mins`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${prefix} ${totalHours}h${minutes > 0 ? ` ${minutes}mins` : ""}`;
  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const suffix = `${hours > 0 ? ` ${hours}h` : ""}${minutes > 0 ? ` ${minutes}mins` : ""}`;
  if (totalDays >= 365) {
    const years = Math.floor(totalDays / 365);
    const days = totalDays % 365;
    return `${prefix} ${years}y${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  if (totalDays >= 30) {
    const months = Math.floor(totalDays / 30);
    const days = totalDays % 30;
    return `${prefix} ${months}mo${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  return `${prefix} ${totalDays}d${suffix}`;
}

function shortStartPlanName(name: string): string {
  if (/^(?:zcode\s+)?start plan$/i.test(name)) return "Start";
  if (/^zcode global build$/i.test(name)) return "Global Build";
  return name;
}

export function formatQuotaPlanLabel(plan: string, source: string | null): string {
  if (source !== "zcode-start") return plan;
  const names = plan.split(",").map((name) => name.trim()).filter(Boolean);
  const first = names.find((name) => shortStartPlanName(name) === "Start") ?? names[0];
  if (!first) return plan;
  return `${shortStartPlanName(first)}${names.length > 1 ? ` +${names.length - 1}` : ""}`;
}

export function formatQuotaWindowLabel(label: string, source?: string | null, modelIds?: readonly string[]): string {
  if (source === "zcode-start") {
    const parts = label.split(" · ");
    if (parts.length > 1 && modelIds?.some((model) => model.toLowerCase() === parts[0]?.replace(/-trial$/i, "").toLowerCase())) parts.shift();
    return parts.map((part) => {
      if (part === "daily") return "Daily";
      if (part === "nightly") return "Nightly";
      if (part === "one-time") return "One-time";
      return shortStartPlanName(part);
    }).join(" · ");
  }
  const match = /^(\d+)\s*hour$/i.exec(label.trim());
  if (!match) return label;
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) return label;
  if (hours === 24) return "Daily";
  if (hours === 168) return "Weekly";
  if (hours === 720) return "Monthly";
  if (hours === 8760) return "Yearly";
  // The guard must test the value that is actually emitted. The day remainder is
  // `Math.floor(remainder / 24)`, a whole number of DAYS, so testing the raw hour
  // remainder emitted a "0d" suffix for any remainder in 1..23 hours — a day count
  // that reads as "less than a day", the opposite of a window just past a month.
  if (hours >= 8760) {
    const days = Math.floor((hours % 8760) / 24);
    return `${Math.floor(hours / 8760)}y${days > 0 ? ` ${days}d` : ""}`;
  }
  if (hours >= 720) {
    const days = Math.floor((hours % 720) / 24);
    return `${Math.floor(hours / 720)}mo${days > 0 ? ` ${days}d` : ""}`;
  }
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24 > 0 ? ` ${hours % 24}h` : ""}`;
  return `${hours}h`;
}

export function formatQuotaRefresh(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `Last refreshed: ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
    : "";
}

export interface QuotaPillSummary {
  /** Absolute remaining credits across pooled windows, when any window reports one. */
  readonly remaining: number;
  /** Absolute ceiling across pooled windows (sum of limits), when known. */
  readonly total: number;
  /** Whether any pooled window reported a usable balance. */
  readonly hasCredits: boolean;
  /** Lowest remaining percent across independent windows, when reported. */
  readonly lowestPercent: number | null;
  /** Display text; null when there is nothing to show. */
  readonly text: string | null;
  /** True when the allowance is effectively spent (warn tone). */
  readonly low: boolean;
  readonly available: boolean;
  readonly empty: boolean;
}

/** Pooled credits add; account-wide limits constrain; model grants are alternatives. */
export function quotaPillSummary(windows: readonly QuotaSummaryWindow[]): QuotaPillSummary {
  let remaining = 0;
  let total = 0;
  let hasCredits = false;
  let hasUnknownLimit = false;
  let lowestPercent: number | null = null;
  const models = new Map<string, number | null>();
  let hasScopedWindows = false;
  let hasExpired = false;
  for (const window of windows) {
    const state = quotaWindowState(window);
    if (window.modelIds?.length) hasScopedWindows = true;
    if (state === "future") continue;
    if (state === "expired") hasExpired = true;
    if (window.modelIds?.length) {
      const balance = state === "expired" ? 0
        : window.remainingPercent ?? window.remaining
          ?? (window.limit != null && window.used != null ? window.limit - window.used : null);
      const known = typeof balance === "number" && Number.isFinite(balance) ? balance : null;
      for (const model of window.modelIds) {
        const previous = models.get(model);
        models.set(model, previous === undefined ? known
          : previous !== null && previous > 0 ? Math.max(previous, known ?? 0)
            : known !== null && known > 0 ? known
              : previous === null || known === null ? null : Math.max(previous, known));
      }
      continue;
    }
    if (state === "expired") continue;
    if (window.accounting === "pooled") {
      const limit =
        typeof window.limit === "number" && Number.isFinite(window.limit) ? window.limit : null;
      let left: number | null = null;
      if (typeof window.remaining === "number" && Number.isFinite(window.remaining)) {
        left = window.remaining;
      } else if (limit !== null && typeof window.used === "number" && Number.isFinite(window.used)) {
        left = limit - window.used;
      }
      // A reported 0/0 is a spent balance, not an absence of data. Only a
      // window with neither side is skipped.
      if (left !== null) {
        remaining += Math.max(0, left);
        if (limit !== null) total += limit;
        else hasUnknownLimit = true;
        hasCredits = true;
      }
      continue;
    }
    if (typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)) {
      const clamped = Math.min(100, Math.max(0, window.remainingPercent));
      lowestPercent = lowestPercent === null ? clamped : Math.min(lowestPercent, clamped);
    }
  }
  let displayText: string | null = null;
  const availableModels = [...models.values()].filter((balance) => balance !== null && balance > 0).length;
  const constrained = (hasCredits && remaining <= 0) || (lowestPercent !== null && lowestPercent <= 0);
  const available = !constrained && (hasScopedWindows ? availableModels > 0 : remaining > 0 || (lowestPercent !== null && lowestPercent > 0));
  // Future-only/unknown quota is not proof of exhaustion; spent current grants are.
  const empty = constrained || (hasScopedWindows
    ? models.size > 0 && [...models.values()].every((balance) => balance !== null && balance <= 0)
    : hasExpired && !hasCredits && lowestPercent === null);
  if (hasCredits) {
    displayText = total > 0 && !hasUnknownLimit ? `${trimNumber(remaining)} of ${trimNumber(total)}` : `${trimNumber(remaining)} left`;
  } else if (!hasScopedWindows && lowestPercent !== null) {
    displayText = `${Math.round(lowestPercent)}% left`;
  }
  if (models.size > 0) {
    const modelText = `${constrained ? 0 : availableModels} of ${models.size} models available`;
    displayText = displayText ? `${displayText} · ${modelText}` : modelText;
    if (lowestPercent !== null) displayText += ` · ${Math.round(lowestPercent)}% account limit left`;
  }
  const low = empty || (lowestPercent ?? 100) <= 10;
  return { remaining, total, hasCredits, lowestPercent, text: displayText, low, available, empty };
}

function trimNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function friendlyQuotaError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower.includes("invalidated") ||
    lower.includes("reauthorization") ||
    lower.includes("refresh token revoked")
  )
    return "OAuth account invalidated — re-login required";
  // Collectorless providers never refresh, so this backend string should no
  // longer surface — but a stale cached error may still carry it. Keep the
  // mapping as a safety net, not a state the UI can reach fresh.
  if (lower.includes("endpoint is not available") || lower === "not available")
    return "Quota tracking is not supported for this provider";
  if (lower.includes("overloaded") || lower.includes("capacity") || lower.includes("temporarily unavailable"))
    return "Provider capacity unavailable — retry after the indicated time";
  if (lower.includes("usage limit") || lower.includes("quota") || lower.includes("rate limit"))
    return "Quota exhausted or rate limited — wait for reset";
  if (lower.includes("http 500") || lower.includes("internal server error"))
    return "Provider temporarily unavailable — retry in a moment";
  if (lower.includes("http 429") || lower.includes("too many requests"))
    return "Rate limited — slow down requests";
  if (lower.includes("http 401") || lower.includes("unauthorized") || lower.includes("invalid"))
    return "Credential expired — re-login or refresh token";
  if (lower.includes("http 403") || lower.includes("forbidden"))
    return "Access denied — check account permissions";
  if (lower.includes("http 402") || lower.includes("payment"))
    return "Payment required — top up account balance";
  if (lower.includes("connect") || lower.includes("network") || lower.includes("timeout"))
    return "Network error — check connection and retry";
  return "Provider error — inspect account health details";
}

export function quotaBarTone(remaining: number | null): QuotaBarTone {
  if (remaining === null) return { bar: "var(--text-tertiary)", text: "var(--text-tertiary)" };
  if (remaining < 20) return { bar: "var(--red)", text: "var(--red)" };
  if (remaining < 50) return { bar: "var(--orange)", text: "var(--orange)" };
  return { bar: "var(--green)", text: "var(--green)" };
}

/** Maximum quota windows shown together in an account card. */
export const QUOTA_WINDOWS_PER_PAGE = 4;

/** Returns a bounded quota-window slice and the normalized page position. */
export function paginateQuotaWindows<T>(
  windows: readonly T[],
  requestedPage: number,
): {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
  readonly startIndex: number;
} {
  const pageCount = Math.ceil(windows.length / QUOTA_WINDOWS_PER_PAGE);
  const lastPage = Math.max(0, pageCount - 1);
  const safeRequestedPage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0;
  const page = Math.min(Math.max(0, safeRequestedPage), lastPage);
  const startIndex = page * QUOTA_WINDOWS_PER_PAGE;
  return {
    items: windows.slice(startIndex, startIndex + QUOTA_WINDOWS_PER_PAGE),
    page,
    pageCount,
    startIndex,
  };
}

export interface AccountIdentity {
  readonly primary: string;
  readonly secondary: string | null;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isTokenHint(value: string): boolean {
  return value.startsWith("eyJ") || value.startsWith("sk-") || value.startsWith("…");
}

export function displayAccountHint(hint: string, name: string): string {
  if (hint.startsWith("eyJ") || hint === "—") return name;
  return hint;
}

/** Credential-kind labels are categories, not identities — never displayed. */
const NON_IDENTITY_HINTS: ReadonlySet<string> = new Set(["oauth", "api_key", "none"]);

export function accountIdentity(hint: string, name: string): AccountIdentity {
  const fallbackName = name.trim() || "Unnamed account";
  const normalizedHint = displayAccountHint(hint, fallbackName).trim();
  const usableHint =
    normalizedHint && normalizedHint !== "—" && !NON_IDENTITY_HINTS.has(normalizedHint.toLowerCase())
      ? normalizedHint
      : null;
  const email =
    [usableHint, fallbackName].find((value): value is string => value !== null && isEmail(value)) ??
    null;
  if (email !== null) {
    const secondary =
      [fallbackName, usableHint].find(
        (value): value is string => value !== null && value !== email && !isTokenHint(value),
      ) ?? null;
    return { primary: email, secondary };
  }
  const secondary =
    usableHint !== null && usableHint !== fallbackName && !isTokenHint(usableHint)
      ? usableHint
      : null;
  return { primary: fallbackName, secondary };
}
