/**
 * Cursor error taxonomy: envelope decoding and failure policy.
 *
 * Cursor answers a failing Run in-band: the terminal Connect frame (flag
 * `0x02`) carries JSON `{"error":{code,message,details}}` *inside* the HTTP 200
 * stream. Each `details[]` entry of type `aiserver.v1.ErrorDetails` is a
 * base64 protobuf (`ErrorDetails{error: CursorError, details: {title, detail,
 * is_retryable}, is_expected}`) whose decoded form is the actionable truth —
 * the prose `message` alone cannot say whether a refusal is retryable.
 *
 * The code→status and code→policy maps follow the reference implementation's
 * proven tables: `5 BAD_MODEL_NAME` is 404, `7–10` rate/usage limits are 429,
 * `41 RESOURCE_EXHAUSTED` is 429, `43 CONVERSATION_TOO_LONG` is 413, and
 * `21 USER_ABORTED_REQUEST` is a caller abort, never a provider failure.
 *
 * Policy vocabulary for the Run lifecycle:
 * - `retryable` — transient (codes 13/25/55/56/57/59/63, 5xx transport):
 *   replay the request.
 * - `model_not_found` — `not_found` / `BAD_MODEL_NAME` before any output:
 *   one retry on the discovered wire id, then terminal.
 * - `conversation_rejected` — the conversation id is poisoned
 *   (`resource_exhausted` anywhere, or `PROVIDER_ERROR` after a zero-token
 *   cut): rotate the id and rebuild from history.
 * - `fallback_h1` — HTTP/2 is blocked for this path: re-run over the
 *   RunSSE + BidiAppend transport.
 * - `quota` / `auth` — terminal for the credential; the account layer owns
 *   cooldown/rotation.
 * - `abort` — the caller cancelled; settle quietly.
 */
import { log } from "../../../observability/logger";
import { decodeMessage } from "./cursor-protocol/messages";
import type { ErrorDetails } from "./cursor-protocol/generated";
import { ErrorDetails_CursorErrorNames } from "./cursor-protocol/generated";
import { parseTrailer, type ConnectTrailer } from "../shared/connect";

/** What the Run lifecycle does about one failure. */
export type CursorFailurePolicy =
  | "retryable"
  | "model_not_found"
  | "conversation_rejected"
  | "fallback_h1"
  | "quota"
  | "auth"
  | "abort"
  | "terminal";

export interface CursorFailure {
  readonly policy: CursorFailurePolicy;
  /** Cursor's numeric error code when the envelope carried one. */
  readonly code: number | undefined;
  /** Cursor's error name (`ERROR_BAD_MODEL_NAME`, …) when known. */
  readonly name: string | undefined;
  /** Human-readable detail: envelope message, then `detail` prose. */
  readonly message: string;
  /** True when the upstream declared the failure retryable in ErrorDetails. */
  readonly upstreamRetryable: boolean;
}

/**
 * Codes the reference implementation treats as transient. Everything else in
 * the 4xx-class (bad request, model blocked, account closed, …) is terminal:
 * retrying it only burns the turn budget.
 */
const CURSOR_RETRYABLE_ERROR_CODES: ReadonlySet<number> = new Set([
  13, // ERROR_OPENAI (upstream vendor hiccup)
  25, // ERROR_TIMEOUT
  55, // ERROR_EXTENSION_HOST_TIMEOUT
  56, // ERROR_NETWORK_ERROR
  57, // ERROR_PROVIDER_ERROR
  59, // ERROR_INTERNAL
  63, // ERROR_SLOW_POOL
]);

/** Codes that mean the credential itself is gone or unwelcome. */
const CURSOR_AUTH_ERROR_CODES: ReadonlySet<number> = new Set([
  1, // ERROR_BAD_API_KEY
  2, // ERROR_NOT_LOGGED_IN
  3, // ERROR_INVALID_AUTH_ID
  4, // ERROR_NOT_HIGH_ENOUGH_PERMISSIONS
  6, // ERROR_USER_NOT_FOUND
  11, // ERROR_AUTH_TOKEN_NOT_FOUND
  12, // ERROR_AUTH_TOKEN_EXPIRED
  18, // ERROR_AGENT_REQUIRES_LOGIN
  38, // ERROR_UNAUTHORIZED
  42, // ERROR_BAD_USER_API_KEY
  46, // ERROR_GITHUB_NO_USER_CREDENTIALS
  65, // ERROR_ACCOUNT_CLOSED
]);

/** Codes that mean the plan's allowance is spent. */
const CURSOR_QUOTA_ERROR_CODES: ReadonlySet<number> = new Set([
  7, // ERROR_FREE_USER_RATE_LIMIT_EXCEEDED
  8, // ERROR_PRO_USER_RATE_LIMIT_EXCEEDED
  9, // ERROR_FREE_USER_USAGE_LIMIT
  10, // ERROR_PRO_USER_USAGE_LIMIT
  14, // ERROR_OPENAI_RATE_LIMIT_EXCEEDED
  22, // ERROR_GENERIC_RATE_LIMIT_EXCEEDED
  23, // ERROR_PRO_USER_ONLY
  34, // ERROR_API_KEY_RATE_LIMIT
  41, // ERROR_RESOURCE_EXHAUSTED
  44, // ERROR_USAGE_PRICING_REQUIRED
  45, // ERROR_USAGE_PRICING_REQUIRED_CHANGEABLE
  50, // ERROR_RATE_LIMITED
  51, // ERROR_RATE_LIMITED_CHANGEABLE
]);

/** The one caller-side "failure": the operator cancelled the turn. */
const CURSOR_ABORT_CODE = 21; // ERROR_USER_ABORTED_REQUEST

/**
 * `model_not_found` recognition. Cursor surfaces an unusable model id as a
 * Connect `not_found`, a gRPC status 5, or a structured `BAD_MODEL_NAME` —
 * all three before any output means "try the discovered id", not "give up".
 */
const CURSOR_MODEL_NOT_FOUND_PATTERN = /^(?:connect error not_found:|grpc error 5:)/i;

/** `resource_exhausted` in prose poisons the conversation id. */
const RESOURCE_EXHAUSTED_PATTERN = /resource_exhausted/i;

function nameOfCode(code: number | undefined): string | undefined {
  if (code === undefined) return undefined;
  return ErrorDetails_CursorErrorNames[code];
}

function policyFor(
  code: number | undefined,
  upstreamRetryable: boolean,
  message: string,
  envelopeCode = "",
): CursorFailurePolicy {
  if (code === CURSOR_ABORT_CODE) return "abort";
  if (code !== undefined) {
    if (CURSOR_AUTH_ERROR_CODES.has(code)) return "auth";
    if (CURSOR_QUOTA_ERROR_CODES.has(code)) return "quota";
    if (CURSOR_MODEL_NOT_FOUND_PATTERN.test(message) || code === 5) return "model_not_found";
    if (code === 43) return "terminal"; // CONVERSATION_TOO_LONG: rebuilding cannot shrink it
    if (CURSOR_RETRYABLE_ERROR_CODES.has(code)) return "retryable";
  }
  // A bare `internal` envelope with no ErrorDetails numeric code is the
  // proxy's own transport cut in envelope clothing — live-verified 2026-11-17
  // ("premature EOF" fired mid-turn on a multi-tool-round continuation while
  // frames were still flowing). The turn never reached turn_ended, so this is
  // the incomplete-stream case: replayable when nothing was surfaced, and the
  // retry loop's progress guard keeps a surfaced answer terminal.
  if (code === undefined && envelopeCode === "internal") return "retryable";
  if (CURSOR_MODEL_NOT_FOUND_PATTERN.test(message)) return "model_not_found";
  if (RESOURCE_EXHAUSTED_PATTERN.test(message)) return "conversation_rejected";
  if (upstreamRetryable) return "retryable";
  return "terminal";
}

/**
 * Decodes one Connect end-of-stream trailer into a structured failure.
 *
 * `details[]` entries of type `aiserver.v1.ErrorDetails` (or its
 * `type.googleapis.com/…` type-url spelling) carry the base64 protobuf whose
 * `CursorError` code and `is_retryable` flag decide the policy; the JSON
 * `code`/`message` are the fallback when no detail decodes. A trailer without
 * an error (a clean end) answers `undefined`.
 */
export function decodeCursorEndStream(trailer: ConnectTrailer): CursorFailure | undefined {
  const error = trailer.error;
  if (error === undefined && trailer.details === undefined) return undefined;

  let code: number | undefined;
  let upstreamRetryable = false;
  let detailProse = "";
  const details = Array.isArray(trailer.details) ? trailer.details : [];
  for (const entry of details) {
    const typed = entry as { type?: string; value?: string } | null;
    if (typed === null || typeof typed.value !== "string") continue;
    const typeName = typeof typed.type === "string" ? typed.type : "";
    if (!typeName.endsWith("aiserver.v1.ErrorDetails")) continue;
    try {
      const bytes = new Uint8Array(Buffer.from(typed.value, "base64"));
      const decoded = decodeMessage<ErrorDetails>("aiserver.v1.ErrorDetails", bytes);
      if (typeof decoded.error === "number") code = decoded.error;
      if (decoded.details?.isRetryable === true) upstreamRetryable = true;
      if (decoded.details?.detail) detailProse = decoded.details.detail;
    } catch (error) {
      // A detail that does not decode must not take the envelope down; the
      // JSON message still describes the failure. But the decode failure is
      // itself evidence (schema drift, a truncated frame), so it is logged —
      // a silently dropped detail once left a content-filter block reading
      // as a bare "Error".
      log.warn("cursor: ErrorDetails detail failed to decode", {
        error: error instanceof Error ? error.message : String(error),
        base64Length: typed.value.length,
      });
    }
  }

  if (code === undefined && detailProse === "") {
    // An envelope with no ErrorDetails gives the caller nothing to act on;
    // log the whole trailer so the live wire stays diagnosable.
    log.debug("cursor: opaque end-stream envelope", {
      trailer: JSON.stringify(trailer).slice(0, 8000),
    });
  }
  const message = [error?.message, detailProse].filter((part) => part && part.length > 0).join(": ");
  // The envelope's string `code` ("resource_exhausted", …) is evidence too:
  // the prose message alone often does not repeat it.
  const evidence = `${error?.code ?? ""} ${message}`;
  return {
    policy: policyFor(code, upstreamRetryable, evidence, typeof error?.code === "string" ? error.code : ""),
    code,
    name: nameOfCode(code),
    message: message.length > 0 ? message : "Cursor ended the stream with an error",
    upstreamRetryable,
  };
}

/**
 * Classifies a thrown transport/HTTP failure (outside the envelope path).
 *
 * A blocked HTTP/2 connection (`is_h2_blocked` from the transport layer) is
 * mapped by the caller to `fallback_h1`; this function covers the rest.
 */
export function classifyCursorThrown(error: unknown): CursorFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (CURSOR_MODEL_NOT_FOUND_PATTERN.test(message)) {
    return { policy: "model_not_found", code: undefined, name: undefined, message, upstreamRetryable: false };
  }
  if (RESOURCE_EXHAUSTED_PATTERN.test(message)) {
    return { policy: "conversation_rejected", code: undefined, name: undefined, message, upstreamRetryable: false };
  }
  // A network-level failure before any output is transient; the retry budget
  // in the lifecycle decides when to stop.
  return { policy: "retryable", code: undefined, name: undefined, message, upstreamRetryable: false };
}

/** Parses a raw trailer payload (JSON bytes) into a failure, if any. */
export function decodeCursorEndStreamBytes(payload: Uint8Array): CursorFailure | undefined {
  return decodeCursorEndStream(parseTrailer(payload));
}
