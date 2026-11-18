import { withBearerAuthentication, type OpenAICompatibleAdapterConfig } from "../../../adapters/compatible-adapter";
import type { CanonicalRequest } from "../../../../protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderId } from "../../../provider-contracts";
import { resolveInboundSessionId } from "../../../operations/session-resolution";
import { buddyConversationHeaders } from "../headers";
import {
  buddyAgentPurpose,
  buddyEnterprise,
  buddyOAuthIdentityHeaders,
  buddyPrivateData,
  buddyUserId,
  resolveBuddyDeviceBinding,
  resolveBuddyHeaderIdentity,
  resolveBuddyIdentity,
} from "../headers";
import { buildCodeBuddyUserAgent, getCodeBuddyCnVersion, getCodeBuddyVersion } from "../../../operations/client-versions";
import { buddyDeviceTokenHeaders } from "../headers";
import { buddyCliHeaders, buddyCliTraceHeaders } from "../headers";

/** Client identity variant behind the per-request CodeBuddy headers. */
export type CodeBuddyVariant = "IDE" | "CLI";

export function codebuddyDomain(variant: CodeBuddyVariant): string {
  return variant === "IDE" ? "www.codebuddy.ai" : "copilot.tencent.com";
}

/**
 * Version source for the identity block's `User-Agent` and `X-IDE-Version`.
 *
 * - `"cli-package"` — the npm `@tencent-ai/codebuddy-code` pin for both the
 *   User-Agent halves and `X-IDE-Version` (the reference CLI contract).
 * - `"cn-desktop"` — the CN desktop build for the CLI identity's versions,
 *   the intl package pin for IDE (the desktop/hybrid contract).
 * - `"auto"` — `cli-package` for CLI, `cn-desktop` for IDE.
 */
export type BuddyIdentityVersion = "auto" | "cli-package" | "cn-desktop";

export interface BuddyIdentityHeaderOptions {
  /** Version source for `User-Agent` / `X-IDE-Version`; default `"auto"`. */
  readonly version?: BuddyIdentityVersion;
  /** Extra headers merged under the identity block (never overrides it). */
  readonly extras?: Readonly<Record<string, string>>;
}

/**
 * The CodeBuddy client-identity header block — the single owner of the
 * `X-Product` / `X-IDE-*` / `X-Domain` / request-marker family shared by chat
 * dispatch, billing/quota reads, and check-in calls.
 *
 * Marker casing is normalized to the desktop contract (`x-requested-with`,
 * `x-codebuddy-request`); the wire is case-insensitive and `fetch` lowercases
 * every name before sending, so bytes on the wire are unchanged.
 */
export function buddyIdentityHeaders(
  variant: CodeBuddyVariant,
  options: BuddyIdentityHeaderOptions = {},
): Record<string, string> {
  const version = options.version ?? "auto";
  const resolved: BuddyIdentityVersion =
    version === "auto" ? (variant === "CLI" ? "cli-package" : "cn-desktop") : version;
  const cliPackage = resolved === "cli-package";
  const packageVersion = getCodeBuddyVersion();
  const cnVersion = getCodeBuddyCnVersion();
  const ideVersion = variant === "CLI" ? (cliPackage ? packageVersion : cnVersion) : packageVersion;
  const userAgent = cliPackage
    ? `CLI/${packageVersion} CodeBuddy/${packageVersion}`
    : buildCodeBuddyUserAgent(variant);
  return {
    ...(options.extras ?? {}),
    "User-Agent": userAgent,
    "X-Product": "SaaS",
    "X-IDE-Type": variant,
    "X-IDE-Name": variant,
    "X-IDE-Version": ideVersion,
    "X-Domain": codebuddyDomain(variant),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
  };
}


/**
 * Per-request CodeBuddy headers — exact provider contract shared by the
 * international (IDE identity) and CN (CLI identity). The stable conversation
 * header is preserved from the client when available; request IDs rotate.
 *
 * `cliIdentity` selects the real CLI contract rather than today's hybrid: the
 * reference CLI is issued by the OpenAI Node SDK, so it carries no browser
 * headers and no device token, and it adds the agent envelope. Left unset it
 * keeps the current behaviour for every provider.
 */
export async function codebuddyHeaders(
  variant: CodeBuddyVariant,
  context?: ProviderDispatchContext,
  request?: CanonicalRequest,
  cliIdentity?: boolean,
): Promise<Record<string, string>> {
  const conversationId = resolveInboundSessionId(context, request);
  const conversation = buddyConversationHeaders({
    ...(conversationId === undefined ? {} : { conversationId }),
  });
  if (resolveBuddyIdentity(context, cliIdentity) === "cli") {
    const identity = resolveBuddyHeaderIdentity(context);
    const purpose = buddyAgentPurpose(context, request);
    // Root/parent conversation context is forwarded only when the caller
    // actually supplied it — the reference emits these conditionally for
    // subagent/root chains and never invents them.
    const inbound = context?.request_headers;
    const rootRequestId = inbound?.["x-root-request-id"]?.trim();
    const parentConversationId = inbound?.["x-parent-conversation-id"]?.trim();
    return {
      // The CLI sends `Accept: application/json` and no device token. It keeps
      // the request-shape markers (`X-Requested-With`, `X-CodeBuddy-Request`)
      // the reference sends on every call regardless of transport, but drops
      // the browser *transport* header (`accept: text/event-stream`) — so the
      // identity is still CLI, not the desktop hybrid.
      accept: "application/json",
      // The reference CLI is issued by the OpenAI Node SDK: its User-Agent and
      // X-IDE-Version both name the npm CLI package pin (`cli-package`).
      ...buddyIdentityHeaders(variant, { version: "cli-package" }),
      ...(purpose === undefined ? {} : { "X-Agent-Purpose": purpose }),
      ...conversation,
      ...(rootRequestId === undefined ? {} : { "X-Root-Request-ID": rootRequestId }),
      ...(parentConversationId === undefined
        ? {}
        : { "X-Parent-Conversation-ID": parentConversationId }),
      ...buddyCliTraceHeaders(conversation),
      // The CLI's OAuth identity family: X-User-Id from the JWT sub plus the
      // base64 X-Userinfo envelope when identity fields exist.
      ...buddyOAuthIdentityHeaders(context, identity),
      ...buddyCliHeaders({
        userId: buddyUserId(context, identity),
        enterpriseId: buddyEnterprise(context, identity),
        privateData: buddyPrivateData(context),
      }),
    };
  }
  const purpose = buddyAgentPurpose(context, request);
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    // Desktop/hybrid identity: User-Agent and X-IDE-Version resolve through
    // the variant (`cn-desktop` — the CN desktop build for CLI, the intl
    // package pin for IDE).
    ...buddyIdentityHeaders(variant),
  };
  // The effective agent purpose, matching the reference's dynamic value.
  // The reference does not invent `conversation`; it sends the purpose only
  // when one exists.
  if (purpose !== undefined) headers["X-Agent-Purpose"] = purpose;
  // The upstream's channel check reads the turn-level aggregation key, and a
  // chat request without it is refused for a missing conversation id.
  Object.assign(headers, conversation);
  // Per-account device binding (qimei36) — distinct device per account.
  const binding = resolveBuddyDeviceBinding(context);
  if (binding !== undefined) {
    headers["X-Device-Id-List"] = JSON.stringify({ qimei36: binding });
  }
  // The desktop client sends the device-token pair on both realms. Captured
  // token (auth_state / device-token file) when present, otherwise the
  // official failure placeholder. (CLI branch above already returned without
  // device headers.)
  Object.assign(headers, await buddyDeviceTokenHeaders({
    realm: variant === "IDE" ? "intl" : "cn",
    context,
    cliIdentity,
  }));
  return headers;
}

/**
 * Shared OpenAI-compatible chat-adapter config for both CodeBuddy variants:
 * bearer auth, chat-only wire contract, per-request identity headers, and the
 * variant's payload hook.
 */
export function codebuddyAdapterConfig(args: {
  providerId: ProviderId;
  baseUrl: string;
  variant: CodeBuddyVariant;
  prePayload: (
    payload: Record<string, unknown>,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ) => void;
  fetchImpl?: typeof fetch;
  cliIdentity?: boolean;
  /**
   * Body compression for chat dispatches. The CodeBuddy CLI contract (donor
   * `codebuddy2api`) gzips the JSON body for the CLI profiles and sends
   * `Accept-Encoding: identity`. `"json"` (default) keeps plain JSON.
   */
  requestCompression?: "json" | "gzip";
  /** When set, retry a channel-check 400 against this path (console fallback). */
  channelFallbackPath?: string;
}): OpenAICompatibleAdapterConfig {
  return withBearerAuthentication({
    provider_id: args.providerId,
    base_url: args.baseUrl,
    buildExtraHeaders: (context, request) =>
      codebuddyHeaders(args.variant, context, request, args.cliIdentity),
    prePayload: args.prePayload,
    ...(args.requestCompression === undefined
      ? {}
      : { request_compression: args.requestCompression }),
    ...(args.channelFallbackPath === undefined
      ? {}
      : { channel_fallback_path: args.channelFallbackPath }),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}
