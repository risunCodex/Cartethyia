/**
 * What one provider-probe answer means about the egress.
 *
 * Extracted from the store so the console, the CLI probe
 * (`scripts/tools/probe-egress.ts`) and the tests cannot drift into three
 * readings of the same response. The rule that matters is not obvious:
 *
 * **The provider's IP gate runs before it validates the body.** So a `4xx`
 * complaint about the payload proves the address was accepted — it is the
 * probe's request that is wrong, not the proxy. Mapping that to `unreachable`
 * ("the probe could not complete") blamed the proxy for our own defect and hid
 * working egresses behind a verdict that said the pool was unusable.
 *
 * Only the free-tier refusal retires an address. Every other answer either says
 * the address works (`allowed`, `throttled`) or says nothing about it
 * (`unreachable`), and treating "says nothing" as "refused" would drop a usable
 * pool for good.
 *
 * The 403-free-tier and 429 verdicts are the probe's reading of the same facts
 * `classifyEgressFailure` (in `network/verdict`) reads on the
 * dispatch path — for the probe they arrive as an HTTP status + body instead of
 * a `GatewayError`, so the shared free-tier regex is borrowed from there to
 * keep the two classifiers' boundaries honest.
 */

import { FREE_TIER_REFUSAL } from "../../../network/verdict";

export type ProbeVerdict = "allowed" | "blocked" | "throttled" | "unreachable";

export interface ProbeAnswer {
  readonly status: ProbeVerdict;
  /** Operator-facing reason; absent when the answer needs none. */
  readonly reason?: string;
}

/**
 * Classifies one upstream response.
 *
 * `407` is separated from the generic 4xx branch on purpose: it comes from the
 * proxy front door, never from the provider, so it is a credential problem on
 * the tunnel and says nothing about whether the address is refused.
 */
export function classifyProviderProbeAnswer(httpStatus: number, body: string): ProbeAnswer {
  if (httpStatus === 403 && FREE_TIER_REFUSAL.test(body)) {
    return { status: "blocked", reason: "Upstream refused this egress address" };
  }
  if (httpStatus === 407) {
    return { status: "unreachable", reason: "Proxy requires authentication" };
  }
  if (httpStatus === 429) {
    return { status: "throttled", reason: "Address accepted; rate limit spent" };
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: "allowed" };
  }
  if (httpStatus >= 500) {
    return { status: "unreachable", reason: `Upstream answered ${httpStatus}` };
  }
  // Any other 4xx: the request reached the upstream's own validation, which
  // only happens once the address is accepted.
  return {
    status: "allowed",
    reason: `Reachable; upstream answered ${httpStatus} for the probe body`,
  };
}

/**
 * Error codes that mean "this attempt never reached the upstream", not "the
 * upstream refused this address".
 *
 * Every one of them is worth a second attempt, and the reason is the same in
 * each case: the failure is a property of one socket, not of the egress. A
 * proxy that has just been dialled for the first time has to resolve, open a
 * tunnel, and complete a TLS handshake, and any of those steps can be refused
 * or reset by a middlebox that accepts the very next attempt — which is exactly
 * the "fails once, works on retry" report. Retiring the pool on the first one
 * blames the address for a cold-start race.
 */
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNECT_TIMEOUT",
]);
/** How many `cause` links to follow; wraps are shallow in practice. */
const PROBE_ERROR_CAUSE_DEPTH = 5;

/**
 * Whether one probe error should be retried before it becomes a verdict.
 *
 * Deliberately narrow: an abort is *our* deadline firing, so retrying it would
 * spend the whole probe budget on a slow egress, and an unknown error is left
 * alone rather than guessed at. Only transport codes that describe a single
 * dead connection qualify.
 */
export function isRetryableProbeError(error: unknown): boolean {

  // Walk the `cause` chain: a transport failure is routinely wrapped — the
  // proxy layer raises `ProxyConnectHandshakeError` whose *message* carries the
  // real code, with nothing on `code`. Checking only the top error would miss
  // exactly the failure this exists for.
  let current: unknown = error;
  for (let depth = 0; depth < PROBE_ERROR_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (!(current instanceof Error)) break;
    if (current.name === "AbortError" || current.name === "TimeoutError") return false;
    // `code` is not on the base `Error`; narrow before reading it rather than
    // asserting a shape the runtime may not have.
    const code: string | undefined =
      "code" in current && typeof current.code === "string" ? current.code : undefined;
    if (code !== undefined && RETRYABLE_TRANSPORT_CODES.has(code.toUpperCase())) return true;
    const message = String(current.message ?? "");
    // The wrapped code is often only in the message, so match it there too.
    for (const candidate of RETRYABLE_TRANSPORT_CODES) {
      if (message.includes(candidate)) return true;
    }
    if (
      message.includes("fetch failed") ||
      message.includes("socket connection was closed unexpectedly") ||
      message.includes("other side closed") ||
      message.startsWith("terminated") ||
      /connection (?:was|is) closed/i.test(message)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

