// Free-pi request headers.
//
// The client sends `Authorization: Bearer <jwt>` plus `x-client-version` (the
// CLI version) on the chat wire, and uses `application/json`. There is no
// device fingerprint — the JWT is the whole identity.

import { FREEPI_CLI_VERSION } from "./freepi-realm";

/** Builds the header set for one free-pi request. */
export function buildFreepiHeaders(jwt: string, stream = false, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${jwt}`,
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    "x-client-version": FREEPI_CLI_VERSION,
  };
  if (sessionId !== undefined && sessionId.length > 0) {
    headers["x-session-id"] = sessionId;
  }
  return headers;
}
