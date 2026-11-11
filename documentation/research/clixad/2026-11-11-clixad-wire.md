# Clixad wire — live verification ledger

Date: 2026-11-11
Method: probing `https://clixad.onrender.com` with the reconstructed
`scripts/provider-probing/clixad/probe-clixad.ts` probe. A real account was
created via the GitHub device flow (per the operator's instruction), and all
fields below were observed live. The token was stored only in
`D:\tmp\scratch\clixad-accounts.json` (outside the repo) and never printed in
full; stdout showed masked prefixes only.

## Account (live, via device flow)

- `POST /v1/auth/device/start` → `{session, user_code, verification_uri,
  expires_in, interval}`. Observed: `expires_in: 899`, `interval: 5`,
  `verification_uri: https://github.com/login/device`, user code `XXXX-XXXX`.
- `POST /v1/auth/device/poll {session}` → after browser approval:
  `{status: "complete", token, userId, email, login, balance, created: true,
  signupBonus, default_model}`.
  - Observed: `userId` UUID, `email`, `login` (GitHub handle),
    `balance: 25000`, `signupBonus: 25000`, `default_model: deepseek-v4-flash`.
  - Token prefix observed: `adg_…` (52 chars; shape `adg_5b22…`).
- `POST /v1/auth/handoff` → `{code}`; the ad wall is then opened at
  `{dashboardUrl}/?c=<code>`. Verified live: a one-time code mints (60 chars).

## Wallet (`GET /v1/wallet`) — observed fields

```
balance: 25000
ads_today: 0
earned_usd_today: 0
screenouts_today: 0
screenout_credits_today: 0
max_reward_usd_per_day: 5
daily_cap_usd: null
grant_per_ad: 40800
rewards.feedback_credits: 500
rewards.feedback_credits_free: 250
rewards.feedback_max_credits_per_day: 1500
free_tier.models: [gpt-5-nano, gemini-2.5-flash-lite, claude-haiku-5.5,
                   deepseek-v4-flash, gemini-3.5-flash-lite]
free_tier.daily_credits: 120000
free_tier.credits_left: 120000
free_tier.turns_left: {gpt-5-nano: 500, gemini-2.5-flash-lite: 307,
                        claude-haiku-5.5: 290, deepseek-v4-flash: 247,
                        gemini-3.5-flash-lite: 82}
free_tier.recommended: deepseek-v4-flash
ledger: [{id, userId, delta: 25000, reason: "signup_bonus",
          balanceAfter: 25000, meta: {}, ts}]
```

## Models (`GET /v1/models`) — observed fields per model

14 models live. Per-model shape (observed):

```
id, label, provider, tier ("cheap"), ad_fundable: true, access ("budget"),
context_window (number; e.g. 400000, 1048576, 24000),
credits_per_mtoken_input, credits_per_mtoken_output,
est_credits_per_task, est_ads_per_task,
free: true, efforts: [...], default_effort, auto_mode: boolean
```

Top-level extras: `capabilities` (web_search flag), `premium_unlock_usd`,
`web_search_credits`, `task_shape`, `retired_models`, `cli_latest`.

## Chat (`POST /v1/chat/completions`) — verified live

Request (OpenAI-compatible): `{model, messages, stream, tools?,
reasoning_effort?}` with `Authorization: Bearer <token>`.

Non-stream response observed:

```
choices[0].message, choices[0].finish_reason
clixad.credits_charged
clixad.balance
clixad.free === true → clixad.credits_waived, clixad.free_credits_left
clixad.spendable → {budget, premium, budget_after_reset}
```

Stream (SSE `data:` frames, `[DONE]` terminator) observed with `stream: true`
on `deepseek-v4-flash`: live chunk stream, `finish_reason: "stop"`,
`credits_charged: 0`, `balance: 25000`, `free.credits_waived: 1`,
`free.free_credits_left: 119999`. The free tier waives the call while the
daily allowance lasts.

## Referral (`GET /v1/referrals`) — observed

```
code: "QBRGZ4GP" (10 chars)
invited: 0, credited: 0, credits_earned: 0
remaining: 20, max_credited: 20
inviter_credits: 5000, invitee_credits: 5000
```

## Billing (`GET /v1/billing/packs`) — observed

```
enabled: true
packs: [
  {id: mini,    credits: 280000,  price_usd: 3},
  {id: starter,  credits: 500000,  price_usd: 5},
  {id: plus,     credits: 1650000, price_usd: 15},
  {id: pro,      credits: 6000000, price_usd: 50},
]
```

## Streak (`POST /v1/streak/claim`) — observed

```
day: 1, credits: 200, claimed: true, balance: 25200 (25000 + 200)
schedule: [200, 300, 400, 500, 700, 900, 1000], length: 7
```

## Sponsor / ad network — observed

`GET /v1/sponsor/config?direct=1`:

```
provider: "adtention"
publisher_id: "pub_f87943f682dfd7b0"
formats.top_bar.publisher_id == publisher_id
formats.sidebar_card.publisher_id: "pub_3a3ad46ec978f7c6"
formats.status_bar.publisher_id: "pub_584e43f110d90bb0"
category: "devops"
subject: (64-hex content-hash-like string)
dwell_ms: 15000
```

`POST /v1/sponsor/direct {formats, cols}` — observed (no booked lines, only
fallbacks):

```
supported: true
lines: [] (no paid slots booked for this account/session)
fallbacks: [
  {format: sidebar_card, text: "Railway: $20 credits when you sign up",
   serve_token: <jwt-ish: eyJz… signed>, click_url: "https://app.clixad.io/r/railway/c"},
  {format: status_bar, text: "$300 Vultr credit to test, 30 days",
   serve_token: <jwt-ish>, click_url: "https://app.clixad.io/r/vultr/s"},
]
measure: <signed token: eyJp…>  (payload includes date + formats + exp)
```

Note: the `serve_token` values are compact signed tokens (`eyJ…` base64url
header.payload.signature) minted by the ad server; they expire (`exp` inside).
The fallback lines are house/affiliate lines that earn nothing (tracked via
`/v1/sponsor/affiliate/impression`, counted not credited).

## Not exercised (needs care)

- `POST /v1/billing/checkout` (would start a paid Stripe purchase with the
  §356(5) BGB consent — not run).
- `/v1/sponsor/impression`, `/v1/sponsor/direct/impression`,
  `/v1/sponsor/direct/views` — reporting endpoints; not run because they
  mutate sponsor credit state.
- `POST /v1/redeem` — needs a code.
- `POST /v1/feedback` — not run (would send a rating).
- `POST /dev/users` — dev signup; not needed (real account exists).
- `GET /v1/web/search` — not run yet; zero-cost catalog probe is safe.
