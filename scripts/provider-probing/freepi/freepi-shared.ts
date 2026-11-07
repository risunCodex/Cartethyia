/**
 * Free-pi upstream wire helpers for probe scripts.
 *
 * Source of truth: the shipped bundle (free-pi-cli 0.6.14,
 * `package/dist/main-j1ey9ghj.js`). The client talks to
 * `https://api.freepi.ai` and uses:
 *
 *   - POST /auth/github/device  {}                    -> GithubDeviceResponseSchema
 *   - POST /auth/consent       { session_id, consent_version, ... }
 *   - POST /auth/token         { session_id, poll_secret? } -> pending/issued
 *   - POST /auth/guest         { consent_version, client, ... } -> guest token
 *   - GET  /client-version     (Bearer optional, x-freepi-cost-exp: 1)
 *   - GET  /me                (Bearer)
 *   - POST /v1/chat/completions (Bearer, x-client-version) — openai-completions
 *
 * Tokens are never printed by these helpers; callers own masking.
 */

import { maskSecret } from "../lib/accounts";

/** Default backend base URL, matching FREEPI_BASE_URL. */
export const FREEPI_BASE_URL = process.env.FREEPI_BASE_URL?.trim().replace(/\/$/, "") ?? "https://api.freepi.ai";

/** Consent version shipped in 0.6.14. */
export const FREEPI_CONSENT_VERSION = "4";

/** CLI version the probes speak, reported via `x-client-version`. */
export const FREEPI_CLI_VERSION = "0.6.14";

/** Header carrying the cost-experiment arm; the client sends `1` on /client-version. */
export const FREEPI_COST_EXP_HEADER = "x-freepi-cost-exp";

/** Header the client sends on /auth/connect/start. */
export const FREEPI_SIGNIN_EXP_HEADER = "x-freepi-signin-exp";

export const FREEPI_CONTEXT_WINDOW = 200_000;
export const FREEPI_MAX_OUTPUT_TOKENS = 8192;
export const FREEPI_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

/** One parsed SSE frame. */
export interface FreepiSseFrame {
  readonly event: string;
  readonly data: unknown;
}

/** Parses an SSE text body into frames (mirrors the adapter's parser). */
export function parseFreepiSse(text: string): FreepiSseFrame[] {
  const frames: FreepiSseFrame[] = [];
  let event = "message";
  let data: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") {
      if (data.length > 0) {
        const payload = data.join("\n");
        data = [];
        if (payload.trim() === "[DONE]") {
          frames.push({ event: "done", data: { finish_reason: "stop" } });
        } else {
          let parsed: unknown = payload;
          try {
            parsed = JSON.parse(payload);
          } catch {
            parsed = payload;
          }
          frames.push({ event, data: parsed });
        }
        event = "message";
      }
      continue;
    }
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "" && line.startsWith("data")) data.push(line.slice(4).replace(/^ /, ""));
  }
  if (data.length > 0) {
    const payload = data.join("\n");
    if (payload.trim() === "[DONE]") {
      frames.push({ event: "done", data: { finish_reason: "stop" } });
    } else {
      let parsed: unknown = payload;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = payload;
      }
      frames.push({ event, data: parsed });
    }
  }
  return frames;
}

function jsonHeaders(jwt?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
  };
}

/** POST JSON, returning the Response. Never retries — callers decide. */
export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  jwt?: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { ...jsonHeaders(jwt), ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** GET JSON, returning the Response. */
export async function getJson(
  baseUrl: string,
  path: string,
  jwt?: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "GET",
    headers: { ...jsonHeaders(jwt), ...extraHeaders },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Device-flow start: POST /auth/github/device. */
export async function startDeviceFlow(baseUrl: string): Promise<{
  readonly session_id: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly interval: number;
  readonly expires_in?: number;
}> {
  const res = await postJson(baseUrl, "/auth/github/device", {});
  if (!res.ok) {
    throw new Error(`device flow start failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    session_id: String(body["session_id"] ?? ""),
    user_code: String(body["user_code"] ?? ""),
    verification_uri: String(body["verification_uri"] ?? ""),
    ...(typeof body["verification_uri_complete"] === "string" ? { verification_uri_complete: body["verification_uri_complete"] as string } : {}),
    interval: Number(body["interval"] ?? 5),
    ...(typeof body["expires_in"] === "number" ? { expires_in: body["expires_in"] as number } : {}),
  };
}

/** Consent submission: POST /auth/consent. */
export async function submitConsent(
  baseUrl: string,
  sessionId: string,
  consentVersion = FREEPI_CONSENT_VERSION,
): Promise<void> {
  const res = await postJson(baseUrl, "/auth/consent", { session_id: sessionId, consent_version: consentVersion });
  if (!res.ok) {
    throw new Error(`consent submission failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
}

/** Token poll: POST /auth/token until issued / timeout. */
export async function pollDeviceToken(
  baseUrl: string,
  sessionId: string,
  opts: { readonly intervalMs?: number; readonly deadlineMs?: number; readonly onPending?: (body: Record<string, unknown>) => void } = {},
): Promise<string> {
  const intervalMs = opts.intervalMs ?? 5000;
  const deadline = opts.deadlineMs ?? 300_000;
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > deadline) throw new Error("token poll timed out");
    const res = await postJson(baseUrl, "/auth/token", { session_id: sessionId });
    if (!res.ok) {
      throw new Error(`token poll failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (body["code"] === "consent_required") throw new Error("token poll: consent_required");
    if (typeof body["token"] === "string" && body["token"]!.length > 0) return body["token"]!;
    opts.onPending?.(body);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Guest start: POST /auth/guest. Throws on refusal. */
export async function startGuestSession(
  baseUrl: string,
  consentVersion = FREEPI_CONSENT_VERSION,
): Promise<{ readonly token: string; readonly allowance_usd: string; readonly remaining_usd: string }> {
  const res = await postJson(baseUrl, "/auth/guest", {
    consent_version: consentVersion,
    client: { os: process.platform, cli_version: FREEPI_CLI_VERSION },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`guest start failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const token = String(body["token"] ?? "");
  if (!token) throw new Error("guest start returned no token");
  return {
    token,
    allowance_usd: String(body["allowance_usd"] ?? ""),
    remaining_usd: String(body["remaining_usd"] ?? ""),
  };
}

/** GET /client-version; returns raw JSON or null on failure. */
export async function fetchClientVersion(
  baseUrl: string,
  jwt?: string,
): Promise<Record<string, unknown> | null> {
  const res = await getJson(baseUrl, "/client-version", jwt, { [FREEPI_COST_EXP_HEADER]: "1" });
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return body;
  } catch {
    return null;
  }
}

/** GET /me; returns raw JSON or null on failure. */
export async function fetchMe(baseUrl: string, jwt: string): Promise<Record<string, unknown> | null> {
  const res = await getJson(baseUrl, "/me", jwt);
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** One chat completion; returns a one-line verdict + details. */
export interface FreepiChatOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly events: readonly string[];
  readonly error: string;
  readonly result: string;
  readonly raw: string;
}

export async function chatCompletion(
  baseUrl: string,
  jwt: string,
  model: string,
  message: string,
  opts: { readonly stream?: boolean; readonly maxTokens?: number; readonly timeoutMs?: number } = {},
): Promise<FreepiChatOutcome> {
  const stream = opts.stream ?? true;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: message }],
    stream,
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
  };
  const completionsUrl = `${baseUrl}/v1`;
  const res = await fetch(`${completionsUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "x-client-version": FREEPI_CLI_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  const events: string[] = [];
  const resolved: string[] = [];
  let error = "";
  if (stream && res.ok) {
    for (const frame of parseFreepiSse(text)) {
      events.push(frame.event);
      const data = frame.data;
      if (typeof data !== "object" || data === null) continue;
      const record = data as Record<string, unknown>;
      if (frame.event === "error") {
        error = `code=${String(record["code"] ?? "?")} ${String(record["message"] ?? "")}`.trim();
      }
      if (frame.event === "message") {
        const choices = Array.isArray(record["choices"]) ? (record["choices"] as Record<string, unknown>[]) : [];
        const delta = choices[0]?.["delta"] as Record<string, unknown> | undefined;
        if (typeof delta?.["content"] === "string" && String(delta["content"]).length > 0) {
          resolved.push(`text="${String(delta["content"]).slice(0, 60)}"`);
        }
        if (typeof record["model"] === "string") resolved.push(`model=${String(record["model"])}`);
      }
      if (frame.event === "chunk" && typeof record["model"] === "string") resolved.push(String(record["model"]));
      if (frame.event === "done") {
        const usage = record["usage"];
        if (typeof usage === "object" && usage !== null) {
          const u = usage as Record<string, unknown>;
          resolved.push(`usage total=${String(u["total_tokens"] ?? "?")}`);
        }
      }
    }
  } else {
    events.push(`http=${res.status}`);
    if (!res.ok) error = text.slice(0, 300);
    else {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const choice = Array.isArray(parsed["choices"]) ? (parsed["choices"] as Record<string, unknown>[])[0] : undefined;
        const msg = choice?.["message"] as Record<string, unknown> | undefined;
        const content = typeof msg?.["content"] === "string" ? (msg["content"] as string) : "";
        if (content) resolved.push(`text="${content.slice(0, 60)}"`);
        if (typeof parsed["model"] === "string") resolved.push(`model=${String(parsed["model"])}`);
      } catch {
        /* keepalive */
      }
    }
  }
  const uniq = [...new Set(events)];
  const ok =
    res.ok &&
    !error &&
    (uniq.some((e) => e === "chunk" || e === "output" || e === "timing_cost" || e === "token_usage" || e === "done") ||
      resolved.length > 0);
  return { ok, status: res.status, events: uniq, error, result: [...new Set(resolved)].join(" | "), raw: text };
}

/** Mask shorthand so probe output never leaks a token. */
export function maskJwt(jwt: string): string {
  return maskSecret(jwt, 6);
}
