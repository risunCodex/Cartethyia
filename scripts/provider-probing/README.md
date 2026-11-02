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
confirmation.

## Running

Probes are plain scripts — there are deliberately no `probe:*` npm scripts.
Run them straight through `bun run scripts/...` (or `bun scripts/...`):

```sh
bun run scripts/provider-probing/qoder/probe-qoder.ts --creds "C:\path\to\qoder-accounts-<ts>.json"
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
| `--ctx <n>` | request context window in tokens (default 180000) for the chat probe |
| `--ide-only` | skip the plugin surface, only the IDE `/model/v1` path |
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
  qoder/
    cosy-signer.ts     # COSY Bearer signer (plugin surface)
    probe-qoder.ts     # plugin COSY vs IDE /model/v1 probe
  kiro/
    probe-kiro.ts      # management (models) + runtime (generation) probe
    probe-kiro-oauth.ts # IdC/Builder-ID browser PKCE + social OAuth probe
    probe-kiro-chat.ts # direct chat dispatch probe (probe-kiro helpers)
  opencode/
    probe-opencode.ts  # raw OpenCode free-tier wire probe (models + chat)
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
bun run scripts/provider-probing/qoder/probe-qoder.ts --creds <file> --model dmodel --ctx 1000000
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
