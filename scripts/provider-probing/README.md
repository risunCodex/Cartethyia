# Provider probing

Live wire probes for provider integrations. Each probe reads exported
accounts from a JSON file, never prints tokens, and reports only status and
the first bytes of each upstream response.

## Credentials

Account exports come from the console. The probes expect one of:

- A bare array of account objects, or
- `{ "exportedAt": "...", "accounts": [...] }`.

Each account uses the same shape the console export writes (field names as
exported): `providerId`, `label`, `credentialKind`, `accessToken`,
`refreshToken`, `authState.userId`, `authState.machineId`.

Tokens are **never** printed. Only a short prefix (e.g. `dt-…`) is shown for
confirmation. Perch's saved sessions (`accounts*.json`) are gitignored: they
carry live access and refresh tokens.

Perch probes are pure HTTP — no CLI install, no spawned process, no desktop,
MCP, or ACP transport. Only `standard` and `standard 1m` are invoked, and the
Saffron system-prompt prefix is required or the upstream answers `403
perch_surface_required`. Repeated incomplete calls trigger `turn_rate_limited`
and can get an account banned; keep live runs to the minimum.

## Running

Probes are plain scripts — there are deliberately no `probe:*` npm scripts.
Run them straight through `bun run scripts/...` (or `bun scripts/...`):

```sh
bun run scripts/provider-probing/qoder/chat/probe-qoder.ts --creds "C:\path\to\qoder-accounts-<ts>.json"
```

Options (per probe, see the script header):

| Flag | Meaning |
| --- | --- |
| `--creds <path>` | required; account export file |
| `--model <id>` | model to probe (default `auto`) |
| `--all` | probe every model in the roster |
| `--models` | list models from the live `/algo/api/v2/model/list` endpoint (signed GET) |
| `--json` | print (or `--out`-write) the full model array as pretty JSON |
| `--out <path>` | write the model list JSON to a file |
| `--ctx <n>` | request context window in tokens (`model_config.max_input_tokens`; unset by default) for the IDE surface |
| `--ide-only` | skip the legacy surface; only the IDE `/model/v1` path (shorthand for `--surface ide`) |
| `--label <name>` / `--index <n>` | select a specific account |

Kiro-specific flags (`probe-kiro.ts` / `probe-kiro-oauth.ts`):

| Flag | Meaning |
| --- | --- |
| `--model <id>` | model to probe on the runtime surface (default `auto`) |
| `--all` | probe every model in the roster |
| `--models` | list models from the live management surface (`List-Available-Models`) |
| `--out <path>` | write the model list JSON to a file |
| `--method <authMethod>` | OAuth: `builder-id` (default), `idc`, `google`, `github` |
| `--region <region>` | AWS region for the IdC/Builder-ID flow (default `us-east-1`) |
| `--start-url <url>` | organization start URL for the IdC flow (default `https://view.awsapps.com/start`) |

## Layout

```
provider-probing/
  lib/
    accounts.ts        # account-file reading + masking
    http.ts            # POST probe helper (timeout, first-bytes head)
    export-accounts.ts # export provider accounts from Lite SQLite to probe JSON
  github/
    github-opencode-login.ts # device login with OpenCode's OAuth app
    github-plan-entitlement-probe.ts # plan/SKU + gpt-6-luna entitlement
    github-auto-multiturn-probe.ts   # live multiturn chat probe
    github-wire-audit-probe.ts       # request-shape audit
  qoder/
    main.ts                    # dispatcher: `bun run .../qoder/main.ts <probe> [args...]`
    cosy-signer.ts             # COSY Bearer signer (plugin surface)
    lib/
      shared.ts                # machine identity, headers, body builders, SSE reader, account loader
      grpc.ts                  # gRPC client factory (proto materialization + stream probe)
    chat/
      probe-qoder.ts           # canonical chat probe: IDE /model/v1 + legacy COSY (flags: --surface, --reply, --model-echo, --cross, --headers, --lite)
      probe-qoder-meta.ts      # per-model probe with strategy metadata (raw_usage provider metadata)
      qoder-capacity-probe.ts  # context acceptance + session-retention experiments (--mode context|retention)
    grpc/
      qoder-grpc-meta.ts       # gRPC per-model probe: metadata/trailers/usage/extras (+ --echo-only)
      qoder-grpc-wire-probe.ts # live gRPC matrix probe against real accounts (isolates rejected tool payloads)
      qoder-grpc-live-test.ts  # gateway live test: qwen3.8-flash + tool over SSE
    direct/
      qoder-gateway-live-test.ts # gateway live test against 127.0.0.1:12800
    quota/
      qoder-entitlement-probe.ts # userinfo + quota + roster (--header-mode, --full, --roster-key)
      probe-qoder-credits.ts     # sash campaign list / claim / reward (--claim, --wait)
    auth/
      qoder-device-login.ts    # device-code login (desktop IDE flow)
      qoder-export-accounts.ts # extract Qoder accounts from local SQLite store (wrapper over lib/export-accounts.ts)
    inspect/
      qoder-body-inspect.ts    # inspect the legacy request body builder output
      qoder-wire-audit.ts      # raw-wire verification + tool-call buffering audit (merged)
    tools/
      qoder-bundle-slice.ts    # print slices of the unpacked bundle around a keyword
    dev/
      gen-chat-proto.ts        # regenerate embedded chat.proto source
      mint-admin-key.ts        # mint a local admin API key into Lite SQLite
      qoder-live-check-db.ts   # inspect local Lite SQLite for API key + active Qoder accounts
  trae/
    probe-trae-chat.ts   # chat/agent wire probe + SSE decode
    probe-trae-quota.ts  # session/entitlement/pay quota probe
    trae-auto-selection-probe.ts # live Auto model-selection wire probe
  freepi/
    probe-freepi.ts      # guest/device identity, catalog, chat, sweep
    freepi-oauth-capture.ts # GitHub device-code login → JWT capture
    freepi-shared.ts     # upstream wire helpers
  perch/
    probe-perch.ts       # Supabase PKCE OAuth capture + pure HTTP model-call probe
    probe-perch-min.ts   # minimal `standard` / `standard 1m` check from a saved session
    perch-shared.ts      # upstream wire helpers (authorize/exchange/plan/account)
  kiro/
    probe-kiro.ts      # management (models) + runtime (generation) probe
    probe-kiro-oauth.ts # IdC/Builder-ID browser PKCE + social OAuth probe
    probe-kiro-chat.ts # direct chat dispatch probe (probe-kiro helpers)
  opencode/
    probe-opencode.ts  # raw OpenCode free-tier wire probe (models + chat)
  antigravity/
    probe-antigravity.ts       # control-plane + models + chat + image probe
    probe-antigravity-oauth.ts # Google OAuth PKCE browser flow + refresh probe
```

The Qoder probe covers two surfaces:

- **Plugin** (`api2.qoder.sh/algo/.../agent_chat_generation`): COSY Bearer
  signed body.
- **IDE** (`api2-v2.qoder.sh/model/v1/chat/completions`): plain
  `Bearer <dt-…>` with `X-Request-ID` / `X-Session-ID` and `Cosy-*` identity
  headers. This is the **default** probe surface (and the adapter's default
  dispatch surface): it streams immediately, while the plugin surface answers
  `10605 isQueued` and parks requests in a server-side queue.

### Context windows (`context_config` / `max_input_tokens`)

The model list states a `max_input_tokens` (the currently selected window) and
a `context_config` map of selectable windows (`1M`/`400K`/`200K`/...). The
selection is sent as `model_config.max_input_tokens` in the chat body — the
upstream honors a value from `context_config` (e.g. `1000000` for 1M,
`400000` for 400K). The adapter now sends the **widest selectable window from
the live list** automatically (a 1M-capable row is dispatched as 1M), so a
client never sees a conversation capped at the currently active 180k window.
Probe with `--ctx 1000000` to ask for the largest window explicitly:

```sh
bun run scripts/provider-probing/qoder/chat/probe-qoder.ts --creds <file> --model dmodel --ctx 1000000
```

### Why `--models --ide` returns 403

`/algo/api/v2/model/list` is a COSY-signed endpoint for every client: the IDE
signs it too (its worker uses the WASM signer). A plain `Bearer <dt-…>`
GET is rejected with `101 Signature invalid`. The probe therefore always signs
the list GET; there is no plain-bearer model-list surface.

### Discovery fix (2026-11-01)

The gateway's `discoverQoderModels` used to send a plain GET without the signed
body (or, in an intermediate bad attempt, a POST — upstream answers 400
"Request method 'POST' not supported"). The correct wire is a **GET that
carries the signed `{}` body**. Bun's fetch rejects GET bodies, so the
validated egress (`createValidatedFetch`) now dials GET/HEAD+body through the
Node http(s) client after the SSRF pass. Verified live: production discovery
returns the full 15-model roster.

Verified live: the same `dt-` token works on both surfaces. The IDE surface
needs the full body shape (`metadata.context`, `metadata.business`,
`stream_options`) and roster model ids (`auto`, `qmodel`, `dmodel`) — a bare
OpenAI body or a plugin-only model id like `qwen3.8-max` fails there.

See `documentation/archive/research/qoder/2026-11-01-qoder-chat-wire-verification.md`
for the full wiring audit.

## Kiro

Kiro's 1.4.62 client talks to two services, both under
`https://{service}.{region}.kiro.dev`:

- **management** — model catalog (`GET /List-Available-Models`) and usage
  (`GET /Get-Usage-Limits`), Smithy `awsJson1_0` with
  `x-amz-target: KiroControlPlaneBearerService.*`.
- **runtime** — generation (`POST /generateAssistantResponse`), Smithy
  `awsJson1_0` with `x-amz-target: KiroRuntimeService.GenerateAssistantResponse`,
  answered as an AWS EventStream frame sequence.

```sh
bun run scripts/provider-probing/kiro/probe-kiro.ts --creds "C:\path\to\kiro-accounts-<ts>.json" --models
bun run scripts/provider-probing/kiro/probe-kiro.ts --creds "C:\path\to\kiro-accounts-<ts>.json" --model auto
bun run scripts/provider-probing/kiro/probe-kiro.ts --creds <file> --models --out models.json
bun run scripts/provider-probing/kiro/probe-kiro-oauth.ts --creds <file> --method builder-id
bun run scripts/provider-probing/kiro/probe-kiro-oauth.ts --creds <file> --method idc --region eu-central-1
bun run scripts/provider-probing/kiro/probe-kiro-oauth.ts --creds <file> --method google
```

The Kiro probe covers two surfaces:

- **management** (`probe-kiro.ts --models`): model list from the control plane,
  scoped by the account's region/profile. Headers mirror the adapter
  (`TokenType` from auth method, `x-kiro-machineid`, `KiroIDE-…` UA).
- **runtime** (`probe-kiro.ts --model <id>`): one generation request decoded
  through the adapter's own EventStream decoder, so the event types and token
  accounting shown are exactly what the gateway will see.

The OAuth probe (`probe-kiro-oauth.ts`) walks the browser PKCE flow live:
register client, print authorize URL, wait for the pasted callback, exchange via
`CreateToken`, and refresh via `CreateToken`. Social (Google/GitHub) uses the
vendor's sign-in service. Nothing is printed except masked token prefixes.

## GitHub Copilot

`github-opencode-login.ts` runs a device-code login with **OpenCode's** GitHub
OAuth app (`Ov23li8tweQw6odWQebz` — distinct from the Copilot Chat extension's
app the console's normal GitHub login uses, and the app the `opencode-copilot`
wire mode presents upstream). It prints the verification URL, polls until the
operator approves, runs the same entitlement check as the console login (an
account without Copilot access is rejected before any token is stored), and
writes the account to a JSON file matching the `ExportedAccount` shape the
probes read:

```sh
bun run scripts/provider-probing/github/github-opencode-login.ts \
  --out "D:\tmp\scratch\github-opencode.json" [--label "my account"] [--open]
```

The account file can be probed directly with
`github-auto-multiturn-probe.ts --creds <file>`.

## Qoder gRPC (1M context)

The Qoder **HTTP** model-server surface caps request bodies at ~256 KiB
(~60K tokens) — verified live (`500 internal server error` above it). The
**gRPC** surface (`model.chat.ChatService/ChatCompletionStream`) accepts up to
~8M chars (~1.9M tokens), so it is the only proven path for real 1M-token
context. Full evidence:
`documentation/research/qoder/2026-11-04-qoder-grpc-1m-context.md`.

`qoder-grpc-meta.ts` probes the gRPC surface per model and captures everything
the server returns — chunk fields (`model` echo, `usage`, `extras`) plus the
gRPC initial metadata and trailers:

```sh
bun run scripts/provider-probing/qoder/grpc/qoder-grpc-meta.ts \
  --creds <accounts.json> --label "Akun Ytprem" --model dmodel --model ultimate
```

**Metadata findings (2026-11-04):** the gRPC surface returns **no** strategy
metadata — the IDE SSE surface's `raw_usage` keys (`provider_model`,
`from_model`, `supply_model`, `model_level`, `router_strategy_name`, `target`)
are absent; `extras` is empty. What the server does return is infra timing in
the gRPC initial metadata: `req-cost-time`, `req-arrive-time`,
`resp-start-time`, `x-envoy-upstream-service-time`, plus `x-request-id` in
both metadata and trailers. Intermittent `429 Upstream error` can occur on
rate-limited slots (e.g. `ultimate`); retrying succeeds.

Related repo probes: `chat/qoder-capacity-probe.ts` (context cap + session
retention modes), and `chat/probe-qoder.ts --lite` (free-tier `lite` via
legacy COSY at 1M).

## OpenCode

`probe-opencode.ts` is a raw wire probe for OpenCode's free tier. It hits the
upstream directly (`opencode.ai`) with the same session/project fingerprint the
real client sends, so it is the ground truth for the adapter's headers and
body — if the probe is accepted, the adapter with the same wire is accepted.

```sh
bun run scripts/provider-probing/opencode/probe-opencode.ts --models
bun run scripts/provider-probing/opencode/probe-opencode.ts --chat --model big-pickle --message "ping" --stream
bun run scripts/provider-probing/opencode/probe-opencode.ts --chat --model big-pickle --message "ping" --dry-run
bun run scripts/provider-probing/opencode/probe-opencode.ts --models --out models.json
bun run scripts/provider-probing/opencode/probe-opencode.ts --chat --token <key> --org <org-id> --stream
```

Free-tier gate facts (verified live 2026-11-02):

- The gate reads the **tool set** on the body, not a single name: a request
  without the full agent-tool set is refused with `403 FreeTierError`.
- A non-streaming request (`stream: false`) is always refused for a free model.
- Free dispatches send **no `Authorization` header** — the anonymous `Bearer
  public` sentinel is no longer sent. Verified live 2026-11-02: the same
  captured free flow answers 200 with `Bearer public`, with no auth header,
  and with the real account token; the gate does not require one (a *wrong*
  bearer still answers 401).
- **A well-formed free request is answered `429 FreeUsageLimitError`** with
  `Retry-After` once the free quota is exhausted — the 2.2.5 binary has no
  `FreeTierError`; the free-limit guard is `FreeUsageLimitError`
  (`provider.free-limit`). Not a wire-shape refusal. A billed model without a
  key answers `401 Missing API key`, and an unknown model id answers `400
  Model is unavailable` — both prove routing is correct, so 429 is a
  quota/cooldown.
- **A real, logged-in 2.2.0 CLI gets the same 429** on a free model (and 402
  "Insufficient account funds" on a billed model), captured through a proxied
  `opencode serve` under mitmproxy (2026-11-02). The real chat wire sends 11
  tools (`edit, glob, grep, read, shell, skill, subagent, webfetch,
  websearch, write, execute`) with `strict:false` on each — no `patch`,
  `question`, or `todowrite` — plus `Accept: */*`, `Authorization: Bearer
  st_…`, and the same session/project fingerprint the adapter sends. See the
  evidence ledger (`documentation/research/opencode/2026-11-02-desktop-2.2.5-binary-evidence.md`).
- Model listing (`/zen/v1/models`) publishes `api.chat-completions.base_url`
  and `compatibility.reasoning_field: "reasoning_content"` per model.

The probe prints only status + first bytes; never tokens.

### Replay tool (`replay-opencode.ts`)

`replay-opencode.ts` reads a captured OpenCode request (from mitmproxy flows
of a real CLI dispatch) and either prints it readable or replays it verbatim
upstream. It also unpacks the minified opencode CLI binary: finds the builder
regions containing `/inference` and beautifies them so the request-shaping
code can be read.

```sh
# Unpack + beautify the builder regions from the CLI binary.
bun run scripts/provider-probing/opencode/replay-opencode.ts unpack \
  [--bin <path-to-opencode.exe>] [--out <dir>]
# Print a captured request readably (redacts credentials).
bun run scripts/provider-probing/opencode/replay-opencode.ts dump <flow.json>
# Replay a captured request verbatim upstream.
bun run scripts/provider-probing/opencode/replay-opencode.ts send <flow.json> \
  [--token <key>] [--org <org-id>] [--no-auth] [--timeout-ms <ms>]
```

Flow JSON shape: `{ "method", "url", "headers", "body" | "bodyFile" }`.
Replaying the captured real-CLI flow (Bearer `st_…` account token) answered
**200 `text/event-stream`** with a real `chat.completion.chunk` for
`glm-5.3-flash-free` on 2026-11-02 — proving the captured wire is valid and
the earlier 429s were quota state, not request shape.

## Antigravity

`probe-antigravity.ts` hits Google's Cloud Code Assist backend raw — no
adapter involved — so the **reference client's** wire shape (from the
unpacked IDE 2.6.0) can be compared 1:1 against the gateway's current shape.
The probe defaults to the reference wiring; pass `--ua adapter` (and, for
chat, `--mode adapter`) to mirror the Cartethyia adapter instead.

```sh
bun run scripts/provider-probing/antigravity/probe-antigravity.ts \
  --creds "C:\path\to\antigravity-accounts-<ts>.json"
# control-plane (ref UA): loadCodeAssist → fetchAvailableModels → quota summary

# Adapter UA shape (for comparison)
bun run ... --creds <file> --ua adapter
# ...with the adapter's client-metadata shape (control-plane)
bun run ... --creds <file> --ua adapter --metadata adapter

# List models (full JSON → --out)
bun run ... --creds <file> --models --out models.json

# Chat stream probe (minimal agent envelope)
bun run ... --creds <file> --chat gemini-2.5-flash

# Chat with the adapter's exact production envelope
bun run ... --creds <file> --chat gemini-2.5-flash --mode current

# Chat with the LEGACY adapter envelope (baseline 0482e934)
bun run ... --creds <file> --chat gemini-2.5-flash --mode legacy

# Run all three envelope modes (legacy / current / minimal) in one go
bun run ... --creds <file> --chat gemini-2.5-flash --diff

# Image generation probe
bun run ... --creds <file> --image "a cat drawing" --size 1024x1024

# Force a base URL (reference list or custom)
bun run ... --creds <file> --base-url https://cloudcode-pa.googleapis.com
```

OAuth probe (PKCE browser flow): prints a Google authorize URL, waits for the
pasted callback, exchanges `code` → tokens, and can refresh an existing
refresh token. Uses the adapter's client id/secret/redirect so a successful
flow validates the exact credential set the gateway uses:

```sh
bun run scripts/provider-probing/antigravity/probe-antigravity-oauth.ts \
  --creds "C:\path\to\antigravity-accounts-<ts>.json" --authorize
bun run ... --creds <file> --refresh
```

Probes never print tokens — only masked prefixes. Key evidence
(unpacked IDE 2.6.0): control-plane UA is `antigravity/<version> <os> <arch>`
(not the chat `antigravity/hub/... (aidev_client; ...)`), clientMetadata sends
`ideName` + `ideVersion` too, `onboardUser` includes `cloudaicompanionProject`,
and `fetchAvailableModels` sends `{project}` in the body.

Chat envelope modes: `--mode current` builds the adapter's production
envelope; `--mode legacy` rebuilds the adapter at baseline `0482e934` (the
old wire — no tool-schema normalization, no forced-tool restatement, and
`used_claude` derived only from the model-id substring); `--mode minimal` is
a small raw agent envelope. Comparing the same model across the three modes
against the live backend shows exactly which shape the upstream accepts.
