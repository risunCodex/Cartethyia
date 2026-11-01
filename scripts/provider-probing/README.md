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

```sh
bun run probe:qoder --creds "C:\path\to\qoder-accounts-<ts>.json"
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

## Layout

```
provider-probing/
  lib/
    accounts.ts        # account-file reading + masking
    http.ts            # POST probe helper (timeout, first-bytes head)
  qoder/
    cosy-signer.ts     # COSY Bearer signer (plugin surface)
    probe-qoder.ts     # plugin COSY vs IDE /model/v1 probe
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
bun run probe:qoder --creds <file> --model dmodel --ctx 1000000
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
