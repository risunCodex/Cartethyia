/**
 * Buddy-family (CodeBuddy/WorkBuddy) classification: the account-ban matcher
 * and the three rejection arms that are gated on the buddy provider ids —
 * the policy block (`11140`), the request-scoped rejections, and the channel
 * rejection (`11-128`).
 */
import { isRecord } from "../../../protocol/codecs";
import { BUDDY_PROVIDER_IDS } from "../../provider-metadata";
import type {
  AccountErrorClassification,
  AccountErrorRule,
  AccountErrorSignals,
} from "../account-error-contracts";

/** The wording an upstream uses when it restricted the account, not the request. */
export function banWording(lower: string): boolean {
  return (
    lower.includes("restricted") ||
    lower.includes("has been banned") ||
    lower.includes("unusual activity") ||
    lower.includes("appeal this restriction") ||
    lower.includes("submit feedback to appeal") ||
    lower.includes("account has been") ||
    lower.includes("账号存在异常行为") ||
    lower.includes("帳號存在異常行為")
  );
}

/**
 * Whether the upstream named a restriction on the account itself.
 *
 * The buddy family reuses "request illegal" for two unrelated rejections, and
 * the difference is only in the body:
 *
 * - `11140` carries `displayMsg` about the account being restricted ("Your
 *   account has been restricted due to unusual activity") and `actions`
 *   offering an appeal. That is a ban — the account is refused, not throttled.
 * - `11-128` is a refusal of this request; the account is fine.
 *
 * Proven account-scoped (2026-10-16): two live share-page requests carrying
 * byte-identical bodies and headers to the same model differed only in the
 * pooled account, and the blocked one 400'd while the other 200'd.
 *
 * Matched on the code *and* the account-restriction wording, so an unrelated
 * upstream that happens to say "restricted" in prose cannot disable accounts.
 */
export function isBuddyAccountBanned(
  lower: string,
  providerCode: string,
  upstreamBody: unknown,
): boolean {
  if (providerCode !== "11140") return false;
  if (banWording(lower)) return true;
  // The message alone is not enough, and this is the case that proved it: the
  // provider's message for a ban is the same two words it uses for a refused
  // request — "request illegal" — while the actual verdict ("Your account has
  // been restricted due to unusual activity") lives in `displayMsg`, which the
  // message extractor never reads. Matching only the message therefore read
  // every ban as a mere request refusal: no category, no disable, and the
  // account kept serving.
  const body = isRecord(upstreamBody) ? upstreamBody : undefined;
  if (body === undefined) return false;
  for (const field of ["displayMsg", "displayTips", "msg", "message"]) {
    const value = body[field];
    if (typeof value === "string" && banWording(value.toLowerCase())) return true;
    // `displayMsg` is a per-language map: `{ en: "…", zh: "…" }`. Any
    // language states the same verdict, so all of them are read.
    if (!isRecord(value)) continue;
    for (const nested of Object.values(value)) {
      if (typeof nested === "string" && banWording(nested.toLowerCase())) return true;
    }
  }
  // `actions` names the remedy: an appeal can only be offered for a verdict
  // about the account, and "edit input" only ever describes a request.
  const actions = body["actions"];
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (typeof action !== "string") continue;
      if (action.toLowerCase().includes("appeal") || action.toLowerCase().includes("feedback")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A deterministic content-policy rejection is NOT credential invalidation.
 * CodeBuddy returns HTTP 403 with provider code 11140 ("request illegal",
 * "did not pass the safety review") — refreshing the token cannot change
 * that outcome and the account itself is healthy, so it must never flip the
 * account to auth_invalidated/disabled. Only real auth signals do.
 */
export function policyRejection(providerCode: string, lower: string): boolean {
  return (
    providerCode === "11140" ||
    lower.includes("safety review") ||
    lower.includes("content did not pass") ||
    lower.includes("request illegal") ||
    lower.includes("content blocked") ||
    lower.includes("account suspended")
  );
}

/**
 * These codes are a verdict on the request, not the account. Cooling the
 * account for them burns a healthy credential on a body that will fail the
 * same way on every other account:
 *
 * - `11148` tool-call/result mismatch — the transcript is broken; the
 *   pre-payload repair is supposed to prevent it, and a slip is still the
 *   body's fault.
 * - `11135` the image cannot be processed, `11133` the model rejected a
 *   parameter, `11101` the body failed to parse — deterministic for that
 *   payload.
 * - `12153` the session is dead — a refresh problem, not a reason to park
 *   the account on the first observation.
 * - `14017` trial not activated — the account may recover once registration
 *   finishes, so a hard cooldown would keep it out after it becomes usable.
 */
function requestScoped(providerCode: string, lower: string): boolean {
  return (
    providerCode === "11148" ||
    providerCode === "11135" ||
    providerCode === "11133" ||
    providerCode === "11101" ||
    providerCode === "12153" ||
    providerCode === "14017" ||
    lower.includes("tool_call_sequence_broken") ||
    lower.includes("unmarshal chat params failed") ||
    lower.includes("invalid image_url content") ||
    lower.includes("offline user session not found") ||
    lower.includes("trial not activated") ||
    lower.includes("trial version is not yet activated")
  );
}

/** A channel rejection (`11-128`) refuses the calling channel, not the prompt. */
function channelRejection(providerCode: string, lower: string): boolean {
  // The same verdict arrives under two spellings: the wire code is emitted as
  // a number (`11128`, which `upstreamProviderCode` stringifies) and as the
  // dashed form (`11-128`, which `failure-policy` matches on). Folding the
  // separator keeps one check honest for both.
  return providerCode.replace(/-/g, "") === "11128" || lower.includes("unapproved channel");
}

function isBuddyProvider(providerId: string | undefined): boolean {
  return providerId !== undefined && BUDDY_PROVIDER_IDS.has(providerId.toLowerCase());
}

/**
 * The shared verdict for the buddy family's two refusal surfaces — the policy
 * block (`11140`) and the channel rejection (`11-128`). Both end in the same
 * split: a ban is a verdict on the credential and disables the account at once,
 * a refusal of one request must only stop that request from being retried
 * verbatim (cooling the account there was the bug that made one malformed
 * request look like a dead credential).
 */
function decidePolicyBlock(
  result: AccountErrorSignals["result"],
  reason: AccountErrorSignals["reason"],
  buddyBanned: boolean,
  refusalReason: string,
): AccountErrorClassification {
  if (buddyBanned) {
    // A ban is evidence about the credential even at provider scope, for the
    // same reason a named revocation is: the message is the evidence. Without
    // this a stream frame's missing credential detail would leave a banned
    // account serving. A ban is the one verdict that stays permanently
    // `disabled` — the upstream refused the account itself, not a window, so
    // a cooldown would only return it to rotation to burn sibling accounts
    // again. Only an operator can recover it.
    return result(
      "policy_blocked_banned",
      "disabled",
      0,
      null,
      reason("Account banned by upstream"),
      true,
    );
  }
  return result(
    "policy_blocked_invalid_request",
    "cooldown",
    0,
    null,
    reason(refusalReason),
    // Never mutates: a refused request fails identically on every account, so
    // cooling would burn a healthy credential on the gateway's own fault.
    false,
  );
}

export const buddyPolicyBlockRule: AccountErrorRule = {
  name: "buddy-policy-block",
  // A ban is a verdict on the credential, and cooldown cannot answer it: the
  // account is refused, not throttled. Disabling is the fix, and disabling
  // *immediately* is a feature — a client's retry budget is spent in seconds,
  // so a banned account that merely cooled stayed in the plan and burned
  // sibling accounts that were still healthy before the window expired.
  //
  // The two shapes are told apart by the body, not the code alone: `11140`
  // names a restriction on the account, `11-128` refuses the request.
  match: (s) => s.policyRejection && isBuddyProvider(s.providerId),
  // Not a ban: the upstream refused this request. The account is fine, so the
  // only correct move is to stop retrying it verbatim. Cooling the account
  // here was the bug that made one malformed request look like a dead
  // credential.
  decide: (s) => decidePolicyBlock(s.result, s.reason, s.buddyBanned, "Upstream refused this request"),
};

export const buddyRequestScopedRule: AccountErrorRule = {
  name: "buddy-request-scoped",
  // Recognised before the auth and quota branches: several of these arrive as
  // 401/403/429, which those branches would otherwise treat as account
  // evidence.
  match: (s) => isBuddyProvider(s.providerId) && requestScoped(s.providerCode, s.lower),
  decide: (s) =>
    s.result(
      "unknown",
      "cooldown",
      0,
      null,
      s.reason("Request-scoped upstream rejection"),
      false,
    ),
};

export const buddyChannelBlockRule: AccountErrorRule = {
  name: "buddy-channel-block",
  // A channel rejection (`11-128`) is the same shape as the policy block: the
  // upstream is refusing the caller for this account, not this particular
  // prompt, and it keeps refusing on every invocation. Classifying it as
  // `unknown` with `mutates=false` would leave the account in rotation failing
  // every request — and since every account fails the same way, the whole pool
  // looks dead with nothing ever parked.
  //
  // Same split as the policy arm: a ban disables, a channel refusal only stops
  // this request. `11-128` is the request shape, so this rule nearly always
  // takes the refusal path — but it shares the ban test so a `11140`-shaped
  // body arriving as a channel rejection still disables. On the refusal path
  // the credential is valid and only the calling channel is refused. Cooling
  // was the bug: it kept a refused account in the plan, where a client's retry
  // budget burned healthy siblings for the whole window.
  match: (s) => isBuddyProvider(s.providerId) && channelRejection(s.providerCode, s.lower),
  decide: (s) => decidePolicyBlock(s.result, s.reason, s.buddyBanned, "Provider channel rejection"),
};

/** The buddy arms, in their original evaluation order. */
export const buddyRules: readonly AccountErrorRule[] = [
  buddyPolicyBlockRule,
  buddyRequestScopedRule,
  buddyChannelBlockRule,
];
