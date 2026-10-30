/**
 * Dedicated `claude` adapter.
 *
 * Wire mechanics live in `src/protocol/`:
 *   - `protocol/codecs.ts`         shared guards, tool-id/schema/tool-name helpers, endpoint URL
 *   - `protocol/request/messages.ts`   canonical -> Claude Messages body
 *   - `protocol/response/messages.ts`  Claude JSON/SSE -> canonical events
 *   - `protocol/upstream/send-claude-messages.ts` shared HTTP send helper
 *   - `errors.ts`   upstream HTTP error -> `GatewayError`
 *   - `policy.ts`   header/beta/credential policy (unchanged)
 *   - `cch.ts`      CCH billing-header body patch (unchanged)
 *
 * Bespoke by wire protocol (Phase C5): the Claude Messages envelope
 * (thinking blocks, cache_control, beta negotiation) is outside the
 * OpenAI-compatible factory's reach — stays bespoke, never re-audit.
 */
import { createHash } from "node:crypto";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { firstUserText, getHeader } from "../../../protocol/canonical-model";
import { log } from "../../../observability/logger";
import {
  assessClaudeCodeCompatibility,
  assertClaudeCodeCompatibility,
  requestHasClaudeTools,
} from "./claude-compatibility";
import { buildClaudeHeaders, type ClaudeHeaderOptions } from "./claude-credentials";
import { isRecord } from "../../../protocol/codecs";
import { HEADER_CONTROL } from "../../../security/outbound-headers";
import { CLAUDE_USER_PROFILES_BETA } from "./claude-user-profiles";
import { sharedClaudeSlowLanes } from "./claude-slow-lane";
import { planSlowLaneRetry } from "./claude-slow-lane-retry";
import { sleep } from "../../../transport/failure-policy";

/**
 * Floor reserved out of the request deadline before a slow-lane wait, so a
 * wait can never consume the budget the next real attempt needs. Mirrors
 * `MIN_RETRY_BUDGET_MS` in the attempt loop.
 */
const SLOW_LANE_DEADLINE_FLOOR_MS = 15_000;
import { resolvePromptCacheKey } from "../../operations/session-resolution";
import { ensureAnthropicBeta, filterClaudeCustomHeaders } from "../shared/claude-messages";
import {
  CLAUDE_CODE_SYSTEM_INSTRUCTION,
  createClaudeBillingText,
  patchClaudeCchBody,
} from "./claude-cch";
import { getClaudeCliVersion, adoptClaudeCliVersion, getClaudeSdkVersion } from "../../operations/client-versions";
import { adoptRequiredVersion } from "../../operations/client-version-resolver";
import { getOrCreateInstallId } from "../shared/install-id";
import { canonicalToClaudeMessagesPayload } from "../../../protocol/request/messages";
import { applyParamQuirks } from "../../../protocol/translation/quirks";
import { CLAUDE_BILLING_HEADER_PREFIX, endpointUrl } from "../../../protocol/codecs";
import { sendClaudeMessagesRequest } from "../../../protocol/upstream/send-claude-messages";
import {
  FALLBACK_CREDIT_BETA,
  fallbackCreditRequestBody,
  fallbackCreditTargetModel,
  hashBody,
  isFallbackCreditTokenRejection,
  refusalCreditToken,
  sharedFallbackCreditCache,
} from "./fallback-credit";
import { assertCredentialKind } from "../../provider-contracts";
import type { ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext } from "../../provider-contracts";
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";

const claudeMessagesModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  reasoning: boolean,
): ModelDefinition =>
  defineModel({
    id: modelId,
    wireFamily: "messages",
    endpoint: "/v1/messages",
    ctx: contextLimit,
    out: outputLimit,
    vision: true,
    reasoning,
    toolCall: true,
  });

export const CLAUDE_MODELS: readonly ModelDefinition[] = [
  claudeMessagesModel("claude-fable-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-fable-5-1", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-mythos-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-mythos-5-1", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-5-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-4-8", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-4-7", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-4-6", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-sonnet-5-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-sonnet-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-sonnet-4-6", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-4-5", 200_000, 64_000, true),
  // 200K: the 4.5 trio predates the million-token window, which arrived with
  // Opus 4.6. Only this row claimed 1M while its own siblings said 200K.
  claudeMessagesModel("claude-sonnet-4-5", 200_000, 64_000, true),
  claudeMessagesModel("claude-haiku-4-5", 200_000, 64_000, true),
];




const CLAUDE_DEVICE_ID_DOMAIN = "cartethyia-claude-device-id-v1";

/**
 * Stable per-installation id, persisted once like the Codex install id. The
 * assistant metadata `device_id` is derived from it so a machine keeps one
 * identity across restarts instead of minting a new one per request.
 *
 * The persistence lives in the shared install-id module: it owns the writable-
 * location fallback (a container runs with `HOME=/root` but as uid 10001) and
 * the policy that a telemetry identity never fails a request.
 */
async function getClaudeInstallId(): Promise<string> {
  return getOrCreateInstallId("claude");
}

/** The stable device id the assistant metadata carries for this installation. */
export async function claudeDeviceId(accountId?: string): Promise<string> {
  const hash = createHash("sha256").update(CLAUDE_DEVICE_ID_DOMAIN).update("\0").update(await getClaudeInstallId());
  if (accountId !== undefined && accountId.length > 0) hash.update("\0").update(accountId);
  return hash.digest("hex");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Whether a caller-supplied user id is already in an accepted shape: the
 * cloaked `user_<64hex>_account_<uuid>_session_<uuid>` form, or a JSON
 * envelope carrying a non-empty `session_id`.
 */
export function isClaudeMetadataUserId(value: string): boolean {
  if (/^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/i.test(value)) return true;
  if (!value.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      isRecord(parsed) &&
      typeof parsed["session_id"] === "string" &&
      (parsed["session_id"] as string).length > 0
    );
  } catch {
    return false;
  }
}

/** Adapter construction options used by deterministic local tests and custom endpoints. */
interface ClaudeAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly base_url?: string;
  readonly custom_headers?: Readonly<Record<string, unknown>>;
}

/**
 * Claude Code CLI impersonation adapter: builds Claude-branded headers via
 * `buildClaudeHeaders`, negotiates beta features, applies CCH billing-header
 * injection, and biases the payload/endpoint for OAuth-style credentials.
 * `provider_id` is always `"claude"` — plain Anthropic API-key traffic uses
 * `AnthropicApiKeyAdapter` instead, which never touches this impersonation
 * machinery.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly provider_id = "claude" as const;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string | undefined;
  private readonly customHeaders: Readonly<Record<string, unknown>> | undefined;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.base_url;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "messages") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        "claude supports messages only",
      );
    }
    if (
      context.credential.credential_kind !== "oauth" &&
      context.credential.credential_kind !== "scoped_access_token"
    ) {
      assertCredentialKind(context.credential, ["oauth", "scoped_access_token"], "claude");
    }
    const customHeaders = filterClaudeCustomHeaders({
      ...this.customHeaders,
      ...context.credential.custom_headers,
    });
    const isClaudeCodeOAuth =
      context.credential.credential_kind === "oauth" ||
      context.credential.credential_kind === "scoped_access_token";
    const incomingBeta = getHeader(context.request_headers, "anthropic-beta");
    const assessment = assessClaudeCodeCompatibility(request, {
      capabilities: candidate.capabilities,
      beta_header: incomingBeta,
      beta_policy: "reject",
      credential_kind: context.credential.credential_kind,
      target_provider: "claude",
    });
    assertClaudeCodeCompatibility(assessment);
    const hasThinking =
      request.reasoning !== undefined &&
      request.reasoning.thinking_type !== "disabled";
    const hasTools = requestHasClaudeTools(request);
    const cliVersion = getClaudeCliVersion();
    const sdkVersion = getClaudeSdkVersion();
    const headerOptions: ClaudeHeaderOptions = {
      credential_kind: context.credential.credential_kind,
      custom_headers: customHeaders,
      capabilities: candidate.capabilities,
      unsupported_beta_policy: "reject",
      target_provider: "claude",
      has_thinking: hasThinking,
      has_tools: hasTools,
      stream: request.stream,
      cli_version: cliVersion,
      sdk_version: sdkVersion,
      ...(context.request_headers === undefined
        ? {}
        : { request_headers: context.request_headers }),
      ...(incomingBeta === undefined ? {} : { anthropic_beta: incomingBeta }),
    };
    const headers: Record<string, string> = buildClaudeHeaders(
      context.credential.secret,
      context.credential.account_id,
      headerOptions,
    );
    const profileId = request.generation_controls["extension:user_profile_id"];
    // A profile id travels two ways on the same request: the `user-profiles`
    // beta that unlocks profile scoping, and the header that names *which*
    // profile. Carrying only the beta declares the capability without ever
    // addressing a profile, so a profile-scoped credential could not be
    // selected.
    if (typeof profileId === "string" && profileId.length > 0) {
      // Dated, not bare: the donor sends `user-profiles-2026-09-04`
      // (the reference client `packages/ai/src/providers/anthropic-user-profiles.ts:4`).
      // `ensureAnthropicBeta` takes any string, so a bare "user-profiles" would
      // pass every check while being a beta Anthropic has never published — an
      // undocumented value the upstream ignores.
      ensureAnthropicBeta(headers, CLAUDE_USER_PROFILES_BETA);
      if (!HEADER_CONTROL.test(profileId)) {
        headers["anthropic-user-profile-id"] = profileId;
      } else {
        // Never let a caller's newline reach the wire: an injected header is
        // the one thing a filter downstream cannot undo.
        log.warn("claude: user_profile_id dropped, contains control characters", {
          provider: "claude",
        });
      }
    }
    const sessionId =
      headers["X-Claude-Code-Session-Id"] ?? resolvePromptCacheKey(request, context);
    // Provider/model parameter quirks run before translation, exactly as they do
    // on the API-key (`anthropic`) path. Without this call the Claude Code
    // adapter never reached the table, so a model that rejects `temperature`
    // (`claude-opus-4-7` and later, `claude-sonnet-5`, `claude-fable-5`) got a
    // 400 on every request that carried one — including the probe, which sets
    // `temperature: 0.2` itself.
    const payload = canonicalToClaudeMessagesPayload(
      applyParamQuirks(request, candidate.provider_id),
      { isOAuth: isClaudeCodeOAuth },
    );
    if (isClaudeCodeOAuth) {
      // Session attribution follows the reference rules: a valid caller id
      // travels verbatim; otherwise a JSON envelope is generated from the
      // resolved session identity (never a bare UUID, which matches neither
      // accepted grammar). API-key callers without an id send none.
      const callerUserId = request.generation_controls["extension:metadata_user_id"];
      if (typeof callerUserId === "string" && isClaudeMetadataUserId(callerUserId)) {
        payload.metadata = { user_id: callerUserId };
      } else if (sessionId !== undefined && sessionId.length > 0) {
        const accountUuid = isUuid(context.credential.account_id)
          ? context.credential.account_id
          : undefined;
        payload.metadata = {
          user_id: JSON.stringify({
            device_id: await claudeDeviceId(accountUuid),
            session_id: sessionId,
            ...(accountUuid === undefined ? {} : { account_uuid: accountUuid }),
          }),
        };
      }
      const system = Array.isArray(payload.system) ? payload.system : [];
      const userText = firstUserText(request);
      const billing = {
        type: "text",
        text: createClaudeBillingText(userText, cliVersion),
      };
      // The breakpoint is NOT pinned here. The reference client caches the
      // *last* system block, so when the caller supplies its own prompt the
      // breakpoint belongs on that, not on the identity — pinning it here put
      // a breakpoint mid-prefix and left the caller's prompt uncached, which
      // is both a fingerprint delta and a cache miss on every request.
      const instruction = {
        type: "text",
        text: CLAUDE_CODE_SYSTEM_INSTRUCTION,
      };
      const hasInstruction = system.some(
        (block) => isRecord(block) && block["text"] === CLAUDE_CODE_SYSTEM_INSTRUCTION,
      );
      const hasBilling = system.some(
        (block) =>
          isRecord(block) &&
          typeof block["text"] === "string" &&
          (block["text"] as string).startsWith(CLAUDE_BILLING_HEADER_PREFIX),
      );
      // Captured-client placement: billing first, instruction second. The
      // patch anchor assumes this order — never reorder around it.
      const assembled = [
        ...(hasBilling ? [] : [billing]),
        ...(hasInstruction ? [] : [instruction]),
        ...system,
      ];
      // The cache breakpoint rides the last system block: everything before it
      // is stable prefix, and caching the tail is what the reference client
      // does. Billing is never breakpointed — it varies per request.
      const lastIndex = assembled.length - 1;
      if (lastIndex > 0) {
        const last = assembled[lastIndex];
        const existing = isRecord(last) ? last["cache_control"] : undefined;
        // A caller's own breakpoint is kept, but upgraded to the reference
        // client's 1h retention when it stated none: that is the default the
        // real CLI sends, and leaving it bare caches a shorter prefix than the
        // upstream will honour.
        const breakpoint =
          isRecord(existing) && existing["ttl"] !== undefined
            ? existing
            : { type: "ephemeral", ttl: "1h" };
        if (isRecord(last)) {
          assembled[lastIndex] = { ...last, cache_control: breakpoint };
        }
      }
      payload.system = assembled;
    }
    const url = endpointUrl(
      this.baseUrl,
      candidate.endpoint_path || "/v1/messages",
      isClaudeCodeOAuth,
    );
    const requestBody = JSON.stringify(payload);
    const patchedBody = isClaudeCodeOAuth ? patchClaudeCchBody(requestBody) : undefined;
    if (isClaudeCodeOAuth && patchedBody === undefined) {
      // Unanchored billing block: warn and send as-is, exactly like the
      // reference client. Availability wins over attestation here — an
      // unattested send is the accepted fallback, a 500 is a self-DoS.
      log.warn("claude billing attestation unanchored; sending unattested", {
        provider: "claude",
      });
    }
    const outboundBody =
      patchedBody === undefined ? requestBody : new TextDecoder().decode(patchedBody);
    // Fallback-credit redemption: a previous refusal of *this exact body* may
    // have left a token that buys one free replay. Keyed by the frozen body
    // because the donor binds the token to the request that was refused
    // (`anthropic.ts:3303`, `params: structuredClone(params)`).
    const creditKey = hashBody(outboundBody);
    const creditToken = sharedFallbackCreditCache.get(creditKey);
    let creditSent = false;
    let body = outboundBody;
    if (creditToken !== undefined) {
      const target = fallbackCreditTargetModel(request.provider_options);
      const redemption = fallbackCreditRequestBody(outboundBody, creditToken, target);
      if (redemption !== undefined) {
        body = redemption;
        creditSent = true;
        // The donor guarantees the beta is present on every redemption
        // (`anthropic.ts:2433-2435`, `:2782-2784`); on this side it is only
        // on the agent profile (`claude-credentials.ts:124`), so add it here.
        ensureAnthropicBeta(headers, FALLBACK_CREDIT_BETA);
      }
    }
    // Slow lane (design doc §5): attach the usage limit when this account's
    // lane is active, so the upstream knows it may serve us on spare capacity.
    // First-party OAuth only, mirroring the donor's gate
    // (`anthropic.ts:2695-2705`). Nothing changes for every other request.
    const accountId = context.credential.account_id;
    const slowEligible =
      isClaudeCodeOAuth && accountId !== undefined && sharedClaudeSlowLanes.isActive(accountId);
    const slowHeaders: Record<string, string> = slowEligible
      ? { ...headers, "anthropic-usage-limit": "slow" }
      : headers;

    // Adopt-on-rejection: a stale pinned CLI version costs one rejected
    // request, not an outage. The shared helper parses the server-named
    // minimum and promotes it process-wide; a retry at the same version
    // cannot loop because the helper only reports a forward move.
    const sendOnce = (
      headers: Record<string, string>,
      body: string,
    ): AsyncIterable<CanonicalEvent> =>
      sendClaudeMessagesRequest(
        url,
        headers,
        body,
        context,
        request,
        this.fetchFn,
        isClaudeCodeOAuth,
      );
    try {
      yield* this.sendWithCreditCapture(
        sendOnce,
        slowHeaders,
        body,
        creditSent ? undefined : creditKey,
      );
      if (creditSent) {
        // One-shot spend. The donor consumes the handle once a turn is served
        // (`consumeActiveFallbackCreditRedemption`, `turn-recovery.ts:510-519`);
        // leaving it here would replay a spent token on the next identical
        // request and cost it the 400 round trip below.
        sharedFallbackCreditCache.delete(creditKey);
      }
      return;
    } catch (error: unknown) {
      // Slow-lane capacity wait (design doc §5): a 429 `slot_busy` or a 529 /
      // `overloaded_error` while the slow limit was sent means "no spare
      // capacity right now", not "this account is done". Retry the SAME
      // account after the server-stated interval rather than failing over —
      // and record no health, because nothing failed.
      //
      // Runs before every other error branch so a capacity wait is never
      // misread as a version rejection or a credential problem.
      if (slowEligible && accountId !== undefined) {
        const waited = await this.planAndWaitSlowLane(error, accountId, context);
        if (waited) {
          // Same account, same bytes: the capacity wait is not a failover.
          yield* this.sendWithCreditCapture(
            sendOnce,
            slowHeaders,
            body,
            creditSent ? undefined : creditKey,
          );
          return;
        }
      }
      if (creditSent && isFallbackCreditTokenRejection(error)) {
        // Donor `anthropic.ts:3469-3481`: the token is rejected, so forfeit it
        // and retry the standard request once without it. A rebuilt body no
        // longer matches the refused one, so the credit cannot ride along.
        sharedFallbackCreditCache.delete(creditKey);
        log.warn("claude: fallback credit token rejected, retrying without it", {
          provider: "claude",
          error: error instanceof Error ? error.message : String(error),
        });
        yield* sendOnce(headers, outboundBody);
        return;
      }
      const adopted = adoptRequiredVersion(
        { get: getClaudeCliVersion },
        adoptClaudeCliVersion,
        error,
        {
          marker: "claude_code_version_too_old",
          pattern: /version (\d+\.\d+\.\d+) or newer is required/i,
        },
      );
      if (adopted === null) throw error;
      const retryCliVersion = getClaudeCliVersion();
      log.warn("claude: adopted server-named CLI version, retrying once", {
        provider: "claude",
        version: retryCliVersion,
      });
      const retryBilling = {
        type: "text",
        text: createClaudeBillingText(firstUserText(request), retryCliVersion),
      };
      const existingSystem = Array.isArray(payload["system"])
        ? (payload["system"] as unknown[])
        : [];
      const retryBody = isClaudeCodeOAuth
        ? patchClaudeCchBody(
            JSON.stringify({
              ...payload,
              system: [
                retryBilling,
                ...existingSystem.filter(
                  (block) =>
                    !(
                      isRecord(block) &&
                      typeof block["text"] === "string" &&
                      (block["text"] as string).startsWith(CLAUDE_BILLING_HEADER_PREFIX)
                    ),
                ),
              ],
            }),
          )
        : undefined;
      const retryHeaders: Record<string, string> = {
        ...headers,
        "User-Agent": `claude-cli/${retryCliVersion} (external, cli)`,
      };
      yield* sendOnce(
        retryHeaders,
        retryBody === undefined ? outboundBody : new TextDecoder().decode(retryBody),
      );
    }
  }

  /**
   * Sends once, passing every event through, and banks a refusal's credit token
   * against the body that was refused.
   *
   * Donor rule (`anthropic.ts:3287-3309`): only a refusal carries a token, and
   * the frozen body is the request that produced it (`params: structuredClone(params)`).
   * On this side the refusal surfaces as a terminal event whose canonical
   * `stop_reason` is `error` (`mapClaudeStopReason`, `response/messages.ts:32-34`)
   * carrying the provider's `stop_details`.
   *
   * `captureKey` is omitted for a redemption send: a body already carrying a
   * token is never the body that was refused, so banking against it would only
   * occupy a cache slot for five minutes with a token that cannot be replayed.
   */
  /**
   * Waits out a slow-lane capacity signal and reports whether to retry.
   *
   * Returns true when the failure was a capacity wait that has now elapsed and
   * the caller should resend; false when it was anything else, so the normal
   * error path proceeds untouched.
   *
   * Bounded by the server's own max-wait and by the request deadline minus the
   * attempt-loop's floor, so a wait can never eat the budget a real retry
   * needs. No health is recorded here — a capacity wait is not a failure.
   */
  private async planAndWaitSlowLane(
    error: unknown,
    accountId: string,
    context: ProviderDispatchContext,
  ): Promise<boolean> {
    const httpStatus =
      error instanceof GatewayError && typeof error.status === "number" ? error.status : undefined;
    const decision = planSlowLaneRetry(
      {
        ...(httpStatus === undefined ? {} : { httpStatus }),
        message: error instanceof Error ? error.message : String(error),
        sentSlow: true,
        // One wait per dispatch: this adapter carries no cross-attempt counter,
        // and a single wait is the conservative bound.
        waitedMs: 0,
        attempts: 0,
      },
      sharedClaudeSlowLanes,
      accountId,
    );
    if (decision === null) return false;

    const allowance = context.deadline - Date.now() - SLOW_LANE_DEADLINE_FLOOR_MS;
    if (allowance <= 0) return false;
    const waitMs = Math.min(decision.delayMs, allowance);
    log.warn("claude: slow lane busy, waiting for capacity on the same account", {
      provider: "claude",
      waitMs,
    });
    try {
      await sleep(waitMs, context.abort_signal);
    } catch {
      // Aborted mid-wait: let the caller surface the original failure rather
      // than a bare cancel, so the client still sees the rate limit.
      return false;
    }
    return true;
  }

  private async *sendWithCreditCapture(
    sendOnce: (
      headers: Record<string, string>,
      body: string,
    ) => AsyncIterable<CanonicalEvent>,
    headers: Record<string, string>,
    body: string,
    captureKey: string | undefined,
  ): AsyncIterable<CanonicalEvent> {
    for await (const event of sendOnce(headers, body)) {
      if (captureKey !== undefined && event.type === "terminal" && event.stop_reason === "error") {
        const token = refusalCreditToken(event.stop_details);
        if (token !== undefined) {
          sharedFallbackCreditCache.set(captureKey, token);
          log.warn("claude: refusal carried a fallback credit, banked for replay", {
            provider: "claude",
          });
        }
      }
      yield event;
    }
  }
}

export const claudeAdapter = new ClaudeAdapter();
