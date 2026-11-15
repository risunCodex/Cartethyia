/**
 * Shared OAuth login helpers for the long-tail provider integrations.
 *
 * Two shapes recur across them:
 *
 * - {@link staticExchangeResult}: the "durable credential, no refresh grant"
 *   exchange result. The stored credential does not expire, so the (NOT NULL)
 *   refresh slot mirrors `access` purely for storage — it is never posted to a
 *   token endpoint — and `expiresAt` is a documented storage horizon, not a
 *   claim about token lifetime. Six providers spelled this out longhand with
 *   the same comment each.
 * - {@link validateBearerByModelList}: the import-credential twin shared by
 *   the Cloudflare and Alibaba BYOK logins — prove the pasted token on the
 *   provider's own model-list read (401/403 = wrong key or wrong plan), and
 *   parse the body so a 200 HTML edge page is not mistaken for success.
 */
import { readJsonResponse } from "../../authentication/oauth-flow-store";
import type { FetchLike, OAuthExchangeResult } from "../../authentication/oauth-flow-store";

/**
 * Storage horizon for a credential whose issuer publishes no expiry. Far out
 * on purpose: the freshness check must never schedule a refresh that no
 * refresher can perform. Not a claim about token lifetime.
 */
export const STATIC_CREDENTIAL_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

export interface StaticExchangeInput {
  readonly access: string;
  /**
   * Refresh slot. Defaults to `access` — the mirror `refresh_ciphertext`
   * requires; no refresher is registered for these providers. A provider whose
   * slot carries a different durable value (a re-mint token, or an empty
   * string for a static JWT) passes it explicitly.
   */
  readonly refresh?: string | undefined;
  /** Account label shown in the console; blank values are omitted. */
  readonly accountLabel?: string | undefined;
  /** Explicit storage horizon when the issuer states one (e.g. a JWT `exp`). */
  readonly expiresAt?: Date | undefined;
  readonly auth_state?: Readonly<Record<string, unknown>> | undefined;
  /** Storage kind the minted credential files under (see `OAuthExchangeResult`). */
  readonly credentialKind?: "api_key" | "oauth" | undefined;
}

export function staticExchangeResult(input: StaticExchangeInput): OAuthExchangeResult {
  const label = input.accountLabel?.trim();
  return {
    access: input.access,
    refresh: input.refresh ?? input.access,
    expiresAt: input.expiresAt ?? new Date(Date.now() + STATIC_CREDENTIAL_HORIZON_MS),
    ...(label ? { accountLabel: label } : {}),
    ...(input.auth_state === undefined ? {} : { auth_state: input.auth_state }),
    ...(input.credentialKind === undefined ? {} : { credentialKind: input.credentialKind }),
  };
}

export interface ValidateBearerOptions {
  /** The provider's own model-list URL — it proves both the key and the plan/region. */
  readonly url: string;
  readonly bearer: string;
  /** Header carrying the bearer; defaults to `authorization`. */
  readonly authHeader?: string;
  readonly fetchFn: FetchLike;
  /** Message thrown when the provider answers 401/403. */
  readonly rejectionMessage: string;
  /** Label for the JSON body read (a 200 HTML edge page is not success). */
  readonly bodyLabel: string;
}

export async function validateBearerByModelList(options: ValidateBearerOptions): Promise<void> {
  const response = await options.fetchFn(options.url, {
    headers: {
      accept: "application/json",
      [options.authHeader ?? "authorization"]: `Bearer ${options.bearer}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(options.rejectionMessage);
  }
  await readJsonResponse(response, options.bodyLabel);
}
