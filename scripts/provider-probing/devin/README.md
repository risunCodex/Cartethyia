# Devin provider probing

Live probes for the shipped Devin adapter. Every script imports the real
modules under `src/providers/integrations/devin/` — protobuf schema, Connect
framing, unary client, metadata identity, OAuth clients — so a probe exercises
exactly what dispatch will use. No hand-rolled protobuf, no duplicated wire.

## Flow: OAuth → capture login → direct upstream

```bash
# 1. Login through the browser (loopback :59653 / :59654), capture the code,
#    exchange it, save the credential, then immediately smoke-test upstream.
bun scripts/provider-probing/devin/devin-oauth-capture.mjs --mode=devin
bun scripts/provider-probing/devin/devin-oauth-capture.mjs --mode=windsurf
bun scripts/provider-probing/devin/devin-oauth-capture.mjs --mode=cli      # adopt credentials.toml
bun scripts/provider-probing/devin/devin-oauth-capture.mjs --mode=paste    # headless
DEVIN_CRED=sk-ws-… bun scripts/provider-probing/devin/devin-oauth-capture.mjs --mode=import --no-smoke

# Credential is written to D:/tmp/scratch/devin-probe/credential.txt (redacted
# on stdout unless --show-secret). The post-login smoke calls GetUserJwt and
# GetCliModelConfigs directly against https://server.codeium.com.

# 2. Re-run the full direct upstream probe with the captured credential.
DEVIN_CRED=$(grep DEVIN_CRED= D:/tmp/scratch/devin-probe/credential.txt | cut -d= -f2-) \
  bun scripts/provider-probing/devin/devin-upstream.mjs --mode=all
```

## Scripts

| Script | What it does |
|---|---|
| `devin-oauth-capture.mjs` | Browser PKCE login (Devin CLI / Windsurf), loopback callback capture, code exchange via the shipped OAuth clients, credential persistence, immediate upstream smoke |
| `devin-oauth-exchange.mjs` | Exchange a pasted code (`--mode=devin\|windsurf\|auth1`) or verify a credential (`--mode=verify`) against 3 RPCs |
| `devin-upstream.mjs` | Direct Connect-RPC: `jwt`, `models`, `status`, `assign`, `chat` (frame stream), `raw`, `all` |
| `devin-live-dispatch.mjs` | Runs the shipped `devinAdapter.dispatch` against the real upstream (no mock) — validates canonical events end-to-end |
| `devin-image-probe.mjs` | Generates a 200×200 red/blue PNG, dispatches it through the adapter, captures the exact request wire (`images=0` expected) |
| `devin-image-control.mjs` | Paired live control: red\|blue vs green\|yellow vs no-image, for both available models — proves inline vision is unsupported |
| `probe-devin-modelconfigs.mjs` | Decoded `GetCliModelConfigs` catalog with limits/flags |
| `probe-devin-api.mjs` | Side-by-side REST legacy (`api.devin.ai`) vs Connect-RPC — proves why the adapter moved host |
| `probe-devin-org.mjs` | Seat identity from `GetUserStatus` (email/orgId/plan/tier) + optional legacy REST grid |
| `probe-devin-v1-models.mjs` | AI Gateway `/api/v1/models` vs Cascade catalog — gateway key ≠ seat key |
| `_lib.mjs` | Shared arg parsing, credential redaction, unary decode, dumped output |

## Credentials

- `DEVIN_CRED` or `DEVIN_API_KEY`: `sk-ws-…` / `gsk-ws-…` seat key, or a JWT
  session token (auto-prefixed `devin-session-token$`).
- `auth1_…` Google/webapp tokens are **not** API keys. Every RPC answers
  `401 invalid api key` / `No organizations found for auth1 user`. The probes
  print that explicitly instead of silently failing.
- Never commit the scratch credential file. stdout always redacts unless
  `--show-secret` is passed.

## Env / flags

Bun swallows `--flag=value` for `.mjs` entrypoints, so every flag also has an
env form: `DEVIN_MODE`, `DEVIN_CODE`, `DEVIN_VERIFIER`, `DEVIN_PROVIDER`,
`DEVIN_BASE_URL`, `DEVIN_TIMEOUT`, `DEVIN_LIMIT`, `DEVIN_PROMPT`, etc.
See each script's header for the full list.

## Notes

- The chat probe (`--mode=chat`) writes a real Connect frame
  (`application/connect+proto`, gzip when ≥1024 B) and decodes the frame stream
  including the `0x02` end-of-stream trailer (which may itself be gzip-compressed).
- `--mode=raw --path=/…` dumps raw response bytes for wire-level inspection.
- Nothing here goes through the gateway; all traffic is direct upstream.

## Live evidence (2026-11-07)

Credential adopted from `%APPDATA%/devin/credentials.toml`
(`windsurf_api_key = "devin-session-token$…"`). Results, all direct to
`https://server.codeium.com`:

| Call | Result |
|---|---|
| `GetUserJwt` | 200, `userJwt` 1912 chars, no custom API server URL |
| `GetCliModelConfigs` | 200, **1010 configs** (874,227 bytes), 7 visible, default `swe-2-flash-medium` |
| `GetUserStatus` | 200, plan Free / tier 19, prompt credits 2500/2500, flow 500/500, quota 100% |
| `GetChatMessage` | 200 `application/connect+proto`, 5 frames, text `"OK"`, usage, trailer `{}` |
| `devinAdapter.dispatch` (live, no mock) | `complete / stop`, text + thinking + usage; tool-use turn parsed from inline `<\|message_model\|>…<\|content_invoke_tool_json\|>` markup |

Live catalog confirms the operator spec: `swe-2-flash-medium` ctx=262144 /
out=131072, `swe-1-6-slow` ctx=200000 / out=128000 + vision. `swe-1-6` was
removed from the seed (absent from the live roster; chat fails
`failed_precondition`), and `swe-1-6-fast` is disabled in the console on the
same account. Discovery returns the account's usable models only; the console
display picker additionally hides rows already on the roster so it only offers
new models.

Two wire bugs were found only by these live probes and fixed in the shipped
adapter: `ModelDimension.value/minRange/maxRange` are protobuf `float`
(fixed32), not `double`; and `CompletionConfiguration` uint64 fields must be
encoded as plain numbers, not `BigInt` (a BigInt produced an
`invalid_argument` stream trailer). See `documentation/research/devin/`.

