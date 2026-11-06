/**
 * OpenAI-family in-stream error frames → typed `GatewayError`.
 *
 * A `200 OK` whose SSE body carries an explicit error envelope is an upstream
 * failure that arrived *after* the status line. Recording it only as a terminal
 * `state: "failed"` leaves the client with no `error.code`, no message, and
 * telemetry with the `unknown_error` category — while the Claude (`messages.ts`)
 * and Gemini decoders throw for the identical event. This module is the one
 * classifier those surfaces share.
 *
 * Classification reads **structured identifiers only** (`error.type`,
 * `error.code`, a numeric `error.status`) and never message prose. A substring
 * rule like `{ text: "capacity" }` fires on any message containing the word —
 * including text the client itself wrote — and scanning for phrases such as
 * "context window" in prose misfires the same way. A frame we cannot classify
 * beyond "the upstream declared a failure" becomes `platform_unavailable`,
 * which is honest: the upstream failed and we do not know more.
 */
import { GatewayError } from "./gateway-error";
import {
  classifyUpstreamError,
  upstreamErrorIdentifier,
  extractUpstreamMessageText,
} from "../transport/failure-policy";
import { isRecord } from "./codecs";


function numericStatus(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      (candidate === 202 || (candidate >= 400 && candidate < 600))
    )
      return candidate;
  }
  return undefined;
}

/**
 * Classifies one error envelope pulled out of a 200-OK stream into the shared
 * `GatewayError` contract, or `undefined` when the frame carries no error.
 *
 * The caller unwraps the envelope first (`json.error`, or `response.error` for
 * a `response.failed` frame), so this function only ever sees the error object
 * itself. `label` is the per-surface fallback message an operator uses to tell
 * which upstream produced the failure.
 */
export function gatewayErrorFromStreamError(
  error: unknown,
  label: string,
): GatewayError | undefined {
  if (error === undefined || error === null) return undefined;
  // Cline-style `{"error": "Not Found"}`: the upstream declared a failure with
  // no structure to classify it by.
  if (typeof error === "string") {
    return new GatewayError("platform_unavailable", 502, error.slice(0, 500) || label, {}, "upstream");
  }
  if (!isRecord(error)) return undefined;

  const identifier = upstreamErrorIdentifier(error);
  const explicitStatus = numericStatus(error["status"], error["statusCode"], error["status_code"]);
  const classification = classifyUpstreamError(explicitStatus, identifier);
  const raw = JSON.stringify(error, null, 2).slice(0, 16_384);
  // Only genuine prose (`message`/`msg`/`error` fields) counts as upstream
  // passthrough text. A `code`/identifier is a classification key, not prose —
  // it still serves as the message fallback when no text exists, but it must
  // not set `upstreamMessageAsIs`.
  const prose = extractUpstreamMessageText(error);
  const message = prose.slice(0, 500) || identifier || label;
  return new GatewayError(
    classification.code,
    classification.status,
    message,
    {
      ...(explicitStatus === undefined ? {} : { providerStatus: explicitStatus }),
      ...(identifier ? { providerCode: identifier } : {}),
      raw,
      ...(prose ? { upstreamMessageAsIs: true } : {}),
      ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
      ...(classification.rateLimitScope
        ? { rateLimitScope: classification.rateLimitScope }
        : {}),
    },
    classification.origin,
  );
}
