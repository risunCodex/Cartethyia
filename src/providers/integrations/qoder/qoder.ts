// Factory-blocked (Phase C4): PAT-to-jobToken session handshake, COSY
// AES/RSA request signing, alphabet-scrambled binary body, enveloped SSE
// frames — session/crypto protocol outside factory reach; stays bespoke.
import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import {
  classifyUpstreamError,
  extractUpstreamMessage,
  isUpstreamQueued,
  mapUpstreamHttpError,
  queueRetryAfterMs,
  upstreamErrorIdentifier,
} from "../../../transport/failure-policy";
import { GatewayError } from "../../../protocol/gateway-error";
import { resolveImageSource } from "../../../protocol/codecs";
import { reasoningEffortFromIntent } from "../../../protocol/reasoning";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalStopReason,
  ContentPart,
  ToolChoice,
  ToolDefinition,
} from "../../../protocol/canonical-model";
import { toolResultParts, toolCallParts } from "../../../protocol/canonical-model";
import { decodeQoderSseEvents } from "./qoder-sse";
import { usageFromProvider, readReasoningText } from "../../provider-usage";
import { readCredentialSecret, assertWireFamily, type ProviderDispatchTarget, type ProviderAdapter, type ProviderDispatchContext, type ProviderId } from "../../provider-contracts";
import type { ModelDefinition } from "../../provider-model-definition";
import { parseQoderOAuthState } from "./qoder-oauth";
import { getQoderVersion } from "../../operations/client-versions";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../operations/upstream-deadline";
import { qoderMachineOs, qoderMachineHostname } from "../../operations/cli-platform";
import { qoderIdeChatUrl, qoderInferenceCandidates, QODER_CHAT_PATH, QODER_REALMS, type QoderRealm } from "./qoder-realm";
import {
  QODER_CN_MODEL_CONFIGS,
  QODER_INTL_MODEL_CONFIGS,
  QODER_INTL_MODELS,
  qoderDiscoveredMaxContexts,
} from "./qoder-catalog";
import { isQoderVirtualModel, qoderDispatchModelId } from "./qoder-virtual";
import {
  LEAK_MARKER_ANY_RE,
  LEAK_MARKER_LITERALS,
  parseQoderTextToolCalls,
  isQoderEchoAttempt,
} from "./qoder-text-tools";

/** How long a trailing partial marker may be before it is held for the next frame. */
const LEAK_HOLD_WINDOW = 24;
/** Fail-open caps so an endless lookalike cannot hold text forever. */
const LEAK_HOLD_MAX_CHARS = 32_768;
const LEAK_HOLD_MAX_FRAMES = 200;

const BAD_ECHO_MESSAGE =
  "Qoder returned an unparseable tool-call echo (request {requestId}); no tools were emitted. The upstream came back empty-handed — retry 🌙";

function badEchoError(): GatewayError {
  return new GatewayError(
    "platform_unavailable",
    502,
    BAD_ECHO_MESSAGE,
    { providerId: QODER_PROVIDER_ID },
    "upstream",
  );
}

/** True when `suffix` is a strict prefix of some marker literal. */
function isLeakMarkerPrefix(suffix: string): boolean {
  if (suffix.length === 0 || suffix.length >= LEAK_HOLD_WINDOW) return false;
  return LEAK_MARKER_LITERALS.some((literal) => literal.startsWith(suffix));
}

/**
 * True when `text` is still plausibly the INTL marker echo block (marker +
 * JSON array/object, or a tool-style tag). Used to keep holding across frames;
 * false means it is ordinary prose and can be released.
 */
function qoderStillLeakCandidate(text: string): boolean {
  if (text.length === 0) return true;
  const marker = LEAK_MARKER_ANY_RE.exec(text);
  if (!marker) {
    return isLeakMarkerPrefix(text) || LEAK_MARKER_ANY_RE.test(text);
  }
  const rest = text.slice(marker.index + marker[0].length).trim();
  if (rest.length === 0) return true;
  if (rest.startsWith("[") || rest.startsWith("{")) return true;
  if (/^<[a-zA-Z0-9_.:-]+\b/.test(rest)) return true;
  // Angle-wrapped JSON: `<{` / `<[` — candidate until a closing `>` appears.
  if (rest.startsWith("<{") || rest.startsWith("<[")) {
    return !rest.includes(">") || rest.endsWith(">");
  }
  return false;
}

interface QoderModeProfile {
  readonly chatUrl: string;
  readonly businessProduct: string;
  readonly businessType: string;
  readonly businessVersion: string;
  readonly cosyScene: string;
  readonly mirrorTopLevelSystem: boolean;
  readonly sendBusinessHeaders: boolean;
  readonly sendModelSourceHeaders: boolean;
  readonly emptyAliyunUserType: boolean;
}

export const MODERN_PROFILE: QoderModeProfile = {
  chatUrl: "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
  businessProduct: "cli",
  businessType: "agent",
  businessVersion: "1.0.22",
  cosyScene: "assistant",
  mirrorTopLevelSystem: true,
  sendBusinessHeaders: true,
  sendModelSourceHeaders: true,
  emptyAliyunUserType: true,
};

const QODER_PROVIDER_ID = "qoder" as const;

const QODER_APPCODE = "cosy";
const QODER_SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
/**
 * Where a PAT is exchanged for a short-lived job token, per realm.
 *
 * The job token is realm-bound: one minted on the global host answers "Login
 * expired" on the China gateway. Exchanging against the wrong host therefore
 * looks like a dead credential rather than a routing bug, which is why the
 * URL is derived from the realm table instead of being one constant.
 *
 * `intl` keeps its historical `center.qoder.sh` v3 endpoint. `cn` uses the
 * openapi host the donor's `PATH_JOB_EXCHANGE` describes; if that path is
 * ever wrong for CN, the failure surfaces as a 401/403 on exchange, not as a
 * silently misrouted request.
 */
const QODER_JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";
function qoderJobTokenUrl(realm: QoderRealm): string {
  return realm === "cn"
    ? `${QODER_REALMS.cn.openapi}/api/v1/jobToken/exchange`
    : QODER_JOB_TOKEN_URL;
}
const QODER_STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export interface QoderAuth {
  userId: string;
  userName: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
  machineId: string;
}
interface QoderModelConfig {
  id: string;
  display_name: string;
  max_input_tokens: number;
  max_output_tokens?: number;
  is_vl: boolean;
  is_reasoning: boolean;
  /**
   * Whether upstream publishes this row as free. Only an explicit `true`
   * marks the model as free-tier; absent or `false` means billed/unknown, so
   * a 402/116 there is genuine quota exhaustion, not a free-tier entitlement
   * refusal, and must not trigger a legacy-surface fallback.
   */
  is_free?: boolean;
  source?: string;
  /**
   * Reasoning effort to send when the caller did not ask for one. Some models
   * on the IDE surface stream no reasoning unless an effort is present.
   */
  default_reasoning_effort?: string;
}

function qoderMd5(value: string | Uint8Array): string {
  return createHash("md5").update(value).digest("hex");
}

/**
 * Canonical compact JSON used by Qoder's COSY signing: keys sorted
 * lexicographically, no whitespace, null/undefined rendered as empty string.
 * The upstream verifies the signature against this exact serialization, so a
 * payload built with plain `JSON.stringify` (insertion order) fails with
 * `code 101 / Signature invalid`.
 */
function qoderJsonSortedCompact(mapping: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(mapping).sort()) {
    const value = mapping[key] === null || mapping[key] === undefined ? "" : mapping[key];
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}
function qoderPathSignature(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith("/algo") ? path.slice(5) : path;
}

const QODER_MACHINE_ID_TTL_MS = 60 * 60 * 1000;
const QODER_MAX_MACHINE_IDS = 1_024;
const qoderMachineIds = new Map<string, { id: string; expiresAt: number }>();
/**
 * A PAT (`pt-...`) must be exchanged for a short-lived job token before it
 * can sign COSY requests. Device tokens (`dt-...`) from OAuth login and job
 * tokens (`jt-...`) are used directly.
 */
export function isQoderPat(secret: string): boolean {
  return secret.startsWith("pt-");
}

/**
 * Stable per-account machine id for OAuth dispatches. Derived from the
 * account id (not minted per request) so pooled accounts keep one device
 * fingerprint across restarts instead of looking like a new device every
 * time, while staying distinct per account.
 */
export function qoderMachineIdForAccount(accountId: string): string {
  const hex = createHash("sha256").update(`qoder-machine-v1:${accountId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Builds dispatch auth from an OAuth device token. The token is used
 * directly as the COSY identity's oauth token; the user id and machine id
 * come from the `auth_state` the login persisted. Fails closed with a
 * reconnect prompt when the identity is absent (e.g. an account created
 * before `auth_state` existed, or an import that dropped the field) instead
 * of signing with a guessed id. The message names the missing field so an
 * operator can fix the export instead of re-logging blind.
 */
export function qoderOAuthAuth(
  secret: string,
  authState: unknown,
  accountId: string | undefined,
): QoderAuth {
  const state = parseQoderOAuthState(authState);
  if (state === undefined) {
    throw new GatewayError(
      "authentication_failed",
      401,
      "Qoder OAuth account is missing its user identity (request {requestId}) (auth_state.userId/machineId absent or empty — re-login, or re-export with authState included); sign in again. Wrong key, right door — check the credential 🔑",
    );
  }
  return {
    userId: state.userId,
    userName: "",
    userType: "personal_standard",
    securityOauthToken: secret,
    refreshToken: "",
    machineId: state.machineId || (accountId ? qoderMachineIdForAccount(accountId) : randomUUID()),
  };
}

function qoderMachineIdFromPat(pat: string): string {
  const key = createHash("sha256").update(pat).digest("hex");
  const now = Date.now();
  const existing = qoderMachineIds.get(key);
  if (existing && existing.expiresAt > now) return existing.id;
  const id = randomUUID();
  qoderMachineIds.delete(key);
  qoderMachineIds.set(key, { id, expiresAt: now + QODER_MACHINE_ID_TTL_MS });
  for (const [candidate, value] of qoderMachineIds) {
    if (value.expiresAt <= now) qoderMachineIds.delete(candidate);
  }
  while (qoderMachineIds.size > QODER_MAX_MACHINE_IDS) {
    const oldest = qoderMachineIds.keys().next();
    if (oldest.done) break;
    qoderMachineIds.delete(oldest.value);
  }
  return id;
}

function qoderStaticHeaders(machineId: string, version = getQoderVersion()): Record<string, string> {
  const date = new Date().toUTCString();
  return {
    "cosy-machinetoken": machineId,
    "cosy-machinetype": "5",
    "cosy-machineid": machineId,
    "cosy-clienttype": "5",
    "cosy-version": version,
    "login-version": "v2",
    appcode: QODER_APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    date,
    signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${date}`),
    "content-type": "application/json",
    "user-agent": "Go-http-client/2.0",
  };
}

function transformQoderBody(plaintext: string): Uint8Array {
  const base64 = Buffer.from(plaintext).toString("base64");
  const third = Math.floor(base64.length / 3);
  const reordered = base64.slice(base64.length - third) + base64.slice(third, base64.length - third) + base64.slice(0, third);
  let encoded = "";
  for (const char of reordered) {
    if (char === "=") encoded += "$";
    else encoded += QODER_ALPHABET[QODER_STANDARD_ALPHABET.indexOf(char)] ?? char;
  }
  return Buffer.from(encoded, "latin1");
}

function qoderBuildCosyHeaders(
  body: Uint8Array,
  url: string,
  auth: QoderAuth,
  version = getQoderVersion(),
): Record<string, string> {
  const key = randomUUID().replaceAll("-", "").slice(0, 16);
  const identity = qoderJsonSortedCompact({
    name: auth.userName,
    aid: auth.userId,
    uid: auth.userId,
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: auth.userType,
    security_oauth_token: auth.securityOauthToken,
    refresh_token: auth.refreshToken,
  });
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(key));
  const info = Buffer.concat([cipher.update(identity), cipher.final()]).toString("base64");
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(key)).toString("base64");
  const payload = Buffer.from(
    qoderJsonSortedCompact({ version: "v1", requestId: randomUUID(), info, cosyVersion: version, ideVersion: "" }),
  ).toString("base64");
  const date = String(Math.floor(Date.now() / 1000));
  const signature = qoderMd5(`${payload}\n${cosyKey}\n${date}\n${Buffer.from(body).toString("latin1")}\n${qoderPathSignature(url)}`);
  return {
    authorization: `Bearer COSY.${payload}.${signature}`,
    "cosy-data-policy": "agree",
    "cosy-machinetype": "5",
    "cosy-machineos": qoderMachineOs(),
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": auth.userId,
    "cosy-key": cosyKey,
    "cosy-bodyhash": qoderMd5(body),
    "cosy-bodylength": String(body.byteLength),
    "cosy-sigpath": qoderPathSignature(url),
    "cosy-organization-id": "",
    "cosy-organization-tags": "",
    "x-request-id": randomUUID(),
    ...(MODERN_PROFILE.sendBusinessHeaders
      ? {
          "cosy-business-product": MODERN_PROFILE.businessProduct,
          "cosy-business-type": MODERN_PROFILE.businessType,
          "cosy-business-version": version,
          "cosy-scene": MODERN_PROFILE.cosyScene,
        }
      : {}),
    "cosy-version": version,
    "login-version": "v2",
    appcode: QODER_APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    date: new Date().toUTCString(),
    signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${new Date().toUTCString()}`),
    "content-type": "application/json",
    "user-agent": "Go-http-client/2.0",
  };
}

type QoderFetcher = (url: string, init: RequestInit) => Promise<Response>;

async function exchangeQoderPat(
  pat: string,
  signal: AbortSignal,
  fetcher: QoderFetcher,
  version = getQoderVersion(),
  realm: QoderRealm = "intl",
): Promise<QoderAuth> {
  const machineId = qoderMachineIdFromPat(pat);
  const encodedBody = transformQoderBody(JSON.stringify({ payload: JSON.stringify({ personalToken: pat, securityOauthToken: "", refreshToken: "", needRefresh: false, authInfo: {} }), encodeVersion: "1" }));
  const response = await fetcher(qoderJobTokenUrl(realm), { method: "POST", headers: qoderStaticHeaders(machineId, version), body: encodedBody as unknown as BodyInit, signal });
  if (!response.ok) throw await mapUpstreamHttpError(response, "qoder");
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned invalid JSON (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
  }
  if (typeof responseBody !== "object" || responseBody === null || Array.isArray(responseBody)) {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned unexpected response (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
  }
  const rec = responseBody as Record<string, unknown>;
  if (typeof rec["id"] !== "string" || typeof rec["securityOauthToken"] !== "string") {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned incomplete credentials (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
  }
  return {
    userId: rec["id"] as string,
    userName: typeof rec["name"] === "string" ? (rec["name"] as string) : "",
    userType: typeof rec["userType"] === "string" ? (rec["userType"] as string) : "personal_standard",
    securityOauthToken: rec["securityOauthToken"] as string,
    refreshToken: typeof rec["refreshToken"] === "string" ? (rec["refreshToken"] as string) : "",
    machineId,
  };
}

async function callQoder(
  url: string,
  body: Record<string, unknown>,
  modelId: string,
  auth: QoderAuth,
  signal: AbortSignal,
  fetcher: QoderFetcher,
  version = getQoderVersion(),
): Promise<Response> {
  const encoded = transformQoderBody(JSON.stringify(body));
  const modelConfig = (body["model_config"] as Record<string, unknown> | null) ?? null;
  return fetcher(url, {
    method: "POST",
    headers: {
      ...qoderBuildCosyHeaders(encoded, url, auth, version),
      ...(MODERN_PROFILE.sendModelSourceHeaders
        ? { "x-model-key": modelId, "x-model-source": typeof modelConfig?.["source"] === "string" ? (modelConfig["source"] as string) : "system" }
        : {}),
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
    },
    body: encoded as unknown as BodyInit,
    signal,
  });
}

/**
 * The human-readable text out of a Qoder error envelope.
 *
 * The envelope is Qoder's own wrapper around the stream, and it does not use
 * one field for the message: the text has been seen as a nested `error`
 * object, a bare string `body`, and a top-level `message`/`msg`. The canonical
 * extractor covers the structured shapes; a string body and the top-level
 * fields cover the rest. Whatever survives is bounded the same way an upstream
 * message is, so a verbose envelope cannot blow up the public error line.
 */
function qoderEnvelopeMessage(rec: Record<string, unknown>): string {
  const structured = extractUpstreamMessage(rec["body"]);
  if (structured.length > 0) return structured;
  if (typeof rec["body"] === "string" && rec["body"].trim().length > 0 && rec["body"] !== "[DONE]")
    return rec["body"].replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  return extractUpstreamMessage(rec);
}

export function qoderEnvelopeToFrames(data: string): Array<{ event: string | null; data: string }> {
  if (data === "[DONE]") return [{ event: null, data: "[DONE]" }];
  let envelope: unknown;
  // The IDE surface sometimes embeds literal newlines inside JSON string
  // values (e.g. the raw_usage event carries keys like
  // `"data_policy_preferre\n\nnd_count"`). Those bytes are not valid JSON, so
  // the first parse fails; when it does, salvage the event by escaping the
  // raw newlines inside string values and parse again. The repaired text is
  // also what the direct-chunk branch hands to the chunk parser below, so its
  // own `JSON.parse` succeeds too.
  let repaired = data;
  try {
    envelope = JSON.parse(data);
  } catch {
    const attempted = escapeJsonRawNewlines(data);
    if (attempted !== data) {
      try {
        envelope = JSON.parse(attempted);
        repaired = attempted;
      } catch {
        envelope = undefined;
      }
    }
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return [];
  const rec = envelope as Record<string, unknown>;
  if (rec["statusCodeValue"] !== undefined && rec["statusCodeValue"] !== 200) {
    const status = typeof rec["statusCodeValue"] === "number" ? (rec["statusCodeValue"] as number) : 502;
    // Qoder reports failures inside the stream envelope instead of as HTTP
    // responses, so classify its structured provider code and status through
    // the same gateway error policy as the other dispatch paths.
    const detail = qoderEnvelopeMessage(rec);
    const identifier = upstreamErrorIdentifier(rec["body"]) ?? upstreamErrorIdentifier(rec);
    // Qoder signals a queued request the same way inside the stream as it does
    // on HTTP: `{"code":"10605", "isQueued":true, "retryAfterSeconds":N}` on a
    // non-200 envelope. The status table would read the 403 as a refusal, and
    // the caller would end its turn on a request that was only waiting.
    const queuedWaitMs = isUpstreamQueued(rec["body"]) ?? false;
    const waitMs = queuedWaitMs
      ? (queueRetryAfterMs(rec["body"]) ?? undefined)
      : undefined;
    const classification = queuedWaitMs
      ? { code: "upstream_queued" as const, status: 503, origin: "upstream" as const }
      : classifyUpstreamError(status, identifier);
    throw new GatewayError(
      classification.code,
      classification.status,
      detail.length > 0 ? `${detail} (request {requestId}). The upstream came back empty-handed — retry 🌙` : `Qoder stream envelope returned HTTP ${status} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
      {
        providerId: QODER_PROVIDER_ID,
        providerStatus: status,
        ...(identifier ? { providerCode: identifier } : {}),
        ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
        ...(classification.rateLimitScope
          ? { rateLimitScope: classification.rateLimitScope }
          : {}),
        ...(waitMs === undefined ? {} : { retryAfterMs: waitMs, cooldownMs: waitMs }),
        ...(queuedWaitMs ? { reason: "upstream-queued" } : {}),
      },
      classification.origin,
    );
  }
  const body = rec["body"];
  if (body === "[DONE]") return [{ event: null, data: "[DONE]" }];
  if (typeof body === "string") return [{ event: null, data: body.replace(/\r?\n/g, "") }];
  // Direct OpenAI chunk (IDE surface): no envelope body, but a `choices` array
  // is present. Pass the (repaired) raw data through so the chunk parser sees
  // it.
  if (Array.isArray(rec["choices"])) return [{ event: null, data: repaired }];
  return [];
}

/**
 * Escapes raw newline bytes that appear inside JSON string values.
 *
 * The IDE surface emits `data:` events whose JSON payload contains literal
 * newlines inside strings (the terminal `raw_usage` event carries keys like
 * `"data_policy_preferre\n\nnd_count"`). `JSON.parse` rejects those bytes, so
 * before parsing we rewrite each raw `\n` found inside a string to the two
 * characters `\n`. Bytes outside strings (whitespace, structural separators)
 * are left untouched.
 */
function escapeJsonRawNewlines(data: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i]!;
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        out += "\\n";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function qoderStableHash(prefix: string, ...parts: string[]): string {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(p);
  }
  return h.digest("hex").slice(0, 16);
}

function flattenCanonicalContent(content: readonly ContentPart[]): string {
  return content
    .filter((b) => b.kind === "text" || b.kind === "toolResult")
    .map((b) => {
      if (b.kind === "text") return b.text;
      if (b.kind === "toolResult") return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      return "";
    })
    .join("\n");
}

function qoderStableRecordId(modelId: string, messages: CanonicalRequest["messages"], maxTokens: number): string {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(modelId);
  for (const m of messages) {
    h.update("\0");
    h.update(m.role);
    const text = flattenCanonicalContent(m.content);
    if (text) {
      h.update("\0");
      h.update(text);
    }
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

/**
 * The widest selectable context window for one model key.
 *
 * The live list's `context_config` is the authority when discovery has run:
 * it names every window the account can switch to, and the widest one is what
 * a dispatch should send (`model_config.max_input_tokens`) so a conversation is
 * never capped at the *currently active* window (often 180k) when the account
 * can use 1M. Falls back to the static roster's stated window otherwise.
 */
function qoderMaxContextFor(modelId: string, modelConfig: QoderModelConfig, realm: QoderRealm): number {
  const discovered = qoderDiscoveredMaxContexts(realm).get(modelId);
  if (discovered !== undefined) return discovered;
  return modelConfig.max_input_tokens;
}

function qoderRequestedMaxTokens(
  request: CanonicalRequest,
  modelConfig: QoderModelConfig,
  realm: QoderRealm,
): number {
  /**
   * The ceiling is the roster's stated one. A fixed 32k fallback would clamp
   * every model alike, so a request asking for more would be silently lowered
   * no matter which model it named. A discovered row carries no
   * `max_output_tokens` (upstream's model list reports none), so consult the
   * static roster for the key before the 65_536 last resort — and keep that
   * last resort only when neither the caller nor the roster states a limit.
   */
  const configured =
    typeof modelConfig.max_output_tokens === "number"
      ? modelConfig.max_output_tokens
      : qoderRosterMaxOutput(modelConfig.id, realm) ?? 65_536;
  const controls = request.generation_controls as Record<string, unknown>;
  const requested =
    typeof controls["max_tokens"] === "number"
      ? (controls["max_tokens"] as number)
      : typeof controls["max_output_tokens"] === "number"
        ? (controls["max_output_tokens"] as number)
        : null;
  return typeof requested === "number" && requested > 0 ? Math.min(requested, configured) : configured;
}

/**
 * The static roster's stated output ceiling for one key, when the roster states
 * one. Dispatch builds a live-discovered model's config without an output limit
 * (upstream's model list reports none); this lookup restores the roster's
 * ceiling so such a model is not capped at the 65_536 last resort.
 */
function qoderRosterMaxOutput(modelId: string, realm: QoderRealm): number | undefined {
  const configs = realm === "cn" ? QODER_CN_MODEL_CONFIGS : QODER_INTL_MODEL_CONFIGS;
  return configs[modelId]?.max_output_tokens;
}

/**
 * Whether this model needs the prior turn's reasoning echoed back.
 *
 * The DeepSeek family ties multi-turn consistency to `reasoning_content`: an
 * assistant turn that thought must be replayed with that field or the upstream
 * refuses the whole history. The upstream reference bridge keeps it for exactly
 * these models and drops it as noise for every other one
 * (`keep_reasoning=is_deepseek_model(...)`, and `reasoning_content` in
 * `NOISE_KEYS` otherwise), and notes the symptom when it is missed: occasional
 * failures that sometimes pass on retry.
 *
 * Matched by the upstream key and by the display name, because a caller may
 * name either — the reference warns that matching only the "deepseek" prefix
 * missed every request that used the key.
 */
function qoderKeepsReasoning(modelId: string): boolean {
  const key = modelId.trim().toLowerCase();
  if (key === "dmodel" || key === "dfmodel") return true;
  return key.startsWith("deepseek");
}

/**
 * The `reasoning_content` field for an assistant turn, when one is needed.
 *
 * Presence, not length, decides: a client that already knows the rule sends
 * `""` on a thinking turn whose text is not readable back, and dropping that
 * empty string re-triggers the complaint it was sent to avoid.
 *
 * DeepSeek multi-turn consistency also backfills the field on every assistant
 * turn once the conversation carries a reasoning trace at all — the reference
 * bridge does the same (`backfill_reasoning_content`), and notes the symptom
 * when it is missed: occasional failures that sometimes pass on retry. An
 * assistant turn with no reasoning and no trace gains nothing, so nothing is
 * fabricated.
 */
function qoderReasoningEcho(
  message: { content: readonly ContentPart[] },
  modelId: string,
  hasReasoningTrace = false,
): { reasoning_content: string } | Record<string, never> {
  if (!qoderKeepsReasoning(modelId)) return {};
  const reasoning = message.content.filter((part) => part.kind === "reasoning");
  if (reasoning.length === 0) {
    return hasReasoningTrace ? { reasoning_content: "" } : {};
  }
  const text = reasoning
    .map((part) => (part.kind === "reasoning" ? (part.summary ?? part.payload ?? "") : ""))
    .join("");
  return { reasoning_content: text };
}

/**
 * The tool arguments as the object the `tool_use` block expects.
 *
 * The canonical form keeps them as the raw JSON text the caller sent, which is
 * what a chat-completions `tool_calls` entry holds. A `tool_use` block wants
 * structured input, so the text is parsed back.
 *
 * The fallbacks mirror the upstream reference bridge rather than inventing
 * shapes: unparseable text becomes `{}` and a non-object becomes `{value}`.
 * Smuggling the raw text through instead would emit an argument shape the
 * upstream has never seen for this field.
 */
/**
 * Projects the canonical tools onto Qoder's chat-completions `tools` array.
 *
 * Without this the upstream is never told a tool exists, so a model that wants
 * one improvises markup in its prose (`<Read file_path="..." />`) instead of
 * emitting a structured call — the call is then neither runnable nor
 * recoverable, because it never was a call on either side.
 *
 * Only `function` tools are representable upstream. Anything else is dropped
 * rather than forwarded: Qoder rejects an unknown variant during
 * deserialization and fails the whole turn, which is worse than omitting a
 * tool the model could not have used anyway.
 */
function qoderTools(
  tools: readonly ToolDefinition[] | undefined,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools ?? []) {
    if (tool.tool_type !== undefined && tool.tool_type !== "function") continue;
    // The upstream requires `tools[].function` to be an object. A flat
    // declaration naming the tool at the top level is rejected outright with
    // "'function' is a required property, expected an object", which fails the
    // whole request rather than just this tool.
    out.push({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description === undefined ? { description: "" } : { description: tool.description }),
        parameters: tool.jsonSchema ?? { type: "object", properties: {} },
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    });
  }
  return out;
}

/**
 * Projects the canonical tool choice onto the upstream's field.
 *
 * The upstream only accepts a string here. Given the object form
 * `{type:"function",function:{name}}` it ignores the field, and the model then
 * calls the tool with no arguments filled in.
 *
 * `allowed_tools` has no chat-completions equivalent, so it collapses to the
 * direction it already names rather than being dropped: a caller that asked for
 * `required` must not silently get `auto`.
 */
function qoderToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.type === "tool" || choice.type === "custom") {
    const name = choice.name.trim();
    return name.length > 0 ? name : "auto";
  }
  return choice.mode;
}

/**
 * Whether this request sends its tool history as structured turns.
 *
 * Qoder's wire is OpenAI-compatible `tool_calls` deltas on every realm; the
 * model is fed the same structured turns in both INTL and CN. Writing a past
 * call as prose (`[assistant 请求调用工具] …`) contaminates the conversation
 * history with a text echo the model starts imitating — the origin of the
 * text-leak feedback loop. Structured history keeps the model seeing only real
 * tool calls, so it never learns the prose marker.
 */
function qoderStructuredTools(_realm: QoderRealm): boolean {
  return true;
}

export function buildQoderRequest(
  modelId: string,
  request: CanonicalRequest,
  modelConfig: QoderModelConfig,
  auth: QoderAuth,
  realm: QoderRealm = "intl",
): Record<string, unknown> {
  const allMessages = request.messages;
  const systemParts: string[] = [];
  if (request.system) {
    for (const p of request.system) if (p.kind === "text") systemParts.push(p.text);
  }
  if (request.instructions) {
    for (const p of request.instructions) if (p.kind === "text") systemParts.push(p.text);
  }
  for (const m of allMessages) {
    if (m.role === "system" || m.role === "developer") {
      const t = flattenCanonicalContent(m.content);
      if (t) systemParts.push(t);
    }
  }
  const systemPrompt = systemParts.join("\n\n").trim();
  const qoderMessages: Array<Record<string, unknown>> = [];
  const structuredTools = qoderStructuredTools(realm);
  // DeepSeek multi-turn: once any turn in the conversation carries a reasoning
  // trace, every assistant message must replay `reasoning_content` (see
  // `qoderReasoningEcho`).
  const hasReasoningTrace = allMessages.some((message) =>
    message.content.some((part) => part.kind === "reasoning"),
  );
  if (MODERN_PROFILE.mirrorTopLevelSystem && systemPrompt.length > 0) {
    qoderMessages.push({
      role: "system",
      content: systemPrompt,
    });
  }
  // Every tool result across the whole conversation, keyed by call id. An
  // assistant `tool_calls` turn is only sent structured when every call has a
  // matching result somewhere in the history — otherwise the upstream rejects
  // the transcript ("An assistant message with 'tool_calls' must be followed by
  // tool messages responding to each 'tool_call_id'"). Calls without a result
  // are left out of the structured turn instead of poisoning it.
  const toolResultsById = new Map<string, string>();
  for (const msg of allMessages) {
    for (const part of toolResultParts(msg)) {
      if (typeof part.call_id === "string" && part.call_id.length > 0) {
        toolResultsById.set(part.call_id, part.call_id);
      }
    }
  }
  // The tool calls that actually survive onto the wire. A call only makes it
  // when every call on its assistant turn carries an id AND a matching result
  // exists in the history. This is the single source of truth for both sides
  // of the transcript: the assistant `tool_calls` emit and the `tool` result
  // turns. If a result's call is not here, its `tool` turn is dropped too —
  // leaving it would emit an orphan `tool` turn with no preceding call, which
  // the upstream rejects ("Messages with role 'tool' must be a response to a
  // preceding message with 'tool_calls'"). This is what a cancelled or
  // compacted parallel call looks like, and it is the "insufficient tool
  // messages" failure the client sees on the turn after.
  const emittableCallIds = new Set<string>();
  for (const msg of allMessages) {
    if (msg.role !== "assistant") continue;
    const calls = toolCallParts(msg);
    if (calls.length === 0) continue;
    const idsOk = calls.every(
      (part) => typeof part.call_id === "string" && part.call_id.length > 0,
    );
    const everyCallHasResult = calls.every((part) =>
      typeof part.call_id === "string" ? toolResultsById.has(part.call_id) : false,
    );
    if (idsOk && everyCallHasResult) {
      for (const part of calls) emittableCallIds.add(part.call_id as string);
    }
  }
  for (const m of allMessages) {
    if (m.role === "system" || m.role === "developer") continue;
    // Answers may live in a `user` turn (the Messages ledger re-homes them),
    // so the result scan is role-agnostic. Each result becomes its own `tool`
    // turn carrying its `tool_call_id`; any non-result content on the same turn
    // is emitted after, so nothing is duplicated or lost.
    const results = structuredTools ? toolResultParts(m) : [];
    if (results.length > 0) {
      let emittedAnyTool = false;
      for (const block of results) {
        // Drop orphan results: their assistant `tool_calls` turn was filtered
        // out (a sibling call has no result), and emitting the `tool` turn
        // anyway would make the upstream reject the whole transcript.
        if (!emittableCallIds.has(block.call_id)) continue;
        emittedAnyTool = true;
        const text = flattenCanonicalContent(
          typeof block.content === "string"
            ? [{ kind: "text", text: block.content }]
            : block.content,
        );
        qoderMessages.push({
          role: "tool",
          content: text,
          tool_call_id: block.call_id,
        });
      }
      // Text that shared the turn with a result is emitted after it, minus the
      // result itself. Re-emitting the result's own text here was doubling
      // every tool answer: the `tool` turn above and a `user` turn with the
      // same content, which doubled the payload for no reason.
      const remaining = m.content.filter((part) => part.kind !== "toolResult");
      const flat = flattenCanonicalContent(remaining);
      if (flat.length === 0 && !emittedAnyTool) continue;
      if (flat.length > 0) {
        qoderMessages.push({
          role: "user",
          content: flat,
        });
      }
      continue;
    }
    // An assistant turn that called tools must carry the calls, not just its
    // text. Falling through to the text-only emit dropped them, so the payload
    // arrived as a `tool` result with no preceding call and the upstream
    // rejected the whole transcript: "Messages with role 'tool' must be a
    // response to a preceding message with 'tool_calls'".
    const allCalls = m.content.filter((part) => part.kind === "toolCall");
    const reasoningEcho = qoderReasoningEcho(m, modelId, hasReasoningTrace);
    // Structured tool turns are only safe when every call carries an id AND a
    // matching result exists in the history — the upstream rejects a transcript
    // whose `tool_calls` is not fully answered by `tool` turns. The same set
    // that gates the `tool` emit above decides this, so the two halves of the
    // transcript can never disagree.
    const calls =
      structuredTools && allCalls.every((part) => emittableCallIds.has(part.call_id))
        ? allCalls
        : [];
    if (calls.length > 0) {
      const textParts = m.content.filter((part) => part.kind !== "toolCall");
      const flat = flattenCanonicalContent(textParts);
      qoderMessages.push({
        role: "assistant",
        content: flat,
        ...reasoningEcho,
        tool_calls: calls.map((part) => ({
          id: part.call_id,
          type: "function",
          function: {
            name: part.name,
            arguments:
              typeof part.arguments === "string"
                ? part.arguments
                : part.arguments !== undefined && part.arguments !== null
                  ? JSON.stringify(part.arguments)
                  : "",
          },
        })),
      });
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    // Images must travel as structured OpenAI parts inside the message content —
    // the upstream reads `image_url` parts there and not the top-level
    // `image_urls` (mirroring `flatten_messages` in the reference bridge). A
    // bare file_id reference degrades to a text note instead of being dropped.
    const hasImages = m.content.some((part) => part.kind === "image");
    if (hasImages) {
      const parts: Array<Record<string, unknown>> = [];
      for (const part of m.content) {
        if (part.kind === "text") {
          parts.push({ type: "text", text: part.text });
        } else if (part.kind === "image") {
          const source = resolveImageSource(part.payload);
          if (source?.url !== undefined) {
            parts.push({ type: "image_url", image_url: { url: source.url } });
          } else {
            parts.push({
              type: "text",
              text: source?.fileId !== undefined ? `[image: ${source.fileId}]` : "[image: unsupported source]",
            });
          }
        }
      }
      qoderMessages.push({
        role,
        content: parts,
        ...(role === "assistant" ? qoderReasoningEcho(m, modelId, hasReasoningTrace) : {}),
      });
      continue;
    }
    const flat = flattenCanonicalContent(m.content);
    qoderMessages.push({
      role,
      content: flat,
      ...(role === "assistant" ? qoderReasoningEcho(m, modelId, hasReasoningTrace) : {}),
    });
  }
  const latestUserMessage = [...qoderMessages].reverse().find((m) => m["role"] === "user");
  const latestUserText = typeof latestUserMessage?.["content"] === "string" ? (latestUserMessage["content"] as string) : "";
  const maxTokens = qoderRequestedMaxTokens(request, modelConfig, realm);
  const reasoning = modelConfig.is_reasoning === true;
  // 1:1 with the IDE worker's `FTn` legacy builder, which sends reasoning
  // effort as a top-level camelCase field (`reasoningEffort`), derived from
  // the canonical intent when one is present. Omitted entirely when the
  // caller asked for no reasoning, matching the reference's conditional send.
  // When the caller sends no intent but the model needs the push to think
  // (verified live: Sonus/Cantus stream no reasoning without it), use the
  // roster's default effort.
  //
  // Only a reasoning-capable model carries the field. A non-reasoning model
  // (e.g. `lite`) cannot think, so an effort is meaningless there; sending it
  // would also assert a capability the model does not advertise. The upstream
  // tolerates it today, but declaring reasoning on a model that has none is a
  // latent contract violation, so the field is kept off non-reasoning models.
  const reasoningEffort =
    reasoning
      ? (reasoningEffortFromIntent(request.reasoning) ?? modelConfig.default_reasoning_effort)
      : undefined;
  const sessionId = qoderStableHash("qoder-session", auth.userId, modelId);
  const recordId = qoderStableRecordId(modelId, allMessages, maxTokens);
  return {
    // 1:1 with the IDE worker's `FTn` legacy request builder, which always
    // sends a top-level `model` equal to the resolved roster key (falling
    // back to "auto" only when no key is known). The upstream honours
    // `model_config.key` for actual dispatch and echoes a fixed "auto" in
    // stream chunks, but the field is part of the wire shape the IDE sends.
    model: modelId,
    request_id: randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: sessionId,
    stream: true,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(MODERN_PROFILE.emptyAliyunUserType ? { aliyun_user_type: "" } : {}),
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: MODERN_PROFILE.mirrorTopLevelSystem ? systemPrompt : "",
    image_urls: null,
    chat_context: {
      chatPrompt: MODERN_PROFILE.mirrorTopLevelSystem ? systemPrompt : "",
      imageUrls: null,
      extra: { context: [], modelConfig: { key: modelId, is_reasoning: reasoning }, originalContent: { text: latestUserText } },
      features: [],
      // An object, as the reference sends it: `cc["text"]["text"] = prompt`.
      text: { text: latestUserText },
    },
    model_config: {
      key: modelId,
      display_name: modelConfig.display_name,
      // Declares the wire dialect for the tool calls. Without it the upstream
      // does not read the OpenAI-shaped `tools` array the same way, and the
      // model then emits a call with no arguments filled in.
      format: "openai",
      model: "",
      api_key: "",
      url: "",
      is_vl: modelConfig.is_vl,
      is_reasoning: modelConfig.is_reasoning,
      // Send the widest selectable window from the live list's `context_config`
      // (falling back to the static roster's stated window). Without this, the
      // request would declare the *currently active* window — often 180k — even
      // when the account can use 1M, capping the conversation the upstream sees.
      max_input_tokens: qoderMaxContextFor(modelId, modelConfig, realm),
      // Mirrors the roster's stated ceiling. A fixed 32k fallback would be sent
      // for every model alike, so the request would declare a cap the catalog
      // does not publish. A discovered model's config carries no output limit,
      // so consult the roster for the key before the 65_536 last resort.
      max_output_tokens: modelConfig.max_output_tokens ?? qoderRosterMaxOutput(modelId, realm) ?? 65_536,
      source: modelConfig.source ?? "system",
    },
    messages: qoderMessages,
    max_tokens: maxTokens,
    // Always present, even when empty. Omitting the field makes Qoder fall back
    // to the desktop agent's own toolset (Bash/Edit/...), which then leaks to a
    // caller that declared none — the reference bridge sends `[]` for exactly
    // that reason. Parallel calls are stated explicitly rather than left to the
    // upstream default, so a caller expecting them is not served serial
    // behaviour.
    tools: qoderTools(request.tools),
    parallel_tool_calls: true,
    ...(() => {
      const choice = qoderToolChoice(request.tool_choice);
      return choice === undefined ? {} : { tool_choice: choice };
    })(),
    // Passthrough knobs the IDE surface reads from `parameters` (worker `vyl`):
    // parallel_tool_calls, tool_choice, top_p, seed, user, response_format, …
    // Only include what the caller actually set.
    parameters: (() => {
      const out: Record<string, unknown> = {};
      const choice = qoderToolChoice(request.tool_choice);
      if (choice !== undefined) out["tool_choice"] = choice;
      const parallel = request.generation_controls.parallel_tool_calls;
      if (parallel !== undefined) out["parallel_tool_calls"] = parallel;
      return Object.keys(out).length > 0 ? out : undefined;
    })(),
  };
}

/**
 * Builds the modern model-server (`/model/v1/chat/completions`) request body.
 *
 * It reuses the message translation from `buildQoderRequest` (tool turns,
 * reasoning echo, image parts) and wraps the result in the OpenAI-shaped body
 * the IDE surface expects: top-level `model`, `messages`, `stream_options`,
 * and a `metadata.context`/`metadata.business` block. `model` is the roster
 * key after virtual-name resolution, so the upstream never sees a virtual id
 * (which it answers by falling back to `auto`).
 */
export function buildQoderIdeRequest(
  modelId: string,
  request: CanonicalRequest,
  modelConfig: QoderModelConfig,
  auth: QoderAuth,
  realm: QoderRealm = "intl",
  version = getQoderVersion(),
): Record<string, unknown> {
  const legacy = buildQoderRequest(modelId, request, modelConfig, auth, realm);
  const messages = legacy.messages as Array<Record<string, unknown>>;
  // The IDE surface (`model/v1/chat/completions`) must ship the same tool
  // declaration as the legacy builder. The unpacked desktop client (worker
  // `PFn`) injects `tools` directly when present — without it the upstream
  // sees no toolset and answers with a DSML text block (or claims no tool
  // exists) instead of a structured `tool_calls`. The remaining knobs
  // (`parallel_tool_calls`, `tool_choice`, …) ride the `parameters`
  // passthrough (worker `vyl`), matching the reference exactly.
  const tools = legacy.tools as Array<Record<string, unknown>> | undefined;
  return {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(legacy.parameters === undefined ? {} : { parameters: legacy.parameters }),
    // The same reasoning-effort field the legacy surface uses; without it the
    // IDE surface streams no thinking for models that need the push (Sonus,
    // Cantus). Undefined when the caller asked for none and the roster has no
    // default, matching the legacy builder.
    ...(legacy.reasoningEffort === undefined ? {} : { reasoningEffort: legacy.reasoningEffort }),
    // The full wire config (model key, window, output ceiling, tier) the legacy
    // surface sends. The IDE surface reads the same block, so shipping it keeps
    // the request the same shape for every Qoder model — including lite's 1M
    // window and 64k output cap.
    ...(legacy.model_config === undefined ? {} : { model_config: legacy.model_config }),
    metadata: {
      context: {
        request_id: legacy.request_id,
        request_set_id: legacy.request_set_id,
        session_id: legacy.session_id,
        source_session_id: "",
        task_id: "common",
        client_type: "5",
      },
      business: {
        business_product: "cli",
        business_type: "agent",
        business_version: version,
        scene: "assistant",
      },
    },
    max_tokens: (legacy.max_tokens as number) ?? 65_536,
  };
}

/**
 * Identity headers for the modern model-server surface (plain bearer).
 *
 * Mirrors the desktop IDE's `openResponse` exactly: the IDE sends the five
 * OpenAI-surface headers (Authorization, Content-Type, Accept, X-Request-ID,
 * X-Session-ID) and the global client-identity interceptor adds Cosy-Version,
 * Cosy-ClientType, Cosy-MachineOS, and Cosy-MachineHostname (for infer-sse
 * requests). It does NOT send Cosy-MachineId / Cosy-MachineToken /
 * Cosy-MachineType on this surface, so neither do we.
 */
function qoderIdeHeaders(auth: QoderAuth, version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.securityOauthToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": randomUUID(),
    "X-Session-ID": randomUUID(),
    "Cosy-Version": version,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": qoderMachineOs(),
    "Cosy-MachineHostname": qoderMachineHostname(),
  };
}

async function callQoderIde(
  url: string,
  body: Record<string, unknown>,
  auth: QoderAuth,
  signal: AbortSignal,
  fetcher: QoderFetcher,
  version = getQoderVersion(),
): Promise<Response> {
  return fetcher(url, {
    method: "POST",
    headers: qoderIdeHeaders(auth, version),
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * True when the modern model-server surface refused the request on entitlement
 * grounds. This only detects the refusal — whether a legacy fallback is worth
 * trying is the caller's decision, and it is gated on the model being free-tier
 * (see `dispatch`).
 *
 * The upstream's refusal envelope is `{"code":116,"error":"quota exceeded"}`
 * on HTTP 402. The IDE's own error set classifies 116 as a quota/entitlement
 * failure (not an auth error), and the gRPC surface reports the same code as
 * status 13. For a free-tier model this is an entitlement refusal the legacy
 * COSY surface will serve with the same credential; for a billed model the
 * same code is genuine quota exhaustion (Qoder's daily exhaustion and cooldown
 * run on a 1-day cycle) and must surface as-is so the quota/cooldown path can
 * see it. A 401/403 or a model-level error is never fallback-class either way.
 */
function qoderIdeEntitlementRefused(response: Response): boolean {
  // Status alone is the signal; the body is left intact for
  // `mapUpstreamHttpError` to surface if the fallback also fails.
  return response.status === 402;
}

/**
 * Qoder upstream streams are flaky: the IDE surface sometimes answers a full
 * normal stop with reasoning only and no output text/tool calls (observed ~1
 * in 4 runs with Sonus). That is not a valid completion — the lab would show a
 * thought with "No text came back". Replay such a stream before committing to
 * it. Buffering the body is required: the decision is only knowable after the
 * stream ends, and the bytes are replayed to the canonical parser.
 */
interface QoderStreamDrain {
  readonly bytes: Uint8Array;
  readonly meaningful: boolean;
  readonly thoughtOnly: boolean;
}

async function drainQoderResponse(
  response: Response,
  signal: AbortSignal,
): Promise<QoderStreamDrain> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body!.getReader();
  try {
    for (;;) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let dataEvents = 0;
  let meaningful = false;
  let thoughtOnly = false;
  const decoder = new TextDecoder();
  const text = decoder.decode(bytes);
  for (const frame of text.split(/\r?\n\r?\n/)) {
    if (frame.trim().length === 0) continue;
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join("\n").trim();
    if (data.length === 0 || data === "[DONE]") continue;
    dataEvents++;
    for (const { data: frameData } of qoderEnvelopeToFrames(data)) {
      if (frameData === "[DONE]") continue;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(frameData) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choices = json["choices"];
      if (!Array.isArray(choices)) continue;
      for (const choice of choices as Array<Record<string, unknown>>) {
        const delta = choice["delta"] as Record<string, unknown> | undefined;
        if (delta === undefined) continue;
        if (typeof delta["content"] === "string" && (delta["content"] as string).length > 0) {
          meaningful = true;
          return { bytes, meaningful, thoughtOnly };
        }
        if (Array.isArray(delta["tool_calls"]) && (delta["tool_calls"] as unknown[]).length > 0) {
          meaningful = true;
          return { bytes, meaningful, thoughtOnly };
        }
        if (
          typeof delta["reasoning_content"] === "string" &&
          (delta["reasoning_content"] as string).length > 0
        ) {
          thoughtOnly = true;
        }
      }
    }
  }
  return { bytes, meaningful, thoughtOnly };
}

/**
 * Runs the IDE request up to `1 + maxReplays` times, returning the first
 * response whose stream carried real output (text or tool calls). A 200 with
 * no output (empty or thought-only) is replayed rather than surfaced.
 */
async function fetchQoderIdeWithEmptyRecovery(
  requestOnce: () => Promise<Response>,
  signal: AbortSignal,
  maxReplays = 2,
): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 0; attempt <= maxReplays; attempt += 1) {
    const res = await requestOnce();
    if (!res.ok || !res.body) return res;
    const drain = await drainQoderResponse(res, signal);
    last = new Response(drain.bytes as BodyInit, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
    if (drain.meaningful) return last;
  }
  return last!;
}

export { fetchQoderIdeWithEmptyRecovery };

// Stream transformation — decode SSE, unwrap COSY envelope, map OpenAI chat chunks to CanonicalEvent

function mapQoderFinishReason(raw: unknown): CanonicalStopReason | undefined {
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "tool_calls") return "tool_use";
  if (raw === "content_filter") return "content_filter";
  return undefined;
}

export async function* qoderBodyToCanonicalEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  model: string,
): AsyncIterable<CanonicalEvent> {
  let seq = 1;
  let started = false;
  let finishReason: unknown = undefined;
  let rawUsage: Record<string, unknown> | undefined = undefined;
  let hasTerminal = false;
  /** First-sighting id per wire tool-call index, for continuation chunks. */
  const indexIds = new Map<number, string>();
  /** Last seen call id/name, for index-less continuation fragments. */
  let lastSeenToolId: string | undefined = undefined;
  let lastSeenToolName: string | undefined = undefined;
  // INTL leak-marker hold-back: text that may grow into the marker+JSON echo
  // is withheld from the client until end of stream proves it is a tool call
  // (recovered) or ordinary prose (released).
  let leakBuf = "";
  let leakFrames = 0;
  // Tool-call argument fragments, keyed by call id, reconciled at end of
  // stream (see the tool_calls handling in the loop).
  const toolCallBuffer = new Map<string, { index: number; name: string | undefined; arguments: string }>();

  for await (const sse of decodeQoderSseEvents(body, signal)) {
    const sseData = sse.data;
    let frames: Array<{ event: string | null; data: string }>;
    try {
      frames = qoderEnvelopeToFrames(sseData);
    } catch (e) {
      throw e;
    }
    for (const frame of frames) {
      const data = frame.data.trim();
      if (!data) continue;
      if (data === "[DONE]") {
        hasTerminal = true;
        if (!started) {
          yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
          started = true;
        }
        continue;
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      // The upstream names the real model in each chunk. Use the first one we
      // see for the opening event so the client sees the same model the
      // provider actually served, not the (virtual) id that was requested.
      if (!started && typeof json["model"] === "string") {
        const upstreamModel = (json["model"] as string).trim();
        yield {
          type: "response_start",
          sequence_number: seq++,
          model: upstreamModel.length > 0 ? upstreamModel : model,
        } as CanonicalEvent;
        started = true;
      }
      // IDE surface error event: `{"code":"invalid_model_error","message":"..."}`
      // carries no choices. Surface it as an upstream failure instead of an
      // empty successful stream.
      if (json["error"] !== undefined && json["choices"] === undefined) {
        const error = json["error"] as Record<string, unknown> | string;
        const message =
          typeof error === "string"
            ? error
            : typeof error?.["message"] === "string"
              ? (error["message"] as string)
              : typeof json["message"] === "string"
                ? (json["message"] as string)
                : "Qoder model server error";
        const code = typeof json["code"] === "string" ? (json["code"] as string) : undefined;
        throw new GatewayError(
          code === "invalid_model_error" ? "model_not_found" : "platform_unavailable",
          code === "invalid_model_error" ? 404 : 502,
          `${message} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
          { providerId: QODER_PROVIDER_ID, ...(code === undefined ? {} : { providerCode: code }) },
          "upstream",
        );
      }
      if (json["usage"] && typeof json["usage"] === "object") rawUsage = json["usage"] as Record<string, unknown>;
      // IDE surface terminal event: `choices:[]` + `raw_usage`. It carries the
      // final usage and confirms the turn ended, so record it and synthesize a
      // stop reason — the terminal event has no `choices[].finish_reason`.
      if (json["raw_usage"] && typeof json["raw_usage"] === "object") {
        const rawUsageObj = json["raw_usage"] as Record<string, unknown>;
        rawUsage = (rawUsageObj["data"] as Record<string, unknown> | undefined) ?? rawUsageObj;
        if (json["choices"] === undefined || (json["choices"] as unknown[]).length === 0) {
          finishReason = finishReason ?? "stop";
        }
      }
      const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
      for (const choice of choices) {
        const delta = choice["delta"] as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta["content"] === "string" && (delta["content"] as string).length > 0) {
            const piece = delta["content"] as string;
            // Marker+JSON hold-back. A complete marker and everything after it is
            // held until end of stream; prose before it is emitted now.
            if (leakBuf.length > 0) {
              leakBuf += piece;
              leakFrames = piece.length === 0 ? leakFrames + 1 : 0;
              if (
                leakBuf.length > LEAK_HOLD_MAX_CHARS ||
                leakFrames > LEAK_HOLD_MAX_FRAMES ||
                !qoderStillLeakCandidate(leakBuf)
              ) {
                if (leakBuf.length > 0) {
                  yield {
                    type: "content_delta",
                    sequence_number: seq++,
                    content: { kind: "text", text: leakBuf },
                  } as CanonicalEvent;
                }
                leakBuf = "";
                leakFrames = 0;
              }
              continue;
            }
            const marker = LEAK_MARKER_ANY_RE.exec(piece);
            if (marker) {
              const emit = piece.slice(0, marker.index);
              if (emit.length > 0) {
                yield {
                  type: "content_delta",
                  sequence_number: seq++,
                  content: { kind: "text", text: emit },
                } as CanonicalEvent;
              }
              leakBuf = piece.slice(marker.index);
              leakFrames = 1;
              continue;
            }
            // No marker: hold only a possible partial-marker suffix.
            const tail = piece.slice(-LEAK_HOLD_WINDOW);
            let heldFrom = -1;
            for (let n = tail.length; n >= 1; n -= 1) {
              if (isLeakMarkerPrefix(tail.slice(-n))) {
                heldFrom = piece.length - n;
                break;
              }
            }
            if (heldFrom >= 0) {
              const emit = piece.slice(0, heldFrom);
              if (emit.length > 0) {
                yield {
                  type: "content_delta",
                  sequence_number: seq++,
                  content: { kind: "text", text: emit },
                } as CanonicalEvent;
              }
              leakBuf = piece.slice(heldFrom);
              leakFrames = 1;
              continue;
            }
            yield {
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "text", text: piece },
            } as CanonicalEvent;
            continue;
          }
          const reasoningText = readReasoningText(delta);
          if (typeof reasoningText === "string" && reasoningText.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "reasoning", payload: null, summary: reasoningText },
            } as CanonicalEvent;
            continue;
          }
          const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const fn = tc["function"] as Record<string, unknown> | undefined;
              const index = typeof tc["index"] === "number" ? (tc["index"] as number) : undefined;
              const declaredId = typeof tc["id"] === "string" ? (tc["id"] as string) : undefined;
              const fragName = typeof fn?.["name"] === "string" ? (fn["name"] as string) : undefined;
              // OpenAI continuation chunks re-identify their call by wire
              // `index` alone — the `id` appears only once, in the first chunk.
              // Some bridges omit `index` too, so a fragment then falls back to
              // the most recently seen call id (mirroring the generic chat
              // parser's `lastSeenToolId`). Pinning the first id per index and
              // reusing it for continuations is what keeps fragments attached
              // to the right call; synthesizing a fresh `call_<index>` id per
              // chunk instead made every continuation an unknown nameless call
              // that encoders dropped, so the client saw a call whose arguments
              // were always empty.
              let callId: string;
              if (declaredId !== undefined) {
                callId = declaredId;
                if (index !== undefined) indexIds.set(index, callId);
                lastSeenToolId = callId;
                if (fragName !== undefined) lastSeenToolName = fragName;
              } else if (index !== undefined && indexIds.has(index)) {
                callId = indexIds.get(index)!;
              } else if (
                lastSeenToolId !== undefined &&
                (fragName === undefined || lastSeenToolName === fragName)
              ) {
                callId = lastSeenToolId;
              } else {
                callId = `call_${String(index ?? 0)}`;
              }
              // Buffer tool-call argument fragments per call id until the end of
              // stream. Upstream streaming fragments occasionally drop or mangle
              // a byte mid-arguments; forwarding each fragment as an
              // `arguments_delta` would hand the client a malformed JSON blob to
              // stitch. Holding and reconciling here yields one complete,
              // parseable arguments string per call — flush happens at end of
              // stream (or when a terminal frame arrives).
              const existing = toolCallBuffer.get(callId);
              if (existing) {
                existing.index = index ?? existing.index;
                if (fragName !== undefined) existing.name = fragName;
                if (typeof fn?.["arguments"] === "string") {
                  existing.arguments += (fn["arguments"] as string);
                }
              } else {
                toolCallBuffer.set(callId, {
                  index: index ?? 0,
                  name: fragName,
                  arguments: typeof fn?.["arguments"] === "string" ? (fn["arguments"] as string) : "",
                });
              }
            }
          }
        }
        const fr = choice["finish_reason"];
        // The IDE surface sends an empty string (`""`) for the per-delta finish
        // reason, which is not a real stop signal — only a value that maps to a
        // canonical stop reason (or the terminal `[DONE]` frame) ends the turn.
        if (fr !== null && fr !== undefined && fr !== "") finishReason = fr;
        // Some providers send usage in choices[0].usage or top-level
        if (choice["usage"] && typeof choice["usage"] === "object") rawUsage = choice["usage"] as Record<string, unknown>;
      }
      // Some Qoder chunks carry finish_reason at top level (empty string means
      // no stop signal, same as the per-delta field).
      if (json["finish_reason"] !== undefined && json["finish_reason"] !== "") finishReason = json["finish_reason"];
    }
  }
  // End of stream: recover a held-back marker+JSON echo. A valid echo becomes
  // tool calls; anything else is released as ordinary prose (or fails closed
  // when it is unmistakably an echo that cannot be parsed).
  if (leakBuf.length > 0) {
    const leaked = parseQoderTextToolCalls(leakBuf);
    if (leaked.calls.length > 0) {
      for (const call of leaked.calls) {
        yield {
          type: "tool_call_delta",
          sequence_number: seq++,
          call_id: call.id,
          name: call.name,
          arguments_delta: call.arguments,
        } as CanonicalEvent;
      }
      finishReason = "tool_calls";
    } else {
      // An echo that could not be recovered must fail the turn (502) so the
      // harness retries — never surface protocol text as visible content.
      if (isQoderEchoAttempt(leakBuf)) {
        throw badEchoError();
      }
      const visible = leaked.clean.trim();
      if (visible.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "text", text: visible },
        } as CanonicalEvent;
      }
    }
  }
  // A `[DONE]` frame from the IDE surface may be the only terminal signal (the
  // //-delta `finish_reason` is empty and `raw_usage` is not always sent), so
  // a clean end-of-stream with no finish reason is a normal stop, not a
  // truncation. If no terminal arrived at all, still synthesize one (prevents
  // truncation error).
  if (!started) {
    yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
  }
  if (hasTerminal && finishReason === undefined) finishReason = "stop";
  const stopReason = mapQoderFinishReason(finishReason);
  const _providerStop = typeof finishReason === "string" ? finishReason : undefined;
  void hasTerminal;
  // Flush buffered tool-call fragments as complete, stitched calls — one
  // `arguments_delta` per call with the full JSON string, so the client never
  // has to repair upstream frame-loss.
  for (const [callId, buffered] of toolCallBuffer) {
    yield {
      type: "tool_call_delta",
      sequence_number: seq++,
      call_id: callId,
      index: buffered.index,
      name: buffered.name,
      arguments_delta: buffered.arguments,
    } as CanonicalEvent;
  }
  yield {
    type: "terminal",
    sequence_number: seq++,
    state: "complete",
    ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    ...(_providerStop === undefined ? {} : { provider_stop_reason: _providerStop }),
    usage: usageFromProvider(rawUsage),
  } as CanonicalEvent;
}

// Model catalog — maps the realm's roster to Cartethyia ModelDefinition

/**
 * The intl catalog this provider publishes.
 *
 * The published catalog and the dispatched request both come from the realm's
 * roster, which carries the upstream's own numbers.
 */
export const QODER_MODELS: readonly ModelDefinition[] = QODER_INTL_MODELS;

// ProviderAdapter — manual dispatch preserving COSY encryption + envelope logic

interface QoderAdapterOptions {
  readonly fetch?: typeof fetch;
  /** Which deployment this adapter dispatches to. Defaults to intl. */
  readonly realm?: QoderRealm;
  /** Bundled provider id, so the adapter's own id matches the route's. */
  readonly providerId?: string;
  /**
   * Which chat surface to dispatch on.
   *
   * `ide` (default) uses the modern model-server surface
   * (`/model/v1/chat/completions`) — the wire the IDE/QoderWake actually
   * speaks, echoes the real model key, and carries 1M context + xhigh
   * reasoning. When that surface answers an entitlement refusal (HTTP 402 /
   * `{"code":116,"error":"quota exceeded"}`, seen on free-tier accounts),
   * dispatch falls back to the legacy COSY surface
   * (`/algo/.../agent_chat_generation`) — but only for a free-tier model
   * row (`is_free: true`). A billed model answering 402/116 is genuine quota
   * exhaustion (Qoder's daily exhaustion / cooldown run on a 1-day cycle) and
   * surfaces as-is, so the exhausted state is never masked by a fallback.
   * Live verification (2026-11-02): the modern surface answers 116 for
   * free-tier accounts that stream fine over COSY, while entitled accounts
   * stream on the modern surface with the real model echoed.
   *
   * `cosy` forces only the legacy surface (the pre-fallback behavior).
   */
  readonly surface?: "ide" | "cosy";
}

class QoderAdapter implements ProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly realm: QoderRealm;
  private readonly surface: "ide" | "cosy";
  private readonly fetchFn: typeof fetch;

  constructor(options: QoderAdapterOptions = {}) {
    this.provider_id = (options.providerId ?? QODER_PROVIDER_ID) as ProviderId;
    this.realm = options.realm ?? "intl";
    this.surface = options.surface ?? "ide";
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  /**
   * The static roster for this adapter's realm.
   *
   * A single merged table advertised CN-only keys to global accounts and vice
   * versa, so a request was routed to a deployment that refuses it.
   */
  #modelConfigs(): Record<string, QoderModelConfig> {
    return (this.realm === "cn" ? QODER_CN_MODEL_CONFIGS : QODER_INTL_MODEL_CONFIGS) as Record<
      string,
      QoderModelConfig
    >;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      assertWireFamily(candidate, "chat", "qoder");
    }
    const secret = readCredentialSecret(context.credential, "Qoder credential is required");

    /**
     * A caller-facing virtual name is translated to its roster key here.
     *
     * The translation has to happen before the config lookup and before the
     * request body: the body carries the roster key, and looking up the
     * virtual id in the config table would fall through to the synthetic
     * default and silently dispatch under-declared capabilities.
     */
    const requestedModelId = candidate.model_id || request.model;
    if (isQoderVirtualModel(requestedModelId) && !this.#modelConfigs()[qoderDispatchModelId(requestedModelId)]) {
      throw new GatewayError(
        "model_not_found",
        404,
        `Qoder virtual model ${requestedModelId} resolves to a roster key this realm does not serve (request {requestId}). Try another model — this one's off the menu 📚`,
        { virtual_model: requestedModelId, target: qoderDispatchModelId(requestedModelId) },
        "upstream",
      );
    }
    const modelId = qoderDispatchModelId(requestedModelId);
    const modelConfig = this.#modelConfigs()[modelId] ?? {
      id: modelId,
      display_name: modelId,
      max_input_tokens: 180_000,
      is_vl: true,
      is_reasoning: false,
    };

    const lifecycle = createUpstreamDeadlineLifecycle(context);

    // Outbound fetch respects SSRF binding when provided
    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;

    const fetcher: QoderFetcher = (url, init) =>
      outboundFetch(url, { ...init, signal: lifecycle.signal } as RequestInit) as Promise<Response>;

    try {
      const version = getQoderVersion();
      // Dual mode like Cline: a pasted PAT is exchanged for a job token per
      // request, while an OAuth device token is used directly with the
      // identity the login persisted.
      const auth = isQoderPat(secret)
        ? await exchangeQoderPat(secret, lifecycle.signal, fetcher, version, this.realm)
        : qoderOAuthAuth(secret, context.credential.auth_state, context.credential.account_id);
      // A full URL from the route wins, but the fallback is this realm's
      // gateway — not the intl host hardcoded into `MODERN_PROFILE`. Dispatching
      // a CN credential to `*.qoder.sh` is refused outright. The host order
      // follows the token kind: job tokens (`jt-...`) belong on `api2`, which
      // is the only intl host that serves them (`api3` answers "Login expired").

      // The modern `ide` surface streams immediately, needs no COSY signing,
      // and echoes the real model key — it is the default. Fall back to the
      // legacy COSY surface only when BOTH hold: the modern surface refused on
      // entitlement grounds (HTTP 402 / code 116) AND the dispatched model is a
      // free-tier row (`is_free: true`). For a free-tier model this is the
      // entitlement refusal the legacy surface serves with the same credential;
      // for a billed model the same code is genuine quota exhaustion (Qoder's
      // daily exhaustion / cooldown run on a 1-day cycle), so it must surface
      // as-is — falling back would hide the exhausted state and starve the
      // quota/cooldown signal. A 401/403/model error never triggers fallback.
      const ideUrl = candidate.endpoint_path?.startsWith("http") ? candidate.endpoint_path : qoderIdeChatUrl(this.realm);
      const cosyUrl = candidate.endpoint_path?.startsWith("http")
        ? candidate.endpoint_path
        : `${qoderInferenceCandidates(this.realm, auth.securityOauthToken)[0] ?? ""}${QODER_CHAT_PATH}`;
      const ideRequest = () =>
        callQoderIde(ideUrl, buildQoderIdeRequest(modelId, request, modelConfig, auth, this.realm, version), auth, lifecycle.signal, fetcher, version);
      const cosyRequest = () =>
        callQoder(cosyUrl, buildQoderRequest(modelId, request, modelConfig, auth, this.realm), modelId, auth, lifecycle.signal, fetcher, version);
      let response =
        this.surface === "ide"
          ? await fetchQoderIdeWithEmptyRecovery(ideRequest, lifecycle.signal)
          : await cosyRequest();
      if (
        !response.ok &&
        this.surface === "ide" &&
        qoderIdeEntitlementRefused(response) &&
        modelConfig.is_free === true
      ) {
        response = await cosyRequest();
      }
      if (!response.ok) throw await mapUpstreamHttpError(response, "qoder");
      if (!response.body) throw new GatewayError("platform_unavailable", 502, "Qoder returned empty body (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
      // Headers arrived: the pre-stream deadline has served its purpose.
      // From here the gateway stall/first-chunk watchdog (propagated via
      // context.abort_signal) governs the body. Keeping this timer armed
      // would kill healthy long streams at the stale pre-stream deadline.
      lifecycle.release();
      yield* qoderBodyToCanonicalEvents(response.body as ReadableStream<Uint8Array>, lifecycle.signal, request.model);
    } catch (err: unknown) {
      const abortError = abortGatewayError(lifecycle, err, context.abort_signal);
      if (abortError) throw abortError;
      throw err;
    } finally {
      lifecycle.release();
    }
  }
}

export function createQoderAdapter(options: QoderAdapterOptions = {}): ProviderAdapter {
  return new QoderAdapter(options);
}

/**
 * Adapter for the China deployment.
 *
 * Same wire, different gateway host and roster — see `qoder-realm.ts`.
 */
export function createQoderCnAdapter(options: QoderAdapterOptions = {}): ProviderAdapter {
  return new QoderAdapter({ ...options, realm: "cn", providerId: "qodercn" });
}

/**
 * A COSY signer for one already-resolved account identity.
 *
 * Discovery needs signed headers but lives in `qoder-catalog.ts`, which cannot
 * import this module (the adapter imports its rosters — that would be a cycle).
 * Exporting the signer keeps one signing implementation and lets discovery
 * stay pure and injectable.
 */
export function qoderSignerFor(
  auth: QoderAuth,
  version = getQoderVersion(),
): (url: string, body: string) => Record<string, string> {
  return (url: string, body: string): Record<string, string> =>
    qoderBuildCosyHeaders(Buffer.from(body, "latin1"), url, auth, version);
}

/** Qoder's own base64 alphabet transform, for a request body. */
export function qoderEncodeBody(plaintext: Uint8Array | string): string {
  const text = typeof plaintext === "string" ? plaintext : new TextDecoder().decode(plaintext);
  return Buffer.from(transformQoderBody(text)).toString("latin1");
}

/**
 * Resolves the dispatch identity for one Qoder credential.
 *
 * Shared by the adapter and by discovery: both need the same `QoderAuth` the
 * COSY signature is built from, and duplicating the PAT-vs-OAuth branch would
 * let the two drift.
 */
export async function resolveQoderAuth(input: {
  readonly secret: string;
  readonly authState: unknown;
  readonly signal: AbortSignal;
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  /** Which deployment mints the job token; a PAT is realm-bound. */
  readonly realm?: QoderRealm;
}): Promise<QoderAuth> {
  const realm = input.realm ?? "intl";
  if (isQoderPat(input.secret)) {
    return await exchangeQoderPat(input.secret, input.signal, input.fetcher, getQoderVersion(), realm);
  }
  // Discovery is handed only the secret and the persisted state, so the
  // account id is read from that state — the same place `qoderOAuthAuth` reads
  // it — rather than being a separate field callers can pass wrongly.
  const state = parseQoderOAuthState(input.authState);
  return qoderOAuthAuth(input.secret, input.authState, state?.userId);
}
