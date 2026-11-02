# Qoder web-console PAT surface (browser session)

Verified live 2026-11-02 on `https://qoder.com` with an exported browser
session cookie (Netscape cookies.txt) for the `pleged lenger` account.

## Endpoints (host `https://qoder.com`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/me` | account profile (id, name, email) |
| GET | `/api/v1/me/integrations` | integration states (`{github: disconnected}` shape) |
| GET | `/api/v1/me/personal-access-tokens?page=1&page_size=50` | list PATs |
| POST | `/api/v1/me/personal-access-tokens` | create PAT |
| DELETE | `/api/v1/me/personal-access-tokens/{token_id}` | revoke PAT |

These are the **web-console** APIs (`qoder.com`), not the chat/gateway APIs
(`openapi.qoder.sh`, `api1/2/3.qoder.sh`). `openapi.qoder.sh/api/v1/me` is
401 with these cookies; only `qoder.com` serves the console session.

## CSRF (required for POST/DELETE)

The console uses double-submit CSRF. Every mutation must send **both**:

1. Header `X-CSRF-TOKEN: <window.csrfToken>` — injected into an inline script on
   each page (`/account/integrations`).
2. Cookie `qoder_csrf_token=<value>` — set via `Set-Cookie` on the same page
   load. The cookie and header must agree.

`GET`s work with the session cookie alone. A POST with the header but without
the cookie (or vice versa) returns `CSRFInvalid` (400).

## PAT shape

Create request: `{ name: string, expires_at: number }` where `expires_at` is a
Unix millisecond epoch. The console date picker caps it at **1 year from today**
(`disabledDate` rejects anything after `+1 year endOf day`); a later value is
rejected by the server.

Create response (201): `{ token_id, name, token, created_at, expires_at,
is_expired }`. The `token` value is the PAT (`pt-…`, 64 chars) and is returned
**only once** — the UI warns it cannot be recovered. Store it at creation.

List response: `{ personal_tokens: [{ token_id, name, created_at, expired_at,
is_expired }], pagination }`. Note the key is `expired_at` (past participle) in
list rows but `expires_at` in the create request/response.

## PAT vs device token

- PAT (`pt-…`): minted in the web console; exchanged by the adapter
  (`exchangeQoderPat`) into a short-lived job token (`jt-…`) per request.
  Durable up to 1 year.
- Device token (`dt-…`): issued by the OAuth device flow; used directly with
  `auth_state` identity.

Live check: a PAT minted this way authenticated on both the modern
`/model/v1` surface and the legacy COSY surface for the same account. On the
free-tier `pleged lenger` account the modern surface still answers `402` /
`{"code":116,"error":"quota exceeded"}` — the entitlement refusal is an
account-state property, not a token-kind property — so dispatch falls back to
legacy COSY for free-tier models.

## Automation

`scripts/provider-probing/qoder/qoder-browser-pat-claimer.ts` implements the
full flow: reads the Netscape cookies.txt, fetches the CSRF pair fresh, and
supports `--list`, `--create --name … --days N --out <path>`, and
`--revoke <token_id>`. The minted PAT is written only to `--out`.
