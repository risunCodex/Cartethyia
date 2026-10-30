> # ARCHIVED — UNTRUSTED
>
> This file was archived on 2026-10-23. It is a **point-in-time record**, not a
> description of current behavior: every `file:line`, symbol, path, and
> measurement below was true when it was written and has not been kept in sync.
> Do not read it to answer a question about the current codebase, and never cite
> it as evidence. See the [project README](../../../README.md).

# Trae — agent surface vs chat surface

Reverse-engineered from the installed Trae IDE (`%LOCALAPPDATA%\Programs\Trae`, v1.107.1)
and from live requests against a `userRegion=sg` account. Everything here was observed,
not inferred; the unknowns are labelled.

**Status: SOLVED.** The picker's models are reachable. See "The working request" — this
corrects the earlier conclusion in this file's history that they were quota-blocked.

## Two disjoint surfaces

Trae exposes two completely different model planes, and a model id is only meaningful on
one of them. This is the single fact that decides whether a model can be served.

| surface | endpoint | identifies model by | models |
|---|---|---|---|
| chat | `POST /api/ide/v1/llm_raw_chat` | `model_name` | the account's `model_list` entries (9) |
| agent | `POST /api/agent/v3/llm_utils_chat` | `config_name` + `config_source` | the IDE picker list (17+) |

They do not intersect. `deepseek-v4.1-flash` is in the second and absent from the first;
verified by hitting the chat endpoint with it on **every** chat host the IDE config lists:

```
core16-normal-sg.trae.ai    4023 model is unknown
core19-normal-sg.trae.ai    4023 model is unknown
core22-normal-sg.trae.ai    4023 model is unknown
api5-normal-alisg.mchost.guru 4023 model is unknown
trae-api-sg.mchost.guru     4023 model is unknown
coresg-normal.trae.ai       4023 model is unknown
core-normal.traeapi.us      4023 model is unknown
```

The mistake that cost the most time was assuming the chat endpoint's `model_name` was the
universal selector. It is not: it only resolves the nine legacy roster entries. The picker's
models resolve through `config_name`, and `model_name` is **ignored** on the agent surface.

## The chat surface

`model_list` is `POST /api/ide/v1/model_list` with body `{"type":"chat"}` — upstream
validates a body, so a bare GET is not the call. It is **per account region**, not per
realm. The SG account serves exactly nine, and the key field is `model_name`, with `name`
and `id` as fallbacks. `type` is a string enum with exactly one accepted value: `chat`.
Every other string (`agent`, `solo_agent`, `all`, empty) and every integer `0..12`
returns 400.

```
claude3.5                 status=true  type=chat_model  multimodal=true   default=true
aws_sdk_claude37_sonnet   status=true  type=chat_model  multimodal=true
gemini-2.5-pro-preview-03-25
gemini_2.5_flash
gpt-4.1-2025-04-14
gpt-4o
deepseek-V3-0324          multimodal=false
deepseek-V3               multimodal=false
deepseek-R1               type=reasoning_model
```

Every row above was confirmed by a real completion except `claude3.5` and
`aws_sdk_claude37_sonnet`, which answer `3003 all models failed`. Those two are listed but
not usable — a roster row that cannot complete is worse than a missing one.

Frame layout from the region host (this is what the donor does *not* describe):

```
event: metadata
data: {"model":"","session_id":"…","prompt_completion_id":0,…}

event: output
data: {"response":"OK","reasoning_content":null,"tool_calls":null,…}

event: token_usage
data: {"prompt_tokens":4,"completion_tokens":1,"total_tokens":5,…}
```

Flat, not the nested `chunk.content` the donor's client uses, and usage arrives as its own
`token_usage` frame with the OpenAI spelling at the top level. The stream ends with no
`event: done`, so the terminal must be synthesised.

## The working request

This is the whole answer. One call serves every picker model:

```
POST /api/agent/v3/llm_utils_chat
Content-Type: application/json
Accept: text/event-stream
… Trae auth headers …

{
  "function":      "solo_agent",
  "config_name":   "deepseek-v4.1-flash",
  "config_source": 1,
  "messages":      [{ "role": "user", "content": [{ "type": "text", "text": "Say OK" }] }],
  "stream":        true,
  "Request":       {}
}
```

Four fields carry it, and each was proven load-bearing by removing it:

| removed | result |
|---|---|
| `function` | `4001 param is invalid` — `[LLMUtilsChat.resolveByUsage] function is empty` |
| `function: "nope"` / `"solo_coder"` | `4001 param is invalid` (unknown function) |
| `config_name: "zzz-nope"` | `4001 param is invalid` |
| `config_source` | resolves `provider_model_name` but emits **no output** |

`config_source: 1` is the subtle one. Without it the server picks the right upstream model
and then streams nothing, which looks like a model problem and is not.

`function` accepts at least `solo_agent` and `chat_v3`. `solo_coder` is 4001 and `chat`
answers `3003 all models failed`, so `solo_agent` is the value to use.

### Verified results

Seventeen configs swept on `coresg-normal.trae.ai`, each asked `Reply with exactly: OK`,
each answered `OK`:

```
PASS gpt-5.4                  gpt-5.4-2026-03-05
PASS Dola-Seed-2.0-Code       ep-20260907150747-7hcmj
PASS gpt-5.2                  gpt-5.2-2025-12-11
PASS gpt-5.2-codex-paygo      gpt-5.2-codex-2026-01-14
PASS gpt-5.1-paygo            gpt-5.1-2025-11-13
PASS gpt-5-paygo              gpt-5-2025-08-07
PASS deepseek-v4.1-flash      ep-20261015155603-69njn
PASS deepseek-v4-flash-0731   deepseek-v4-flash-0731
PASS deepseek-v4-pro-0813     ali-deepseek-v4-pro-0813
PASS kimi-k3                  aws-kimi-k3
PASS kimi-k2.7-code           azure-kimi-k2.7-code
PASS kimi-k2.5                ep-20260508133327-lzz7k
PASS gemini-3.1-pro           gemini-3.1-p
PASS gemini-3-flash-solo      gemini-3-flash-preview
PASS gemini-3.1-pro-paygo     gemini-3.1-p
PASS minimax-m3               Minimax-M3
PASS minimax-m2.7             Minimax-M2.7
```

`glm-5.2` is **not** servable. It appears in the harness's model-id map but is absent from
the account's `solo_agent` config list, and sending it yields `4001 param is invalid`. An id
existing in the binary is not evidence it is provisioned for an account.

### Reading `4001 param is invalid` correctly

This one code covers several different failures and must not be read as a single cause. It is
returned for a config name the account does not have (`glm-5.2`), for a `function` value the
server does not know (`nope`, `solo_coder`), and for a genuinely bogus id. Confirmed by byte
comparison — `glm-5.2` and `zzz-totally-bogus` return an identical response:

```
event: error
data: {"code":4001,"message":"We're sorry, the param is invalid. Please try with a valid param.","extra":null}
event: done
data: {"finish_reason":"stop"}
```

So a `4001` can mean **unknown config**, **entitlement/paywall** (a model the account has not
bought), or **wrong shape**. The endpoint does not distinguish them, and neither the config
list nor the error says which. The only reliable discriminator is whether the name appears in
`batch_get_detail_param` for the account: present + `4001` points at entitlement, absent +
`4001` means the id is simply wrong. Do not treat `4001` as proof a model is paid.

Host matrix for the agent endpoint (same SG token):

```
coresg-normal.trae.ai           200 OK
core22-normal-sg.trae.ai        200 OK
api16-normal-alisg.mchost.guru  200 OK
core-normal.traeapi.us          403 no schema found   <- region mismatch, as with chat
```

### Response shape

Same flat frame set as the chat surface, plus a richer `timing_cost` that reports the real
upstream model:

```
event: metadata
data: {"model":"","session_id":"…",…}

event: timing_cost
data: {…,"account_type":"paygo","provider_model_name":"gpt-5.4-2026-03-05",…}

event: output
data: {"response":"OK","reasoning_content":null,"tool_calls":null,"phase":"final_answer"}

event: token_usage
data: {"name":"","prompt_tokens":8,"completion_tokens":5,"total_tokens":13,…}

event: done
data: {"finish_reason":"stop"}
```

Reasoning models stream their thinking in `reasoning_content` while `response` stays empty
until the final answer. `deepseek-v4.1-flash` did exactly this:

```
{"response":"","reasoning_content":" need answer user just \"","phase":null}
{"response":"","reasoning_content":"Say OK\". Need comply.","phase":null}
```

So a client must read **both** fields, not just `response`. Unlike the chat surface, this
stream does terminate with `event: done`.

## How the roster was found

The picker's ids are not in the web bundle at all — grepping every `.js`/`.mjs` for
`deepseek-v4.1-flash` returns nothing. They live in
`resources/app/modules/ai-agent/harness.dll` (172 MB), but there only as a mode map
(`"deepseek-v4.1-flash": "default"`), which is useless as a request spec.

The usable roster comes from the config endpoint the IDE itself calls:

```
POST /api/ide/v1/batch_get_detail_param
{ "functions": ["solo_agent"], "Request": {} }
```

Response is `function_configs[0].config_info_list[]`, one entry per picker model, each with
`config_name`, `usage`, `config_source`, and `model_detail_list[].model_name`. Counts per
function:

```
solo_agent   44 configs   (22 picker models)
solo_coder   37 configs
chat_v3      41 configs
chat         22 configs
agent         0 configs   <- "agent" is not a valid function
coder         0 configs
```

Filtering to `usage == "chat_completion"` yields exactly the chat-servable set; the rest are
`fast_apply`, `title_generation`, `input_optimization`, `laziness_detection`, and
`custom_model` entries that are not chat targets.

The `model_detail_list` upstream names (`deepseek-v4.1-flash__dev`, `__max`) are **not**
accepted by the agent endpoint as `config_name`. Only the bare config name works.

## Dead ends — do not re-chase

- **`config_name` + `config_source` on `llm_raw_chat`.** Appeared to make the picker model
  "recognised" because the error changed from `model is unknown` to a generic failure. It is
  a lie: a bogus `config_name: "totally-not-a-model-xyz"` produces a byte-identical response.
  The change came from `config_source`, not from the model being accepted.
- **Reading any single "sorry" message as a diagnosis.** The generic
  `something went wrong` / `param is invalid` strings are emitted for unknown ids, wrong
  shapes, and entitlement failures alike. Always A/B against a bogus id before concluding
  what a message means; several hours were lost to a message that changed for an unrelated
  reason.
- **`/api/ide/v1/agents/runs`.** Answers `5003 agent running quota limit exceeded`, and does
  so for an empty body. Recorded earlier as an account-level quota gate; it is simply the
  wrong door — `llm_utils_chat` serves the same models without the gate.
- **`/api/ide/v1/llm_raw_chat_prompt`.** Returns `code: 0 Success` and echoes the messages
  back. It echoes for a bogus model too, so it is a prompt normaliser, not inference.
- **`/api/ide/v1/chat_prompt`, `/api/ide/v1/chat_completion`,
  `/api/ide/v1/playground/chat`, `/api/ide/v1/use_fast_request`** — 404 or 500.
- **`/api/v1/chat/*`** (`start_chat`, `initialize`, `subscribe_events`) — the harness's
  **local** Rust server (`harness/server/src/modules/chat/*.rs`), so they 404 remotely.
- **`/api/solo_hub/v1`** — also local hub RPC (`change_config`, `list_apps`,
  `check_cli_status`), not a remote REST path.
- **`frontierUrl` / `FrontierFrame`** — a WebSocket transport the IDE opens to the hub; the
  URL is delivered at runtime (`missing frontierUrl!` in
  `harness/hub/module/src/handlers/config.rs`) and no `ws://` literal exists in any DLL.
  Never needed: the models are reachable over plain HTTPS.
- **`/api/v1/commercial/check_estimated_balance`** — reachable (400, not 404) but no field
  combination was found that it accepts; entitlement was never read.

## Device identity

The IDE stores its real device identity in `%APPDATA%\Trae\ahanet\tt_net_config.config`
(`device_id=7384815624742012432`) and its SG host list in `ahanet/hostcache_sync_v1`
(`core22-normal-sg.trae.ai`, `api16/22-normal-alisg.mchost.guru`). Using these instead of
derived ids changed nothing — model resolution is not device-gated.

## What this means for the gateway

Reflecting what shipped, not what this file first proposed.

- **The intl catalog is agent-only.** The two surfaces share no model id, so a
  single-surface catalog is the only honest one. Every intl row carries
  `surface: "agent"` and dispatches to {@link TRAE_AGENT_CHAT_PATH}; a test
  asserts that for each row and asserts the legacy chat ids are gone. CN remains
  on the chat path with its own roster.
- **The agent surface is three fields, not one.** `toTraeAgentBody` renames
  `model_name` to `config_name` and adds both `config_source: 1` and
  `function: "solo_agent"` — the table above proves each is load-bearing. It
  lives inside the same adapter, selected by the *row's* endpoint, and is the
  default: a target with no route resolves to the agent path rather than
  silently landing on a surface that rejects every model in the roster.
- **Discovery is `/model/list`, not the config endpoint.** `discoverTraeModels`
  POSTs `{"type":"chat"}` (upstream requires a body, so it is not a bare GET)
  and reads `model_name` first, falling back to `name` then `id`.
  `batch_get_detail_param` with `functions: ["solo_agent"]` remains the way to
  enumerate the picker's configs — that is how the 17-model sweep below was
  built — but no shipped code filters on `usage`.
- **Reasoning arrives on its own field.** A client must read both `response` and
  `reasoning_content`; the answer often stays empty until the final frame.
- **Tool calling is declared with `parameters` as a JSON string** (upstream
  types it as a Go `string` and rejects an object), and returns `function_call`
  rather than OpenAI's `function`, spread across frames whose `id` is present
  exactly when the arguments are not.
