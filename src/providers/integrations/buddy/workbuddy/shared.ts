import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { OpenAICompatibleAdapterConfig } from "../../../adapters/compatible-adapter";
import { withBearerAuthentication } from "../../../adapters/compatible-adapter";
import type { CanonicalRequest } from "../../../../protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderId } from "../../../provider-contracts";
import { resolveInboundSessionId } from "../../../operations/session-resolution";
import { buddyConversationHeaders } from "../buddy-conversation-headers";
import { buddyCliHeaders, buddyCliTraceHeaders } from "../buddy-cli-headers";
import {
  buddyAgentPurpose,
  buddyEnterprise,
  buddyOAuthIdentityHeaders,
  buddyPrivateData,
  buddyUserId,
  resolveBuddyDeviceBinding,
  resolveBuddyIdentity,
} from "../buddy-identity";
import {
  buildWorkBuddyUserAgent,
  getWorkBuddyClientVersion,
  getWorkBuddyCliVersion,
} from "../../../operations/client-versions";
import {
  getTuringDeviceTokenService,
  resolveTuringSdkRoot,
  type TuringSdkConfig,
  WORKBUDDY_TURING_CONFIG,
} from "../turing-device-token";

/**
 * WorkBuddy serves chat from a versioned path on a base URL that carries no
 * version segment (billing uses the unversioned `/billing/…` path), so both the
 * adapter config and the static catalog rows must state it. The generic
 * `/chat/completions` default would join into
 * `https://www.workbuddy.ai/chat/completions`, which that upstream answers with
 * a 405 HTML error page.
 */
export const WORKBUDDY_CHAT_PATH = "/v2/chat/completions" as const;

export {
  buildWorkBuddyUserAgent,
  getWorkBuddyClientVersion,
  getWorkBuddyCliVersion,
};

/** WorkBuddy international gateway domain (Origin/Referer/X-Domain). */
export const WORKBUDDY_DOMAIN = "www.workbuddy.ai";

/**
 * Stable per-account device identifiers.
 *
 * WorkBuddy's desktop client presents one fixed virtual device per account.
 * Deriving `X-Machine-ID` / `X-Session-ID` from the account id (sha256, 36 hex)
 * keeps them constant across restarts while staying distinct per account, so
 * multiple pooled accounts are not correlated by a missing or drifting device
 * fingerprint. Mirrors the reference gateway's `wb2a:<purpose>:<uid>` scheme.
 */
function deriveAccountStableId(accountId: string, purpose: string): string {
  const sum = createHash("sha256").update(`wb2a:${purpose}:${accountId}`).digest("hex");
  return sum.slice(0, 36);
}

/**
 * Per-request WorkBuddy chat headers — the exact desktop-client contract.
 *
 * The international gateway gates chat on the desktop `User-Agent` (platform
 * brand `WorkBuddy AI`, carried on the wire as the token `workbuddy-ai`;
 * the wrong token trips 403 code 11140), plus the `X-CodeBuddy-Request` risk
 * gate and the account-scoped device headers.
 * The background client-version monitor keeps this value fresh; dispatch only
 * reads the cached value and never waits on a version endpoint.
 *
 * `cliIdentity` selects the reference CLI contract instead. The two are not
 * variations of one set: the CLI drops every browser header and the device
 * token, and adds the agent envelope. Left unset, nothing changes.
 */
export async function workbuddyHeaders(
  context?: ProviderDispatchContext,
  request?: CanonicalRequest,
  domain = WORKBUDDY_DOMAIN,
  clientVersion = getWorkBuddyClientVersion(),
  cliIdentity?: boolean,
): Promise<Record<string, string>> {
  const identity = resolveBuddyIdentity(context, cliIdentity);
  const conversation = buddyConversationHeaders({
    ...(resolveInboundSessionId(context, request) === undefined
      ? {}
      : { conversationId: resolveInboundSessionId(context, request) }),
    // The reference emits dashed-UUID message/request ids on the WorkBuddy
    // desktop product and 32-hex on CLI traffic (build_attempt_headers converts
    // only the message/request ids, and only for the WorkBuddy profiles).
    messageIdStyle: identity === "desktop" ? "uuid" : "hex",
  });
  const accountId = context?.credential.account_id;
  const purpose = buddyAgentPurpose(context, request);
  if (identity === "cli") {
    const inbound = context?.request_headers;
    const rootRequestId = inbound?.["x-root-request-id"]?.trim();
    const parentConversationId = inbound?.["x-parent-conversation-id"]?.trim();
    // The reference CLI: issued by the OpenAI Node SDK, so no browser
    // *transport* header (origin/referer/accept-language) and no device token,
    // and the machine/session device pair does not exist — only `X-User-Id`,
    // which is `anonymous` without a uid. It keeps the request-shape markers
    // (`x-requested-with`, `x-codebuddy-request`) the reference sends on every
    // call regardless of transport.
    return {
      accept: "application/json",
      "user-agent": `CLI/${getWorkBuddyCliVersion()} CodeBuddy/${getWorkBuddyCliVersion()}`,
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
      "x-domain": domain,
      ...(purpose === undefined ? {} : { "x-agent-purpose": purpose }),
      "x-ide-name": "CLI",
      "x-ide-type": "CLI",
      "x-ide-version": getWorkBuddyCliVersion(),
      "x-product": "SaaS",
      "x-no-enterprise-id": "1",
      ...conversation,
      ...(rootRequestId === undefined ? {} : { "x-root-request-id": rootRequestId }),
      ...(parentConversationId === undefined
        ? {}
        : { "x-parent-conversation-id": parentConversationId }),
      ...buddyCliTraceHeaders(conversation),
      ...buddyOAuthIdentityHeaders(context),
      ...buddyCliHeaders({
        userId: buddyUserId(context),
        enterpriseId: buddyEnterprise(context),
        privateData: buddyPrivateData(context),
      }),
    };
  }
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "user-agent": buildWorkBuddyUserAgent(clientVersion, getWorkBuddyCliVersion()),
    origin: `https://${domain}`,
    referer: `https://${domain}/`,
    "accept-language": "en-US",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    "x-domain": domain,
    ...(purpose === undefined ? {} : { "x-agent-purpose": purpose }),
    "x-ide-name": "WorkBuddy",
    "x-ide-type": "WorkBuddy",
    "x-ide-version": clientVersion,
    // Both references send the literal `SaaS` here. `WorkBuddy` was a value
    // this repo invented; the desktop product name belongs in `x-ide-name`,
    // and the CN test below compares the two realms against each other rather
    // than to a hard-coded string.
    "x-product": "SaaS",
    // Personal international accounts carry no enterprise id: declare it
    // explicitly so upstream risk control does not treat the omission as
    // suspicious.
    "x-no-enterprise-id": "1",
  };
  // The conversation/tracing family the upstream's channel check looks for. A
  // live request carrying only `x-session-id` was refused for a missing
  // conversation id; the aggregation key below is the one the reference marks
  // mandatory.
  Object.assign(headers, conversation);
  if (accountId) {
    headers["x-user-id"] = accountId;
    headers["x-machine-id"] = deriveAccountStableId(accountId, "machine");
    headers["x-session-id"] = deriveAccountStableId(accountId, "session");
  }
  // Per-account device binding: distinct device identity per account (see
  // resolveBuddyDeviceBinding). Sent as the desktop's X-Device-Id-List.
  const binding = resolveBuddyDeviceBinding(context);
  if (binding !== undefined) {
    headers["x-device-id-list"] = JSON.stringify({ qimei36: binding });
  }
  Object.assign(headers, await buddyDeviceTokenHeaders({
    realm: domain.endsWith(".cn") ? "cn" : "intl",
    context,
    cliIdentity,
  }));
  return headers;
}

/**
 * Desktop risk token, sent only when the account actually has one.
 *
 * The account's own `auth_state` wins. When it carries none, a file the
 * desktop client writes (`CARTETHYIA_DEVICE_TOKEN_FILE`, default
 * `/app/data/device_token`) is read instead — cached for five minutes, and
 * ignored when it is larger than 1 KB, because a token file that size is not
 * a token. A missing file is the normal case and reads as "no token".
 */
const DEVICE_TOKEN_FILE_MAX_BYTES = 1024;
const DEVICE_TOKEN_FILE_TTL_MS = 5 * 60_000;
let deviceTokenFileCache: { readonly value: string | undefined; readonly readAt: number } | undefined;

export function readBuddyDeviceToken(context?: ProviderDispatchContext): string | undefined {
  const state = context?.credential.auth_state;
  const value = state?.["deviceToken"] ?? state?.["device_token"];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return readDeviceTokenFile();
}

/**
 * The reference `X-Device-Token` pair, per the official desktop app.
 *
 * The desktop client (WorkBuddyAI, channel 400111) always presents one of the
 * two on chat traffic — a real token from the TuringShield SDK, or an
 * `X-Device-Token-Error` when the SDK cannot produce one. It never omits both,
 * and it sends the header on every realm (Intl and CN alike). The SDK is a
 * proprietary native addon; when it is not configured we fall back to a
 * captured token (auth_state / `CARTETHYIA_DEVICE_TOKEN_FILE`) and only then
 * to the official failure state.
 *
 * - `CARTETHYIA_TURING_SDK_PATH` → real token via `TuringDeviceTokenService`.
 * - Legacy token (auth_state/file) → used when the SDK is unavailable.
 * - CLI identity never carries a device token (the CLI has no device).
 */
export async function buddyDeviceTokenHeaders(args: {
  realm: "intl" | "cn";
  context: ProviderDispatchContext | undefined;
  cliIdentity: boolean | undefined;
  turingConfig?: TuringSdkConfig;
}): Promise<Record<string, string>> {
  const { context, cliIdentity, turingConfig } = args;
  void args.realm; // the desktop client sends the token on both realms
  if (resolveBuddyIdentity(context, cliIdentity) === "cli") return {};
  // Native SDK first (real token), when configured.
  if (resolveTuringSdkRoot() !== null) {
    const sdkHeaders = await getTuringDeviceTokenService(turingConfig ?? WORKBUDDY_TURING_CONFIG).headersForRequest(false);
    if (sdkHeaders["x-device-token"] !== undefined) return sdkHeaders;
    // SDK configured but could not produce a token: mirror its failure state,
    // like the desktop client does — do not fall back to a stale file token.
    return sdkHeaders;
  }
  // No SDK on this deployment: a captured token is better than nothing.
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

/**
 * Shared OpenAI-compatible chat-adapter config for WorkBuddy: bearer auth
 * (api_key and oauth both use `Authorization: Bearer`), `/v2/chat/completions`
 * endpoint, per-request desktop-client headers, and the payload hook.
 */
export function workbuddyAdapterConfig(args: {
  providerId: ProviderId;
  baseUrl: string;
  domain?: string;
  prePayload: (
    payload: Record<string, unknown>,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ) => void;
  fetchImpl?: typeof fetch;
  cliIdentity?: boolean;
}): OpenAICompatibleAdapterConfig {
  return withBearerAuthentication({
    provider_id: args.providerId,
    base_url: args.baseUrl,
    endpoint_paths_by_wire_family: { chat: WORKBUDDY_CHAT_PATH },
    buildExtraHeaders: (context, request) =>
      workbuddyHeaders(context, request, args.domain ?? WORKBUDDY_DOMAIN, undefined, args.cliIdentity),
    prePayload: args.prePayload,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}
