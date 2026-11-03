/**
 * ZCode gift-plan claims (the promo packs).
 *
 * This is **not** a check-in: ZCode has no streak, no daily credit and no
 * status/claim pair like the Buddy family. Its gift plans sit unclaimed on the
 * account until a claim is posted, and where they are offered is the tricky
 * part:
 *
 * - `/api/v1/zcode-plan/billing/preview` lists the plans the account may claim;
 * - the app's marketing feed (`/api/v1/marketing/touch`) lists the **banner**
 *   promos — a weekend build that appears in neither `preview` nor `current`
 *   while the app shows its banner.
 *
 * Both reads and the claim are app-only endpoints: a Bearer token alone is
 * answered `3001 parameter error` before auth. They need `X-Device-Mid` (the
 * gateway validates it as a UUID and never binds it to the account) and
 * `X-ZCode-App-Version`.
 *
 * The reply is judged by the body, never the HTTP status: `0` claimed, `1003`
 * already claimed, `3007` the app's Aliyun attestation is missing.
 */
import { createHash } from "node:crypto";
import { sleep } from "../../../shared/sleep";
import { asRecord, asTrimmedString } from "../../../shared/coerce";
import type { ValidatedFetch } from "../../../network/outbound-fetch";

const ZCODE = "https://zcode.z.ai";
const BILLING = `${ZCODE}/api/v1/zcode-plan/billing`;
const TOUCH = `${ZCODE}/api/v1/marketing/touch`;
const APP_VERSION = "3.16.3";
const PLATFORM = "linux-x64";
const TIMEOUT_MS = 15_000;
const CLAIMED_ALREADY = 1003;
const CAPTCHA = 3007;
/** The upstream answers these under load; the same call succeeds later. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_TRIES = 3;

export type ZcodeGiftState = "claimed" | "already_claimed" | "nothing" | "captcha" | "partial" | "error";

export interface ZcodeGiftResult {
  readonly state: ZcodeGiftState;
  readonly claimed: readonly string[];
  readonly detail: string | null;
}

/** Stable per account — a per-request device id is itself a jitter signal. */
function deviceMid(accountId: string): string {
  const hash = createHash("sha256").update(`zcode-device\0${accountId}`).digest("hex");
  const variant = ((parseInt(hash[16] as string, 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function headers(credential: string, accountId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Device-Mid": deviceMid(accountId),
    "X-Client-Language": "en-US",
    "X-ZCode-App-Version": APP_VERSION,
    "X-Platform": PLATFORM,
  };
}

/** The claim actions a marketing delivery offers, and the plan's own name. */
function bannerClaims(delivery: unknown): { plans: Array<{ planId: string; name: string | null }>; malformed: boolean } {
  const ids: string[] = [];
  const names: string[] = [];
  let malformed = false;
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    if (asTrimmedString(record["type"]) === "claim_zcode_plan") {
      const planId = asTrimmedString(asRecord(record["args"])?.["plan_id"]);
      if (planId !== undefined) ids.push(planId);
      else malformed = true;
    }
    const plan = asRecord(record["zcode_plan"]);
    const name = asTrimmedString(plan?.["name"]);
    if (name !== undefined) names.push(name);
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(delivery, 0);
  const name = names[0] ?? null;
  return { plans: ids.map((planId) => ({ planId, name })), malformed };
}

/** Only a successful, readable envelope can represent an empty list. */
async function read(
  fetcher: ValidatedFetch,
  url: string,
  credential: string,
  accountId: string,
): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  let response = await fetcher(url, {
    method: "GET",
    headers: headers(credential, accountId),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  for (let attempt = 1; RETRY_STATUSES.has(response.status) && attempt < RETRY_TRIES; attempt += 1) {
    await sleep(1_500 * attempt);
    response = await fetcher(url, {
      method: "GET",
      headers: headers(credential, accountId),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  const payload = asRecord(await response.json().catch(() => null));
  if (!response.ok || !payload || payload["success"] === false) return { ok: false, data: null };
  const code = payload["code"];
  if (![0, 200, "0", "200"].includes(code as string | number)) return { ok: false, data: null };
  // Successful empty lists omit data (or return null) on the app endpoints.
  if (payload["data"] == null) return { ok: true, data: null };
  const data = asRecord(payload["data"]);
  return { ok: data !== undefined && data !== null, data: data ?? null };
}

/**
 * Every plan the account may claim, once each. A `null` for a list means it
 * did not read — never "nothing to claim".
 */
async function toClaim(
  fetcher: ValidatedFetch,
  credential: string,
  accountId: string,
): Promise<{ plans: Array<{ planId: string; name: string | null }>; unread: string[] }> {
  const plans: Array<{ planId: string; name: string | null }> = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  const add = (planId: string, name: string | null): void => {
    if (seen.has(planId)) return;
    seen.add(planId);
    plans.push({ planId, name });
  };

  try {
    const feed = await read(fetcher, `${TOUCH}?seq=0`, credential, accountId);
    if (!feed.ok) unread.push("marketing feed did not read");
    else {
      const deliveries = feed.data?.["deliveries"];
      if (deliveries != null && (!Array.isArray(deliveries) || deliveries.some((delivery) => !asRecord(delivery)))) {
        unread.push("marketing feed has no delivery list");
      }
      for (const delivery of Array.isArray(deliveries) ? deliveries : []) {
        const banner = bannerClaims(delivery);
        if (banner.malformed) unread.push("marketing feed has an invalid claim action");
        for (const claim of banner.plans) add(claim.planId, claim.name ?? claim.planId);
      }
    }
  } catch {
    unread.push("marketing feed did not read");
  }

  try {
    const preview = await read(
      fetcher,
      `${BILLING}/preview?app_version=${APP_VERSION}&platform=${PLATFORM}`,
      credential,
      accountId,
    );
    if (!preview.ok) unread.push("billing preview did not read");
    else {
      const listed = preview.data?.["plans"];
      if (listed != null && !Array.isArray(listed)) unread.push("billing preview has no plan list");
      for (const entry of Array.isArray(listed) ? listed : []) {
        const plan = asRecord(entry);
        const planId = asTrimmedString(plan?.["plan_id"]);
        if (planId === undefined) {
          unread.push("billing preview has an invalid plan");
          continue;
        }
        add(planId, asTrimmedString(plan?.["name"]) ?? planId);
      }
    }
  } catch {
    unread.push("billing preview did not read");
  }

  return { plans, unread };
}

/** Posts one claim and says what the body's own code means. */
async function claimOne(
  fetcher: ValidatedFetch,
  credential: string,
  accountId: string,
  planId: string,
): Promise<"claimed" | "already_claimed" | "captcha" | "failed"> {
  let response = await fetcher(`${BILLING}/claim`, {
    method: "POST",
    headers: headers(credential, accountId),
    body: JSON.stringify({ plan_id: planId }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  for (let attempt = 1; RETRY_STATUSES.has(response.status) && attempt < RETRY_TRIES; attempt += 1) {
    await sleep(1_500 * attempt);
    response = await fetcher(`${BILLING}/claim`, {
      method: "POST",
      headers: headers(credential, accountId),
      body: JSON.stringify({ plan_id: planId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  const payload = asRecord(await response.json().catch(() => null));
  const rawCode = payload?.["code"];
  const code = typeof rawCode === "string" && rawCode.trim() !== "" ? Number(rawCode) : rawCode;
  if (payload?.["success"] === false) return "failed";
  if (code === CAPTCHA) return "captcha";
  if (code === CLAIMED_ALREADY) return "already_claimed";
  if (code === 0 && response.ok) return "claimed";
  return "failed";
}

/** Claims every gift plan ZCode offers the account. */
export async function claimZcodeGifts(args: {
  readonly accountId: string;
  readonly credential: string;
  readonly fetcher: ValidatedFetch;
}): Promise<ZcodeGiftResult> {
  const { accountId, credential, fetcher } = args;
  if (!credential) return { state: "error", claimed: [], detail: "account has no credential" };
  try {
    const { plans, unread } = await toClaim(fetcher, credential, accountId);
    if (plans.length === 0) {
      return unread.length > 0
        ? { state: "error", claimed: [], detail: unread.join("; ") }
        : { state: "nothing", claimed: [], detail: null };
    }
    const claimed: string[] = [];
    const already: string[] = [];
    const captcha: string[] = [];
    const failed: string[] = [];
    for (const plan of plans) {
      const outcome = await claimOne(fetcher, credential, accountId, plan.planId).catch(() => "failed" as const);
      const name = plan.name ?? plan.planId;
      if (outcome === "claimed") claimed.push(name);
      else if (outcome === "already_claimed") already.push(name);
      else if (outcome === "captcha") captcha.push(name);
      else failed.push(name);
    }
    const detail = [
      captcha.length ? "CAPTCHA required; claim in the ZCode app" : "",
      failed.length ? `${failed.length} gift claim(s) failed` : "",
      ...unread,
    ].filter(Boolean).join("; ");
    const outcomes = [claimed.length > 0 || already.length > 0, captcha.length > 0, failed.length > 0 || unread.length > 0];
    if (outcomes.filter(Boolean).length > 1) return { state: "partial", claimed, detail: detail || null };
    if (failed.length > 0 || unread.length > 0) return { state: "error", claimed, detail: detail || null };
    if (captcha.length > 0) return { state: "captcha", claimed, detail: detail || null };
    if (claimed.length > 0) return { state: "claimed", claimed, detail: null };
    return { state: "already_claimed", claimed, detail: null };
  } catch {
    return {
      state: "error",
      claimed: [],
      detail: "Gift claim request failed",
    };
  }
}
