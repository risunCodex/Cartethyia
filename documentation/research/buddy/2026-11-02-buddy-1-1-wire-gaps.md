# CodeBuddy/WorkBuddy — 1:1 wire alignment: remaining gaps

Companion to the 2026-11-02 unpack audits (CLI 2.179.2 and the WorkBuddy
desktop). This note lists every remaining structural difference between what
the gateway's buddy adapters send and what the reference CLI sends, ranked by
evidence. "Verified live" = a probe against the real endpoint (account
`cb-accounts-2026-11-02T06-10-27-996Z.json`) returned the stated status.

## 0. What is already aligned (no action)

| Aspect | State |
|---|---|
| Endpoint | `https://www.codebuddy.ai/v2/chat/completions` (intl) — matches CLI log & route table |
| Auth | `Authorization: Bearer <JWT>` — works (verified live 200) |
| Conversation headers | `x-conversation-id`, `x-conversation-request-id`, `x-conversation-message-id`, `x-request-id` — required, sent |
| Identity headers | `X-User-Id` (JWT `sub`), `X-Domain`, `X-Product`, `X-IDE-*` — match |
| Agent block | `X-Agent-Intent/Type/Runtime` + dynamic `X-Agent-Purpose` — match |
| `X-Custom-Channel-Id` | login-only in the reference, never on chat — correctly absent |
| `reasoning_summary: auto` | injected when effort set (verified live 200) |
| `cache_retention: long` | injected for non-custom chat models (verified live 200) |
| Device/qimei36 | sent on desktop identity only (cbcn/workbuddy/workbuddycn); CLI identity correctly omits |

## 1. Remaining mismatches (by evidence)

| # | Field | Gateway sends | Reference CLI | Evidence | Action |
|---|---|---|---|---|---|
| 1 | `prompt_cache_key` (top-level) | **always** (derived `wb2a-…`) | **never** (`prompt_cache_key` has 0 hits in every bundle: TUI, headless, lite-wb, server) | static scan | **remove** from buddy payload |
| 2 | `thinking: { type: "enabled" }` (body) | **always for deepseek** | not a chat-body field (`thinking` in the bundle is the Anthropic content-block shape only) | static scan + 200 without it | **stop injecting** as a body field; keep DeepSeek replay/`reasoning_content` logic |
| 3 | `reasoning_effort: "high"` default | injected for deepseek when absent | CLI sends effort only when the model settings have it; deepseek `thinkingLevelMap` maps `high→high`, `max→max` (no forced default) | `resolveCacheRetention`-adjacent build; 200 with and without | verify: likely keep only when caller asked; do not force `high` |
| 4 | `X-User-Id` source | JWT `sub` on cb; internal account id on workbuddy/workbuddycn | JWT `sub` / account uid everywhere | live capture | unify to JWT `sub` on all buddy providers |
| 5 | `user-agent` / `X-IDE-*` desktop vs CLI | workbuddy desktop profile sends `WorkBuddy/… workbuddy-ai/… CLI/…` | desktop chat is actually sent by the bundled CLI daemon (UA `CLI/<v> CodeBuddy/<v>`) | WorkBuddy unpack | verify live; likely switch desktop chat to CLI UA |
| 6 | `accept` | CLI `application/json` | reference axios chat uses `application/json` | static | OK (no change) |
| 7 | `thinking` for non-deepseek | injected only for deepseek | n/a | — | OK |

## 2. What the CLI *does* send that we now match

- `cache_retention` (`long` default, `short` with
  `CODEBUDDY_DISABLE_PROMPT_CACHING_1H`).
- `reasoning_summary: auto` when an effort is set and none given.
- Conversation/turning headers (B3, traceparent, request ids).
- `X-Agent-*` envelope + dynamic purpose.

## 3. Recommended change set

1. **Remove `prompt_cache_key`** from `buddyPrePayloadCommon` (and its
   `injectBuddyPromptCacheKey` helper) — top-level prompt-cache key is not part
   of the buddy wire.
2. **Stop injecting `thinking:{type:"enabled"}` as a body field** in
   `applyDeepSeekReasoning`; keep the `reasoning_effort` handling and the
   DeepSeek `reasoning_content` replay backfill (that is a real upstream rule).
3. **Unify `X-User-Id`** to the JWT `sub` (drop the internal account-id
   fallback for buddy providers).
4. (verify) Confirm desktop chat UA on a live capture before changing the
   WorkBuddy desktop profile.

## 4. Notes

- Live probes used `--provider cb --model deepseek-v4.1-flash` and `--model
  auto` (→ `default-model`); both 200.
- The `401` first seen in probes was a missing `Authorization` header in the
  probe harness, not an upstream rejection.
