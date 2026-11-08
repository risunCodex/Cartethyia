/**
 * Provider credential envelope and resolution handling.
 *
 * Strips token envelopes so adapters never emit `Bearer Bearer`, and resolves
 * ordered upstream credential alternatives for the control plane.
 */

import { GatewayError } from "../protocol/gateway-error";
import type { CredentialKind, ProviderId, ResolvedCredential } from "./provider-contracts";

/** Envelope labels a stored credential may carry. */
export type TokenEnvelope = "bearer" | "oauth" | "provider";

const ENVELOPE_PREFIXES: Record<TokenEnvelope, string> = {
  bearer: "Bearer ",
  oauth: "OAuth ",
  provider: "provider:",
};

/**
 * Removes one explicitly identified envelope so adapters never emit
 * `Bearer Bearer`. The bearer branch strips case-insensitively with
 * surrounding-whitespace normalization; oauth/provider envelopes keep their
 * exact byte slices. Input without the identified envelope passes through
 * untouched.
 */
export function unwrapProviderToken(
  value: string | Uint8Array,
  envelope?: TokenEnvelope,
): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const text = new TextDecoder().decode(bytes);
  if (envelope === "bearer") {
    const trimmed = text.trim();
    const match = /^bearer\s+(.+)$/is.exec(trimmed);
    return new TextEncoder().encode((match?.[1] ?? trimmed).trim());
  }
  const prefix = envelope === undefined ? undefined : ENVELOPE_PREFIXES[envelope];
  if (prefix !== undefined && text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return new TextEncoder().encode(text.slice(prefix.length));
  }
  return new Uint8Array(bytes);
}

/** One control-plane credential alternative, ordered by operator preference. */
export interface CredentialAlternative {
  readonly provider_id: ProviderId;
  readonly account_id?: string | undefined;
  readonly credential_kind: CredentialKind;
  /** Secret supplied by the control plane, never read from a client request. */
  readonly secret?: string | Uint8Array | undefined;
  /** Health/expiry/quota result from the account control plane. */
  readonly usable?: boolean | undefined;
  /** Non-secret per-account upstream auth configuration; see `ResolvedCredential`. */
  readonly auth_state?: Readonly<Record<string, unknown>> | undefined;
}

/** Result of ordered credential selection, with no client-auth fields. */
export interface CredentialResolution {
  readonly credential: ResolvedCredential;
  readonly alternative_index: number;
}

/**
 * Selects the first usable upstream credential alternative in operator order.
 * Public Cartethyia authentication is intentionally absent from this interface.
 */
export class CredentialResolver {
  /**
   * Resolves an ordered list, including a genuine no-credential route.
   * @throws GatewayError when all alternatives are unavailable.
   */
  resolve(
    providerId: ProviderId,
    alternatives: readonly CredentialAlternative[],
  ): CredentialResolution {
    for (const [alternativeIndex, alternative] of alternatives.entries()) {
      if (alternative.provider_id !== providerId) continue;
      if (alternative.usable === false) continue;
      if (alternative.credential_kind === "none") {
        return {
          credential: {
            provider_id: providerId,
            ...(alternative.account_id === undefined ? {} : { account_id: alternative.account_id }),
            credential_kind: "none",
            ...(alternative.auth_state === undefined ? {} : { auth_state: alternative.auth_state }),
          },
          alternative_index: alternativeIndex,
        };
      }
      const secret = resolveSecret(alternative.secret);
      if (secret === undefined) continue;
      return {
        credential: {
          provider_id: providerId,
          ...(alternative.account_id === undefined ? {} : { account_id: alternative.account_id }),
          credential_kind: alternative.credential_kind,
          secret,
          ...(alternative.auth_state === undefined ? {} : { auth_state: alternative.auth_state }),
        },
        alternative_index: alternativeIndex,
      };
    }

    throw new GatewayError(
      "invalid_request",
      401,
      "No usable upstream credential is configured for the selected provider (request {requestId}). Wrong key, right door — check the credential 🔑",
      { provider_id: providerId },
    );
  }
}

function resolveSecret(value: CredentialAlternative["secret"]): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const unwrapped = unwrapProviderToken(value);
  return unwrapped.length === 0 ? undefined : unwrapped;
}
