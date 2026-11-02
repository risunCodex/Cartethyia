import { withBearerAuthentication, type OpenAICompatibleAdapterConfig } from "../../../adapters/compatible-adapter";
import type { CanonicalRequest } from "../../../../protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderId } from "../../../provider-contracts";
import { resolveInboundSessionId } from "../../../operations/session-resolution";
import { buddyConversationHeaders } from "../buddy-conversation-headers";
import {
  buddyAgentPurpose,
  buddyEnterprise,
  buddyOAuthIdentityHeaders,
  buddyPrivateData,
  buddyUserId,
  resolveBuddyDeviceBinding,
  resolveBuddyIdentity,
} from "../buddy-identity";
import { buildCodeBuddyUserAgent, getCodeBuddyCnVersion, getCodeBuddyVersion } from "../../../operations/client-versions";
import { buddyDeviceTokenHeaders } from "../workbuddy/shared";
import { CODEBUDDY_TURING_CONFIG } from "../turing-device-token";
import { buddyCliHeaders, buddyCliTraceHeaders } from "../buddy-cli-headers";

/** Client identity variant behind the per-request CodeBuddy headers. */
export type CodeBuddyVariant = "IDE" | "CLI";

export function codebuddyDomain(variant: CodeBuddyVariant): string {
  return variant === "IDE" ? "www.codebuddy.ai" : "copilot.tencent.com";
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
  const identity = variant === "IDE" ? "IDE" : "CLI";
  const ua = buildCodeBuddyUserAgent(identity);
  const conversationId = resolveInboundSessionId(context, request);
  const conversation = buddyConversationHeaders({
    ...(conversationId === undefined ? {} : { conversationId }),
  });
  if (resolveBuddyIdentity(context, cliIdentity) === "cli") {
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
      "User-Agent": `CLI/${getCodeBuddyVersion()} CodeBuddy/${getCodeBuddyVersion()}`,
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-IDE-Version": getCodeBuddyVersion(),
      "X-Domain": codebuddyDomain(variant),
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
      ...(purpose === undefined ? {} : { "X-Agent-Purpose": purpose }),
      ...conversation,
      ...(rootRequestId === undefined ? {} : { "X-Root-Request-ID": rootRequestId }),
      ...(parentConversationId === undefined
        ? {}
        : { "X-Parent-Conversation-ID": parentConversationId }),
      ...buddyCliTraceHeaders(conversation),
      // The CLI's OAuth identity family: X-User-Id from the JWT sub plus the
      // base64 X-Userinfo envelope when identity fields exist.
      ...buddyOAuthIdentityHeaders(context),
      ...buddyCliHeaders({
        userId: buddyUserId(context),
        enterpriseId: buddyEnterprise(context),
        privateData: buddyPrivateData(context),
      }),
    };
  }
  const purpose = buddyAgentPurpose(context, request);
  return {
    accept: "text/event-stream",
    "User-Agent": ua,
    "X-Product": "SaaS",
    "X-IDE-Type": identity,
    "X-IDE-Name": identity,
    // Every reference branch sends this, in both the desktop and the CLI
    // product; its absence here is what made a CodeBuddy dispatch the only
    // buddy caller with no client version on the wire.
    "X-IDE-Version": identity === "CLI" ? getCodeBuddyCnVersion() : getCodeBuddyVersion(),
    "X-Domain": codebuddyDomain(variant),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    // The effective agent purpose, matching the reference's dynamic value.
    // The reference does not invent `conversation`; it sends the purpose only
    // when one exists.
    ...(purpose === undefined ? {} : { "X-Agent-Purpose": purpose }),
    // Same family WorkBuddy sends: the upstream's channel check reads the
    // turn-level aggregation key, and a chat request without it is refused for a
    // missing conversation id.
    ...conversation,
    // Per-account device binding (qimei36) — distinct device per account.
    ...(() => {
      const binding = resolveBuddyDeviceBinding(context);
      return binding === undefined ? {} : { "X-Device-Id-List": JSON.stringify({ qimei36: binding }) };
    })(),
    // The desktop client sends the device-token pair on both realms. SDK
    // token when configured, captured token otherwise, or the official failure
    // placeholder. CodeBuddy uses its own SDK payload profile (same SDK,
    // distinct product identity). (CLI branch above already returned without
    // device headers.)
    ...(await buddyDeviceTokenHeaders({
      realm: identity === "IDE" ? "intl" : "cn",
      context,
      cliIdentity,
      turingConfig: CODEBUDDY_TURING_CONFIG,
    })),
  };
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
}): OpenAICompatibleAdapterConfig {
  return withBearerAuthentication({
    provider_id: args.providerId,
    base_url: args.baseUrl,
    buildExtraHeaders: (context, request) =>
      codebuddyHeaders(args.variant, context, request, args.cliIdentity),
    prePayload: args.prePayload,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}
