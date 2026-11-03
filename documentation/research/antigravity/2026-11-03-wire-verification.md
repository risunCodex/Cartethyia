# Antigravity wire verification — live probes (2026-11-03)

Ground-truth from live `daily-cloudcode-pa.googleapis.com` probes using an
exported account (`thehertaborneo@gmail.com`, free tier). Worked from the
unpacked IDE 2.6.0 (`cloudCodeMainService.js`) and the Cartethyia adapter.

## Control-plane

### loadCodeAssist
- Reference wire: `POST /v1internal:loadCodeAssist` body
  `{ metadata: { ideName: "antigravity", ideType: "ANTIGRAVITY",
  ideVersion: "2.6.0" } }` (reference UA `antigravity/2.6.0 windows amd64`).
- Result: **200** `{ currentTier: { id: "free-tier", ... } }`.
- Project resolved: `aicode-consumers` (`cloudaicompanionProject`).
- **Project is MANDATORY downstream**: without it, chat and quota endpoints
  return 403 "You do not have a valid license of this product".

### fetchAvailableModels
- `POST /v1internal:fetchAvailableModels` body `{ project }` → **200**.
- Full roster (19 rows) captured to
  `D:\tmp\scratch\antigravity\live-models.json`.

| wire id | display | model_enum | ctx | out |
|---|---|---|---|---|
| claude-sonnet-4-6 | Claude Sonnet 4.6 (Thinking) | MODEL_PLACEHOLDER_M35 | 250000 | 64000 |
| claude-opus-4-6-thinking | Claude Opus 4.6 (Thinking) | MODEL_PLACEHOLDER_M26 | 250000 | 64000 |
| gemini-2.5-flash | Gemini 3.5 Flash Lite | MODEL_GOOGLE_GEMINI_2_5_FLASH | 1048576 | 65535 |
| gemini-2.5-flash-thinking | Gemini 3.5 Flash Lite | MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING | 1048576 | 65535 |
| gemini-2.5-flash-lite | Gemini 3.5 Flash Lite | MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE | 1048576 | 65535 |
| gemini-2.5-pro | Gemini 2.5 Pro | MODEL_GOOGLE_GEMINI_2_5_PRO | 1048576 | 65535 |
| gemini-3-flash | Gemini 3 Flash | MODEL_PLACEHOLDER_M18 | 1048576 | 65536 |
| gemini-3.1-flash-lite | Gemini 3.1 Flash Lite | MODEL_PLACEHOLDER_M50 | 1048576 | 65535 |
| gemini-3.1-flash-image | Gemini 3.1 Flash Image | MODEL_PLACEHOLDER_M21 | 65536 | 65536 |
| gemini-3.5-flash-lite | Gemini 3.5 Flash Lite | MODEL_PLACEHOLDER_M198 | 1048576 | 65535 |
| gemini-3.8-flash-low | Gemini 3.8 Flash (Low) | MODEL_PLACEHOLDER_M320 | 1048576 | 65536 |
| gemini-3.8-flash-medium | Gemini 3.8 Flash (Medium) | MODEL_PLACEHOLDER_M319 | 1048576 | 65536 |
| gemini-3.8-flash-high | Gemini 3.8 Flash (High) | MODEL_PLACEHOLDER_M318 | 1048576 | 65536 |
| gemini-3.8-flash-tiered | (unnamed) | MODEL_PLACEHOLDER_M322 | 1048576 | 65536 |
| gpt-oss-120b-medium | GPT-OSS 120B (Medium) | MODEL_OPENAI_GPT_OSS_120B_MEDIUM | 131072 | 32768 |
| tab_flash_lite_preview | (unnamed) | MODEL_PLACEHOLDER_M19 | 16384 | 4096 |
| tab_jump_flash_lite_preview | (unnamed) | MODEL_PLACEHOLDER_M28 | 16384 | 4096 |
| chat_20706 | (internal) | MODEL_CHAT_20706 | 16384 | — |
| chat_23310 | (internal) | MODEL_CHAT_23310 | 32768 | — |

### retrieveUserQuotaSummary
- `POST /v1internal:retrieveUserQuotaSummary` body `{ project }` + headers
  `x-client-name: antigravity`, `x-client-version: 2.6.0` → **200**.
- Shape: `{ groups: [ { buckets: [ { bucketId, displayName, window, resetTime,
  remainingFraction } ] } ] }` — matches the adapter's `parseSummaryQuotas`.
- **Without `project` → 403** (license error). Adapter must pass project.

## Chat (`v1internal:streamGenerateContent?alt=sse`)

Envelope comparison on `gemini-2.5-flash` ("Reply with the single word: OK"):

| envelope | project | status | result |
|---|---|---|---|
| legacy (baseline 0482e934) | yes | 200 | thought → "OK" |
| current (adapter production) | yes | 200 | thought → "OK" |
| minimal (raw) | **no** | 403 | license error |
| minimal (raw) | yes | 200 | thought → "OK" |

- **Both adapter envelopes are accepted.** The reference/minimal envelope with
  `project` is also accepted.
- The 403 difference is entirely the missing `project`; not the system
  instruction, labels, or tool config.
- Claude route (`claude-sonnet-4-6`): 200 with `project`; modelVersion echoed
  as `claude-sonnet-4-6`. Baseline `claude-opus-4-6-thinking` appears for
  Opus (matching `antigravityWireModelId` mapping).

## Key takeaways for the adapter

1. `project` is mandatory on chat and quota paths (already handled by
   `loadAntigravityProject` — verified).
2. `retrieveUserQuotaSummary` (quota) requires `project` in the body; the
   quota adapter resolves it via `loadAntigravityProject` — good.
3. UA shape: reference control-plane UA is `antigravity/<version> <os> <arch>`.
   The adapter's `antigravity/hub/... (aidev_client; ...)` chat UA was still
   accepted on `fetchAvailableModels`/`loadCodeAssist` (both 200), so the UA
   difference is not a hard gate.
4. `model_enum` literals from live (~M35/M26/M320/...) differ from the
   adapter's `ANTIGRAVITY_MODEL_WIRE_PROFILES` (M132/M36/M16) — inspect and
   align.
5. `tab_*` rows are internal/unnamed in this account; `chat_20706` and
   `chat_23310` are internal — the adapter's discovery denylist already
   excludes them.
