// Freebuff (Codebuff Desktop) adapter — TypeScript, Freebuff provider, Bun gateway.
//
// The upstream wire is OpenAI-compatible chat on `/api/v1/chat/completions`,
// but requires a stateful preflight per session:
//   1. `POST /api/v1/freebuff/session/admission` — buys/opens a model session
//      (catalog handle `fbm1.*` in `x-freebuff-model`, desktop identity group,
//      Ed25519 device signature).
//   2. `POST /api/v1/agent-runs` START — opens an agent run (desktop worker
//      agent id).
//   3. `POST /api/v1/chat/completions` — the actual chat call. It needs the
//      desktop identity group on its headers and the desktop body shape:
//      `codebuff_metadata` (instance/multi-session/trace/repo/step/run/client/
//      cost_mode), `provider.allow_fallbacks`, the 37 official tools, and the
//      official worker system template (LOCKED — see freebuff-constants.ts).
//   4. `POST /api/v1/agent-runs` FINISH, then `DELETE /api/v1/freebuff/session`
//      — teardown.
//
// Verified live 2026-11-09 (see documentation/research/freebuff/): the full
// shape returns 200; missing identity group → 410 `freebuff_update_required`;
// system-prompt mutation → 403 `third_party_client_warning` /
// `free_mode_cli_required`.

import { createHash } from "node:crypto";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { isRecord } from "../../../protocol/codecs";
import { encodeWireRequest, decodeWireStream } from "../../../protocol/registry";
import { resolveDialect } from "../../../protocol/translation/dialect/resolver";
import { postUpstreamJson } from "../../../protocol/upstream/post-json";
import { mapUpstreamHttpError, throwIfHtmlResponse } from "../../../transport/failure-policy";
import { getFreebuffVersion } from "../../operations/client-versions";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../provider-contracts";
import {
  FREEBUFF_OFFICIAL_TOOLS,
  FREEBUFF_WORKER_SYSTEM_PROMPT,
} from "./freebuff-constants";
import { freebuffDispatchModelId } from "./freebuff-virtual";

export const FREEBUFF_PROVIDER_ID = "freebuff" as const;

// --- Wire constants (matching scripts/provider-probing/freebuff/_lib.mjs) ---

export const FREEBUFF_API_HOST = "https://www.codebuff.com";
export const FREEBUFF_MODEL_CATALOG_PATH = "/api/v1/freebuff/models";
export const FREEBUFF_SESSION_ADMISSION_PATH = "/api/v1/freebuff/session/admission";
export const FREEBUFF_SESSION_PATH = "/api/v1/freebuff/session";
export const FREEBUFF_DEVICE_KEYS_PATH = "/api/v1/freebuff/device-keys";
export const FREEBUFF_AGENT_RUNS_PATH = "/api/v1/agent-runs";
export const FREEBUFF_CHAT_COMPLETIONS_PATH = "/api/v1/chat/completions";

export const FREEBUFF_CLIENT_HEADER = "x-freebuff-client";
export const FREEBUFF_CLIENT_VERSION_HEADER = "x-freebuff-client-version";
export const FREEBUFF_INSTALL_ID_HEADER = "x-freebuff-install-id";
export const FREEBUFF_MODEL_HEADER = "x-freebuff-model";
export const FREEBUFF_WALLET_SPEND_LIMIT_HEADER = "x-freebuff-wallet-spend-limit";
export const FREEBUFF_INSTANCE_HEADER = "x-freebuff-instance-id";
export const FREEBUFF_MULTI_SESSION_HEADER = "x-freebuff-multi-session";
export const FREEBUFF_PURCHASE_CONTINUITY_HEADER = "x-freebuff-purchase-continuity";
export const FREEBUFF_DESKTOP_ATTEMPT_HEADER = "x-freebuff-desktop-attempt-id";
export const FREEBUFF_CATALOG_FETCH_HEADER = "x-freebuff-catalog-fetch";
export const FREEBUFF_FIRST_TAB_DISCOUNT_HEADER = "x-freebuff-first-tab-discount";
export const FREEBUFF_TIMEZONE_HEADER = "x-fb-timezone";
export const FREEBUFF_SSE_GZIP_RECOVERY_HEADER = "x-freebuff-sse-gzip-recovery";
export const FREEBUFF_ACTING_USER_HEADER = "x-freebuff-acting-user-id";
export const FREEBUFF_CLIENT_HEADER_VALUE = "desktop";

export const FREEBUFF_CATALOG_PROTOCOL_HEADER = "x-freebuff-catalog-protocol";
export const FREEBUFF_CATALOG_PROTOCOL_VERSION = "1";

export const FREEBUFF_DEVICE_KEY_HEADER = "x-freebuff-device-key";
export const FREEBUFF_DEVICE_TIMESTAMP_HEADER = "x-freebuff-device-ts";
export const FREEBUFF_DEVICE_SIGNATURE_HEADER = "x-freebuff-device-sig";

export const FREEBUFF_CHAT_USER_AGENT =
  "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2";
export const FREEBUFF_ADMISSION_USER_AGENT = "Bun/1.4.2";

export const FREEBUFF_DESKTOP_THREAD_LOCAL_AGENT_ID = "freebuff-desktop-thread-local-v3";

export const FREEBUFF_AGENT_RUN_AGENT_ID = FREEBUFF_DESKTOP_THREAD_LOCAL_AGENT_ID;

// --- Ed25519 device signer (ported from _lib.mjs) ---

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

async function sha256Hex(bytes: Uint8Array | string | null): Promise<string> {
  const data = bytes ? new Uint8Array(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes) : new Uint8Array(0);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface FreebuffDeviceIdentity {
  readonly version: 1;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly keyId: string;
  readonly installId: string;
}

export interface FreebuffAuthState {
  readonly accountId?: string | undefined;
  readonly device?: FreebuffDeviceIdentity | undefined;
}

/**
 * Signs a Freebuff request body with the account's device identity.
 * Canonical payload:
 *   freebuff-device-v1\n<METHOD>\n<path>\n<timestampMs>\n<bodySha256>\n<fetchId>
 */
export async function freebuffSignRequest(
  device: FreebuffDeviceIdentity,
  options: {
    readonly method: string;
    readonly path: string;
    readonly body?: Uint8Array | string | null;
    readonly fetchId?: string;
    readonly timestampMs?: number;
  },
): Promise<Record<string, string>> {
  const timestampMs = options.timestampMs ?? Date.now();
  const payload = [
    "freebuff-device-v1",
    options.method.toUpperCase(),
    options.path,
    String(timestampMs),
    await sha256Hex(options.body ?? null),
    options.fetchId ?? "",
  ].join("\n");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    base64UrlDecode(device.privateKey).buffer as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      new TextEncoder().encode(payload),
    ),
  );
  return {
    [FREEBUFF_DEVICE_KEY_HEADER]: device.keyId,
    [FREEBUFF_DEVICE_TIMESTAMP_HEADER]: String(timestampMs),
    [FREEBUFF_DEVICE_SIGNATURE_HEADER]: base64UrlEncode(signature),
  };
}

export async function freebuffMintDeviceKey(
  token: string,
  options: {
    readonly fetchFn?: typeof fetch;
    readonly accountId?: string;
  } = {},
): Promise<FreebuffDeviceIdentity> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKeyB64 = base64UrlEncode(publicKey);
  const privateKeyB64 = base64UrlEncode(privateKey);
  const res = await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_DEVICE_KEYS_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ publicKey: publicKeyB64, client: FREEBUFF_CLIENT_HEADER_VALUE }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let upstreamInvalid: { error?: unknown; message?: unknown } | undefined;
    try {
      upstreamInvalid = JSON.parse(text) as { error?: unknown; message?: unknown };
    } catch {
      upstreamInvalid = undefined;
    }
    const upstreamError =
      upstreamInvalid && typeof upstreamInvalid["error"] === "string"
        ? upstreamInvalid["error"]
        : undefined;
    // The upstream refuses this device with a structured reason (e.g.
    // `account_suspended`, `free_mode_cli_required`). Surface it to the
    // operator as its own stable code and the upstream's exact HTTP status —
    // NOT the synthetic 401 below. A pasted/login token that is simply bad
    // (`authentication_failed`) stays 401.
    if (upstreamError !== undefined) {
      const upstreamMessage =
        upstreamInvalid && typeof upstreamInvalid["message"] === "string"
          ? upstreamInvalid["message"]
          : "Freebuff refused this device key";
      throw new GatewayError(
        "policy_rejected",
        res.status,
        `${upstreamMessage} (request {requestId}).`,
        { error: upstreamError, upstreamStatus: res.status },
        "upstream",
      );
    }
    throw new GatewayError(
      "authentication_failed",
      401,
      `Freebuff device-key registration failed (HTTP ${res.status}) (request {requestId}). ${text.slice(0, 200)}`,
      {},
      "upstream",
    );
  }
  const body: unknown = await res.json().catch(() => null);
  const keyId = isRecord(body) && typeof body["keyId"] === "string" ? body["keyId"] : undefined;
  if (!keyId) {
    throw new GatewayError("authentication_failed", 401, "Freebuff device-key registration returned no keyId (request {requestId}).", {}, "upstream");
  }
  const scopeKey = options.accountId ? `user:${options.accountId}` : `token:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  return {
    version: 1,
    publicKey: publicKeyB64,
    privateKey: privateKeyB64,
    keyId: `${scopeKey}|${keyId}`,
    installId: crypto.randomUUID(),
  };
}

// --- Session preflight (admission + agent-runs) ---

export interface FreebuffAdmission {
  instanceId: string;
  admittedRes: Response;
  admittedBody: Record<string, unknown> | null;
}

export interface FreebuffAgentRun {
  readonly runId: string;
}

export interface FreebuffSession {
  readonly admission: FreebuffAdmission;
  readonly agentRun: FreebuffAgentRun;
  readonly instanceId: string;
  readonly runId: string;
  readonly catalogFetchId: string;
  readonly modelHandle: string;
}

function readAuthState(credential: NonNullable<ProviderDispatchContext["credential"]>): FreebuffAuthState {
  const authState = credential.auth_state;
  if (!isRecord(authState)) return {};
  const accountId = typeof authState["accountId"] === "string" ? authState["accountId"] : undefined;
  const deviceRaw = authState["device"];
  if (!isRecord(deviceRaw)) return { accountId };
  const version = deviceRaw["version"];
  const publicKey = deviceRaw["publicKey"];
  const privateKey = deviceRaw["privateKey"];
  const keyId = deviceRaw["keyId"];
  const installId = deviceRaw["installId"];
  if (
    version === 1 &&
    typeof publicKey === "string" &&
    typeof privateKey === "string" &&
    typeof keyId === "string" &&
    typeof installId === "string"
  ) {
    return {
      accountId,
      device: { version: 1, publicKey, privateKey, keyId, installId },
    };
  }
  return { accountId };
}

function resolveInstallId(authState: FreebuffAuthState): string {
  return authState.device?.installId ?? crypto.randomUUID();
}

function resolveAccountId(authState: FreebuffAuthState, token: string): string {
  return authState.accountId ?? `token:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

async function resolveCatalogHandle(
  token: string,
  model: string,
  context: ProviderDispatchContext,
): Promise<{ handle: string; fetchId: string }> {
  const fetchFn = context.outbound_fetch ?? globalThis.fetch;
  const res = await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_MODEL_CATALOG_PATH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      [FREEBUFF_CATALOG_PROTOCOL_HEADER]: FREEBUFF_CATALOG_PROTOCOL_VERSION,
      [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
    },
    signal: context.abort_signal,
  });
  if (!res.ok) {
    throw await mapUpstreamHttpError(res, FREEBUFF_PROVIDER_ID);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) {
    throw new GatewayError("platform_unavailable", 502, "Freebuff catalog returned an invalid body (request {requestId}).", {}, "upstream");
  }
  const fetchId = typeof body["fetchId"] === "string" ? body["fetchId"] : "";
  const rows = body["rows"];
  if (!Array.isArray(rows)) {
    throw new GatewayError("platform_unavailable", 502, "Freebuff catalog returned no rows (request {requestId}).", {}, "upstream");
  }
  // Key match (m-<hex>) first, then legacy-digest, then display-name fragment.
  const requestedKey = model;
  let row: unknown | undefined = rows.find((r) => isRecord(r) && r["key"] === requestedKey);
  if (row === undefined) {
    row = rows.find((r) => isRecord(r) && Array.isArray(r["legacyDigests"]) && (r["legacyDigests"] as unknown[]).some((d) => typeof d === "string" && freebuffLegacyModelDigest(model) === d));
  }
  if (row === undefined) {
    const slug = model.toLowerCase();
    row = rows.find((r) => {
      if (!isRecord(r)) return false;
      const display = typeof r["displayName"] === "string" ? r["displayName"].toLowerCase() : "";
      return display.includes(slug) || slug.includes(display);
    });
  }
  if (!isRecord(row)) {
    throw new GatewayError("invalid_request", 400, `Freebuff catalog has no handle for model ${model} (request {requestId}).`, { providerId: FREEBUFF_PROVIDER_ID });
  }
  const handle = row["handle"];
  if (typeof handle !== "string" || handle.length === 0) {
    throw new GatewayError("invalid_request", 400, `Freebuff catalog row for ${model} has no handle (request {requestId}).`, { providerId: FREEBUFF_PROVIDER_ID });
  }
  return { handle, fetchId };
}

/** FNV-1a digest matching the server's legacy-model digest. */
function freebuffLegacyModelDigest(modelId: string): string {
  const input = `freebuff-legacy-model:${modelId}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

async function freebuffAdmission(
  token: string,
  authState: FreebuffAuthState,
  modelHandle: string,
  catalogFetchId: string,
  context: ProviderDispatchContext,
): Promise<FreebuffAdmission> {
  const fetchFn = context.outbound_fetch ?? globalThis.fetch;
  const instanceId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const installId = resolveInstallId(authState);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    [FREEBUFF_CATALOG_PROTOCOL_HEADER]: FREEBUFF_CATALOG_PROTOCOL_VERSION,
    [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
    [FREEBUFF_TIMEZONE_HEADER]: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [FREEBUFF_FIRST_TAB_DISCOUNT_HEADER]: "0",
    [FREEBUFF_MODEL_HEADER]: modelHandle,
    [FREEBUFF_WALLET_SPEND_LIMIT_HEADER]: "0",
    [FREEBUFF_INSTANCE_HEADER]: instanceId,
    [FREEBUFF_MULTI_SESSION_HEADER]: "1",
    [FREEBUFF_PURCHASE_CONTINUITY_HEADER]: "1",
    [FREEBUFF_DESKTOP_ATTEMPT_HEADER]: attemptId,
    [FREEBUFF_INSTALL_ID_HEADER]: installId,
    "user-agent": FREEBUFF_ADMISSION_USER_AGENT,
  };
  if (catalogFetchId.length > 0) headers[FREEBUFF_CATALOG_FETCH_HEADER] = catalogFetchId;
  if (authState.device) {
    Object.assign(
      headers,
      await freebuffSignRequest(authState.device, {
        method: "POST",
        path: FREEBUFF_SESSION_ADMISSION_PATH,
        fetchId: catalogFetchId,
      }),
    );
  }
  const res = await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_SESSION_ADMISSION_PATH}`, {
    method: "POST",
    headers,
    body: null,
    signal: context.abort_signal,
  });
  const body: unknown = await res.json().catch(() => null);
  return { instanceId, admittedRes: res, admittedBody: isRecord(body) ? body : null };
}

async function freebuffAgentRunStart(
  token: string,
  authState: FreebuffAuthState,
  context: ProviderDispatchContext,
): Promise<FreebuffAgentRun> {
  const fetchFn = context.outbound_fetch ?? globalThis.fetch;
  const body = JSON.stringify({ action: "START", agentId: FREEBUFF_AGENT_RUN_AGENT_ID, ancestorRunIds: [] });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
    "user-agent": FREEBUFF_ADMISSION_USER_AGENT,
  };
  if (authState.accountId) headers[FREEBUFF_ACTING_USER_HEADER] = authState.accountId;
  const res = await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_AGENT_RUNS_PATH}`, {
    method: "POST",
    headers,
    body,
    signal: context.abort_signal,
  });
  if (!res.ok) {
    throw await mapUpstreamHttpError(res, FREEBUFF_PROVIDER_ID);
  }
  const parsed: unknown = await res.json().catch(() => null);
  const runId = isRecord(parsed) && typeof parsed["runId"] === "string" ? parsed["runId"] : undefined;
  if (!runId) {
    throw new GatewayError("platform_unavailable", 502, "Freebuff agent-runs START returned no runId (request {requestId}).", {}, "upstream");
  }
  return { runId };
}

async function freebuffAgentRunFinish(
  token: string,
  authState: FreebuffAuthState,
  runId: string,
  context: ProviderDispatchContext,
): Promise<void> {
  const fetchFn = context.outbound_fetch ?? globalThis.fetch;
  const body = JSON.stringify({
    action: "FINISH",
    runId,
    status: "completed",
    totalSteps: 0,
    directCredits: 0,
    totalCredits: 0,
    steps: [],
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
    "user-agent": FREEBUFF_ADMISSION_USER_AGENT,
  };
  if (authState.accountId) headers[FREEBUFF_ACTING_USER_HEADER] = authState.accountId;
  try {
    await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_AGENT_RUNS_PATH}`, {
      method: "POST",
      headers,
      body,
      signal: context.abort_signal,
    });
  } catch {
    // best-effort teardown
  }
}

async function freebuffReleaseSession(
  token: string,
  authState: FreebuffAuthState,
  instanceId: string,
  catalogFetchId: string,
  context: ProviderDispatchContext,
): Promise<void> {
  const fetchFn = context.outbound_fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
    [FREEBUFF_INSTANCE_HEADER]: instanceId,
    [FREEBUFF_MULTI_SESSION_HEADER]: "1",
    "user-agent": FREEBUFF_ADMISSION_USER_AGENT,
  };
  if (authState.device) {
    Object.assign(
      headers,
      await freebuffSignRequest(authState.device, {
        method: "DELETE",
        path: FREEBUFF_SESSION_PATH,
        fetchId: catalogFetchId,
      }),
    );
  }
  try {
    await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_SESSION_PATH}`, {
      method: "DELETE",
      headers,
      signal: context.abort_signal,
    });
  } catch {
    // best-effort teardown
  }
}

// --- Chat request build ---

function expiresbuffChatBody(
  request: CanonicalRequest,
  payload: Record<string, unknown>,
  session: FreebuffSession,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    freebuff_instance_id: session.instanceId,
    freebuff_multi_session: "1",
    trace_session_id: crypto.randomUUID(),
    repo_snapshot:
      '{"gitAvailable":false,"repositoryVisibility":"unknown","fileCount":0,"fileCountIsLowerBound":false,"testFileCount":0,"changedFileCount":0,"changedFileScanTruncated":false}',
    llm_step_number: "1",
    run_id: session.runId,
    client_id: clientIdOf(request),
    cost_mode: "free",
  };
  const body: Record<string, unknown> = {
    ...payload,
    model: session.modelHandle,
    tools: FREEBUFF_OFFICIAL_TOOLS.map((tool) => JSON.parse(JSON.stringify(tool))),
    tool_choice: "auto",
    stream: true,
    codebuff_metadata: metadata,
    provider: { allow_fallbacks: true },
  };
  // The upstream wants the official worker template as the system message, and
  // the caller's own turns (user/assistant/tool) must survive intact. Prepend
  // the worker as a system message; never overwrite the caller's first message
  // (which is usually the user turn).
  const messages = body["messages"];
  if (Array.isArray(messages)) {
    body["messages"] = [
      { role: "system", content: FREEBUFF_WORKER_SYSTEM_PROMPT },
      ...messages,
    ];
  } else {
    body["messages"] = [{ role: "system", content: FREEBUFF_WORKER_SYSTEM_PROMPT }];
  }
  return body;
}

let clientIdCounter = 0;
function clientIdOf(_request: CanonicalRequest): string {
  // 13-char base36 client id (official SDK shape).
  clientIdCounter = (clientIdCounter + 1) % 36;
  const rand = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 12);
  return rand + clientIdCounter.toString(36);
}

// --- Adapter ---

export function createFreebuffAdapter(): ProviderAdapter {
  return {
    provider_id: FREEBUFF_PROVIDER_ID,

    systemPrompt(): string {
      return FREEBUFF_WORKER_SYSTEM_PROMPT;
    },

    async *dispatch(
      request: CanonicalRequest,
      candidate: ProviderDispatchTarget,
      context: ProviderDispatchContext,
    ): AsyncIterable<CanonicalEvent> {
      const credential = context.credential;
      const secret = credential.secret ? new TextDecoder().decode(credential.secret).trim() : "";
      if (!secret) {
        throw new GatewayError("authentication_failed", 401, "Freebuff credential secret is missing (request {requestId}).", { providerId: FREEBUFF_PROVIDER_ID });
      }
      const authState = readAuthState(credential);
      if (!authState.device) {
        throw new GatewayError("authentication_failed", 401, "Freebuff device identity is missing — sign in again (request {requestId}).", { providerId: FREEBUFF_PROVIDER_ID });
      }

      // 1. Resolve catalog handle + fetchId (ephemeral, per dispatch).
      //    A caller-facing virtual name is translated to its `m-<hex>` roster
      //    key first (see freebuff-virtual.ts); the handle resolution then
      //    works unchanged, in the same vocabulary as the catalog rows.
      const modelId = freebuffDispatchModelId(candidate.model_id || request.model);
      const { handle: modelHandle, fetchId } = await resolveCatalogHandle(secret, modelId, context);

      // 2. Admission.
      const admission = await freebuffAdmission(secret, authState, modelHandle, fetchId, context);
      if (!admission.admittedRes.ok) {
        // A 409 purchase_in_use means a previous session still holds the model.
        // Release it and retry admission once.
        if (admission.admittedRes.status === 409 && admission.admittedBody?.["error"] === "purchase_in_use") {
          const holder = admission.admittedBody?.["currentInstanceId"];
          if (typeof holder === "string") {
            await freebuffReleaseSession(secret, authState, holder, fetchId, context);
            const retry = await freebuffAdmission(secret, authState, modelHandle, fetchId, context);
            if (!retry.admittedRes.ok) throw await mapUpstreamHttpError(retry.admittedRes, FREEBUFF_PROVIDER_ID);
            admission.instanceId = retry.instanceId;
            admission.admittedRes = retry.admittedRes;
            admission.admittedBody = retry.admittedBody;
          }
        } else {
          throw await mapUpstreamHttpError(admission.admittedRes, FREEBUFF_PROVIDER_ID);
        }
      }

      // 3. Agent-runs START.
      const agentRun = await freebuffAgentRunStart(secret, authState, context);
      const session: FreebuffSession = {
        admission,
        agentRun,
        instanceId: admission.instanceId,
        runId: agentRun.runId,
        catalogFetchId: fetchId,
        modelHandle,
      };

      try {
        // 4. Build payload via the standard OpenAI chat encoder.
        const dialectPolicy = resolveDialect(candidate.model_id, candidate.provider_id, candidate.wire_family, candidate.dialect);
        const payload = await encodeWireRequest(candidate.wire_family, request, {
          dialectPolicy,
        });
        const body = expiresbuffChatBody(request, payload, session);

        // 5. Chat headers: desktop identity group + device signature.
        const headers: Record<string, string> = {
          "content-type": "application/json",
          Authorization: `Bearer ${secret}`,
          "user-agent": FREEBUFF_CHAT_USER_AGENT,
          [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
          [FREEBUFF_CLIENT_VERSION_HEADER]: getFreebuffVersion(),
          [FREEBUFF_INSTALL_ID_HEADER]: authState.device.installId,
          [FREEBUFF_ACTING_USER_HEADER]: resolveAccountId(authState, secret),
          [FREEBUFF_CATALOG_FETCH_HEADER]: fetchId,
          [FREEBUFF_SSE_GZIP_RECOVERY_HEADER]: "1",
          ...(await freebuffSignRequest(authState.device, {
            method: "POST",
            path: FREEBUFF_CHAT_COMPLETIONS_PATH,
            body: JSON.stringify(body),
            fetchId,
          })),
        };

        const upstream = await postUpstreamJson(
          `${FREEBUFF_API_HOST}${FREEBUFF_CHAT_COMPLETIONS_PATH}`,
          headers,
          body,
          context,
          context.outbound_fetch ?? globalThis.fetch,
        );
        const res = upstream.res;
        try {
          if (!res.ok) {
            await throwIfHtmlResponse(res);
            throw await mapUpstreamHttpError(res, FREEBUFF_PROVIDER_ID);
          }
          await throwIfHtmlResponse(res);
          const contentType = res.headers.get("content-type") ?? "";
          if (!contentType.includes("text/event-stream")) {
            // Non-SSE body on 2xx — error envelope or protocol violation.
            const raw = await res.text().catch(() => "");
            const parsed: unknown = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
            if (isRecord(parsed) && parsed["error"] !== undefined) {
              throw await mapUpstreamHttpError(new Response(raw, { status: 200, statusText: "OK", headers: { "content-type": "application/json" } }), FREEBUFF_PROVIDER_ID);
            }
            throw new GatewayError("platform_unavailable", 502, "Freebuff chat returned a non-SSE body (request {requestId}).", {}, "upstream");
          }
          if (!res.body) {
            throw new GatewayError("platform_unavailable", 502, "Freebuff chat returned an empty stream (request {requestId}).", {}, "upstream");
          }
          yield* decodeWireStream(candidate.wire_family, res.body, request, {
            signal: context.abort_signal,
            dialectPolicy,
          });
        } finally {
          upstream.release();
        }
      } finally {
        // 6. Teardown.
        await freebuffAgentRunFinish(secret, authState, session.runId, context);
        await freebuffReleaseSession(secret, authState, session.instanceId, fetchId, context);
      }
    },
  };
}
