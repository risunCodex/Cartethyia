// Kiro (Kiro Control Plane) quota.
//
// Billing lives on the Kiro control-plane (management) service — in the
// 1.4.62 build `GetUsageLimits` is `GET /Get-Usage-Limits` on
// `https://management.{region}.kiro.dev`. The legacy `codewhisperer.*` /
// `q.*` AWS usage surfaces are no longer used.
//
// The account's region and profile matter here for the same reason they matter
// at dispatch: the request is scoped to them, and an account-bound credential
// must not be sent the shared placeholder profile.
//
// The usage surface is one of the places the upstream correlates a credential
// against the device it belongs to, so it presents the same frozen machine id
// and the same connection discipline as dispatch. A credential that reports one
// device here and another at dispatch is the shape this gateway exists to avoid.

import type {
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import {
  isoDate,
  number,
  percentWindow,
  quotaRecord,
  record,
  text,
} from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import {
  buildKiroAmzUserAgent,
  buildKiroRuntimeUserAgent,
  getKiroVersion,
} from "../../operations/client-versions";
import { machineIdForAuthState } from "./kiro-machine-id";
import { resolveKiroProfileArn } from "./kiro-profile";
import { AWS_REGION_PATTERN, KIRO_DEFAULT_REGION, KIRO_MANAGEMENT_HOST_TEMPLATE } from "./kiro-catalog";

/**
 * The fetcher shape this module needs: a plain callable. `FetchLike` from the
 * quota contracts is the global `typeof fetch` (which carries extra callable
 * properties like `preconnect`), and the OAuth client passes its narrower
 * structural `FetchLike` here — so accept the common callable shape instead of
 * either full type.
 */
type KiroFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface KiroQuotaAuth {
  readonly region: string;
  readonly authMethod: string;
  readonly profileArn: string;
  readonly machineId: string;
}

/** Reads the account's auth configuration for the quota call. */
function quotaAuth(context: QuotaCollectionContext | undefined): KiroQuotaAuth {
  const raw = context?.auth_state ?? {};
  const regionRaw = typeof raw["region"] === "string" ? raw["region"].trim() : "";
  const region = AWS_REGION_PATTERN.test(regionRaw) ? regionRaw : KIRO_DEFAULT_REGION;
  const authMethod = typeof raw["authMethod"] === "string" ? raw["authMethod"] : "builder-id";
  // The usage surface is profile-scoped and refuses a request without the field,
  // exactly as generation does, so it scopes to the same value generation does:
  // the account's own resolved profile, or nothing.
  const profileArn = resolveKiroProfileArn(raw);
  // The quota call reaches the same upstream as dispatch, so it presents the
  // same device identity through the same resolver. Deriving it independently
  // here is how one account ends up reporting two devices.
  const machineId = machineIdForAuthState(raw);
  return { region, authMethod, profileArn, machineId };
}

/** Headers every usage attempt shares. */
function usageHeaders(credential: string, auth: KiroQuotaAuth): Record<string, string> {
  const version = getKiroVersion();
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential}`,
    accept: "application/json",
    connection: "close",
    "amz-sdk-request": "attempt=1; max=1",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "x-amz-user-agent": buildKiroAmzUserAgent(version, auth.machineId),
    "user-agent": buildKiroRuntimeUserAgent(version, auth.machineId),
    "x-kiro-machineid": auth.machineId,
  };
  if (auth.authMethod === "api_key") headers["TokenType"] = "API_KEY";
  else if (auth.authMethod === "external_idp") headers["TokenType"] = "EXTERNAL_IDP";
  else if (auth.authMethod === "idc") headers["TokenType"] = "SSO_OIDC";
  return headers;
}

/** One usage breakdown entry → a quota window. */
function breakdownWindow(breakdown: Record<string, unknown>, reset: string | null): ProviderQuotaWindow | null {
  const used = number(breakdown["currentUsageWithPrecision"]) ?? number(breakdown["currentUsage"]);
  const limit = number(breakdown["usageLimitWithPrecision"]) ?? number(breakdown["usageLimit"]);
  if (used === null || limit === null || limit <= 0) return null;
  const kind = text(breakdown["resourceType"])?.toLowerCase() ?? "unknown";
  return percentWindow(kind, kind, (used / limit) * 100, reset, used, limit, "independent");
}

/** The free-trial entry beside a breakdown, when the account has one. */
function freeTrialWindow(breakdown: Record<string, unknown>, reset: string | null): ProviderQuotaWindow | null {
  const trial = record(breakdown["freeTrialInfo"]);
  if (trial === null) return null;
  const used = number(trial["currentUsageWithPrecision"]) ?? number(trial["currentUsage"]);
  const limit = number(trial["usageLimitWithPrecision"]) ?? number(trial["usageLimit"]);
  if (used === null || limit === null || limit <= 0) return null;
  const kind = text(breakdown["resourceType"])?.toLowerCase() ?? "unknown";
  return percentWindow(
    `${kind}_freetrial`,
    `${kind} (free trial)`,
    (used / limit) * 100,
    isoDate(trial["freeTrialExpiry"]) ?? reset,
    used,
    limit,
    "independent",
  );
}

/** Parses the usage payload into windows. */
function parseUsage(payload: unknown): ProviderQuotaResult {
  const root = quotaRecord(payload);
  const reset = isoDate(root["nextDateReset"]) ?? isoDate(root["resetDate"]);
  const list = root["usageBreakdownList"];
  const windows: ProviderQuotaWindow[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      const breakdown = record(entry);
      if (breakdown === null) continue;
      const window = breakdownWindow(breakdown, reset);
      if (window !== null) windows.push(window);
      const trial = freeTrialWindow(breakdown, reset);
      if (trial !== null) windows.push(trial);
    }
  }
  const subscription = record(root["subscriptionInfo"]);
  // The bundle asks with `isEmailRequired: true`, and the upstream then reports
  // the account's email in `userInfo.email`. That is the only identity a social/
  // imported token exposes (the access token itself is opaque, not a JWT), so it
  // becomes the suggested account label for the refresh sweep to adopt.
  const userInfo = record(root["userInfo"]);
  const email = text(userInfo?.["email"]);
  return {
    source: "kiro",
    plan: text(subscription?.["subscriptionTitle"]) ?? "Kiro",
    windows,
    error: null,
    ...(email === null ? {} : { accountLabel: email }),
  };
}

/**
 * Reads Kiro's usage limits.
 *
 * Three surfaces are attempted in turn because which one answers depends on the
 * account's auth family and region; an auth refusal is remembered so the
 * reported error names the real cause instead of the last transport failure.
 */
export async function fetchKiroQuota(
  credential: string,
  fetcher: KiroFetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  const token = credential.trim();
  if (token.length === 0) throw new Error("Kiro credential is empty.");
  const auth = quotaAuth(context);
  const headers = usageHeaders(token, auth);
  const query = new URLSearchParams({
    isEmailRequired: "true",
    origin: "AI_EDITOR",
    resourceType: "AGENTIC_REQUEST",
  });
  // The 1.4.62 client sends the profile in the query (`GetUsageLimitsCommand`
  // with `{origin, profileArn, resourceType, isEmailRequired}`). Without it the
  // upstream answers 400 `Invalid profileArn.` — and there is no POST surface;
  // the legacy `codewhisperer.*`/`q.*` AWS usage paths are gone.
  if (auth.profileArn.length > 0) query.set("profileArn", auth.profileArn);

  const managementHost = KIRO_MANAGEMENT_HOST_TEMPLATE.replace("{region}", auth.region);
  const attempts: readonly { readonly name: string; readonly run: () => Promise<Response> }[] = [
    {
      name: "management-get",
      run: () =>
        fetcher(`${managementHost}/Get-Usage-Limits?${query.toString()}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15_000),
        }),
    },
  ];

  let sawAuthRefusal = false;
  let lastError = "Unable to fetch Kiro usage right now.";
  for (const attempt of attempts) {
    let response: Response;
    try {
      response = await attempt.run();
    } catch (error) {
      lastError = `${attempt.name}: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    if (!response.ok) {
      await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) sawAuthRefusal = true;
      lastError = `${attempt.name}: HTTP ${response.status}`;
      continue;
    }
    const payload = await response.json().catch(() => undefined);
    if (payload === undefined) {
      lastError = `${attempt.name}: response was not JSON`;
      continue;
    }
    return parseUsage(payload);
  }

  // A refused credential is the actionable answer, and it is the same whichever
  // surface refused it — say that rather than the last transport error.
  if (sawAuthRefusal) {
    return {
      source: "kiro",
      plan: null,
      windows: [],
      error: "Kiro rejected the stored credential for usage. Reconnect the account if this persists.",
    };
  }
  return { source: "kiro", plan: null, windows: [], error: lastError };
}
