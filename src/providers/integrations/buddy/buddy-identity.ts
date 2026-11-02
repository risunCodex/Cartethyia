import type { ProviderDispatchContext } from "../../provider-contracts";
import { createHash } from "node:crypto";
import { decodeJwtPayload } from "../../authentication/oauth-flow-store";
import { buddyAccountUid } from "./buddy-oauth-shared";
import type { CanonicalRequest } from "../../../protocol/canonical-model";

/**
 * Which upstream client a buddy provider presents itself as.
 *
 * `desktop` is what every buddy provider sends today and stays the default for
 * all four. `cli` is the identity the reference gateways use for CLI traffic: a
 * different header set, a different User-Agent formula, and a different CN
 * upstream.
 *
 * Nothing flips to `cli` implicitly. Being wrong here is what gets an account
 * blocked upstream, so a provider changes identity only when an operator or an
 * account says so.
 */
export type BuddyIdentity = "desktop" | "cli";

/**
 * Resolves the identity one buddy dispatch presents.
 *
 * Precedence is account then provider: an account authorized as a CLI keeps
 * that identity even when the provider default changes, because the upstream
 * recorded it at login. The provider-level flag is
 * `compatibilityProfile.cli_identity`, already declared, validated, and
 * defaulted — it just never reached these adapters before.
 */
export function resolveBuddyIdentity(
  context: ProviderDispatchContext | undefined,
  profileIdentity?: boolean | undefined,
): BuddyIdentity {
  const accountRaw = context?.credential.auth_state?.["cliIdentity"];
  if (accountRaw === true) return "cli";
  if (accountRaw === false) return "desktop";
  return profileIdentity === true ? "cli" : "desktop";
}

/**
 * The upstream's `X-User-Id` for a buddy dispatch.
 *
 * The reference CLI sends the literal `anonymous` when it has no uid rather
 * than omitting the header, so an unauthenticated dispatch still looks like a
 * client rather than like a caller that forgot a header.
 *
 * When the credential carries a JWT, the `sub` claim is the upstream uid and
 * wins over the gateway's internal account id — the two can differ after an
 * import, and the channel check keys on the upstream identity. Opaque API keys
 * carry no identity, so the internal account id is the fallback.
 */
export function buddyUserId(context?: ProviderDispatchContext): string {
  const secret = context?.credential?.secret;
  const token = secret ? new TextDecoder().decode(secret).trim() : "";
  const uid = buddyAccountUid(token);
  if (uid !== undefined) return uid;
  const accountId = context?.credential.account_id;
  return accountId !== undefined && accountId.length > 0 ? accountId : "anonymous";
}

/**
 * Claim names a buddy access token may carry the enterprise id under.
 *
 * A list of candidates rather than one name because the upstream's token shape
 * is not pinned anywhere this codebase can verify, and guessing one name would
 * silently report "personal" for every account whose token spells it another
 * way. Every candidate is a plausible spelling of the same fact; the first that
 * holds a non-empty string wins, and a token carrying none yields no enterprise.
 */
const ENTERPRISE_CLAIMS: readonly string[] = [
  "enterprise_id",
  "enterpriseId",
  "enterprise",
  "tenant_id",
  "tenantId",
  "org_id",
  "organization_id",
];

/**
 * The enterprise this buddy account belongs to, or `undefined` for a personal
 * one.
 *
 * Two sources, in this order:
 *
 * 1. **`auth_state.enterpriseId`** — written when the account was authorized, or
 *    set by an operator for an account whose token does not carry the fact.
 *    Wins because it is the one a human can correct.
 * 2. **A claim on the access token** — for accounts authorized before this
 *    existed, whose `auth_state` was never populated.
 *
 * Deliberately conservative: no enterprise id means *personal*, and personal is
 * what the gateway already sends. An unknown account is therefore unchanged
 * rather than being given an enterprise it may not have — claiming one the
 * upstream does not recognise is the kind of mismatch that draws a channel
 * check.
 */
export function buddyEnterprise(context?: ProviderDispatchContext): string | undefined {
  const stored = context?.credential.auth_state?.["enterpriseId"];
  if (typeof stored === "string" && stored.trim().length > 0) return stored.trim();
  const token = context?.credential.secret;
  if (token === undefined || token.length === 0) return undefined;
  const claims = decodeJwtPayload(new TextDecoder().decode(token).trim());
  if (claims === undefined) return undefined;
  for (const claim of ENTERPRISE_CLAIMS) {
    const value = claims[claim];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Per-account device binding (`qimei36`) for the buddy providers.
 *
 * The desktop auth state sends `X-Device-Id-List: {"qimei36":"…"}` alongside
 * the Turing token — a second, independent device identity. Pinning it per
 * account makes every account in a pool present a distinct device to the
 * upstream risk control instead of sharing the machine's single fingerprint.
 *
 * Resolution order:
 * 1. `auth_state.qimei36` — explicit operator-set binding (imported or edited).
 * 2. Derived deterministically from the internal account id (sha256 → 32 hex).
 *    This keeps the binding stable across restarts without a database write,
 *    and gives each freshly-added account its own id automatically.
 *
 * IMPORTANT — the derived fallback is **not portable across instances**:
 * export/import mints a NEW account id, so the derived binding changes and the
 * upstream channel check (11128) rejects the re-imported account. The export
 * path therefore materializes the raw result of this resolver into
 * `auth_state.qimei36` whenever an account relies on the derivation, so a
 * re-import carries the exact same device identity.
 *
 * Returns `undefined` only when no account id is available (unauthenticated).
 */
export function resolveBuddyDeviceBinding(context?: ProviderDispatchContext): string | undefined {
  const explicit = context?.credential.auth_state?.["qimei36"];
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  const accountId = context?.credential.account_id;
  if (accountId === undefined || accountId.length === 0) return undefined;
  return createHash("sha256").update(`wb2a:qimei36:${accountId}`).digest("hex").slice(0, 32);
}

/** Materializes the portable binding for an account into a stored auth-state
 * map, when the account does not already pin one explicitly. Used by the
 * export path so a re-import keeps the exact qimei36 device identity. */
export function materializeBuddyDeviceBinding(
  accountId: string,
  authState: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const existing = authState?.["qimei36"];
  if (typeof existing === "string" && existing.trim().length > 0) return undefined;
  if (accountId.length === 0) return undefined;
  const derived = createHash("sha256").update(`wb2a:qimei36:${accountId}`).digest("hex").slice(0, 32);
  return { ...(authState ?? {}), qimei36: derived };
}

/**
 * The OAuth identity header family the reference ships on every cloud API call
 * (`runIdentityHeaders`): `X-User-Id` plus the base64 `X-Userinfo` envelope and
 * the auth-method / id-source markers.
 *
 * The JWT `sub` is the uid; the base64 envelope mirrors the reference exactly:
 * `{ uin, owner_uin?, id_source?, token_source? }` — one leg per identity
 * field that exists, so a personal account sends `{uin}` while an enterprise
 * account adds `owner_uin`. `X-Auth-Method` / `X-Id-Source` are only sent when
 * the operator pinned them in `auth_state` (there is no reliable source to
 * invent them from). An opaque API key carries no uid and yields nothing.
 */
export function buddyOAuthIdentityHeaders(
  context?: ProviderDispatchContext,
): Record<string, string> {
  const secret = context?.credential?.secret;
  const token = secret ? new TextDecoder().decode(secret).trim() : "";
  const uid = buddyAccountUid(token) ?? context?.credential.account_id ?? "";
  if (uid.length === 0) return {};
  const enterpriseId = buddyEnterprise(context);
  const state = context?.credential.auth_state;
  const idSource =
    typeof state?.["idSource"] === "string" && (state["idSource"] as string).trim().length > 0
      ? (state["idSource"] as string).trim()
      : undefined;
  const method =
    typeof state?.["authMethod"] === "string" && (state["authMethod"] as string).trim().length > 0
      ? (state["authMethod"] as string).trim()
      : undefined;
  const headers: Record<string, string> = { "X-User-Id": uid };
  if (method !== undefined) headers["X-Auth-Method"] = method;
  if (idSource !== undefined) headers["X-Id-Source"] = idSource;
  if (enterpriseId !== undefined || idSource !== undefined || method !== undefined) {
    const info: Record<string, string> = { uin: uid };
    if (enterpriseId !== undefined) info["owner_uin"] = enterpriseId;
    if (idSource !== undefined) info["id_source"] = idSource;
    if (method !== undefined) info["token_source"] = method;
    headers["X-Userinfo"] = Buffer.from(JSON.stringify(info), "utf-8").toString("base64");
  }
  return headers;
}

/**
 * Whether this dispatch is in the reference's private-data mode. The CLI only
 * sends `X-Private-Data: true` while the session is private; otherwise the
 * header is deleted, never sent as `false`. The gateway has no session-level
 * private flag, so the operator pins one per account in `auth_state.privateData`.
 */
export function buddyPrivateData(context?: ProviderDispatchContext): boolean {
  return context?.credential.auth_state?.["privateData"] === true;
}

/**
 * The effective agent purpose for one dispatch, matching the reference's
 * `getEffectiveAgentPurpose` behavior as closely as the gateway can:
 *
 * - `PERSONAL_AGENT_ROLE` set → `person_agent` (same env the CLI reads);
 * - otherwise an inbound `x-agent-purpose` header is preserved (the caller
 *   already stated a purpose — same shape the reference passes through);
 * - otherwise the header is omitted. The reference does not invent `conversation`.
 */
export function buddyAgentPurpose(
  context?: ProviderDispatchContext,
  request?: CanonicalRequest,
): string | undefined {
  if (process.env.PERSONAL_AGENT_ROLE && process.env.PERSONAL_AGENT_ROLE.trim().length > 0) {
    return "person_agent";
  }
  const inbound = context?.request_headers?.["x-agent-purpose"]?.trim();
  if (inbound !== undefined && inbound.length > 0) return inbound;
  const fromRequest = request?.metadata?.["agent_purpose"];
  if (typeof fromRequest === "string" && fromRequest.trim().length > 0) return fromRequest.trim();
  return undefined;
}
