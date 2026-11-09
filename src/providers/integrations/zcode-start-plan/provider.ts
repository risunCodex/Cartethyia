/**
 * ZCode Start Plan provider integration.
 *
 * The plan lane is an Anthropic Messages endpoint that only accepts the
 * dressed ZCode client request (see `dress`): the gateway content-inspects the
 * `system` field and refuses a request without the exact three-block identity
 * fingerprint with `405 {code:3012}`. The credential is a ZCode login JWT —
 * pasted, or minted by the sign-in flow (`oauth.ts`).
 *
 * Wire facts mirrored from the donor gateway (verified live 2026-10-30):
 * - `anthropic-beta: mid-conversation-system-2026-04-07` rides every request.
 * - `metadata.user_id` is a JSON string `{"device_id","account_uuid","session_id"}`
 *   the gateway reads for attribution; it lives in the body, not a header.
 * - The LLM identity face carries per-request correlation ids: `x-session-id`,
 *   `x-request-id`, `x-zcode-trace-id`, `x-query-id`, `x-zcode-query-source`.
 * - Errors inside an HTTP 200 response come as a `{code,msg,logid}` envelope
 *   (`1113` grant spent, `3009` model concurrency, `3012` identity gate) and
 *   are mapped through the shared `classifyUpstreamError`.
 */
import { randomUUID } from "node:crypto";
import { release as osRelease } from "node:os";

import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";
import { getOrCreateInstallId } from "../shared/install-id";
import { resolveInboundSessionId } from "../../operations/session-resolution";
import { assertCredentialKind, assertWireFamily } from "../../provider-contracts";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../provider-contracts";
import { GatewayError } from "../../../protocol/gateway-error";
import { applyParamQuirks } from "../../../protocol/translation/quirks";
import { buildClaudeMessagesRequest, filterClaudeCustomHeaders } from "../shared/claude-messages";
import { mapClaudeHttpError } from "../../../protocol/messages-errors";
import { isRecord } from "../../../protocol/codecs";
import { classifyUpstreamError, upstreamErrorIdentifier, upstreamMessageAsIs } from "../../../transport/failure-policy";
import { parseClaudeSseStream, claudeResponseToEvents } from "../../../protocol/response/messages";
import { createUpstreamDeadlineLifecycle } from "../../operations/upstream-deadline";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { parseJwt } from "../../authentication/jwt-validator";
import prompt from "./zcode_prompt.json";

const CLI_PREFIX: string = prompt.cliPrefix;
const STABLE_SECTIONS: readonly string[] = prompt.stableSections;
const ENVIRONMENT_TEMPLATE: string = prompt.environmentTemplate;

export const ZCODE_START_PLAN_PROVIDER_ID = "zcode-start" as const;
export const ZCODE_START_PLAN_ENDPOINT_PATH = "/v1/messages" as const;
export const ZCODE_START_PLAN_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic" as const;

/**
 * Client version the plan endpoint expects in the identity headers. This is
 * kept in step with the bundled prompt asset (`zcode_prompt.json`, 3.14.5):
 * the gateway content-inspects the system blocks, and a version/prompt split
 * (e.g. 3.16.3 headers over 3.14.5 blocks) risks the 3012 identity gate. Bump
 * both together only after re-capturing the live blocks and re-verifying.
 */
const APP_VERSION = "3.14.5";
/** Anthropic beta the desktop client sends on the plan lane (captured live). */
const ANTHROPIC_BETA = "mid-conversation-system-2026-04-07";
/** The plan gateway enforces a serial per-account in-flight limit; 8192 is the desktop default. */
const DEFAULT_MAX_TOKENS = 8192;

type Loose = Record<string, unknown>;
type TextBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

function cached(text: string): TextBlock {
  return { type: "text", text, cache_control: { type: "ephemeral" } };
}

/** Fills the environment block; the whole text is data, not layout. */
function environmentBlock(provider: string, model: string): string {
  return ENVIRONMENT_TEMPLATE.replace("{cwd}", process.cwd())
    .replace("{platform}", "linux")
    .replace("{shell}", "bash")
    .replace("{provider}", provider)
    .replace("{model}", model);
}

/** The account uuid carried by the plan JWT, for metadata attribution. */
function jwtUserId(credential: { secret?: Uint8Array | undefined } | undefined): string {
  if (!credential?.secret || credential.secret.length === 0) return "";
  try {
    const token = new TextDecoder().decode(credential.secret);
    const parsed = parseJwt(token);
    const userId = parsed?.payload?.["user_id"];
    return typeof userId === "string" ? userId : "";
  } catch {
    return "";
  }
}

/** Identity headers every dispatch carries; the adapter adds Authorization. */
async function identityHeaders(context: ProviderDispatchContext): Promise<Record<string, string>> {
  const sessionId = resolveInboundSessionId(context) ?? `session_${randomUUID().replace(/-/g, "").slice(0, 32)}`;
  const requestId = randomUUID();
  const traceId = randomUUID();
  const queryId = `01a1${requestId.slice(4).replace(/-/g, "").slice(0, 28)}`;
  const deviceMid = await getOrCreateInstallId("zcode-start-plan");
  return {
    "user-agent": `ZCode/${APP_VERSION} ai-sdk/anthropic/3.0.81`,
    "http-referer": "https://zcode.z.ai",
    "x-title": "Z Code@electron",
    "x-zcode-app-version": APP_VERSION,
    "x-zcode-agent": "glm",
    "x-release-channel": "production",
    "x-client-language": "en-US",
    "x-client-timezone": "Asia/Jakarta",
    "x-platform": "linux-x64",
    "x-os-category": "linux",
    "x-os-version": osRelease(),
    "x-request-id": requestId,
    "x-query-id": queryId,
    "x-zcode-trace-id": traceId,
    "x-zcode-session-type": "main",
    "x-zcode-query-source": "main_turn",
    "x-session-id": sessionId,
    "x-device-mid": deviceMid,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": ANTHROPIC_BETA,
  };
}

/**
 * Replaces the payload's system prompt with the ZCode three-block fingerprint.
 * A caller-supplied system prompt is folded into the third block, after the
 * environment text: a separate block is rejected with 3012.
 */
function dress(payload: Loose, provider = "zcode"): void {
  const model = typeof payload.model === "string" ? payload.model : "";
  const own: string[] = [];
  const system = payload.system;
  if (typeof system === "string") {
    if (system.trim()) own.push(system);
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as Loose).type === "text" &&
        typeof (block as Loose).text === "string" &&
        (block as Loose).text
      ) {
        own.push((block as Loose).text as string);
      }
    }
  }
  const tail = [environmentBlock(provider, model), ...own].join("\n\n");
  payload.system = [
    cached(CLI_PREFIX),
    cached(STABLE_SECTIONS.join("\n\n")),
    cached(tail),
  ];
}

export const ZCODE_START_PLAN_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "glm-5.3",
    providerId: ZCODE_START_PLAN_PROVIDER_ID,
    wireFamily: "messages",
    endpoint: ZCODE_START_PLAN_ENDPOINT_PATH,
    ctx: 1_000_000,
    out: 131_072,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "glm-5.3-flash",
    providerId: ZCODE_START_PLAN_PROVIDER_ID,
    wireFamily: "messages",
    endpoint: ZCODE_START_PLAN_ENDPOINT_PATH,
    ctx: 1_000_000,
    out: 131_072,
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
];

/** True when the body is the ZCode `{code,msg,logid}` business-error envelope. */
function isZcodeEnvelopeError(body: Record<string, unknown>): boolean {
  if (body["success"] === false) return true;
  const code = body["code"];
  return code !== undefined && ![0, 200, "0", "200"].includes(code as string | number);
}

/**
 * Plan-lane Messages adapter. Unlike the plain Anthropic adapter it must (a)
 * dress the three-block system fingerprint, (b) inject `metadata.user_id`, and
 * (c) treat a `{code,msg}` envelope inside an HTTP 200 as a refusal — the
 * gateway reports business errors on success statuses.
 */
export class ZcodeStartPlanAdapter implements ProviderAdapter {
  readonly provider_id = ZCODE_START_PLAN_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(fetchImpl?: typeof fetch, baseUrl?: string) {
    this.fetchFn = fetchImpl ?? globalThis.fetch;
    this.baseUrl = (baseUrl ?? ZCODE_START_PLAN_BASE_URL).replace(/\/+$/, "");
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "messages") {
      assertWireFamily(candidate, "messages", "zcode-start messages leg");
    }
    if (context.credential.credential_kind !== "api_key") {
      assertCredentialKind(context.credential, "api_key", "zcode-start");
    }
    if (context.credential.secret === undefined || context.credential.secret.length === 0) {
      throw new GatewayError(
        "invalid_request",
        400,
        "zcode-start: plan JWT is missing a secret value (request {requestId}). Wrong key, right door — check the credential 🔑",
      );
    }
    const planJwt = new TextDecoder().decode(context.credential.secret);
    const sessionId = resolveInboundSessionId(context, request) ?? `session_${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    const deviceMid = await getOrCreateInstallId("zcode-start-plan");
    const accountUuid = jwtUserId(context.credential);
    const customHeaders = filterClaudeCustomHeaders({
      ...context.credential.custom_headers,
    });
    const outbound = buildClaudeMessagesRequest({
      request: applyParamQuirks(request, candidate.provider_id),
      authHeader: "bearer",
      credential: { secret: planJwt, customHeaders },
      baseUrl: this.baseUrl,
      endpointPath: candidate.endpoint_path,
      mutatePayload: (payload) => {
        dress(payload);
        const metadata = (isRecord(payload["metadata"]) ? payload["metadata"] : {}) as Loose;
        metadata["user_id"] = JSON.stringify({
          device_id: deviceMid,
          account_uuid: accountUuid,
          session_id: sessionId,
        });
        payload.metadata = metadata;
        if (payload["max_tokens"] == null) payload["max_tokens"] = DEFAULT_MAX_TOKENS;
        return payload;
      },
    });
    Object.assign(outbound.headers, await identityHeaders(context));

    const outboundFetch = context.outbound_fetch ?? this.fetchFn;
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    let response: Response;
    try {
      response = await outboundFetch(outbound.url, {
        method: "POST",
        headers: outbound.headers,
        body: outbound.body,
        signal: lifecycle.signal,
      });
    } catch (error: unknown) {
      lifecycle.release();
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(
        "transport_unavailable",
        502,
        `zcode-start upstream fetch failed: ${(error as Error)?.message ?? String(error)}`,
        {},
        "network",
      );
    }
    lifecycle.release();

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw mapClaudeHttpError(response.status, bodyText, response.headers);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("text/event-stream") || request.stream) {
      if (response.body === null) {
        throw new GatewayError(
          "platform_unavailable",
          502,
          "zcode-start returned no stream body (request {requestId}). The upstream came back empty-handed — retry 🌙",
          {},
          "upstream",
        );
      }
      yield* parseClaudeSseStream(response.body, context.abort_signal, false);
      return;
    }
    const bodyText = await response.text().catch(() => "");
    let json: unknown;
    try {
      json = JSON.parse(bodyText) as unknown;
    } catch {
      const upstreamText = upstreamMessageAsIs(bodyText, "");
      throw new GatewayError(
        "platform_unavailable",
        502,
        upstreamText.message || "zcode-start response is not valid JSON (request {requestId}). The upstream came back empty-handed — retry 🌙",
        { raw: bodyText.slice(0, 4096) },
        "upstream",
      );
    }
    if (!isRecord(json)) {
      throw new GatewayError(
        "platform_unavailable",
        502,
        "zcode-start response must be an object (request {requestId}). The upstream came back empty-handed — retry 🌙",
        {},
        "upstream",
      );
    }
    if (isZcodeEnvelopeError(json)) {
      const identifier = upstreamErrorIdentifier(json);
      const classification = classifyUpstreamError(undefined, identifier);
      const upstreamText = upstreamMessageAsIs(json, "");
      throw new GatewayError(
        classification.code,
        classification.status,
        upstreamText.message || "zcode-start reported an upstream error",
        {
          providerId: this.provider_id,
          ...(identifier === undefined ? {} : { providerCode: identifier }),
          ...(upstreamText.hadUpstreamText ? { upstreamMessageAsIs: true } : {}),
          raw: bodyText.slice(0, 4096),
        },
        classification.origin,
      );
    }
    yield* claudeResponseToEvents(json, request, false);
  }
}

export function createZcodeStartPlanAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new ZcodeStartPlanAdapter(fetchImpl);
}
