# Qoder — identity, daily credits, and activity claims

Durable knowledge for Qoder (intl realm) account work: where identity comes
from, which claim surfaces exist, what has been proven dead, and the
verification order for a new claim path. The full evidence trail lives in
[`documentation/research/qoder/2026-10-29-qoder-credits-claims-identity.md`](../../../documentation/research/qoder/2026-10-29-qoder-credits-claims-identity.md)
and [`documentation/research/qoder/2026-11-01-qoder-chat-wire-verification.md`](../../../documentation/research/qoder/2026-11-01-qoder-chat-wire-verification.md).

## Identity

- **Native identity** (`P1gA…` machineToken, hex `machineType`/`machineOs`) is
  minted by the vendor bridge. Keep it in
  `src/providers/integrations/qoder/qoder-umid.ts` (`umidpack` binaries in
  `vendor/qoder-umid/umidpack/`, seeds replayed there). Same-account controls
  found that generated, random, empty, and omitted machine headers all expose
  an existing daily CREDITS grant. Identity does not create a missing grant.
- Device-login `dt-…`/`drt-…` tokens carry neither user id nor machine id;
  both travel in `auth_state` and every COSY-signed dispatch needs both.
- A PAT (`pt-…`) is exchanged for a job token (`jt-…`) before COSY signing:
  `resolveQoderAuth` (`qoder.ts`) is the only exchange authority; re-exchange
  invalidates the previous `jt-…`, so reuse one identity per process, not one
  per request.

## Claim surfaces

| Surface | Path(s) | Host | Status |
| --- | --- | --- | --- |
| Daily 100 credits | `GET /sash/api/v1/me/campaigns`, `POST …/{id}/claim`, `GET …/{id}/reward` | `openapi.qoder.sh` | Working; 404 `GRANT_NOT_FOUND` means the *provision* is absent, not the request |
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

1. `GET /sash/api/v1/me/campaigns` (bearer `dt-…`, machine headers optional
   for the tested CREDITS surface) — is the
   CREDITS campaign visible, and what is `claimStatus`? Probe-style safety
   applies: never claim without an explicit `CLAIMABLE`.
2. Only shapes with `CLAIM_BENEFIT`/`CREDITS` proceed to `POST …/claim`.
3. `GET /algo/api/v2/activity` (COSY, empty-signed GET) + `claim/eligibility`
   only when a NEW activity id has to be found.
4. Persist refreshed tokens and identity back to the account file after every
   exchange; never report a claim without the persisted state.

## When touching this code

Keep `qoder-umid.ts` (mint/replay), `qoder-oauth.ts` (device flow), and the
`NativeIdentityRecord` persistence schema aligned; migration parity across
`migrations/lite-sqlite3/` and `migrations/full-postgres/` is enforced by
`test/persistence/sqlite-baseline.test.ts`. Verify downstream with the real
device flow plus one signed request — typecheck proves shape, not grant state.
