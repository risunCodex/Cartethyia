# DeepAI Code 0.3.35 — Live wire verification (probe)

- **Date:** 2026-11-11
- **Path:** `scripts/provider-probing/deepai/` (`deepai-oauth-capture.mjs`, `probe-deepai.mjs`, `_lib.mjs`)
- **Account:** live (login via loopback capture, `username=jinhsera`, `is_pro=false`)
- **Scratch evidence:** `D:\tmp\scratch\deepai-probe\accounts.json` (credential — gitignored)

## Verified live

### 1. Sign-in exchange (`/deepai_code/desktop_auth/exchange/`)

- Hosted login URL: `https://api.deepai.org/deepai_code/desktop_auth/?state=<hex32>&port=<loopback>`
- Callback: `http://127.0.0.1:<port>/callback?code=<code>&state=<state>` (state verified).
- `POST …/desktop_auth/exchange/` body `{"code": "…"}` → **200**
  `{"api_key": "…", "username": "jinhsera", "is_pro": false}`.
- Credential is the `api_key`; no refresh token.

### 2. Model list (`GET /deepai_code/models`)

- **200**, 22 models (unauthenticated; lane headers only).
- Wiring: `{ models: [{ id, name, reasoning, input[], contextWindow, maxTokens, theosPerRequest?, api? }] }`.
- Full roster (2026-11-11):

| model | name | input | ctx | max | theos/req | api |
|---|---|---|---|---|---|---|
| glm-5.3-flash | GLM 5.3 Flash | text,image | 1048576 | 131072 | 0 | - |
| deepseek-v4.1-flash | DeepSeek V4.1 Flash 1017 | text,image | 1048576 | 131072 | 0 | - |
| mimo-2.6-flash | MiMo 2.6 Flash | text,image | 1048576 | 131072 | 0 | - |
| qwen-3.8-flash | Qwen 3.8 Flash | text,image | 991000 | 128000 | 0 | - |
| minimax-m3.1-flash | MiniMax M3.1 Flash | text,image | 1048576 | 131072 | 0 | - |
| solar-mini-4 | Solar Mini 4 | text | 524288 | 131072 | 0 | - |
| gpt-6-luna | GPT-6 Luna | text,image | 1048576 | 128000 | 0 | - |
| mimo-2.6-pro | MiMo 2.6 Pro | text,image | 1048576 | 131072 | 0 | - |
| crouton-alpha | Crouton Alpha | text,image | 1048576 | 131072 | 0 | - |
| glyph-cluster | Glyph Cluster | text | 256000 | 131072 | 0 | - |
| deepai-cyber | DeepAI Cyber | text | 1048576 | 131072 | 0 | - |
| minimax-m3 | MiniMax M3 | text | 512000 | 131000 | 2 | - |
| gpt-6.1-sol | GPT-6.1 Sol | text,image | 1048576 | 128000 | 10 | - |
| gemini-4-argon | Gemini 4 Argon | text,image | 1048576 | 131072 | 10 | - |
| glm-5.3 | GLM 5.3 | text | 1048576 | 131072 | 3 | - |
| kimi-k3 | Kimi K3 | text,image | 1048576 | 131072 | 3 | - |
| muse-spark-1.3 | Muse Spark 1.3 | text,image | 1048576 | 131072 | 6 | - |
| claude-opus-5-5 | Claude Opus 5.5 | text,image | 1000000 | 64000 | 15 | - |
| muse-wonder | Muse Wonder | text,image | 1048576 | 131072 | 15 | - |
| qwen-3.8-max-prime | Qwen 3.8 Max Prime | text,image | 1000000 | 131072 | 15 | - |
| claude-fable-5-2 | Claude Fable 5.2 | text,image | 1000000 | 64000 | 20 | - |
| gpt-6-astra | GPT-6 Astra | text,image | 1048576 | 128000 | 50 | openai-responses |

### 3. Quota

- `GET /deepai_code/theos` → **200**:
  `{ enabled: true, lane_version: 4, balance: "50.00000", granted: "50.00000", refresh_at: "2026-11-12T15:51:29+00:00", check_in: { nonce: "46a16a0a7ec586dcd49bb38568aac61a", seconds: 600 } }`.
  - Daily free grant: 50 Theos, refreshes every 24h (`refresh_at` = now + ~24h).
  - Check-in nonce rotates; `seconds=600` ⇒ re-check-in every 10 minutes.
- `GET /get_usage_summary` → **200** `{ is_authenticated, is_pro }` (body shape confirmed).

### 4. Model hit (`POST /deepai_code/chat/completions`)

- Non-stream (**200**, `application/json`), `glm-5.3-flash`, `max_tokens=256`:
  - `model` echo: `z-ai/glm-5.3-flash` (upstream rewrites id with provider prefix).
  - `finish_reason=stop`, reply `Hello! I'm GLM 5.3 Flash. How can I help you today?`.
  - `usage`: `{ prompt_tokens: 87, completion_tokens: 60, total_tokens: 147, is_byok: false, prompt_tokens_details: { cached_tokens: 64, audio_tokens: 0, video_tokens: 0 }, cost_details: { upstream_inference_cost: null, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0 }, completion_tokens_details: { reasoning_tokens: 34, image_tokens: 0 }, cache_creation_input_tokens: 0, market_cost: 0 }`.
  - Note: `cached_tokens: 64` (prompt cache active), `reasoning_tokens: 34` (thinking tokens counted inside completion).
- Stream (**200**, `text/event-stream`):
  - Chunks: OpenAI `chat.completion.chunk` shape with `delta {role|content}`, `model: "z-ai/glm-5.3-flash"`, `system_fingerprint: "fp_fwq48ze4a0"`, `created` epoch.

## Wire notes (confirmed live)

- Header set: `Content-Type: application/json`, `X-DeepAI-Code-Theos: 4`, `X-DeepAI-Code-Instance`, `X-DeepAI-Code-Machine` (present — machine id readable on this host), `Api-Key: <api_key>`.
- `X-DeepAI-Code-Check-In` + `X-DeepAI-Code-Beacon` accepted on `/theos` (200).
- Upstream model id canonicalization: request `glm-5.3-flash` → response `z-ai/glm-5.3-flash`.
- Theos meter: request `theosPerRequest=0` models are free; `claude-opus-5-5`/`gpt-6-astra` are metered (15/50 per request).

## Remaining unknowns

- Exact spend behavior on metered models (not probed — costs Theos).
- Whether `reasoning_effort` / `thinking` controls are accepted.
- DeepAI `X-DeepAI-Code-Check-In` rotation + `machine_required` behavior when the machine header is absent (server-side).

## Landed integration (2026-11-11)

The provider shipped into the gateway as a **Free Limited** bundled provider:

- `src/providers/integrations/deepai/` — `provider.ts` (spec + adapter),
  `deepai-oauth.ts` (browser loopback login + import), `deepai-quota.ts`
  (`/theos` + `/get_usage_summary`), `deepai-catalog.ts` (22-row roster +
  live discovery), `deepai-common.ts` (machine id + lane headers).
- The adapter stamps `Api-Key` (not Bearer) + `X-DeepAI-Code-Theos: 4` /
  `X-DeepAI-Code-Instance` / `X-DeepAI-Code-Machine` per dispatch; chat wire
  → `/deepai_code/chat/completions`, `gpt-6-astra` (responses) →
  `/deepai_code/responses`.
- 11 zero-Theos rows are `freeTier` (Free models); the metered rows ship with
  the roster and are routed on the same wires.
- Tests: `test/providers/deepai.test.ts` (catalog, quota, OAuth, adapter
  wire). Probe scripts for live capture/wire live in
  `scripts/provider-probing/deepai/`.
