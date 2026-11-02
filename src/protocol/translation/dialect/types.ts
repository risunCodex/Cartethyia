/**
 * Wire dialect layer — the per-provider dial that sits *below* `WireFamily`.
 *
 * `WireFamily` names the transport envelope (chat / responses / messages /
 * gemini). A dialect names the *dial* that family speaks for one provider or
 * model family: DeepSeek's `reasoning_content` + DSML in-band tool calls,
 * Qwen's `enable_thinking` + `<tool_call>` chat template, Anthropic's native
 * Messages vocabulary, and the generic OpenAI-compatible default.
 *
 * The split matters because "canonical forces everything through one general
 * shape" is what made the pipeline fragile: quirks unique to a family
 * (reasoning field names, system-message cardinality, tool_choice support,
 * in-band tool markup) had nowhere to live except ad-hoc `if (providerId ===
 * …)` branches inside generic codecs. Here they are a resolved policy object
 * the codecs read, exactly like oh-my-pi's `OpenAICompatPolicy`.
 */

/** A wire dialect. `"openai"`/`"anthropic"` are the generic defaults for each
 *  `WireFamily`; the rest are family-specific dialects. */
export type DialectId =
  | "openai" // OpenAI-compatible generik (default wire chat)
  | "anthropic" // Anthropic-compatible/ Claude-native dialect: signature thinking, cache-control
  | "deepseek" // DSML + reasoning_content + max_tokens + strip tokens
  | "qwen" // enable_thinking + <tool_call> + strict chat template
  | "kimi"
  | "glm"
  | "minimax"
  | "gemini"; // extensibel

/** Resolved policy consumed by the wire codecs. Every field has a safe
 *  default matching today's behavior; absent values fall back to it. */
export interface DialectPolicy {
  /** Which wire field carries a previous assistant turn's reasoning. None when
   *  the wire has no reasoning side-channel (e.g. strict non-reasoning
   *  upstreams that reject the extra field). Default `"reasoning_content"` —
   *  the Chat wire's side channel, matching current behavior. */
  readonly reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
  /** Which token-limit field the upstream accepts. Default `"max_tokens"`. */
  readonly maxTokensField: "max_tokens" | "max_completion_tokens";
  /** When truthy, strip the named family's special tokens from the stream. */
  readonly stripSpecialTokens: "deepseek" | false;
  /** False collapses multiple `system` messages into one (strict chat templates,
   *  e.g. Qwen Portal / Alibaba / MiniMax). */
  readonly supportsMultipleSystemMessages: boolean;
  /** False drops `tool_choice` entirely (DeepSeek rejects it). */
  readonly supportsToolChoice: boolean;
  /** True requires every tool-call assistant turn to also carry text content
   *  (DeepSeek V4 validates the exact content). */
  readonly requiresAssistantContentForToolCalls: boolean;
  /** False rejects synthetic reasoning placeholders on a tool-call turn
   *  (DeepSeek V4 validates the exact value). */
  readonly allowsSyntheticReasoningContent: boolean;
  /** How a reasoning effort is encoded on the wire. */
  readonly thinkingFormat: "openai" | "qwen" | "deepseek" | "chat-template";
  /** In-band tool-call codec to use (DSML / `<tool_call>` …), or null for
   *  structured-only tool calls. */
  readonly inband: DialectId | null;
}
