# Wire dialects

A **wire dialect** is the provider-specific *dial* that a wire family speaks for
one model or provider family. It sits below the wire family and lets the codecs
encode/decode provider-specific behavior without scattering
`if (providerId === …)` branches through generic code.

A wire family (`chat`, `responses`, `messages`, `gemini`) names the transport
envelope. A dialect names how that envelope is spoken for a particular family of
models: DeepSeek's `reasoning_content` + DSML in-band tool calls, Qwen's
`enable_thinking` + `<tool_call>` chat template, and the generic OpenAI- /
Anthropic-compatible defaults.

## Data

| Column | Table | Holds |
| --- | --- | --- |
| `dialect` | `models` | Explicit dialect id for a model row, nullable. Absent = resolver fallback. |

Migration `0040_add_models_dialect.sql` adds the column (lite + full). `NULL`
means the resolver decides — the safe default.

## Resolution

`resolveDialect` (`src/protocol/translation/dialect/resolver.ts`) is pure, never
throws, and always returns a policy. Precedence:

1. **DB override** — `models.dialect` (wins when set).
2. **`ModelDefinition.dialect`** — explicit static catalog declaration.
3. **Heuristic rules** — `DIALECT_RULES` (`rules.ts`): provider/model-id based,
   declarative, mirroring `quirks.ts`.
4. **Family default** — `anthropic` for the `messages` wire, `openai`
   otherwise.

An unknown dialect id (e.g. from a future DB row) falls back to the family
default — never throws, never invents behavior.

## Policies

`DialectPolicy` (`src/protocol/translation/dialect/types.ts`) is the resolved
knob set the codecs read:

- `reasoningContentField` — which wire field carries previous-turn reasoning
  (`reasoning_content` for DeepSeek/chat).
- `maxTokensField` — `max_tokens` vs `max_completion_tokens`.
- `stripSpecialTokens` — `"deepseek"` strips DSML/special tokens from streams.
- `supportsMultipleSystemMessages` — false collapes multiple `system` messages
  into one (strict chat templates: Qwen Portal / Alibaba / MiniMax).
- `supportsToolChoice` — false drops `tool_choice` (DeepSeek rejects it).
- `requiresAssistantContentForToolCalls` — true requires text content on a
  tool-call assistant turn (DeepSeek V4).
- `allowsSyntheticReasoningContent` — false rejects synthetic reasoning
  placeholders (DeepSeek V4).
- `thinkingFormat` — `openai` | `qwen` | `deepseek` | `chat-template`.
- `inband` — which in-band tool-call scanner to use (`deepseek` DSML, `qwen`
  `<tool_call>`), or null for structured-only.

Default policies are frozen to today's behavior: a request with no dialect set
encodes byte-identically to before this layer existed.

## Codec integration

- `src/protocol/request/chat.ts` reads the policy for reasoning field, token
  limit field, tool_choice, system-message cardinality, tool-call content, and
  Qwen `enable_thinking`.
- `src/protocol/request/messages.ts` reads `supportsToolChoice`.
- `src/protocol/response/chat.ts` selects the in-band scanner by `inband`
  (Qwen `<tool_call>` JSON vs DSML).
- The compatible adapter (`compatible-adapter.ts`) resolves the dialect from the
  route candidate and passes it through `encodeWireRequest` / `decodeWireStream`.

## Flow

```
models.dialect (0040) → RouteCandidate.dialect
                              │
OpenAICompatibleAdapter.preparePayload
   policy = resolveDialect(model_id, provider_id, wire_family, dialect)
   encodeWireRequest(wireFamily, request, { ...context, dialectPolicy: policy })
```

## Default off / backward compatible

Without a dialect set or resolved, the policy equals today's behavior (`openai`
/ `anthropic`). Nothing changes for an existing install until a model row sets a
dialect or the heuristic rules match it. `ModelDefinition.dialect` is optional;
the resolver only guesses when no override exists.

## Provider notes

- **DeepSeek** — `reasoning_content`, `max_tokens`, no `tool_choice`, DSML
  in-band tool calls, requires assistant content for tool-call turns, rejects
  synthetic reasoning placeholders.
- **Qwen** — `enable_thinking` + `thinking_budget`, `<tool_call>` in-band,
  single system message (strict chat template).
- **Anthropic / Claude** — the `messages` family default; signature thinking,
  cache-control handled by the native codec.
