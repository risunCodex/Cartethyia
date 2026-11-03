// Attempt completion bookkeeping: one home for everything every dispatch attempt ends with.
import { readReportedModel } from "../../providers/operations/reported-model";
import { GatewayError, publicGatewayErrorBody } from "../../protocol/gateway-error";
import type { ValidatedOutboundFetch } from "../../providers/provider-contracts";
import { reportAttemptOutcome } from "../../providers/operations/account-health-service";
import type { UsageRecord } from "../../protocol/canonical-model";
import { classifyUpstreamFailure } from "../failure-policy";
import type { AdmissionLease } from "../../security/admission/contracts";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { resolvePayloadCapture, TelemetryPayloadCapture, truncateUtf8 } from "../../observability/payload-capture";
import { payloadDirectory } from "../../observability/payload-store";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import type { ProxyRequestOutcome, ProxyRequestState } from "../request/state";
import type { PayloadCaptureState } from "../../observability/payload-capture";
import { finalizeRequestTelemetry } from "../guards/error-lifecycle";
import { debitCachedQuota, quotaLens } from "../../providers/quota/cache";
import { BUDDY_PROVIDER_IDS } from "../../providers/provider-metadata";
import { log } from "../../observability/logger";
import {
  disablePoolForProxyHttpStatus,
  recordPoolDispatchOutcome,
} from "../../network/pool-health-machine";
import { ProxyConnectRefusalError } from "../../network/pool/agent";
import { captureDepthMaxBytes, providerCaptureMaxBytes } from "./capture-policy";

/**
 * What the client received for a failed terminal attempt, in the same public
 * envelope the error middleware sends on the wire (`{ error: { origin, code,
 * message, details } }`). Stored so Request Detail's "Client Response"
 * panel can trace an error exactly as the client saw it, including for failures
 * that never produced a response body.
 */
export function errorClientResponseBody(error: unknown): string {
  if (error instanceof GatewayError) {
    // Same serializer the error middleware sends on the wire, so the stored
    // copy cannot drift from what the client received.
    return JSON.stringify(publicGatewayErrorBody(error));
  }
  return JSON.stringify({
    error: { origin: "cartethyia", code: "internal_error", message: "Internal server error" },
  });
}

export function parseCapturedBody(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

const PROVIDER_CAPTURE_AWAIT_MS = 2_000;
const CAPTURABLE_RESPONSE_TYPES = /^(text\/|application\/(json|x-ndjson|sse))/i;

/** Only JSON/SSE/text bodies are parseable; binary native wire is skipped. */
function shouldCaptureProviderResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType === "") return true;
  return CAPTURABLE_RESPONSE_TYPES.test(contentType);
}

/** Bounded read of a response clone's body; never disturbs the caller's stream. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // Collect decoded chunks and join once: `+=` per chunk reallocates the
  // prefix (O(n^2)). The budget is UTF-8 **bytes** — the same basis the record
  // budget and the request-line slice use — measured per decoded chunk, with
  // the final chunk trimmed by truncateUtf8 so a code point is never split.
  const parts: string[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (totalBytes + chunkBytes > maxBytes) {
        parts.push(truncateUtf8(chunk, maxBytes - totalBytes));
        totalBytes = maxBytes;
        break;
      }
      parts.push(chunk);
      totalBytes += chunkBytes;
    }
  } catch {
    // Best-effort capture must never fail the request path.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The clone branch is discarded either way.
    }
  }
  return parts.join("");
}

export interface ProviderExchangeCapture {
  request: unknown;
  response: Promise<unknown>;
  /**
   * The model the upstream named in its own response, read from the raw bytes.
   *
   * Filled by `captureProviderExchange` — the one wrapper every provider's
   * network call passes through — rather than by each adapter. Adapters were
   * synthesizing their opening event with the model *we asked for*, so a
   * provider answering a different one reported as if it had complied; reading
   * the bytes here is the only place that sees what the upstream actually
   * wrote, for every wire, without six adapters to keep in step.
   */
  reportedModel?: Promise<string | undefined>;
}

/**
 * Outbound request headers worth recording for diagnosis.
 *
 * Deliberately an allowlist of non-secret protocol headers: the capture store
 * is read through the console, so a blanket copy would persist bearer tokens
 * and API keys. These are the headers that describe *how* a request was
 * framed (session identity, turn index, model routing), which is what makes a
 * provider bug reproducible after the fact.
 */
const CAPTURED_REQUEST_HEADERS = [
  "x-opencode-client",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-opencode-parent-session-id",
  "x-opencode-request",
  "x-opencode-project",
  "x-session-affinity",
  "x-grok-session-id",
  "x-grok-conv-id",
  "x-grok-turn-idx",
  "x-grok-req-id",
  "x-grok-model-override",
  "x-grok-client-version",
  "x-grok-client-identifier",
  "x-grok-agent-id",
  "x-session-id",
  "x-parent-session-id",
  "traceparent",
  "b3",
  // The buddy channel check reads this family. A capture that kept only
  // `x-session-id` could not show whether a `11-128 conversation id missing`
  // refusal was a missing header or something else.
  "x-conversation-id",
  "x-conversation-request-id",
  "x-conversation-message-id",
  "x-root-request-id",
  "x-request-id",
  "x-trace-id",
  "x-b3-traceid",
  "x-b3-spanid",
  "x-b3-sampled",
  "x-claude-code-session-id",
  "user-agent",
] as const;
/** Copies only the allowlisted, non-empty headers from an outbound request. */
function selectCapturedHeaders(init?: RequestInit): Record<string, string> | undefined {
  if (init?.headers === undefined) return undefined;
  let source: Headers;
  try {
    source = new Headers(init.headers);
  } catch {
    return undefined;
  }
  const selected: Record<string, string> = {};
  for (const name of CAPTURED_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value !== null && value.length > 0) selected[name] = value;
  }
  return Object.keys(selected).length === 0 ? undefined : selected;
}

/**
 * Keeps the Proxy→Provider request line (method, URL, allowlisted headers) and
 * drops the body. Used by the `metadata` capture mode so operators can inspect
 * framing without retaining prompt/response content.
 */
export function providerRequestMetadataOnly(request: unknown): unknown {
  if (typeof request !== "object" || request === null) return null;
  const record = request as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  if (typeof record["method"] === "string") metadata["method"] = record["method"];
  if (typeof record["url"] === "string") metadata["url"] = record["url"];
  if (
    typeof record["headers"] === "object" &&
    record["headers"] !== null &&
    !Array.isArray(record["headers"])
  ) {
    metadata["headers"] = record["headers"];
  }
  return Object.keys(metadata).length === 0 ? null : metadata;
}

/**
 * Captures one provider request body into the stored provider-request panel.
 *
 * Providers send bodies in several shapes: a plain string (the common case), a
 * `Uint8Array`/Buffer (Qoder's custom cosy encoding), or another BodyInit
 * type (URLSearchParams, Blob, FormData) that cannot be sliced safely here.
 * Strings and byte arrays are decoded and stored; anything else is recorded as
 * present-but-opaque, same as the metadata path.
 */
function captureRequestBodyBody(
  body: BodyInit,
  maxBytes: number,
): { body: unknown } | { body_present: true; body_bytes: number } {
  if (typeof body === "string") {
    return { body: parseCapturedBody(truncateUtf8(body, maxBytes)) };
  }
  if (body instanceof Uint8Array) {
    return { body: parseCapturedBody(truncateUtf8(new TextDecoder().decode(body), maxBytes)) };
  }
  return { body_present: true, body_bytes: capturedBodyByteLength(body) };
}

/** Byte length of a request body in whatever shape the provider sent it. */
function capturedBodyByteLength(body: BodyInit): number {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  if (typeof body === "object" && body !== null && "size" in body) {
    const size = (body as { size?: unknown }).size;
    if (typeof size === "number" && Number.isFinite(size)) return Math.round(size);
  }
  if (typeof body === "object" && body !== null && "byteLength" in body) {
    const byteLength = (body as { byteLength?: unknown }).byteLength;
    if (typeof byteLength === "number" && Number.isFinite(byteLength)) return Math.round(byteLength);
  }
  return 0;
}

/**
 * Wraps a validated outbound fetch to tee the provider request/response.
 *
 * `captureBody=false` records the request line but skips the response
 * `clone()` + bounded read: tenants in `none`/`metadata` mode paid a full
 * 256 KiB tee + decode + parse per attempt for bodies the terminal capture
 * discarded. The request line is metadata-cheap and always kept.
 */
export function captureProviderExchange(
  inner: ValidatedOutboundFetch,
  sink: ProviderExchangeCapture,
  captureBody = true,
  maxBytes = providerCaptureMaxBytes(),
): ValidatedOutboundFetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const rawBody = init?.body;
    const headers = selectCapturedHeaders(init);
    sink.request = {
      method: init?.method ?? "GET",
      url,
      ...(headers === undefined ? {} : { headers }),
      // `captureBody=false` is the `none`/`metadata` path: record that a body
      // was sent and how big it was, without slicing or parsing it. The old
      // shape sliced up to `maxBytes` of the translated body and ran it through
      // `JSON.parse` for every attempt — content a metadata-mode tenant had
      // explicitly declined to retain, paid on every dispatch.
      ...(rawBody === null || rawBody === undefined
        ? {}
        : captureBody
          ? captureRequestBodyBody(rawBody, maxBytes)
          : { body_present: true, body_bytes: capturedBodyByteLength(rawBody) }),
    };
    const response = await inner(input, init);
    sink.response =
      captureBody && shouldCaptureProviderResponse(response)
        ? readBoundedBody(response.clone(), maxBytes).then(parseCapturedBody)
        : Promise.resolve(null);
    // Read regardless of `captureBody`: this is metadata about the dispatch, not
    // payload retention, so a tenant in `metadata` mode still records which
    // model answered. It clones internally and reads only the head.
    sink.reportedModel = readReportedModel(response).catch(() => undefined);
    return response;
  };
}

async function resolvedProviderResponse(
  provider: ProviderExchangeCapture | undefined,
): Promise<unknown> {
  if (!provider) return null;
  let timedOut = false;
  const settled = await Promise.race([
    provider.response,
    new Promise<null>((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, PROVIDER_CAPTURE_AWAIT_MS)),
  ]);
  if (settled === null || settled === undefined) {
    // Distinguish "slow payload" from "no payload": a bare null cannot tell the
    // two apart, so the timeout is reported explicitly.
    return timedOut ? { _truncated: true, _reason: "provider_capture_timeout" } : null;
  }
  return settled;
}

/**
 * Captures terminal payloads before telemetry finalization. It never throws into
 * the request path, but awaiting the bounded storage operation ensures the
 * request-detail endpoint cannot race the payload row and report a false miss.
 */
async function captureTerminalPayload(
  state: ProxyRequestState,
  db: CartethyiaDatabase,
  tenantId: string | null,
  requestId: string,
  requestBody: unknown,
  responseBody: unknown,
  clientResponseBody?: string,
  providerCapture?: ProviderExchangeCapture,
): Promise<void> {
  // Every exit below records *why*. The drawer reads empty for all of them
  // alike, so without this an operator debugging remotely — with no access to
  // the server's logs — cannot distinguish "capture is off" from "capture is
  // broken", and the four blank panels look like a bug either way.
  const note = (reason: PayloadCaptureState): void => {
    state.payloadCaptureState = reason;
  };
  if (!tenantId) {
    note("skipped_no_tenant");
    return;
  }
  try {
    // Resolved once per request and memoized on the request state. The
    // per-attempt call in the dispatch paths and this terminal call were
    // resolving the same tenant setting independently, so a request with
    // several attempts paid for it repeatedly and the two call sites could
    // disagree about whether capture is on at all.
    if (state.payloadCapturePreference === undefined) {
      state.payloadCapturePreference = await resolvePayloadCapture(db, tenantId);
    }
    const resolved = state.payloadCapturePreference;
    if (!resolved.ok) {
      note("skipped_preference_read_failed");
      return;
    }
    const { mode, depth, retentionMs } = resolved;
    if (mode === "none") {
      note("skipped_mode_none");
      return;
    }
    if (mode === "metadata") {
      const providerRequest = providerRequestMetadataOnly(providerCapture?.request ?? null);
      if (providerRequest === null) {
        note("captured_metadata");
        return;
      }
      const metadataCapture = await new TelemetryPayloadCapture(db).capture({
        tenantId,
        requestId,
        requestBody: null,
        responseBody: null,
        providerRequestBody: providerRequest,
        retentionMs,
        scope: "tenant",
        tenantOptIn: true,
      });
      note(metadataCapture.payloadCaptureState ?? "captured_metadata");
      return;
    }
    const maxBytes = captureDepthMaxBytes(depth);
    const providerRequest = providerCapture?.request ?? null;
    const providerResponse = await resolvedProviderResponse(providerCapture);
    const terminalCapture = await new TelemetryPayloadCapture(db).capture({
      tenantId,
      requestId,
      requestBody: requestBody ?? null,
      responseBody: responseBody ?? null,
      ...(clientResponseBody === undefined ? {} : { clientResponseBody: clientResponseBody ?? null }),
      ...(providerRequest === null ? {} : { providerRequestBody: providerRequest }),
      ...(providerResponse === null ? {} : { providerResponseBody: providerResponse }),
      maxBytes,
      retentionMs,
      scope: "tenant",
      tenantOptIn: true,
    });
    note(terminalCapture.payloadCaptureState ?? "captured");
  } catch (error) {
    note("failed_write");
    reportCaptureFailure(error);
  }
}

let captureFailureReported = false;

/**
 * One warning per process for a failing payload capture. The cause is a
 * deployment condition that does not change per request, so repeating it for
 * every request would bury the rest of the log without adding information.
 */
function reportCaptureFailure(error: unknown): void {
  if (captureFailureReported) return;
  captureFailureReported = true;
  const directory = payloadDirectory();
  const reason = error instanceof Error ? error.message : String(error);
  log.warn(
    `[telemetry] payload capture is enabled for this tenant but the body was not stored ` +
      `(${reason}). Check that "${directory}" exists and is writable by the runtime user; ` +
      `a bind-mounted data directory is often owned by root while the container runs unprivileged.`,
  );
}

/**
 * Maps a missing or non-successful upstream terminal event to the GatewayError
 * the client should see.
 *
 * Shared by the streaming and non-streaming dispatch paths so both report the
 * same code, status and message for the same upstream condition. The stream
 * path passes `truncated` because it can distinguish "ended early" from "never
 * terminated"; the non-stream path cannot.
 */
export function terminalFailure(
  terminal: { readonly state: string; readonly stop_reason?: string; readonly provider_stop_reason?: string; readonly stop_details?: Record<string, unknown> } | undefined,
  options: { readonly truncated?: boolean } = {},
): GatewayError | undefined {
  if (terminal === undefined) {
    // The upstream produced no terminal event: its own stream is what ended
    // without a verdict, so this is an upstream failure, not ours.
    return new GatewayError(
      "transport_unavailable",
      502,
      "The upstream closed the response without reporting a result (request {requestId}). Retry; if it keeps happening, the account or pool is unstable. The connection ghosted us — come back in a moment 👻",
      {},
      "upstream",
    );
  }
  if (terminal.state === "failed") {
    // A terminal `failed` state is only ever written by the upstream decoders
    // (a provider error envelope or a corrupt provider stream), so it carries
    // the upstream's failure, not the gateway's.
    const details: Record<string, unknown> = {};
    if (terminal.provider_stop_reason) details["provider_code"] = terminal.provider_stop_reason;
    if (terminal.stop_details) Object.assign(details, terminal.stop_details);
    const message = typeof details["message"] === "string" ? details["message"] : "upstream request failed (request {requestId}). The upstream came back empty-handed — retry 🌙";
   // Preserve the upstream's error code when the provider embedded it in
   // `stop_details` (Cursor writes `quota_exceeded` and `authentication_failed`
   // there). Wrapping every terminal failure as `transport_unavailable` discarded
   // those codes, so `quota_exceeded` was never seen by the classifier and the
   // exhausted account was never cooled.
   const code = typeof details["code"] === "string" ? details["code"] : undefined;
   const status = typeof details["status"] === "number" ? details["status"] : 502;
   const gatewayCode =
     code === "quota_exceeded" ? "quota_exceeded" :
     code === "authentication_failed" ? "authentication_failed" :
     "transport_unavailable";
   const gatewayStatus =
     gatewayCode === "quota_exceeded" ? 429 :
     gatewayCode === "authentication_failed" ? 401 :
     status;
   return new GatewayError(gatewayCode, gatewayStatus, message, details, "upstream");
  }
  if (terminal.state === "aborted") {
    // A client-initiated cancellation is not an upstream fault; the stream path
    // reports it as truncation instead.
    return options.truncated === true
      ? undefined
      : new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
  }
  return undefined;
}

/**
 * A usage record carrying only the request's own token estimate, with no price
 * yet: `estimated_cost` is `null` (unpriced) so the analytics `partial` flag
 * counts it, rather than `0`, which would claim the turn cost nothing. The
 * dispatch call sites reprice it against the routed model before committing.
 */
export function estimatedUsage(inputTokens: number, outputTokens: number): UsageRecord {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: "unavailable",
    cache_write_tokens: "unavailable",
    uncached_input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: "unavailable",
    estimated_cost: null,
  };
}

/**
 * Single attempt completion: one home for everything every dispatch attempt
 * ends with — outcome recording, usage commit, health report, payload
 * capture, telemetry finalization. Streaming and non-streaming paths build
 * the same completion (outcome literal first, so `state.outcome` keeps its
 * exact per-path shape) and differ only in `terminal`: intermediate
 * failover attempts commit usage + report health but defer capture and
 * telemetry to the terminal attempt, so one request emits exactly one
 * telemetry row however many candidates it tried.
 *
 * Pool cooldown flagging, metrics, client encoding, and failover/refresh
 * decisions stay at the call sites — they are retry/transport policy, not
 * completion bookkeeping.
 */
export interface AttemptCompletion extends ProxyRequestOutcome {
  readonly modelId?: string;
  readonly error?: unknown;
  /**
   * The HTTP status the terminal classifier derived for a raw (non-GatewayError)
   * failure — an upstream socket drop is 502, not the 500 the fallback implied.
   * Only consulted when the error carries no status of its own and no wire
   * response named one.
   */
  readonly terminalHttpStatus?: number;
  readonly lease?: AdmissionLease;
  /** Usage to reconcile, or undefined when this attempt consumed nothing billable. */
  readonly commitUsage?: UsageRecord;
  /** Capture + telemetry run only for the terminal attempt of a request. */
  readonly terminal: boolean;
  readonly tenantId: string | null;
  readonly ingressBody: unknown;
  readonly responseBody: unknown;
  readonly clientResponseText?: string;
  readonly providerCapture?: ProviderExchangeCapture;
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly snapshotService?: { invalidate(): unknown };
  /** First content delta timestamp (for TTFT calculation). */
  readonly firstContentDeltaAtMs?: number;
  /** Last event timestamp (for generation duration calculation). */
  readonly lastEventAtMs?: number;
  /** The model the upstream reported in its own response, verbatim. */
  readonly reportedModel?: string;
}

/**
 * The fields every dispatch completion shares, regardless of outcome.
 *
 * The streaming path and the non-streaming path each assembled this set by
 * hand, so a field added to one (a new telemetry buffer, a snapshot service)
 * could silently miss the other. Callers spread this and add only what differs:
 * status, usage, error classification, and the response body.
 */
export function completionContext(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly tenantId: string | null;
  readonly ingressBody: unknown;
  readonly providerCapture?: ProviderExchangeCapture;
  readonly db: CartethyiaDatabase;
  readonly accountId?: string | undefined;
  readonly accountLabel?: string | undefined;
  readonly networkPoolId?: string | undefined;
  readonly lease?: AdmissionLease | undefined;
  readonly telemetryBuffer?: TelemetryBatchBuffer | undefined;
  readonly snapshotService?: { invalidate(): unknown } | undefined;
}): Pick<
  AttemptCompletion,
  | "providerId"
  | "modelId"
  | "tenantId"
  | "ingressBody"
  | "db"
  | "terminal"
  | "accountId"
  | "accountLabel"
  | "networkPoolId"
  | "lease"
  | "providerCapture"
  | "telemetryBuffer"
  | "snapshotService"
> {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    tenantId: input.tenantId,
    ingressBody: input.ingressBody,
    ...(input.providerCapture === undefined ? {} : { providerCapture: input.providerCapture }),
    db: input.db,
    terminal: true,
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
    ...(input.networkPoolId === undefined ? {} : { networkPoolId: input.networkPoolId }),
    ...(input.lease === undefined ? {} : { lease: input.lease }),
    ...(input.telemetryBuffer === undefined ? {} : { telemetryBuffer: input.telemetryBuffer }),
    ...(input.snapshotService === undefined ? {} : { snapshotService: input.snapshotService }),
  };
}

/**
 * The terminal-completion base the native routes (generation, responses
 * compact, system one, web search, token count) all assemble. The proxy and
 * streaming paths use `completionContext`; these routes previously spelled
 * the same twelve fields by hand in six places. Callers spread this and add
 * only what differs: status, response body, error classification.
 */
export function nativeCompletionBase(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly tenantId: string | null;
  readonly ingressBody: unknown;
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly networkPoolId?: string;
  readonly lease?: AdmissionLease;
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly snapshotService?: { invalidate(): unknown };
  readonly providerCapture?: ProviderExchangeCapture;
  readonly usage?: AttemptCompletion["usage"];
  readonly commitUsage?: AttemptCompletion["commitUsage"];
}): Omit<
  AttemptCompletion,
  | "status"
  | "responseBody"
  | "httpStatus"
  | "terminalHttpStatus"
  | "error"
  | "clientResponseText"
  | "firstContentDeltaAtMs"
  | "lastEventAtMs"
  | "reportedModel"
  | "errorCategory"
  | "errorOrigin"
  | "ttfbMs"
  | "tokensPerSec"
> {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    tenantId: input.tenantId,
    ingressBody: input.ingressBody,
    terminal: true,
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
    ...(input.networkPoolId === undefined ? {} : { networkPoolId: input.networkPoolId }),
    ...(input.lease === undefined ? {} : { lease: input.lease }),
    db: input.db,
    ...(input.telemetryBuffer === undefined ? {} : { telemetryBuffer: input.telemetryBuffer }),
    ...(input.snapshotService === undefined ? {} : { snapshotService: input.snapshotService }),
    ...(input.providerCapture === undefined ? {} : { providerCapture: input.providerCapture }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.commitUsage === undefined ? {} : { commitUsage: input.commitUsage }),
  };
}

/**
 * Decides whether a failed attempt proves *the pool* is unusable, and which
 * HTTP status that verdict rests on.
 *
 * Both a proxy and an upstream can answer 402, and the two mean opposite
 * things: a proxy's 402 says this pool cannot carry traffic (disable it), while
 * an upstream's 402 is that provider's billing verdict on the account that was
 // dialed (cool the account down, leave the pool alone). The status alone
 * cannot separate them, so the decision rides on who answered.
 *
 * A proxy that refuses the CONNECT handshake answers *before* any upstream is
 * dialed, so its status is unambiguously the proxy's own. That refusal is not a
 * `GatewayError` — it is a typed `ProxyConnectRefusalError` — so reading the
 * status off `error.status` alone saw `undefined` here, the 402/407 check never
 * fired, and a pool that had refused to tunnel stayed enabled and kept being
 * selected.
 */
export function resolveProxyDisableDecision(completion: AttemptCompletion): {
  readonly disableProxy: boolean;
  readonly responseHttpStatus: number | undefined;
} {
  const proxyConnectStatus =
    completion.error instanceof ProxyConnectRefusalError
      ? completion.error.statusCode
      : undefined;
  const responseHttpStatus =
    completion.error instanceof GatewayError
      ? completion.error.status
      : (proxyConnectStatus ?? completion.httpStatus);
  // Only a proxy-origin payment/auth response proves the pool itself is unusable;
  // an upstream provider's 402 is a quota/billing response for that provider.
  const errorOrigin =
    completion.error instanceof GatewayError
      ? completion.error.origin
      : proxyConnectStatus !== undefined
        ? "network"
        : completion.errorOrigin;
  const disableProxy =
    completion.networkPoolId !== undefined &&
    completion.status !== "completed" &&
    errorOrigin === "network" &&
    (responseHttpStatus === 402 || responseHttpStatus === 407);
  return { disableProxy, responseHttpStatus };
}

/**
 * Reduces the account's cached pooled balance by the credits this request
 * reported, so the next plan sees the spend instead of the balance the sweep
 * last fetched.
 *
 * Scoped to the buddy family: `credit_used` there is buddy-meter credit, the
 * same unit the cached windows store. Other providers report the field in
 * their own unit, and debiting them would subtract the wrong thing. A missing
 * cache entry, a failed last fetch, or a cache write that throws is left
 * alone — the request already succeeded, and the floor keeps its previous
 * reading until the sweep.
 */
async function debitBuddySpend(completion: AttemptCompletion): Promise<void> {
  if (completion.status !== "completed") return;
  const accountId = completion.accountId;
  const providerId = completion.providerId;
  const credits = completion.usage?.credit_used;
  if (accountId === undefined || providerId === undefined) return;
  if (!BUDDY_PROVIDER_IDS.has(providerId.toLowerCase())) return;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits <= 0) return;
  try {
    await debitCachedQuota(quotaLens(completion.tenantId), accountId, credits, undefined);
  } catch {
    // Swallowed: the balance update is advisory. The sweep corrects it.
  }
}

export async function completeAttempt(
  state: ProxyRequestState,
  completion: AttemptCompletion,
): Promise<void> {
  // Idempotency guard: the terminal completion claims the request before any
  // await, so a caller that retries completion after a bookkeeping failure
  // (e.g. the streaming error path re-entering after `commitUsage` threw)
  // cannot double-commit usage, report health twice, or emit a second
  // telemetry row. Intermediate failover attempts deliberately leave
  // `completed` clear: they commit their own usage estimate and report
  // health, then the terminal attempt records the real outcome and emits the
  // one telemetry row the request is owed.
  if (state.completed) return;
  // Read before the outcome is frozen. The capture wrapper already started the
  // read when the response arrived; awaiting it here costs nothing on the
  // non-streaming path and only a bounded head-read on the streaming one.
  // Absent means the upstream named no model — never backfilled from the
  // request, which would report the ask as the answer.
  const reportedModel =
    completion.reportedModel ??
    (completion.providerCapture?.reportedModel === undefined
      ? undefined
      : await completion.providerCapture.reportedModel.catch(() => undefined));
  state.outcome = {
    status: completion.status,
    httpStatus:
      completion.httpStatus ??
      (completion.error instanceof GatewayError
        ? completion.error.status
        : completion.terminalHttpStatus ??
          (completion.status === "completed"
            ? 200
            : completion.status === "cancelled"
              ? 499
              : completion.status === "truncated"
                ? 502
                : 500)),
    ...(completion.providerId === undefined ? {} : { providerId: completion.providerId }),
    ...(completion.accountId === undefined ? {} : { accountId: completion.accountId }),
    ...(completion.accountLabel === undefined ? {} : { accountLabel: completion.accountLabel }),
    ...(completion.networkPoolId === undefined ? {} : { networkPoolId: completion.networkPoolId }),
    ...(completion.errorCategory === undefined ? {} : { errorCategory: completion.errorCategory }),
    ...(completion.errorOrigin === undefined ? {} : { errorOrigin: completion.errorOrigin }),
    ...(completion.usage === undefined ? {} : { usage: completion.usage }),
    ...(completion.ttfbMs === undefined ? {} : { ttfbMs: completion.ttfbMs }),
    ...(completion.tokensPerSec === undefined ? {} : { tokensPerSec: completion.tokensPerSec }),
    ...(reportedModel === undefined ? {} : { reportedModel }),
    ...(completion.firstContentDeltaAtMs === undefined ? {} : { firstContentDeltaAtMs: completion.firstContentDeltaAtMs }),
    ...(completion.lastEventAtMs === undefined ? {} : { lastEventAtMs: completion.lastEventAtMs }),
    ...(completion.reportedModel === undefined ? {} : { reportedModel: completion.reportedModel }),
  };
  if (completion.terminal) state.completed = true;
  // Usage reconciliation is bookkeeping, and it is the last thing standing
  // between the caller and its resource release. Letting a store failure
  // propagate from here aborts the completion sequence *after* `completed` is
  // claimed, so the caller's release never runs and the in-flight gauge climbs
  // for the life of the process; the reservation is released unreconciled
  // either way, so the slot is not what is at stake. Swallowed for the same
  // reason the health and pool reports below are: a failed report must not
  // decide the request's outcome.
  if (completion.lease?.commitUsage && completion.commitUsage) {
    try {
      await completion.lease.commitUsage(completion.commitUsage);
    } catch {
      // Swallowed: usage reconciliation is non-critical bookkeeping.
    }
  }
  await debitBuddySpend(completion);
  const { disableProxy, responseHttpStatus } = resolveProxyDisableDecision(completion);
  // Cancelled attempts write no health (client gone; outcome unknown) —
  // matches the historical `!cancelled` guards at every site. Health is
  // advisory: a failed report must never re-enter the retry path (a retry
  // would see `completed` and skip completion entirely), so it is swallowed.
  if (completion.status !== "cancelled" && !disableProxy) {
    // Account health records only failures that are evidence about the
    // provider's own account: upstream verdicts (quota, auth, model
    // capacity, rate limits), or credential-scoped refusals from the
    // upstream. Local rejections — API-key admission (`max_concurrent`,
    // rpm/token budgets), routing capacity, pool selection, request
    // preparation — are decisions this gateway made about its own limits;
    // they say nothing about the account and must not cool it or write a
    // phantom `logged -> cooldown` transition. Success always reports so a
    // cooling account recovers.
    const succeeded = completion.status === "completed";
    const gatewayError = completion.error instanceof GatewayError ? completion.error : undefined;
    const upstreamVerdict = gatewayError?.origin === "upstream";
    const isProxyDeploymentError =
      completion.error instanceof Error ? completion.error.message.toLowerCase().includes("deployment_disabled") || (completion.error.message.toLowerCase().includes("sin1::") && completion.error.message.toLowerCase().includes("deployment")) : false;
    if (succeeded || isProxyDeploymentError || upstreamVerdict) {
      const evidence = isProxyDeploymentError
        ? { scope: "pool" as const, origin: "network" as const }
        : { ...classifyUpstreamFailure(completion.error) };
      try {
        await reportAttemptOutcome(completion.db, {
          accountId: completion.accountId,
          ...(completion.modelId === undefined ? {} : { modelId: completion.modelId }),
          ...(completion.status === "failed"
            ? {
                error: completion.error,
                evidence,
              }
            : {}),
          ...(completion.snapshotService ? { snapshotService: completion.snapshotService } : {}),
        });
      } catch {
        // Swallowed: health reporting is non-critical bookkeeping.
      }
    }
  }
  if (completion.networkPoolId && completion.status !== "cancelled") {
    try {
      if (disableProxy && (responseHttpStatus === 402 || responseHttpStatus === 407)) {
        await disablePoolForProxyHttpStatus(
          completion.db,
          completion.networkPoolId,
          responseHttpStatus,
          completion.snapshotService,
        );
      } else {
        const errorOrigin =
          completion.errorOrigin ??
          (completion.error instanceof ProxyConnectRefusalError ? "network" : undefined);
        await recordPoolDispatchOutcome(completion.db, completion.networkPoolId, {
          succeeded: completion.status === "completed",
          ...(completion.providerId === undefined ? {} : { providerId: completion.providerId }),
          ...(completion.error === undefined ? {} : { error: completion.error }),
          // A CONNECT refusal is the proxy's own answer, given before any
          // upstream was dialed, so it is a network fault even though the
          // error carries no origin of its own. Without one the pool stays in
          // rotation and the next probe dials the same front door.
          ...(errorOrigin === undefined ? {} : { errorOrigin }),
          ...(completion.snapshotService === undefined
            ? {}
            : { snapshotInvalidator: completion.snapshotService }),
        });
      }
    } catch {
      // Pool health is advisory; never fail or retry a completed request for it.
    }
  }
  if (!completion.terminal) {
    // An intermediate failover attempt: the terminal attempt is the one that
    // captures. Named rather than left blank so a request that never reached a
    // terminal attempt is distinguishable from one that did and captured
    // nothing.
    if (state.payloadCaptureState === undefined) {
      state.payloadCaptureState = "skipped_not_terminal";
    }
    return;
  }
  await captureTerminalPayload(
    state,
    completion.db,
    completion.tenantId,
    state.requestId,
    completion.ingressBody,
    completion.responseBody,
    completion.clientResponseText,
    completion.providerCapture,
  );
  if (completion.telemetryBuffer) finalizeRequestTelemetry(state, completion.telemetryBuffer);
}
