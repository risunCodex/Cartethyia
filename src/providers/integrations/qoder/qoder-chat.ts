/**
 * Qoder legacy COSY chat builder & transport.
 *
 * `buildQoderRequest` translates one canonical request into the legacy
 * `/algo/.../agent_chat_generation` body (and, by reuse, the messages/tools
 * shared by the IDE and gRPC surfaces). `callQoder` signs and sends it over
 * the COSY surface with the real client's headers (Bun UA, machine identity,
 * `x-model-key/source`, SSE accept).
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  CanonicalRequest,
  ContentPart,
} from "../../../protocol/canonical-model";
import { toolResultParts, toolCallParts } from "../../../protocol/canonical-model";
import { reasoningEffortFromIntent } from "../../../protocol/reasoning";
import { resolveImageSource } from "../../../protocol/codecs";
import { getQoderVersion } from "../../operations/client-versions";
import { qoderDiscoveredMaxContexts, QODER_CN_MODEL_CONFIGS, QODER_INTL_MODEL_CONFIGS } from "./qoder-catalog";
import { transformQoderBody, qoderBuildCosyHeaders } from "./qoder-cosy";
import { qoderSessionId } from "./qoder-auth";
import { flattenCanonicalContent, qoderToolChoice, qoderTools } from "./qoder-body";
import type { QoderRealm } from "./qoder-realm";
import type { QoderAuth, QoderModelConfig } from "./qoder-types";

export interface QoderModeProfile {
  readonly businessProduct: string;
  readonly businessType: string;
  readonly cosyScene: string;
  readonly mirrorTopLevelSystem: boolean;
  readonly sendBusinessHeaders: boolean;
  readonly sendModelSourceHeaders: boolean;
  readonly emptyAliyunUserType: boolean;
}

export const MODERN_PROFILE: QoderModeProfile = {
  businessProduct: "cli",
  businessType: "agent",
  cosyScene: "assistant",
  mirrorTopLevelSystem: true,
  sendBusinessHeaders: true,
  sendModelSourceHeaders: true,
  emptyAliyunUserType: true,
};

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
  const sessionId = qoderSessionId(auth.userId, modelId);
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
    source_session_id: "",
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

type QoderFetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Signs and sends one legacy COSY chat request. The body is alphabet-scrambled
 * before signing; headers come from `qoderBuildCosyHeaders` plus the modern
 * `x-model-key`/`x-model-source` and SSE accepts.
 */
export async function callQoder(
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
