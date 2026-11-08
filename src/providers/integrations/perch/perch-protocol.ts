// Perch wire protocol (pure HTTP, reverse-engineered from the official CLI).
//
// The hosted inference surface is `POST /api/perch-terminal/model-call`. The
// server surface-gates the call: it only accepts requests that carry the full
// CLI turn envelope — a fresh turn ticket minted with `{surface:"cli"}`,
// the Roost tier choice (`roostModelChoice`), the account attribution, and
// the Saffron system-prompt prefix (the server fingerprints it). Without that
// prompt the upstream answers `403 perch_surface_required` even with a valid
// token and ticket (verified live 2026-11-08).
//
// The stream is plain SSE with JSON frames:
//   data: {"type":"keepalive"}
//   data: {"type":"answer_delta","text":"..."}
//   data: {"type":"done","ok":true,"text":"...","model":"...","usage":{...}}
//   data: {"type":"model_call_failed",...}
//   data: {"type":"error","message":"..."}

import type { CanonicalRequest } from "../../../protocol/canonical-model";
// The prompt lives in a plain TS module: Bun's standalone binary has no
// `saffron-system-prompt.txt` asset on disk, so a readFileSync()-backed
// constant silently became a two-line stub in the compiled binary and the
// upstream answered `403 perch_surface_required`.
export { PERCH_SAFFRON_SYSTEM_PROMPT } from "./perch-system-prompt";
import { PERCH_SAFFRON_SYSTEM_PROMPT } from "./perch-system-prompt";

/** Default hosted model id when the account endpoint is unreachable. */
export const PERCH_DEFAULT_CHAT_MODEL = "wandb-kimi-k2-6";

/** App origin (model-call + ticket + account + plan endpoints). */
export const PERCH_APP_URL = "https://app.perchai.app";

/** The CLI user-agent the upstream recognizes as a CLI surface. */
export const PERCH_CLI_USER_AGENT = "perchai-cli/unknown";

export interface PerchTurnContext {
  readonly userId: string | null;
  readonly workspaceId: string | null;
  readonly orgId: string | null;
  readonly planCode: string | null;
  readonly runId: string;
}

/**
 * Builds the model-call body for one turn. The Saffron system-prompt prefix
 * opens `request.messages` (required) and the caller's conversation follows.
 * The tier is selected through `roostModelChoice` (`standard` | `standard 1m`).
 */
export function buildPerchModelCallBody(
  request: CanonicalRequest,
  tier: string,
  ctx: PerchTurnContext,
  preferredModelId = PERCH_DEFAULT_CHAT_MODEL,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const systemParts = [
    ...(request.system ?? []),
    ...(request.instructions ?? []),
  ];
  const systemText = systemParts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
  // The upstream fingerprints the *prefix* of the Saffron prompt, not the
  // whole string (both the 28k original and this 432-char prefix answer 200,
  // while a plain assistant placeholder answers 403). Keep Saffron as the
  // opener unconditionally: a caller-supplied system turn is appended, never
  // substituted, so live traffic cannot strip the surface identity. The probe
  // path injects exactly this prefix via `systemPrompt()`, hence `startsWith`
  // is a no-op there and the wire body stays byte-identical to the verified one.
  const systemContent = systemText.startsWith(PERCH_SAFFRON_SYSTEM_PROMPT)
    ? systemText
    : systemText
      ? `${PERCH_SAFFRON_SYSTEM_PROMPT}\n\n${systemText}`
      : PERCH_SAFFRON_SYSTEM_PROMPT;
  messages.push({ role: "system", content: systemContent });
  for (const message of request.messages) {
    const text = message.content
      .map((part) => (part.kind === "text" ? part.text : ""))
      .filter((t) => t.trim().length > 0)
      .join("\n");
    if (!text) continue;
    messages.push({ role: message.role, content: text });
  }
  const maxTokens =
    request.generation_controls.max_tokens ??
    request.generation_controls.max_output_tokens ??
    request.generation_controls.max_completion_tokens ??
    32000;
  const temperature = request.generation_controls.temperature ?? 0.6;
  const runId = ctx.runId;
  return {
    request: {
      messages,
      temperature,
      maxTokens: Number(maxTokens) || 32000,
    },
    runId,
    lane: "chat",
    strictManual: false,
    preferredModelId,
    avoidModelIds: [],
    attribution: {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      runId,
      lane: "chat",
      source: "cli",
      billingMultiplier: null,
    },
    clientSurface: "cli",
    resendAfterOutput: true,
    roostModelChoice: tier,
    roostReasoning: true,
    effort: { level: "high", orchestration: false },
  };
}

export interface PerchModelCallDone {
  readonly ok: boolean;
  readonly text: string;
  readonly model: string;
  readonly provider: string;
  readonly usage?: Record<string, unknown>;
  readonly error?: string;
  readonly errorCode?: string;
}

export interface PerchSseEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** Parses an SSE body into JSON frames. */
export function parsePerchSse(text: string): PerchSseEvent[] {
  const events: PerchSseEvent[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      if (typeof data["type"] === "string") {
        events.push({ type: data["type"] as string, data });
      }
    } catch {
      // Ignore non-JSON frames.
    }
  }
  return events;
}

/** Extracts the final result from a completed stream. */
export function summarizePerchStream(events: readonly PerchSseEvent[]): PerchModelCallDone {
  let text = "";
  let ok = false;
  let model = "";
  let provider = "";
  let usage: Record<string, unknown> | undefined;
  let error: string | undefined;
  let errorCode: string | undefined;

  for (const event of events) {
    const d = event.data;
    if (event.type === "answer_delta" && typeof d["text"] === "string") {
      text += d["text"];
    } else if (event.type === "reasoning_delta" && typeof d["text"] === "string") {
      // Reasoning text is not part of the visible answer.
      void d;
    } else if (event.type === "done") {
      ok = d["ok"] === true;
      if (ok) {
        if (typeof d["text"] === "string") text = d["text"];
        if (typeof d["model"] === "string") model = d["model"];
        if (typeof d["provider"] === "string") provider = d["provider"];
        const usageRaw = d["usage"];
        if (usageRaw && typeof usageRaw === "object") {
          usage = usageRaw as Record<string, unknown>;
        }
      } else {
        if (typeof d["error"] === "string") error = d["error"];
        if (typeof d["errorCode"] === "string") errorCode = d["errorCode"];
      }
    } else if (event.type === "model_call_failed" || event.type === "error") {
      if (error === undefined && typeof d["error"] === "string") error = d["error"];
      if (errorCode === undefined && typeof d["errorCode"] === "string") errorCode = d["errorCode"];
      if (errorCode === undefined && typeof d["code"] === "string") errorCode = d["code"] as string;
    }
  }
  return { ok: ok || text.length > 0, text, model, provider, ...(usage ? { usage } : {}), ...(error ? { error } : {}), ...(errorCode ? { errorCode } : {}) };
}

/** Renders a canonical message list into a debug label (for capture). */
export function summarizeMessages(request: CanonicalRequest): string {
  return request.messages
    .map((m) => `${m.role}:${m.content.map((p) => (p.kind === "text" ? p.text.length : 0)).reduce((a, b) => a + b, 0)}`)
    .join("|");
}
