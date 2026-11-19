import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { authCredential, getJson, record, text } from "../../quota/quota-contracts";
import { parseLimitWindows } from "../../quota/quota-limit-windows";
import { clineClientHeaders, workosToken } from "./cline";

/**
 * Quota headers carry the same client identity as the dispatch surface.
 *
 * `clineClientHeaders()` is the one builder (the reference client's request
 * layer mirrored, versions tracked to npm latest): the two version headers
 * stay two different versions — `x-client-version` is the Cline CLI (`cline`
 * on npm, the 3.x line) and `x-core-version` is `@cline/sdk`, a separate npm
 * package with its own 0.x release line. Sending the client version in both
 * slots would tell the billing surface our core was a version `@cline/sdk`
 * never published. One set on every surface: two Cline surfaces disagreeing
 * about the same machine is exactly the shape an upstream "please update and
 * re-authenticate" refusal takes, and it is indistinguishable from a dead
 * credential from the response alone.
 *
 * Header identity is not what gates these endpoints: probing `/users/me`,
 * `/users/me/plan` and `/users/me/plan/usage-limits` with no identity headers,
 * the SDK identity and the CLI identity all returned identical responses. The
 * 404 from the plan routes is "no plan history found for user", i.e. account
 * state, not a rejected client.
 */
function clineQuotaHeaders(): Record<string, string> {
  // No `x-task-id`: account and billing calls omit it rather than inventing
  // a per-request identity (the reference client does the same).
  return {
    ...clineClientHeaders(),
    accept: "application/json",
    "content-type": "application/json",
  };
}

const CLINE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5 Hour",
  weekly: "7 Day",
  monthly: "30 Day",
};

/** Reads Cline's `limits[]` array — one entry per billing window. */
function usageWindows(value: unknown): readonly ProviderQuotaWindow[] {
  return [
    ...parseLimitWindows(value, {
      kindPaths: ["type"],
      percentPaths: ["percentUsed"],
      resetPaths: ["resetsAt"],
      limitPaths: ["limit", "entitlement", "total"],
      usedPaths: ["used", "usedCredits"],
      // Cline reports a percentage and a ceiling but no absolute used value,
      // so the absolute is derived rather than left null.
      deriveUsed: (_entry, usedPercent, limit) =>
        usedPercent !== null && limit !== null ? (limit * usedPercent) / 100 : null,
      labelFor: (kind) => CLINE_WINDOW_LABELS[kind] ?? null,
      fallbackLabel: (kind) => kind,
    }),
  ];
}

function isMissingPlanHistory(reason: unknown): boolean {
  const message =
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return /\b404\b|\bno plan history\b/i.test(message);
}

/** Envelope marking a resolved secret as an api key rather than an OAuth grant. */
export const CLINE_API_KEY_PREFIX = "cline-api-key:" as const;

/** Wraps a resolved api_key secret so the collector can route it to /models. */
export function markClineApiKeyCredential(credential: string): string {
  return credential.startsWith(CLINE_API_KEY_PREFIX) ? credential : `${CLINE_API_KEY_PREFIX}${credential}`;
}

export async function fetchClineQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const isApiKey = credential.startsWith(CLINE_API_KEY_PREFIX);
  const bearer = isApiKey ? credential.slice(CLINE_API_KEY_PREFIX.length) : null;

  let headers: Record<string, string>;
  if (isApiKey && bearer) {
    // An api key is its own bearer token: `Authorization: Bearer sk_...`, with
    // no `workos:` prefix.
    //
    // Prefixing it is what produced "Unauthorized: please make sure you're
    // using the latest version of Cline and re-authenticate" — verified against
    // a live key, where the same key returned 200 on `/users/me` bare and 401
    // once `workos:` was prepended. The message names a version problem, so it
    // reads as a client the upstream refuses rather than a malformed header,
    // which is why it went unrecognised for so long.
    headers = { ...clineQuotaHeaders(), authorization: `Bearer ${bearer}` };
  } else {
    const fields = authCredential(credential);
    const access = text(fields.accessToken);
    if (!access) throw new Error("Cline credential has no access token.");
    headers = {
      ...clineQuotaHeaders(),
      authorization: `Bearer ${workosToken(access)}`,
    };
  }
  const me = record(await getJson("https://api.cline.bot/api/v1/users/me", headers, fetcher));
  const userId = text(me?.id);
  if (!userId) throw new Error("Cline account response has no user id.");
  const [planRaw, limitsRaw] = await Promise.allSettled([
    getJson("https://api.cline.bot/api/v1/users/me/plan", headers, fetcher),
    getJson("https://api.cline.bot/api/v1/users/me/plan/usage-limits", headers, fetcher),
  ]);
  const plan = record(planRaw.status === "fulfilled" ? planRaw.value : null);
  const limitsFailed = limitsRaw.status === "rejected";
  const windows = usageWindows(limitsRaw.status === "fulfilled" ? limitsRaw.value : null);
  const error =
    limitsFailed && !isMissingPlanHistory(limitsRaw.reason)
      ? "Failed to fetch quota limits."
      : null;
  return {
    source: "cline",
    plan: text(record(plan?.plan)?.displayName) ?? text(plan?.displayName) ?? "Cline",
    windows,
    error,
  };
}
