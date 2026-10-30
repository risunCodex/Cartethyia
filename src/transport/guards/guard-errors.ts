/**
 * Shared construction points for the guard errors that more than one guard
 * raises. Normalisation downstream is single-seam (`error-lifecycle.ts`); the
 * duplication this module removes was on the construction side, where four
 * guards each hand-rolled their own code + message for the same conditions.
 */
import { GatewayError } from "../../protocol/gateway-error";

/** Thrown when the request's client peer address cannot be established. */
export function peerAddressUnavailableError(): GatewayError {
  return new GatewayError(
    "admission_unavailable",
    503,
    "client peer address unavailable (request {requestId}). We couldn't see who's knocking — retry 🚪",
  );
}

/** Thrown when the request body exceeds the endpoint's byte budget. */
export function bodyTooLargeError(maxBytes: number): GatewayError {
  return new GatewayError(
    "request_too_large",
    413,
    `The request body is larger than this endpoint accepts (${maxBytes} bytes) (request {requestId}). Shorten the prompt or split the request. We love long reads, but not that long 📚`,
  );
}


