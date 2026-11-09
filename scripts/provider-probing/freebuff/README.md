# Freebuff probing

Live wire probes for the Freebuff Desktop 0.0.201 upstream, reconstructed from
the app bundle (`D:\tmp\unpacked\freebuff\app\resources\orchestrator\orchestrator.js`).

## Wire map (prod)

| Surface | Endpoint | Notes |
|---|---|---|
| Code login | `POST /api/auth/cli/code` | body `{fingerprintId}` → `{loginUrl, fingerprintHash, expiresAt}` |
| Login poll | `GET /api/auth/cli/status` | `fingerprintId` + `fingerprintHash` + `expiresAt` → `{user:{authToken}}` |
| User info | `GET /api/v1/me?fields=…` | `Authorization: Bearer <token>` |
| Device keys | `POST /api/v1/freebuff/device-keys` | body `{publicKey, client:"desktop"}` → `{keyId}`; Ed25519 |
| Model catalog | `GET /api/v1/freebuff/models` | headers: `x-freebuff-catalog-protocol: 1`, `x-freebuff-client: desktop` |
| Session admission | `POST /api/v1/freebuff/session/admission` | model/instance headers; device-signed |
| Session status | `GET /api/v1/freebuff/session` | heartbeat variant uses `x-freebuff-heartbeat: 1` |
| Session release | `DELETE /api/v1/freebuff/session` | `x-freebuff-instance-id` + `x-freebuff-multi-session: 1` |
| Cloud chat list | `GET /api/v1/cloud/history/chats` | `x-freebuff-device-chats: 1` |
| Cloud chat get | `GET /api/v1/cloud/history/chats/{id}` | same header |
| Cloud run create | `POST /api/v1/cloud/runs` | `x-freebuff-cloud-questions: 1`; body includes `deviceExecution:{sessionId,bindingId}` |
| Cloud run stream | `GET /api/v1/cloud/runs/{runId}/stream?after=N` | SSE (`Accept: text/event-stream`) |
| Cloud run poll | `GET /api/v1/cloud/runs/{runId}?after=N` | non-stream fallback |

Hosts (prod): API/AUTH `https://www.codebuff.com`; WEB (offers, click-return)
`https://freebuff.com`. The staging hosts observed in the bundle
(`staging-auth.freebuff.com`, `staging-*.freebuffweb.site`) are gated behind
env overrides.

## Ads surface

All requests are plain `POST`/`GET` with `Authorization: Bearer <token>` and
UA `Freebuff-Desktop/<version>` (desktop build). The desktop wires:

| Endpoint | Body / notes |
|---|---|
| `GET /api/v1/ads/policy` | ad serving policy |
| `GET /api/v1/ads/sponsored-skills` | sponsored skills delivery list |
| `POST /api/v1/ads/agentic/offer` | `{v:1, conversationId, messages[], device{os,timezone,locale}, userAgent, ...facts}`; sent to WEB host |
| `POST /api/v1/ads/impression` | `{impUrl, mode:"desktop", userAgent, os}`; header `X-Freebuff-Event-Id` (+ optional `X-Freebuff-Render-Delay-Ms`) |
| `POST /api/v1/ads/click` | `{impUrl, dwellMs?}`; header `X-Freebuff-Event-Id` / `X-Freebuff-Dwell-Ms` |
| `POST /api/v1/ads/click-return` | `{impUrl, ...}` |
| `POST /api/v1/ads/engagement` | `{impUrl, ...}` |
| `POST /api/v1/ads/prefs` | ad preference patch |

First-party impressions are deduped server-side (208 or
`X-Freebuff-Ack-Outcome: deduped`); the client retries up to 3×.

**Reward model**: `z-ai/glm-5.3-flash` is the reward model ("Earned reward ·
resets daily"). The desktop unlocks it when `rateLimitsByModel[...].limit > 0`
— i.e. recording ad views is what earns the unlock. `--ads` runs the sweep and
then re-checks admission for the reward model.

**Live probe note (2026-11-09)**: `GET /api/v1/ads/policy` → 200 (arm
`reduced`, partner placements listed). `POST /api/v1/ads/agentic/offer` with a
desktop-shaped body → 200 `{v:1, decision:"none", reason:"ineligible_client"}`
for every conversationId shape tried. This account is `countryCode: ID` with
`countryBlockReason: country_not_allowed` (from session admission), so ad
campaigns are server-gated per-region — the endpoint is reachable, but no offer
is served here. `sponsored-skills`/`prefs` are not public surfaces (404 HTML on
both API and WEB hosts).

## Running

OAuth capture (opens a browser; writes the token to scratch):

```sh
bun scripts/provider-probing/freebuff/freebuff-oauth-capture.mjs
```

Probe with a captured token:

```sh
bun scripts/provider-probing/freebuff/freebuff-probe.mjs --creds=D:/tmp/scratch/freebuff-probe/credential.txt
bun scripts/provider-probing/freebuff/freebuff-probe.mjs --token=... --model=openai/gpt-6-luna
bun scripts/provider-probing/freebuff/freebuff-probe.mjs --list-models
bun scripts/provider-probing/freebuff/freebuff-probe.mjs --creds=... --ads
bun scripts/provider-probing/freebuff/freebuff-probe.mjs --creds=... --probe-all
bun scripts/provider-probing/freebuff/freebuff-probe.mjs --creds=... --chat --prompt="hi"
```

Device identity persists across runs in `--key-file` (default
`D:/tmp/scratch/freebuff-probe/device-key.json`): the Ed25519 key and the
per-account `keyId` registration are loaded/saved there, mirroring the desktop
profile behavior.

Flags:

| Flag | Meaning |
|---|---|
| `--out <path>` | credential output path (capture) |
| `--token <t>` | inline token (probe) |
| `--creds <path>` | read token from a capture file (probe) |
| `--model <id>` | model to admit (default `deepseek/deepseek-v4-flash`) |
| `--list-models` | print bundled wire model ids |
| `--ads` | run the ad-surface sweep (policy → offer → impression → click → reward re-check) |
| `--dwell <ms>` | dwell for ad click (default 2500) |
| `--probe-all` | admit every target wire id (open tier) and report |
| `--chat` | admit → create cloud run → read stream → release (see gate note below) |
| `--prompt <text>` | prompt for `--chat` |
| `--key-file <path>` | device-key store (default `D:/tmp/scratch/freebuff-probe/device-key.json`) |
| `--no-browser` | do not auto-open the browser (capture) |
| `--no-release` | keep the admitted session open (probe) |
| `--show-secret` | print the full token |

## Cloud chat gate (live-verified)

The real chat surface is `POST /api/v1/chat/completions` (official desktop
shape), preceded by `POST /api/v1/agent-runs` (START) and admission using the
**catalog handle** (`fbm1.*`) in `x-freebuff-model` — not the wire id/key. The
older `cloud/runs` surface is a different (device-execution) path, not the
chat endpoint.

Live results on this account (2026-11-09):
- Admission with catalog handle → 200 active (validated).
- `agent-runs` START → 200 with runId (validated).
- `chat/completions` → **200** with `provider: Luminal`, streamed content and
  usage (validated live, DeepSeek/Solar-class model). See the identity-group
  note below for what unblocks 410.

**Chat identity group (chat 410 → 200).** Since 2026-10-14 the upstream gate
for `POST /api/v1/chat/completions` is whether the whole session *looks like*
the desktop client (`freebuff_update_required` 410 otherwise). The chat
request must carry the full desktop identity group — not just bearer + SDK UA:

- `x-freebuff-client: desktop`
- `x-freebuff-client-version: <app version>` (`FREEBUFF_APP_VERSION` or the
  bundled known desktop version)
- `x-freebuff-install-id: <uuid>` (same value as the admission call)
- `x-freebuff-sse-gzip-recovery: 1`
- `x-freebuff-acting-user-id` + `x-freebuff-catalog-fetch` (fresh fetchId)

Without the identity group (e.g. the October official capture, which predates
the gate) the same body gets 410. Body shape must also be the official desktop
shape: catalog handle in `model`, `codebuff_metadata` with `freebuff_instance_id` /
`freebuff_multi_session: "1"` / `trace_session_id` / `repo_snapshot` /
`llm_step_number: "1"` / `run_id` / `client_id` / `cost_mode: "free"`,
`provider: { allow_fallbacks: true }`, the 37 official tools
(`assets/official-tools.json`), `tool_choice: "auto"`, and the official worker
system template (`assets/official-system-worker.txt`).

`--chat` runs the full validated chain (admission handle + agent-runs START →
chat → FINISH → release) and reports the chat response verbatim; it never
loops retries.

Tokens are never printed unless `--show-secret`. Only a short prefix is shown;
use `--out`/`--creds` to move tokens through files.

## Verified live probe notes (2026-11-09)

Full chain verified against a live account: code login → `/me` → device-keys →
catalog → session admission → release, all 200.

- **`/me` fields** are exactly `id, email, discord_id, stripe_customer_id,
  banned, created_at, name` — `accessTier`/`paidPlan` are rejected with 400.
- **Catalog rows key on `m-<hex>`**, not the wire form `provider/model`; each
  row also carries a long `handle` (fbm1.*). Wire-form ids (`deepseek/
  deepseek-v4-flash`) are still accepted by session admission.
- **Admission response** is the real entitlement surface: `status: active`,
  `expiresAt`, `freebucks` (balance, daily limit/spent/reset at 08:00
  America/Los_Angeles), per-model `rateLimit` (6/day, pool `limited`), per-model
  `prices`, `planRequiredModelIds`, `offPeak` pricing for fast models, and
  `countryCode`/`countryBlockReason` (informational; does not block).
- The admitted session shows up as a `desktopPurchases` entry and increments
  `desktopSessionCounts.premium`; `DELETE` release ends it (`status: ended`).
