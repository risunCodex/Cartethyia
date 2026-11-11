# Qoder — identity, daily credits, and activity claims

Durable knowledge for Qoder account work (both realms — intl and CN): where
identity comes
from, which claim surfaces exist, what has been proven dead, and the
verification order for a new claim path. The full evidence trail lives in
[`documentation/research/qoder/archive/qoder-research-archive-2026-11-11.zip`](../../../documentation/research/qoder/archive/qoder-research-archive-2026-11-11.zip) (`2026-11-05-qoder-credits-claims-identity.md`)
and [`documentation/research/qoder/2026-11-05-qoder-cosy-signing-machine-identity.md`](../../../documentation/research/qoder/2026-11-05-qoder-cosy-signing-machine-identity.md).

**Two realms** (`src/providers/integrations/qoder/qoder-realm.ts`): intl
(`api1/api2/api3.qoder.sh`, `openapi.qoder.sh`, client id `e883ade2-…`) and CN
(provider id `qodercn`, `gateway.qoder.com.cn`, `openapi.qoder.com.cn`, client
id `e93fe488-…`, UA `QoderWork/1.1.64`). Dispatch prefers the modern IDE chat
surface (`https://api2-v2.qoder.sh/model/v1/chat/completions`, plain bearer,
OpenAI-shaped) over the legacy COSY path; `/algo/**` COSY signing applies to
the legacy path only. The device-login identity match (alphabet, client ids,
machine id) is byte-for-byte with the desktop IDE, and the PKCE verifier is a
fixed 64 chars from `randomBytes` (CSPRNG, RFC 7636).

## Identity

- **OS-derived identity** (`P1gA…`-shaped machineToken, hex `machineType`/`machineCode`)
  is derived from the host OS fingerprint + account uid (donor-style
  deterministic derivation: UUIDv4-shaped machine id, base64url token,
  18-hex type/code). The vendor bridge (`umidpack` / `runtime-info`) is no
  longer vendored or executed; see
  `src/providers/integrations/qoder/qoder-umid.ts`. Per-host stable, per-account
  isolated via the uid salt. **CORRECTED 2026-11-04:** the genuine bridge token
  WAS required for CREDITS campaign visibility — earlier same-account controls
  that suggested generated/random/empty machine headers expose the grant were
  wrong for the current campaign. The OS-derived identity keeps the bridge
  token shape and is sent as the full machine-header set; the legacy generated
  fallback (source `"generated"`) omits `cosy-machinetoken/type/code` to avoid
  the upstream filter (donor issue #10).
- The daily-credits claim is the IDE's plain `Bearer` (device token, or a
  PAT↔job token) + machine headers — **no WASM signing needed**. `machineId`
  is platform-specific: serial-hex on macOS/ELF, a cached UUID on Windows
  (`%APPDATA%/Qoder/cache/machine_token.json` → `id`), and a placeholder
  machineId yields `403 Signature invalid`.
- Device-login `dt-…`/`drt-…` tokens carry neither user id nor machine id;
  both travel in `auth_state` and every COSY-signed dispatch needs both.
- A PAT (`pt-…`) is exchanged for a job token (`jt-…`) before COSY signing:
  `resolveQoderAuth` (`qoder.ts`) is the only exchange authority; re-exchange
  invalidates the previous `jt-…`, so reuse one identity per process, not one
  per request. The exchange binds machine identity (`machine_id` +
  `machine_token`) like the real client.

## Claim surfaces

| Surface | Path(s) | Host | Status |
| --- | --- | --- | --- |
| Daily 100 credits (campaigns) | `GET /sash/api/v1/me/campaigns`, `POST …/{id}/claim`, `GET …/{id}/reward` | `openapi.qoder.sh` (intl; CN realm: `openapi.qoder.com.cn`) | Working; 404 `GRANT_NOT_FOUND` means the *provision* is absent, not the request |
| Legacy daily check-in | `GET /sash/api/v1/me/daily-check-in/status`, `POST …/claim` | same realm host | Legacy surface alongside campaigns (`qoder-checkin.ts`) |
| Activity claim family | `GET /algo/api/v2/activity` (Inference), `GET /api/v2/activity/claim/eligibility`, `POST /api/v2/activity/claim?activityId=`, `GET /api/v2/activity/quota/reset/latest` | `api2.qoder.sh` / `openapi.qoder.sh` | Live and callable; ids are **server-provisioned** — the client never enumerates them |
| Pro trial (`pro-upgrade/eligibility`, `pro-upgrade/claim`) | `openapi.qoder.sh` | — | **Dead** (404 in every identity shape tested); superseded by the activity family |

## Signing rules

1. **COSY Bearer** (`qoderSignerFor` in `qoder.ts`) is the scheme for
   `/algo/**` inference and model paths, and it has a trap: for a GET, sign the
   **empty string**, not a scrambled `"{}"` body — a `{}`-signed body with no
   content answers 403 `Signature invalid`, and POSTing the scrambled GET body
   answers `400 Request method 'POST' not supported`. Model-list GETs that send
   a body are the exception, not the rule.
2. **Gateway HMAC "Signature"** (unpacked client's shared process): secret is
   `sha256("cosy:" + ideVersion + ":" + machineToken)`, the signed body hash is
   sha256 of the **content-length string**, and the path is signed with the
   leading `/algo` stripped. Headers `X-Request-Id`, `X-Client-Timestamp`,
   `Authorization: Signature <sig>`. Not yet needed by Cartethyia — record, do
   not implement speculatively.
3. **Go static headers** (`qoderStaticHeaders`): `appcode`, `date`,
   `signature = md5("cosy&<b64secret>&<date>")`. Already proven.
4. Region endpoints live at
   `GET https://center.qoder.sh/algo/api/v2/service/region/endpoints`
   (`inferNodes` → `api2.qoder.sh`); pin hosts through that table, not by hand.

## Provisioning — proven server-side

Missing grants and trial activities remain server-provisioned. The tested
fresh-account matrix did not establish why an account is provisioned, and the
desktop IDE's full bootstrap stream remains untested. For daily CREDITS, check
grant presence and daily-window timing separately from device identity; the
same-account header controls are recorded in the research note.

## Order of verification for a claim question

1. `GET /sash/api/v1/me/campaigns` (bearer `dt-…` or exchanged `jt-…`, with
   the **real UMID machine headers** — required for CREDITS visibility) — is
   the CREDITS campaign visible, and what is `claimStatus`? Probe-style safety
   applies: never claim without an explicit `CLAIMABLE`.
2. Only shapes with `CLAIM_BENEFIT`/`CREDITS` proceed to `POST …/claim`
   (body `{}`, `campaignId` UUID — `campaignKey` alone returns 400).
3. `GET /algo/api/v2/activity` (COSY, empty-signed GET) + `claim/eligibility`
   only when a NEW activity id has to be found.
4. Persist refreshed tokens and identity back to the account file after every
   exchange; never report a claim without the persisted state.
5. When a wire guess 403s or the campaign is hidden, cross-check the donor
   reimplementation repo `Public/qoder2api-hub` (`qoder_accounts.py`,
   `qoder_sign.py`) before more live probing.

## When touching this code

Keep `qoder-umid.ts` (OS-derived mint), `qoder-oauth.ts` (device flow), and the
`NativeIdentityRecord` persistence schema aligned; migration parity across
`migrations/lite-sqlite3/` and `migrations/full-postgres/` is enforced by
`test/persistence/sqlite-baseline.test.ts`. Verify downstream with the real
device flow plus one signed request — typecheck proves shape, not grant state.
