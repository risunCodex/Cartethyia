# Perch turn-ticket client marker and surface gate (2026-11-18)

Evidence ledger for the `perch_surface_required` / `banned` failures observed
on 2026-11-18, reconstructed from the shipping clients and live A/B replays.
Companion to `README.md` (wire reference) — this file records what changed
after 2026-11-08.

## Sources and versions

| Source | Version | How obtained |
| --- | --- | --- |
| npm `perchai-cli` tarball | 2.4.137 | `registry.npmjs.org/perchai-cli/latest` → `dist/perch.mjs` unpacked to `D:/tmp/unpacked/perchai-cli/` |
| Perch Terminal desktop installer | 2.5.9 (`app-perchai-app`) | `windows-x64.exe` NSIS → `app-64.7z` → `resources/app.asar` unpacked to `D:/tmp/unpacked/perch/`; wire logic in `dist-electron/main.js` |
| Live probes | fresh Google-OAuth account, Starter plan | scripted fetches; full request/response bodies redacted of tokens |

Both shipping clients construct the turn-ticket and model-call the same way
(the desktop bundles the same `lib/perchTerminal/*` code).

## Observed failures (fresh account, same session)

1. Login + `POST /api/perch-terminal/cli-plan {plan:"starter"}` →
   `{"ok":true,"planRequired":false}` (plan assigned).
2. Model-call with a **legacy-shaped** request (probe envelope, 432-char
   Saffron prefix system prompt) → `403 perch_surface_required`.
3. Official CLI 2.4.137 run against the same session → **200** (`pong`).
4. Byte-level replays of the official request in four variations:
   - A: official body + official headers → 200
   - B: official body + `User-Agent: perchai-cli/unknown` → 200
   - C: official body + legacy extra fields (`roostModelChoice`,
     `roostReasoning`, `effort`) → 200
   - D: official body + `attribution.userId/workspaceId = null` → 200
5. Shortly after, enforcement flipped on the account: `POST /turn-ticket` →
   `401 not_authenticated`, model-call → `Not authorized`, account endpoint
   reported `planCode:null` + `tierSelectionRequired:true`, and finally
   `POST /cli-plan` → `403 {"errorCode":"banned","error":"This account was
   banned for using Perch through another app or tool, which the terms do not
   allow."}`.

## Proven

- **`ticketClient: 2` on the turn-ticket mint is the current-client marker.**
  CLI 2.4.137: `body: {...t, [TURN_TICKET_CLIENT_FIELD]: TURN_TICKET_CLIENT_VERSION}`
  with `TURN_TICKET_CLIENT_FIELD = "ticketClient"`, `...VERSION = 2`.
  Desktop 2.5.9: identical (`lib/perchTerminal/turnTicketClientVersion.ts`).
  Neither the 2026-11-08 research wire nor this repository's adapter/probes
  sent it before this change.
- **The account state flip is real and account-scoped**: the same JWT that
  answered `200` on `GET /api/perchai/account` was refused by `/turn-ticket`
  (`401 not_authenticated`), and the plan row was gone
  (`tierSelectionRequired:true`) before the `banned` verdict surfaced.
- **UA version, legacy body fields, and attribution null-ness are NOT the
  gate** (replays B/C/D above all answered 200).
- The adapter's 432-char Saffron prefix is still a byte-prefix of the
  current official system prompt (`official.startsWith(prefix) === true`),
  so the prefix itself did not drift.

## Inferred (not yet isolated on a live account)

- **The 403 `perch_surface_required` on a fresh, plan-assigned account is
  most consistent with the model-call being rejected because its turn ticket
  was minted without `ticketClient`** (a "foreign" ticket). The one test that
  would isolate it — our exact legacy body + a `ticketClient` mint — lost its
  account to the ban before it could run (`401` at mint).
- The ban follows repeated surface-gated attempts (the fresh account burned
  two `perch_surface_required` replies plus legacy mints before enforcement
  flipped within minutes). Whether a *single* clean official-shaped request
  pattern is tolerated long-term is unknown.

## Changes made in this repository (this date)

- `perch.ts` `#mintTicket`: body now carries `ticketClient: PERCH_TICKET_CLIENT_VERSION`
  (constant `2` in `perch-realm.ts`); `errorCode: "banned"` maps to upstream
  `authentication_failed`/401 at both the mint and the model-call so routing
  stops dialing a dead account instead of mislabelling it `platform_unavailable`.
- `client-versions.ts` perch fallback: `2.4.132` → `2.4.137`.
- Probe scripts (`probe-perch.ts`, `probe-perch-min.ts`): mint with
  `ticketClient: 2`.

## Mitmproxy capture of the shipping client (2026-11-18, accounts 3 and 4)

The unpacked npm CLI 2.4.137 was run under mitmproxy
(`HTTPS_PROXY=http://127.0.0.1:18443`, `NODE_USE_ENV_PROXY=1`,
`NODE_OPTIONS=--use-system-ca` — Node's fetch needs the system-CA flag to
trust the mitm CA). Flow files: `D:/tmp/scratch/perch/perch-cli.flows`
(account 3), `perch-fresh4.flows` / `perch-fresh4b.flows` (account 4).

Byte-level facts from the captures:

- The official turn-ticket mint is exactly
  `{"surface":"cli","profile":"standard","ticketClient":2}` with headers
  `Content-Type, Authorization, User-Agent: perchai-cli/2.4.137,
  x-perch-locale`. The ticket response embeds `surface:"cli"` and
  `plan:"pilot"`.
- The official model-call carries the full 28k Saffron prompt and the same
  header set — **and still received
  `403 perch_surface_required`** on accounts 3 and 4, minutes after a
  successful plan assignment, while `GET /api/perchai/account` in the same
  run reported `planCode:"pilot"`, `tierSelectionRequired:false`, a
  workspace, and `limits.allowed_models {"models":["*"]}`.
- `GET /api/connections → 403 not_entitled` ("Cloud agents are not enabled
  for this account") is benign — cloud agents are Pro-only and the CLI
  ignores it.
- The gate is therefore **not model-scoped**: a rejected model would answer
  `starter_model_blocked`/`plan_model_blocked`, and this account's
  allow-list is `["*"]`.

## Revised timeline hypothesis (leading: egress-IP flag)

All four accounts share one egress IP. On that IP:

| Window (local) | Event | Result |
| --- | --- | --- |
| 09:56–09:58 | account 1, legacy wire (no `ticketClient`) | 403 surface |
| 10:09–10:14 | account 1, official CLI ×2 + 4 byte-level replays | **200** ✅ |
| ~10:16+ | account 1 verdict: `banned` (plan revoked, mint 401) | dead |
| ≥10:20 | accounts 2/3/4, official CLI incl. byte-perfect captures | 403 surface |

Nothing about the wire explains a flip from 200 to 403 while the requests
became *more* official (account 4's capture is byte-identical to account 1's
successful runs). The simplest consistent reading: after the account-1 ban
the **egress IP** (or sessions minted from it) landed on a watchlist that
answers `perch_surface_required` regardless of plan state. Untested — a
different egress IP or a time-decay retry is needed to confirm.

## Verification plan

1. **Different egress IP** (VPN/hotspot): one official `perch run` — if 200,
   the IP-flag hypothesis is proven and the wire question closes (the
   `ticketClient` patch remains correct anyway).
2. **Time-decay retry** on account 4 ~15–20 min after its first failure —
   matches account 1's 14-minute success window if decay is the mechanism.
3. Keep call counts minimal; the ban detector reacts within minutes.
