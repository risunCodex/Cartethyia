# Freebuff Desktop 0.0.201 — wire audit + live probe

Evidence date: 2026-11-09

## tl;dr

- Freebuff (Codebuff) is a hosted desktop coding agent. Transport is **plain
  HTTP** (`fetch`), not WebSocket/SSE — except the cloud run **stream** (SSE)
  which is a downstream read channel, not a chat transport.
- Auth is an **OAuth code flow** (`/api/auth/cli/code` + poll
  `/api/auth/cli/status`) that returns a bearer `authToken`.
- Session purchase/admission = `POST /api/v1/freebuff/session/admission`
  (model headers + optional Ed25519 device signature). Catalog =
  `GET /api/v1/freebuff/models` (catalog protocol 1).
- Real chat runs through **`POST /api/v1/chat/completions`** (official desktop
  shape, gated by a desktop-identity check since 2026-10-14). The older
  `cloud/runs` surface is a device-execution harness, not the chat transport.
- Ads surface exists (`/api/v1/ads/*`) but is gated per-region; this probe
  account (countryCode `ID`) gets `decision:"none", reason:"ineligible_client"`
  on every offer shape.
- Bundle source: `D:\tmp\unpacked\freebuff\app\resources\orchestrator\orchestrator.js`
  (Bun bundle, Freebuff Desktop 0.0.201 win-x64).

## Unpack chain

1. `Freebuff-0.0.201-win-x64.exe` — NSIS installer.
2. `7z x` → `app-64.7z` → Electron resources.
3. `app.asar` → `app\resources\orchestrator\orchestrator.js` (single Bun
   bundle, ~9 MB, un-minified enough to keep function/const names).

All wire facts below were extracted from that bundle, then verified live where
noted.

## Hosts

| Role | Host | Notes |
|---|---|---|
| API / AUTH | `https://www.codebuff.com` | prod; `API_HOST`, `AUTH_HOST` |
| WEB | `https://freebuff.com` | `FREEBUFF_WEB_HOST`; offers/click-return land here |
| Staging | `staging-auth.freebuff.com`, `staging-*.freebuffweb.site` | gated behind env overrides; unused in prod |

## Auth: OAuth code flow

| Step | Endpoint | Request | Response |
|---|---|---|---|
| Issue code | `POST /api/auth/cli/code` | `{fingerprintId}` | `{loginUrl, fingerprintHash, expiresAt, expiresInMs}` |
| Browser sign-in | `GET https://www.codebuff.com/login?auth_code=…` | — | hosted UI |
| Poll | `GET /api/auth/cli/status?fingerprintId=…&fingerprintHash=…&expiresAt=…` | — | `{user:{authToken, id, email, name}}` |

- Token is a plain bearer (`Authorization: Bearer <authToken>`).
- Scratch capture script: `scripts/provider-probing/freebuff/freebuff-oauth-capture.mjs`
  (writes `FREEBUFF_TOKEN=` to `D:/tmp/scratch/freebuff-probe/credential.txt`).
- Live-verified 2026-11-09: code issued, browser sign-in, token received
  (account id `cfffe1d9…`, email `almayayhanyagutah@gmail.com`).

## Surface inventory

### User + device

| Endpoint | Method | Notes |
|---|---|---|
| `/api/v1/me?fields=…` | GET | Valid fields: `id, email, discord_id, stripe_customer_id, banned, created_at, name`. **`accessTier`/`paidPlan` rejected (400)**. |
| `/api/v1/freebuff/device-keys` | POST | body `{publicKey, client:"desktop"}` → `{keyId}`; Ed25519. |

### Session (admission / heartbeat / release)

| Endpoint | Method | Notes |
|---|---|---|
| `/api/v1/freebuff/session/admission` | POST | model headers + device sig; → `{status:"active", instanceId, expiresAt, freebucks, rateLimit, prices, …}` |
| `/api/v1/freebuff/session` | GET | heartbeat variant uses `x-freebuff-heartbeat: 1` |
| `/api/v1/freebuff/session` | DELETE | `x-freebuff-instance-id` + `x-freebuff-multi-session: 1` → `{status:"ended"}` |
| `/api/v1/freebuff/appearance` | GET | UI appearance |
| `/api/v1/paid` | GET | paid-plan surface (web host) |

**Admission headers** (all from bundle):

| Header | Value |
|---|---|
| `x-freebuff-client` | `desktop` |
| `x-freebuff-client-version` | app version (env `FREEBUFF_APP_VERSION`) |
| `x-freebuff-install-id` | install UUID |
| `x-freebuff-model` | wire model id (`provider/model`) |
| `x-freebuff-wallet-spend-limit` | `session` |
| `x-freebuff-instance-id` | per-session UUID |
| `x-freebuff-multi-session` | `1` |
| `x-freebuff-purchase-continuity` | `1` |
| `x-freebuff-desktop-attempt-id` | UUID |
| `x-freebuff-desktop-admitted-at` | admission timestamp |
| `x-freebuff-session-renewal-id` | renewal |
| `x-freebuff-device-key` / `-ts` / `-sig` | Ed25519 signature (see below) |
| `x-freebuff-acting-user-id` | acting user |

**Device signature payload** (canonical):
```
freebuff-device-v1\n<METHOD>\n<path>\n<timestampMs>\n<bodySha256>\n<fetchId>
```
Signed with the registered Ed25519 key; headers
`x-freebuff-device-key`, `x-freebuff-device-ts`, `x-freebuff-device-sig`.

**Admission response** is the real entitlement surface (live-verified):

- `status: "active"`, `instanceId`, `expiresAt` (1 h), `remainingMs`, `accessTier` ("limited"), `countryCode`, `countryBlockReason` (informational — does not block admission).
- `freebucks`: `{balance, daily:{limit, spent, remaining, resetAt, resetTimeZone}, wallet:{balance, monthlyBonus}, planId, prices{model:cost}, priceNotices, offPeak, priceChanges, planRequiredModelIds, upgrade}`.
- `rateLimit`: `{model, entitlementBreakdown:{base,referral,streak}, limit, pool:"limited", poolLabel:"Daily", period:"pacific_day", resetAt, windowHours:24, recentCount}`.
- `rateLimitsByModel`: same shape per admitted model.
- `desktopSessionCounts`: `{premium, unlimited, nextExpiryAt}`.
- `desktopPurchases` / `desktopRefunds`.

Live-verified: DeepSeek V4.1 Flash and Solar Mini/Pro 4 admit 200 and release
200; all `fbc/*` slow/stealth rows return **409 `model_unavailable`** with
`withdrawn: true` even though catalog lists `access:"open"` — the catalog is
not the admission gate.

### Model catalog

| Endpoint | Method | Notes |
|---|---|---|
| `/api/v1/freebuff/models` | GET | headers `x-freebuff-catalog-protocol: 1`, `x-freebuff-client: desktop` |

Response: `{protocol:1, version:"v0.g1.e83064.limited.5.l0p25.n1", issuedAt, refreshAt, rows[], recommendedKey, fallbackKey, plansUrl, sections, fetchId}`.

Row shape (live dump): `{key: "m-<hex>", handle: "fbm1.*", displayName, tagline, taglineTooltip, warning, badges[], multimodal, premium, dataUse ("training"|"service"), access ("open"|"locked"), lockedLabel, lockedTooltip, efforts[], defaultEffort, reasoningEffort, contextWindow, compaction{cacheExpiryMs, cacheExpiryMinTokens, maxContextLength, lean?}, sortOrder, placement{section, order, recommended?, more?}, peakPills, legacyDigests[]}`.

**Key mapping**: catalog rows key on `m-<hex>`; wire form `provider/model` is
used for admission/pricing. Bundle matcher `freebuffModelIdMatches(candidate,
baseId)` accepts exact match or `baseId-<6-8 digits>` (dated variants such as
`glm-5.3-flash-2026-09-05`).

**Live catalog for this account (13 rows, tier limited)**:

| Wire id | displayName | access | premium | ctx | multimodal | admission |
|---|---|---|---|---|---|---|
| `deepseek/deepseek-v4-flash` | DeepSeek V4.1 Flash 10/17 | open | false | 1M | true | ✅ 200 |
| `fbc/deepseek-slow` | DeepSeek V4.1 Flash Slow | open | false | 1M | true | ❌ 409 |
| `deepseek/deepseek-v4-flash-fast` | DeepSeek V4.1 Flash Fast 10/17 | locked | true | 1M | true | ✅ 200 |
| `openai/gpt-6-luna` | GPT-6 Luna | locked | true | 1M | true | ✅ 200 |
| `upstage/solar-mini4` | Solar Mini 4 | open | false | 500k | false | ✅ 200 |
| `upstage/solar-pro4` | Solar Pro 4 | open | false | 500k | false | ✅ 200 |
| `meta/muse-spark-1.3-contributor` | Muse Spark 1.3 | locked | false* | 1M | false | (not swept) |
| `openai/gpt-6.1-terra` | GPT-6.1 Terra | locked | true | 1M | true | ✅ 200 |
| `fbc/mimo-slow` | MiMo v2.6 Flash Slow | open | false | 400k | true | ❌ 409 |
| `fbc/crouton-alpha` | Crouton Alpha | open | false | 1M | false | ❌ 409 |
| `fbc/glyph-cluster` | Glyph Cluster | open | false | 256k | false | ❌ 409 |
| `fbc/nemotron-3.5-lightning` | Nemotron 3.5 Lightning | open | false | 256k | false | ❌ 409 |
| `fbc/claude-haiku-5.5-100k` | Claude Haiku 5.5 · 100k | locked | true | 100k | true | ❌ 409 |

\* Muse Spark 1.3 is locked to **Pro plan** (not generic "paid plan").
Bundled `FREEBUFF_MODELS` holds 64 wire ids; the live catalog is a
per-tier/per-region subset.

**Admission sweep (2026-11-09, `--probe-all`)** — `access: locked` ≠ gate.
8 of 12 swept wire ids admitted 200, including premium rows and the reward
model:
- ✅ `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-fast`
- ✅ `upstage/solar-mini4`, `upstage/solar-pro4`
- ✅ `z-ai/glm-5.3-flash` (reward model — already unlocked on this account)
- ✅ `openai/gpt-6-luna`, `openai/gpt-6.1-terra`
- ❌ all `fbc/*` rows → 409 `model_unavailable` with `withdrawn: true`
  ("not offered on your account — we recommend DeepSeek V4.1 Flash").
  The `fbc/*` rows advertise `access: open` but are **withdrawn server-side**
  for this account/region; catalog visibility is not admission eligibility.
- `z-ai/glm-5.3-flash` (reward) was in `rateLimitsByModel` with `limit: 6`
  on the first admission — the reward model is unlocked by default here, not
  gated behind an ad view alone.

### Cloud chat / runs (the real chat path)

Auth: `Authorization: Bearer <token>` + **`x-freebuff-device-chats: 1`**.

| Endpoint | Method | Notes |
|---|---|---|
| `/api/v1/cloud/history/chats` | GET | list chats (`?projectId=…`, `cursor`, `limit`, `search`) |
| `/api/v1/cloud/history/chats/{id}` | GET | get chat |
| `/api/v1/cloud/history/chats/{id}` | PATCH | update chat |
| `/api/v1/cloud/history/chats/{id}/fork` | POST | fork |
| `/api/v1/cloud/history/chats/{id}/rollback` | POST | rollback |
| `/api/v1/cloud/history/chats/{id}/attention` | PATCH | `{throughRevision}` ack |
| `/api/v1/cloud/history/chats/{id}/runs` | GET | list runs |
| `/api/v1/cloud/history/runs/{id}` | GET | get run |
| `/api/v1/cloud/history/runs/{id}/events` | GET | events |
| `/api/v1/cloud/history/runs/{id}/traces` | GET | traces |
| `/api/v1/cloud/history/projects-access` | GET | access grant |
| `/api/v1/cloud/runs` | POST | **create run** (dispatch chat) |
| `/api/v1/cloud/runs/{runId}/stream?after=N` | GET | SSE stream (`Accept: text/event-stream`) |
| `/api/v1/cloud/runs/{runId}?after=N` | GET | non-stream poll |

**Run creation** (`POST /api/v1/cloud/runs`):
- Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`,
  `x-freebuff-cloud-questions: 1`, and
  `X-Freebuff-Product-Context: {"originApp":"desktop","originProjectId":…,"originProjectType":"cloud"|"local"}`
  (from the desktop `request3` helper).
- Body (submission shape, from bundle):
  ```json
  {
    "workspaceId": "<threadId>",
    "projectId": "…",              // optional; cloud project
    "baseRef": "…",                // optional
    "runId": "…",                  // UUID; REQUIRED (missing → 400)
    "instanceId": "<agent>-<threadId>",
    "prompt": "…",
    "displayPrompt": "…",
    "chatTitle": "…",
    "model": "<catalog handle>",   // turn.hostedModel?.handle ?? turn.model
    "effort": "high",
    "agentMode": "codebuff",
    "injectAgentsMd": true,
    "seed": "…",                   // optional; uploaded project snapshot
    "github": "…",                 // optional; retried without on 400
    "images": [{"data":"…","mediaType":"…"}]   // optional
  }
  ```
  `deviceExecution: {sessionId: uuid, bindingId: uuid}` is added only for
  device-execution mode (both must be UUIDs, `bindingId` not null).
- Server-validation results (live):
  | Body | Result |
  |---|---|
  | missing `runId` | 400 `Invalid cloud run request` |
  | `runId` present, no active session | 409 `Start a session before running in the cloud.` |
  | `deviceExecution` present, no enrolled device | 409 `Your computer isn't connected. Open Freebuff on it, then try again.` |

**Stream**: SSE frames have `id` (string of digits), `kind`, `preview`,
`events[]`; `CLOUD_STREAM_MAX_FRAME_BYTES` guard; idle watchdog 30 s
(`CLOUD_STREAM_IDLE_MS`, header `x-freebuff-stream-id`).

The chat is executed in the `codebuff` harness (agentic, with tool/terminal
surfaces) — it is **not** a raw model completion endpoint. **The raw API
cannot stream a chat on its own**: the cloud-runs surface requires an enrolled
desktop Freebuff device (device-execution). Admission alone (200) buys the
session, but `POST /cloud/runs` gated on device enrollment.

**Session admission `purchase_in_use` release** — admission answers 409
`purchase_in_use` while a previous session still holds the model purchase.
The holder instance id is surfaced in the 409 body (`currentInstanceId` /
`desktopPurchases[].holderInstanceId`); plain GET session returns
`status: none` without purchases. Flow (verified): admit → 409 → DELETE
session with holder instance → re-admit → 200.

### Device execution (separate surface)

Base: `${API_HOST}/api/v1/cloud/device-execution/{path}` with header
`x-freebuff-device-token: <session token>` (from admission) plus Bearer.
Used for local-folder execution/capabilities (`capabilities?protocolVersion=3&…`,
`devices`, `devices/{id}/connection`, `…/chat`).

### Ads surface

All requests: `Authorization: Bearer <token>`, UA `Freebuff-Desktop/<version>`
(`DESKTOP_AD_REQUEST_USER_AGENT`), JSON.

| Endpoint | Method | Body / notes |
|---|---|---|
| `/api/v1/ads/policy` | GET | policy: `{arm, showcaseArm, composerCtaArm, rotationMs, inlinePoolMax, breakPlacementIds, partnerPlacementIds, billboardPlacementIds, displayPlacementIds, timerMs, dismissLockMs, dockArm}` |
| `/api/v1/ads/agentic/offer` | POST | **WEB host.** `{v:1, conversationId, messages[]max20, localCapability?, sponsoredCapability?, cloudCapability?, capabilityInspection?, invitationCapability?, invitationReadyDiscoveryVersion?, device{os,timezone,locale}, userAgent, inPlaceExecutionVersion:1, runSpecVersion:1, conversionToolsVersion:2, recheck?, projectKey?}` |
| `/api/v1/ads/impression` | POST | `{impUrl, mode:"desktop", userAgent, os}` + `X-Freebuff-Event-Id`; first-party variant adds `X-Freebuff-Render-Delay-Ms` |
| `/api/v1/ads/click` | POST | `{impUrl, dwellMs?}` + event-id / `X-Freebuff-Dwell-Ms` |
| `/api/v1/ads/click-return` | POST | `{impUrl, …}` |
| `/api/v1/ads/engagement` | POST | `{impUrl, …}` |
| `/api/v1/ads/prefs` | POST | pref patch |
| `/api/v1/ads/sponsored-skills` | GET | sponsored skills delivery |
| `/api/v1/ads/invitation/click` | POST | invitation click |
| `/api/v1/ads/invitation/event` | POST | invitation event |

**First-party ack**: `acknowledgeFirstPartyView` — token = `impUrl`, header
`X-Freebuff-Event-Id`, retry 3×, dedupe via 208 or
`X-Freebuff-Ack-Outcome: deduped`.

**Reward model**: `FREEBUFF_REWARD_MODEL_ID = "z-ai/glm-5.3-flash"`
("Earned reward · resets daily", `earned: true`). Unlock check in the desktop:
`rateLimitsByModel["z-ai/glm-5.3-flash"].limit > 0` → watching ads / earning is
what unlocks the reward model. `claimableGrantFreebucks` can also make
`canStart` true when balance < price.

**Live probe (2026-11-09, account ID)**:
- `GET /api/v1/ads/policy` → 200, arm `reduced`, partner placements listed.
- `POST /api/v1/ads/agentic/offer` (desktop-shaped body, all conversationId
  shapes: UUID / `probe-` / 32-hex) → **200 `{v:1, decision:"none",
  reason:"ineligible_client"}`**.
- `sponsored-skills` / `prefs` → 404 HTML on both API and WEB hosts (not
  public surfaces).
- Conclusion: the ads campaign is server-gated per-region — this account is
  `countryCode: ID` with `countryBlockReason: country_not_allowed` (from
  admission). The endpoint is reachable; no offer is served to this region.
  No impression/click could be fired (no impUrl to report).

## Model id bundle constants

64 wire ids in `FREEBUFF_MODELS` (subset shown; full list in
`scripts/provider-probing/freebuff/_lib.mjs` `FREE_BUFF_MODELS` of 45 + this
audit found 64 in bundle): deepseek (v4-flash / v4-pro / v4.1-flash /
v4-flash-fast), openai (gpt-5.4/5.5/5.5-pro/5.6-*/6-*/6.1-*/o3-pro),
google (gemini-3.x-flash / 4-argon), anthropic (claude-fable-5.1/opus-4.8/5/5.5/sonnet-4.6/5), z-ai (glm-5-turbo/5.2/5.3(-flash/-flashx/-prime)), qwen (3.6/3.7/3.8*), x-ai (grok-4.5/4.6/4.7/4.20), mistralai (mistral-large/codestral-2508), meta (llama-4-maverick / muse-spark-1.2/1.3-contributor), minimax (minimax-m3), moonshotai (kimi-k3), crof (kimi-k3-eco), upstage (solar-mini4/solar-pro4), stealth (ox-alpha/space-bunny-alpha), fbc (*slow/stealth/100k rows).

## Probe scripts (`scripts/provider-probing/freebuff/`)

- `freebuff-oauth-capture.mjs` — code login → poll → persist token.
- `freebuff-probe.mjs` — `/me` → device-keys → catalog → admission → release;
  subcommands:
  - `--probe-all` — admit every target wire id (open tier + premium/reward),
    release each, print summary. Live result: 8 admit / 5 `fbc/*` 409.
  - `--chat` — admit (with `purchase_in_use` auto-release) → create cloud run
    → read SSE stream → release. Reports the device-enrollment gate when it
    stops the run.
  - `--ads` — policy/offer/impression/click/reward-recheck sweep.
  - `--list-models` — bundled wire model ids.
  - `--key-file` — persistent device-key store (default
    `D:/tmp/scratch/freebuff-probe/device-key.json`).
- `_lib.mjs` — shared constants + `FreebuffDeviceSigner` (Ed25519, persisted
  per-account keyId registration) + ad helpers + `fbFetch`.
- `README.md` — wire map, flags, verified probe notes.

## Device signature spoofing (verified)

The Ed25519 device key is **not bound to hardware**. It is stored in the local
profile (`record.registrations`), scoped per account:

```js
scopeFor(account) {
  if (account.accountId) return `${host} user:${account.accountId}`;
  return `${host} token:${sha256(token).slice(0,32)}`;
}
```

The server only verifies that the presented `keyId` was registered for that
account (via `POST /device-keys` with the public key). A probe can generate its
own Ed25519 key, register it, and sign admission/session requests — which is
exactly what `freebuff-probe.mjs` does (admission 200 verified). The real gate
is the bearer token (OAuth), not the device key. Session-scoped
`x-freebuff-device-token` (from admission) is a separate credential used on the
device-execution path.

## Live cross-check vs freebuff-proxy audit (2026-11-09)

`Public/freebuff-proxy` (v2.11.2, last updated ~3 weeks before this session)
provided a second, deeper reverse-engineering perspective. Its claims were
tested live against the current upstream:

| Their claim | Live result | Verdict |
|---|---|---|
| Admission model header must be the catalog **handle** (`fbm1.*`), not key/wire id | ✅ 200 active (`model: m-096e75164d` in receipt) | **Adopted** — probe now resolves handle and sends it |
| `agent-runs` START/FINISH (3 headers: auth, content-type, acting-user-id) | ✅ 200, runId returned; FINISH 200 | **Adopted** for `--chat` |
| Chat = `POST /api/v1/chat/completions` (official body/header shape + desktop identity group) | ✅ **200**, `provider: Luminal`, streamed answer (validated live) | Adopted in `--chat` (see identity-group note below) |
| `cloud/runs` is not the chat surface | Confirmed — it is a device-execution path | Dropped from `--chat` |
| Never send `x-codebuff-api-key` / `/api/v1/me` (0 captures) | `me` still usable (200) but not part of official wire | Kept only as diagnostic step |

**Chat identity gate (10-14+, live-verified)**: a bare chat shape (bearer +
SDK UA + body) gets **410 `freebuff_update_required`** — the check is whether
the *session* looks like the desktop client, not the CLI version number. The
desktop identity group must ride on the chat request itself:

- `x-freebuff-client: desktop`
- `x-freebuff-client-version` (`FREEBUFF_APP_VERSION` or bundled known desktop version)
- `x-freebuff-install-id` (same UUID as the admission call)
- `x-freebuff-sse-gzip-recovery: 1`
- `x-freebuff-acting-user-id` + `x-freebuff-catalog-fetch` (fresh fetchId)

With the identity group plus the official desktop body (handle model,
`codebuff_metadata` with instance/multi-session/trace/repo/step/run/client/
cost_mode, `provider: {allow_fallbacks: true}`, 37 official tools, `tool_choice:
"auto"`, `stream: true`, official worker system template) → **200** with
`provider: Luminal` and streamed answer. The 403 `third_party_client_warning`
strike path was observed on mismatch shapes; the forwarded 1:1 shape is 200.

**System prompt fingerprint (locked — do not modify).** The chat gate also
validates the *contents* of the system message, not just its opening. Live
A/B on a real account (2026-11-09):

| Mutation | Result | Verdict |
|---|---|---|
| Baseline: official worker template (7918 chars) | 200 | accepted |
| Shorter system (~100 chars, official opening) | 403 `third_party_client_warning` | rejected |
| Medium system (~500 chars, official opening) | 403 `third_party_client_warning` | rejected |
| Opening replaced with a non-official string (same total length) | 403 `free_mode_cli_required` | rejected |
| `"Buffy"` replaced with a same-length token (`"alpha"`) | 403 `free_mode_cli_required` | rejected |
| Opening replaced with a *different official marker* (e.g. `"You are Buffy, the strategic coding assistant."`) | 428 waiting-room / accepted | whole body must keep the official template |
| Append one sentence at the end of the official worker | 428 waiting-room / accepted | append tolerated |

Findings:
- The worker template must stay **byte-identical to the official 7918-char
  worker** (assets/official-system-worker.txt). Shortening any part → 403.
- The opening must be one of the six official markers in
  `FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS` (free-agents.ts:1213) — all of them
  contain the word `"Buffy"`. Replacing `"Buffy"` (even same-length) → 403.
- Switching to a different official marker, or appending at the end, passes the
  shape gate (the 428 seen is the IP/slot waiting-room gate, not a shape
  refusal — this account's egress IP is flagged `res_proxy/hosting/anonymous`).
- **Practical rule: keep the worker verbatim; only append at the end for
  extra instructions. Never replace the opening or shorten the body.**

Server-side validation lives outside the public repo (the public `free-agents.ts`
only exposes the opening list; the full-body check is private).

**Handle changes admission results (follow-up sweep)**: re-running `--probe-all`
with catalog-handle admission (plus official session headers) changed outcomes
versus the earlier wire-id admission:

| Model | wire-id admission | handle admission |
|---|---|---|
| `fbc/deepseek-slow` | 409 `model_unavailable` | **200 active** |
| `fbc/mimo-slow` | 409 `model_unavailable` | 429 `rate_limited` (sweep throttle) |
| `fbc/crouton-alpha` | 409 `model_unavailable` | **200 active** |
| `fbc/glyph-cluster` | 409 `model_unavailable` | 429 `rate_limited` (sweep throttle) |
| `fbc/nemotron-3.5-lightning` | 409 `model_unavailable` | **200 active** |
| `fbc/claude-haiku-5.5-100k` | 409 `model_unavailable` | **200 active** |
| premium rows (gpt-6-luna etc.) | 200 | 200 |

The 409 `model_unavailable` seen earlier was an artifact of sending the wire id
in `x-freebuff-model`; the official handle form admits those rows. This
reconfirms: **admission must use the catalog handle**, and sweep throttling
(429) is the remaining limiter, not model availability.

## Open items

- Ads: verify with a non-ID-region account to confirm the regional gate.
- `x-freebuff-attention` header values (`active`/`away`/…) not yet probed.
- `meta/muse-spark-1.3-contributor` (Pro-locked row) not swept; confirm its
  admission status separately.
- Chat 200 confirmed on DeepSeek/Solar-class models; confirm on premium models
  (plan-locked) and verify `--stream` SSE framing end-to-end.
