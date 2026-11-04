/**
 * Shared helpers for Qoder probe scripts.
 *
 * Consolidates the code that used to be copy-pasted across every probe:
 * machine identity, IDE chat headers, chat body builders, the account loader,
 * the SSE reader, and a redacting printer. One source of truth, strict TS, no
 * `any`.
 *
 * Upstream hosts below are the ones the probes were verified against live
 * (2026-11-04). The gateway's canonical per-realm constants live in
 * `src/providers/integrations/qoder/qoder-realm.ts`; these literals keep the
 * exact hosts the probes proved (legacy COSY on `api2.qoder.sh`, IDE on
 * `api2-v2.qoder.sh`, control plane on `openapi.qoder.sh`). Note the model-list
 * endpoint is reachable on both `api2` and `openapi` — the discrepancy is
 * documented, not silently resolved.
 */
import { createHash, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
  type ExportedAccount,
} from "../../lib/accounts";
import type { QoderProbeAuth } from "../cosy-signer";

/** Single source for the probe client version (was 9 literals, 2 values). */
export const QODER_VERSION = "1.1.81";

export const QODER_IDE_CHAT_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";
export const QODER_LEGACY_CHAT_URL =
  "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
export const QODER_MODEL_LIST_URL = "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1";
export const QODER_OPENAPI_BASE = "https://openapi.qoder.sh";

/** Machine OS token as the upstream expects it (`aarch64_macos`, `x86_64_linux`, …). */
export function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}

/** Safe machine hostname, normalized to the IDE's header-safe form. */
export function machineHostname(): string {
  const raw = (osHostname() ?? "").trim().toLowerCase();
  const safe = raw
    .replace(/[^\x21-\x7e]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (safe.length <= 96) return safe;
  return `${safe.slice(0, 87)}-${createHash("sha256").update(safe).digest("hex").slice(0, 8)}`;
}

/** Builds the `QoderProbeAuth` identity for one account. */
export function authFromAccount(account: ExportedAccount): QoderProbeAuth {
  return {
    userId: account.authState?.userId ?? "",
    userName: account.label ?? "",
    userType: "personal_standard",
    securityOauthToken: requireAccountToken(account),
    refreshToken: "",
  };
}

/** Result bag for the shared account loader. */
export interface LoadedProbeAccount {
  readonly account: ExportedAccount;
  readonly token: string;
  readonly userId: string;
  readonly machineId: string;
  readonly auth: QoderProbeAuth;
}

/**
 * Loads the account from `--creds` and derives everything a probe needs.
 * Replaces the 14 near-identical account-loading sequences.
 */
export function loadProbeAccount(values: {
  readonly creds?: string;
  readonly label?: string;
  readonly index?: string;
  readonly providerId?: string;
}): LoadedProbeAccount {
  const creds = values.creds;
  if (creds === undefined) throw new Error("--creds <path> is required");
  const accounts = readAccountsFile(creds);
  const account = pickAccount(accounts, {
    ...(values.providerId !== undefined ? { providerId: values.providerId } : {}),
    ...(values.label !== undefined ? { label: values.label } : {}),
    ...(values.index !== undefined ? { index: Number(values.index) } : {}),
  });
  const token = requireAccountToken(account);
  const userId = account.authState?.userId ?? "";
  const machineId =
    account.authState?.machineId && account.authState.machineId.length > 0
      ? account.authState.machineId
      : randomUUID();
  return { account, token, userId, machineId, auth: authFromAccount(account) };
}

/** Full IDE `/model/v1` header set (machine-id tripled only when provided). */
export function ideChatHeaders(opts: {
  readonly token: string;
  readonly version?: string;
  readonly machineId?: string;
  readonly hostname?: string;
  readonly os?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
}): Record<string, string> {
  const version = opts.version ?? QODER_VERSION;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": opts.requestId ?? randomUUID(),
    "X-Session-ID": opts.sessionId ?? randomUUID(),
    "Cosy-Version": version,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": opts.os ?? machineOs(),
    "Cosy-MachineHostname": opts.hostname ?? machineHostname(),
  };
  if (opts.machineId !== undefined) {
    headers["Cosy-MachineId"] = opts.machineId;
    headers["Cosy-MachineToken"] = opts.machineId;
    headers["Cosy-MachineType"] = "5";
  }
  return headers;
}

/**
 * Builds the legacy COSY `agent_chat_generation` body — the shape the native
 * client sends. Returns the wrapped `{ body, rid }` pair the caller needs for
 * signing and tracing.
 */
export function buildLegacyChatBody(opts: {
  readonly model: string;
  readonly userId: string;
  readonly text?: string;
  readonly isReasoning?: boolean;
  readonly displayName?: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}): { readonly body: Record<string, unknown>; readonly rid: string } {
  const rid = randomUUID();
  const text = opts.text ?? "ping";
  const isReasoning = opts.isReasoning ?? true;
  const sessionId = createHash("sha256").update(`qoder-session:${opts.userId}:${opts.model}`).digest("hex").slice(0, 32);
  return {
    body: {
      request_id: rid,
      request_set_id: rid,
      chat_record_id: rid,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: { context: [], modelConfig: { key: opts.model, is_reasoning: isReasoning }, originalContent: { text } },
        features: [],
        text: { text },
      },
      model_config: {
        key: opts.model,
        display_name: opts.displayName ?? "Qwen3.8-Flash",
        format: "openai",
        model: "",
        api_key: "",
        url: "",
        is_vl: true,
        is_reasoning: isReasoning,
        max_input_tokens: opts.maxInputTokens ?? 180000,
        max_output_tokens: opts.maxOutputTokens ?? 65536,
        source: "system",
      },
      messages: [{ role: "user", content: text }],
      max_tokens: 256,
      tools: [],
      parallel_tool_calls: true,
    },
    rid,
  };
}

/** Builds the modern IDE `/model/v1` chat body. Returns `{ body, rid, sid }`. */
export function buildIdeChatBody(opts: {
  readonly model: string;
  readonly version?: string;
  readonly message?: string;
  readonly maxTokens?: number;
  readonly contextTokens?: number;
  readonly outputTokens?: number;
}): { readonly body: Record<string, unknown>; readonly rid: string; readonly sid: string } {
  const rid = randomUUID();
  const sid = randomUUID();
  const version = opts.version ?? QODER_VERSION;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [{ role: "user", content: opts.message ?? "ping" }],
    stream: true,
    stream_options: { include_usage: true },
    metadata: {
      context: {
        request_id: rid,
        request_set_id: randomUUID(),
        session_id: sid,
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
    max_tokens: opts.maxTokens ?? 16,
  };
  if (opts.contextTokens !== undefined || opts.outputTokens !== undefined) {
    const config: Record<string, unknown> = {};
    if (opts.contextTokens !== undefined) config.max_input_tokens = opts.contextTokens;
    if (opts.outputTokens !== undefined) config.max_output_tokens = opts.outputTokens;
    body.model_config = config;
  }
  return { body, rid, sid };
}

/** Handlers for {@link readSse}. */
export interface SseHandlers {
  onDelta?(text: string): void;
  onReasoning?(text: string): void;
  onModel?(model: string): void;
  onFrame?(frame: Record<string, unknown>): void;
  onError?(error: unknown): void;
  onDone?(): void;
  maxFrames?: number;
}

/**
 * Reads an SSE stream frame by frame. Handles the OpenAI-shaped `data:` JSON
 * (`choices[].delta.content|reasoning_content`, `model`, `error`, `[DONE]`).
 * Cancels the reader when done.
 */
export async function readSse(
  response: Response,
  handlers: SseHandlers,
): Promise<{ readonly frames: number; readonly stopped: boolean }> {
  const maxFrames = handlers.maxFrames ?? 60;
  const reader = response.body?.getReader();
  if (!reader) return { frames: 0, stopped: false };
  const decoder = new TextDecoder();
  let buf = "";
  let frames = 0;
  let stopped = false;
  try {
    while (frames < maxFrames) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        frames += 1;
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            stopped = true;
            continue;
          }
          try {
            const json = JSON.parse(data) as {
              model?: string;
              choices?: Array<{
                delta?: { content?: string; reasoning_content?: string };
                finish_reason?: string | null;
              }>;
              error?: unknown;
            };
            if (json.error !== undefined) {
              handlers.onError?.(json.error);
              stopped = true;
              continue;
            }
            const frame = json as unknown as Record<string, unknown>;
            handlers.onFrame?.(frame);
            if (typeof json.model === "string") handlers.onModel?.(json.model);
            const delta = json.choices?.[0]?.delta;
            if (delta) {
              if (typeof delta.content === "string") handlers.onDelta?.(delta.content);
              if (typeof delta.reasoning_content === "string") handlers.onReasoning?.(delta.reasoning_content);
            }
            if (json.choices?.[0]?.finish_reason) stopped = true;
          } catch {
            // not JSON — ignore non-data lines
          }
        }
        idx = buf.indexOf("\n\n");
      }
      if (stopped) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { frames, stopped };
}

/** Recursive printer that never shows token/secret/key/credential fields. */
export function summarizeRedacted(value: unknown, depth = 0): string {
  if (depth > 2) return "…";
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    return `[${value.slice(0, 5).map((x) => summarizeRedacted(x, depth + 1)).join(", ")}${value.length > 5 ? ", …" : ""}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !/token|secret|key|credential/i.test(k))
      .map(([k, v]) => `${k}:${summarizeRedacted(v, depth + 1)}`);
    return `{${entries.slice(0, 12).join(", ")}${entries.length > 12 ? ", …" : ""}}`;
  }
  return JSON.stringify(value);
}
