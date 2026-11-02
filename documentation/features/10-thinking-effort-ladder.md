# Thinking & effort ladder

The **thinking/effort ladder** is the data-driven map from a model (and its
wire family) to the set of reasoning efforts it accepts and the wire field that
carries that effort. It replaces the previous hardcoded `if (modelId.includes(
…))` clamps with a declarative rule table, so adding a new generation is a
table row instead of a new branch in generic code.

A model's reasoning config is captured in a `ThinkingConfig`:

- `mode` — how the effort is transported on the wire:
  - `effort` — OpenAI-style `reasoning_effort` / `reasoning.effort`.
  - `budget` — Anthropic budget-era: `thinking.enabled` + `budget_tokens`
    (plus `output_config.effort`).
  - `anthropic-adaptive` — Claude adaptive-era: `thinking.adaptive` +
    `output_config.effort`.
  - `google-level` — Gemini: the effort sets the thinking/output floor.
- `efforts` — the supported ladder (subset of the canonical ladder, never
  empty).
- `defaultLevel` — the effort used when a caller expresses none (e.g. DeepSeek
  forces `high`).
- `requiresEffort` — true when the upstream rejects off/omitted efforts.

## Canonical ladder

The canonical ladder is `[instant, minimal, low, medium, high, xhigh, max]`,
ordered least to most intensive
(`REASONING_EFFORT_LADDER` in `src/protocol/translation/thinking.ts`).
Provider ladders are subsets of it; `instant` only appears on models that
publish it (Mercury).

## Resolution

`resolveThinkingForModel` (`src/protocol/translation/dialect/thinking-ladder.ts`)
is pure, never throws, and always returns a config. Precedence:

1. **Declared efforts** — `ModelDefinition.reasoningEfforts` or
   `ModelDefinition.thinking` (static catalog). Valid levels are filtered
   against the canonical ladder; an empty filter falls through.
2. **Rule table** — `THINKING_LADDER_RULES`: first matching rule wins. Rules
   can match on wire family, model-id regex, and provider regex; Claude rules
   normalize dots (`claude-opus-4.6` → `-`) to match generations.
3. **Family default** — extended ladder with per-family transport mode
   (`effort` for chat/responses, `budget` for messages, `google-level` for
   Gemini).

Notable entries in the rule table (same semantics as the removed if-chain):

| Model / wire | Supported efforts | Mode |
| --- | --- | --- |
| Responses wire (generic) | `minimal..xhigh` | effort |
| `gpt-5.5` (responses) | `low..xhigh` | effort |
| `gpt-5.6` / `gpt-6` / `daybreak` (responses) | `low..max` | effort |
| `muse` | `minimal..xhigh` | effort |
| `gemini` | `minimal..high` | google-level |
| `mimo-v2.6` | `low, medium, high` | effort |
| `mercury` (chat) | `instant, low, medium, high` | effort |
| Claude `opus-4-6`/`sonnet-4-6` | `low..high` | anthropic-adaptive |
| Claude `fable`/`mythos`/`opus-5`/`sonnet-5`/`opus-4-7`/`opus-4-8` | `low..max` | anthropic-adaptive |
| Claude `opus-4-5`/`sonnet-4-5`/`haiku-4-5`/older | `minimal..xhigh` | budget |
| Default | `minimal..max` | effort |

## Canonical clamp

`clampThinkingLevelForModel` (`src/protocol/translation/dialect/model-thinking.ts`)
is the single clamp every codec uses:

- A requested effort already in the ladder passes through untouched.
- A request above the ladder steps down to the highest supported level at or
  below it (e.g. `max` on Mercury → `high`).
- A request below the floor uses the floor (e.g. `minimal` on `gpt-5.5` →
  `low`), never the top of the ladder.
- Synonyms normalize: `ultra` → `max`, `off` → `none`.
- Unknown strings and `none`/`off` drop (return `undefined`), never inventing a
  fallback.

## Output floor

When the applied effort differs from the requested one, the caller sized
`max_tokens` for the effort it asked for, and the applied level spends part of
that budget on reasoning before writing the answer. `outputFloorFor` raises the
output budget to half the model's catalog limit (floored at 16 384 tokens) so a
clamped request does not truncate. It only ever raises, never lowers, and never
exceeds the model's own limit.

## Codec integration

- The compatible adapter (`OpenAICompatibleAdapter.preparePayload`) resolves the
  config once per dispatch via `resolveThinkingForModel` and passes it as
  `CodecContext.thinking` through `encodeWireRequest`.
- `chat.ts` clamps `reasoning_effort`; Qwen `enable_thinking` still keys off
  the dialect policy's `thinkingFormat`.
- `responses.ts` clamps `reasoning.effort`.
- `messages.ts` uses `mode` to choose the wire thinking shape — `anthropic-adaptive`
  emits `thinking.adaptive` + `output_config.effort`; any other mode emits
  `thinking.enabled` + a `budget_tokens` derived from the level (floored at
  1024). It clamps `output_config.effort` the same way.
- Codecs called directly (outside the adapter) fall back to resolving the config
  from the model/wire, so behavior is identical without context.
- `applyDeepSeekReasoning` uses `DEEPSEEK_DEFAULT_EFFORT` (`high`) when a
  DeepSeek request carries no effort.

## Default off / backward compatible

A request with no declared efforts and no matching rule resolves to the family
default, which reproduces today's exact wire bytes. Golden tests
(`test/protocol/translation/thinking-ladder.test.ts`) assert the payloads stay
identical for the default path. `ModelDefinition.thinking` is optional and
compile-time only — there is **no database migration**; `reasoningEfforts`
remains the persisted source for declared efforts.
