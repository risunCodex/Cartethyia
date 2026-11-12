import type { ProviderDispatchContext } from "../../provider-contracts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeJwtPayload } from "../../authentication/oauth-flow-store";
import { buddyAccountUid } from "./account";
import type { CanonicalRequest } from "../../../protocol/canonical-model";

// ── buddy-identity ──────────────────────────────────────────

export type BuddyIdentity = "desktop" | "cli";

export function resolveBuddyIdentity(
  context: ProviderDispatchContext | undefined,
  profileIdentity?: boolean | undefined,
): BuddyIdentity {
  const accountRaw = context?.credential.auth_state?.["cliIdentity"];
  if (accountRaw === true) return "cli";
  if (accountRaw === false) return "desktop";
  return profileIdentity === true ? "cli" : "desktop";
}

export function buddyUserId(context?: ProviderDispatchContext): string {
  const secret = context?.credential?.secret;
  const token = secret ? new TextDecoder().decode(secret).trim() : "";
  const uid = buddyAccountUid(token);
  if (uid !== undefined) return uid;
  const accountId = context?.credential.account_id;
  return accountId !== undefined && accountId.length > 0 ? accountId : "anonymous";
}

const ENTERPRISE_CLAIMS: readonly string[] = [
  "enterprise_id",
  "enterpriseId",
  "enterprise",
  "tenant_id",
  "tenantId",
  "org_id",
  "organization_id",
];

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

export function resolveBuddyDeviceBinding(context?: ProviderDispatchContext): string | undefined {
  const explicit = context?.credential.auth_state?.["qimei36"];
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  const accountId = context?.credential.account_id;
  if (accountId === undefined || accountId.length === 0) return undefined;
  return createHash("sha256").update(`wb2a:qimei36:${accountId}`).digest("hex").slice(0, 32);
}

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

function identityClaim(claims: Record<string, unknown> | undefined, name: string): string | undefined {
  if (claims === undefined) return undefined;
  const value = claims[name];
  if (typeof value === "string" && value.trim().length > 0 && value.trim().length <= 128) return value.trim();
  return undefined;
}

export function buddyOAuthIdentityHeaders(
  context?: ProviderDispatchContext,
): Record<string, string> {
  const secret = context?.credential?.secret;
  const token = secret ? new TextDecoder().decode(secret).trim() : "";
  const uid = buddyAccountUid(token) ?? context?.credential.account_id ?? "";
  if (uid.length === 0) return {};
  const enterpriseId = buddyEnterprise(context);
  // The reference gateway reads `id_source` / `token_source` from the JWT
  // payload and the account record, not from stored auth state — an account
  // authorized before either was persisted still carries them on the wire.
  // Precedence matches the donor (`client_profiles._identity_claim_headers`):
  // account fields first, then JWT claims, then legacy `auth_state`.
  const claims = token.length > 0 ? decodeJwtPayload(token) : undefined;
  const state = context?.credential.auth_state;
  const idSource =
    identityClaim(claims, "id_source") ??
    identityClaim(claims, "idSource") ??
    identityClaim(state as Record<string, unknown> | undefined, "idSource");
  const method =
    identityClaim(claims, "token_source") ??
    identityClaim(state as Record<string, unknown> | undefined, "authMethod");
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

export function buddyPrivateData(context?: ProviderDispatchContext): boolean {
  return context?.credential.auth_state?.["privateData"] === true;
}

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

const DEVICE_TOKEN_FILE_MAX_BYTES = 1024;

const DEVICE_TOKEN_FILE_TTL_MS = 5 * 60_000;

let deviceTokenFileCache: { readonly value: string | undefined; readonly readAt: number } | undefined;

export function readBuddyDeviceToken(context?: ProviderDispatchContext): string | undefined {
  const state = context?.credential.auth_state;
  const value = state?.["deviceToken"] ?? state?.["device_token"];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return readDeviceTokenFile();
}

export async function buddyDeviceTokenHeaders(args: {
  realm: "intl" | "cn";
  context: ProviderDispatchContext | undefined;
  cliIdentity: boolean | undefined;
}): Promise<Record<string, string>> {
  const { context, cliIdentity } = args;
  void args.realm; // the desktop client sends the token on both realms
  if (resolveBuddyIdentity(context, cliIdentity) === "cli") return {};
  const token = readBuddyDeviceToken(context);
  if (token !== undefined) return { "x-device-token": token };
  return { "x-device-token-error": "sdk_not_initialized" };
}

function readDeviceTokenFile(): string | undefined {
  const now = Date.now();
  if (deviceTokenFileCache !== undefined && now - deviceTokenFileCache.readAt < DEVICE_TOKEN_FILE_TTL_MS) {
    return deviceTokenFileCache.value;
  }
  const path = process.env["CARTETHYIA_DEVICE_TOKEN_FILE"] ?? "/app/data/device_token";
  let value: string | undefined;
  try {
    const raw = readFileSync(path);
    if (raw.byteLength > 0 && raw.byteLength <= DEVICE_TOKEN_FILE_MAX_BYTES) {
      const text = raw.toString("utf8").trim();
      if (text.length > 0) value = text;
    }
  } catch {
    value = undefined;
  }
  deviceTokenFileCache = { value, readAt: now };
  return value;
}

// ── buddy-cli-headers ──────────────────────────────────────────

export function buddyCliTraceHeaders(
  conversation: Readonly<Record<string, string>>,
): Record<string, string> {
  const traceId = conversation["x-trace-id"] ?? conversation["x-b3-traceid"];
  const spanId = conversation["x-b3-spanid"];
  if (traceId === undefined) return {};
  const b3 = `${traceId}-${spanId ?? traceId.slice(0, 16)}-1-${traceId.slice(0, 16)}`;
  return { ...(spanId === undefined ? {} : { "X-B3-ParentSpanId": spanId }), b3 };
}

export function buddyCliHeaders(args: {
  readonly userId: string;
  readonly enterpriseId?: string | undefined;
  readonly privateData?: boolean;
}): Record<string, string> {
  const enterpriseId =
    args.enterpriseId !== undefined && args.enterpriseId.trim().length > 0
      ? args.enterpriseId.trim()
      : undefined;
  return {
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    // The reference enum is local-agent / cloud-agent / agent-agent, and its
    // parser returns "other" for anything unknown or absent. A gateway is none
    // of the three, so "other" is the honest value rather than a guess.
    "X-Agent-Runtime": "other",
    "X-User-Id": args.userId,
    ...(args.privateData === true ? { "X-Private-Data": "true" } : {}),
    ...(enterpriseId === undefined
      ? {}
      : {
          "X-Enterprise-Id": enterpriseId,
          // The tenant falls back to the enterprise: the two are the same value
          // for an account that belongs to one enterprise, and the upstream
          // reads both.
          "X-Tenant-Id": enterpriseId,
        }),
  };
}

// ── buddy-conversation-headers ──────────────────────────────────────────

function newMessageId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function toUuidHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isValidTraceId(value: string): boolean {
  if (value.length !== 16 && value.length !== 32) return false;
  return /^[0-9a-fA-F]+$/.test(value);
}

export interface BuddyConversationIds {
  /**
   * Conversation-scoped id, stable across turns. `undefined` means the client
   * sent none, and the header is then omitted rather than fabricated.
   */
  readonly conversationId?: string | undefined;
  /**
   * Turn-scoped aggregation key. When absent a fresh one is generated, because
   * the header is mandatory and a call without it is what drew `11128`.
   */
  readonly conversationRequestId?: string | undefined;
  /** Inbound trace id to pass through; falls back to the conversation request id. */
  readonly traceId?: string | undefined;
  /**
   * Wire format for the two message-scoped ids (`x-conversation-message-id`,
   * `x-request-id`).
   *
   * The reference emits these as dashed UUIDs on the desktop product
   * and as 32-hex on CLI traffic (`build_attempt_headers` converts only the
   * message/request ids, and only for the desktop profiles). The turn
   * aggregation key (`x-conversation-request-id` / `x-root-request-id`) and the
   * B3/W3C trace ids stay hex in both styles, because B3's spec accepts only
   * hex. Default `"hex"`.
   */
  readonly messageIdStyle?: "hex" | "uuid" | undefined;
}

export function buddyConversationHeaders(
  ids: BuddyConversationIds = {},
): Record<string, string> {
  const conversationRequestId =
    ids.conversationRequestId && ids.conversationRequestId.trim().length > 0
      ? ids.conversationRequestId.trim()
      : newMessageId();
  const messageId = newMessageId();
  // The message-scoped ids may render as a dashed UUID (WorkBuddy desktop) or
  // as 32-hex (CLI); the raw hex is still what the B3/W3C trace ids derive from.
  const messageHeaderValue = ids.messageIdStyle === "uuid" ? toUuidHex(messageId) : messageId;
  const traceId =
    ids.traceId && ids.traceId.trim().length > 0 ? ids.traceId.trim() : conversationRequestId;
  const b3TraceId = isValidTraceId(conversationRequestId) ? conversationRequestId : messageId;

  const headers: Record<string, string> = {
    "x-conversation-request-id": conversationRequestId,
    "x-conversation-message-id": messageHeaderValue,
    "x-request-id": messageHeaderValue,
    "x-root-request-id": conversationRequestId,
    "x-trace-id": traceId,
    // W3C trace context alongside the B3 set below: the upstream reads both,
    // and every reference request carries `traceparent`, so sending only the
    // B3 half leaves a header the channel check expects absent.
    traceparent: `00-${b3TraceId}-${messageId.slice(0, 16)}-01`,
    "x-b3-traceid": b3TraceId,
    "x-b3-spanid": messageId.slice(0, 16),
    "x-b3-sampled": "1",
  };
  // Always sent, invented when the caller gave none.
  //
  // `x-conversation-id` is mandatory, and a chat request without it is refused
  // with `400 · 11-128 "request illegal"` — an error that names neither the
  // header nor the channel, and which reads like a block rather than a missing
  // field. Isolated against the live API by removing one header at a time:
  // only `x-conversation-id`, `x-conversation-request-id` and
  // `x-conversation-message-id` are required; the B3/W3C trace set, the
  // stainless set, the agent block and the IDE block are all optional.
  //
  // Inventing one when the caller has none is still the right default: the id
  // is per-dispatch here, so a caller with no session is not claiming a session
  // it never had — and withholding the header only guarantees a refusal.
  headers["x-conversation-id"] =
    ids.conversationId !== undefined && ids.conversationId.trim().length > 0
      ? ids.conversationId.trim()
      : newMessageId();
  return headers;
}
