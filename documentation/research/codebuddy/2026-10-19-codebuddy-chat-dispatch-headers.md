# CodeBuddy chat dispatch — which headers are actually required

Measured against `https://www.codebuddy.ai/v2/chat/completions` with a real
CodeBuddy intl (`cb`) OAuth access token, on 2026-10-19.
These are dated observations; revalidate before treating them as a current
upstream guarantee.

## The three required headers

Exactly three. A chat request missing any one of them is refused with
`400 · 11-128` and `"msg":"request illegal"`.

| Header | Required |
|---|---|
| `x-conversation-id` | **yes** |
| `x-conversation-request-id` | **yes** |
| `x-conversation-message-id` | **yes** |
| B3 set (`x-b3-traceid`, `x-b3-spanid`, `x-b3-sampled`) | no |
| W3C `traceparent` | no |
| `x-request-id`, `x-root-request-id`, `x-trace-id` | no |
| stainless set (all eight) | no |
| agent block (`X-Agent-Intent/Type/Runtime`, `X-Private-Data`) | no |
| IDE block (`X-IDE-Type/Name/Version`, `User-Agent`) | no |
| `X-Product`, `X-Domain`, `X-Requested-With`, `X-CodeBuddy-Request` | no |

Method: build the full client-shaped header set, then remove one header at a
time and dispatch. Removing any of the three gives `11-128`; removing any
single one of the others still answers 200.

The requirement is **turn-shaped, not id-shaped**: sending
`x-conversation-id: ""` is also refused. So the fix for a caller with no
session is to send a generated id, not to forward a blank value.

## Why this went unnoticed

`11-128` names neither the header nor the channel, so it reads like a block.
Every real client carries a session id, so only a dispatch with **no** inbound
session ever hits it — which is exactly the shape a raw probe takes.

## Two errors that look alike but are not

```
11-128  "request illegal"                                  → missing/blank conversation header
11101   "Non-stream chat request is currently not supported" → needs stream: true
11102   "model [...] service info not found"                 → model not served
11158   "model [X] is not allowed for user type [personal_free_user]" → tier refusal
```

The first three are request-shape problems. Only `11158` is a tier refusal, and
it is the signal a "pro only" marker has to key on.

## Dispatch prerequisites

Beyond headers, the request itself must be:

* `stream: true` — a non-stream chat answers `11101`.
* **first message `role: "system"`** — otherwise `11-128` with
  `"msg":"first message is not system prompt"`, which is the same code as a
  missing header and is easy to misread as one.

## Model tier on a free account (`personal_free_user`)

Probed every id in `GET /v3/config` (20 rows) by dispatching a minimal turn.
Reproduced twice; results are identical.

| Result | Models |
|---|---|
| **Refused** (`11158`, pro only) | `primary-model`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gemini-3.5-flash` |
| **Not served** (`11102`) | `deep-model` |
| Allowed | `default-model`, `fast-model`, `balanced-model`, `deepseek-v4.1-flash`, `deepseek-v4.1-flash-sg`, `hy4-preview`, `hy3`, `kimi-k2.8-preview`, `glm-5.3-flash`, `glm-5.3`, `glm-5.2`, `kimi-k3`, `kimi-k2.6` |

`/v3/config` has **no field that predicts this**. Verified:

* `credits` does not — `kimi-k3` is `x1.62` and allowed, `gpt-5.6-luna` is
  `x0.14` and refused; `hy3` is `x0.00` and allowed, `gemini-3.5-flash` is
  `x0.99` and refused.
* `vendor` does not — `glm-5.3` is `e` and allowed, `gpt-5.5` is `e` and
  refused.

So tier is only knowable from a dispatch (`11158`) or from the account type.
A catalog field cannot stand in for it.

## Note on the CN reference

`Public/codebuddy2api` targets `www.codebuddy.cn`. Its billing paths
(`/v2/billing/meter/get-user-resource` and siblings) answer **404** on the intl
host — the regions do not share them.
