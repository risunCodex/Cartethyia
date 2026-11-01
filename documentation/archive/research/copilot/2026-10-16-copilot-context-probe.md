> # ARCHIVED â€” UNTRUSTED
>
> This file was archived on 2026-10-23. It is a **point-in-time record**, not a
> description of current behavior: every `file:line`, symbol, path, and
> measurement below was true when it was written and has not been kept in sync.
> Do not read it to answer a question about the current codebase, and never cite
> it as evidence. See the [project README](../../../README.md).

# Copilot context probe, 2026-10-16

Measured directly against `api.individual.githubcopilot.com`, without a gateway,
from an Individual account. The token is not recorded here. To reproduce, use the
same account credentials: decrypt `provider_accounts.credential_ciphertext` for
`provider_id = 'github'`; the layout is `iv(12) + tag(16) + ciphertext`.

## Request method

Two steps. `/auto` selects a model and returns a session token. Inference uses
that token.

```text
POST https://api.individual.githubcopilot.com/auto
{"prompt": "Reply pong.", "tier": "efficiency" | "balance" | "intelligence"}

-> {"selected_model": {...}, "session_token": "..."}
```

```text
POST https://api.individual.githubcopilot.com/responses
Copilot-Session-Token: <session_token>
{"model": "<selected_model.id>", "input": [{"role": "user", "content": "..."}],
 "max_output_tokens": 16, "stream": false}
```

`gpt-6-luna` and `mai-code-1.1-flash` both reject with `model_not_supported`
when called without a session token. Both only work inside an auto session.

## Header

Every request, both steps:

```text
authorization: Bearer <copilot access token>
content-type: application/json
user-agent: GitHubCopilotChat/0.70.0
editor-version: vscode/1.142.0
editor-plugin-version: copilot-chat/0.70.0
copilot-integration-id: vscode-chat
openai-intent: conversation-agent
x-initiator: user
x-interaction-type: conversation-agent
x-github-api-version: 2026-08-01
x-request-id: <unique per request>
```

Inference adds `Copilot-Session-Token`. HTTP is case-insensitive, but the bundle
spells it exactly that way.

`x-github-api-version` is proven, not assumed:

| Endpoint | `2026-01-09` | `2026-08-01` |
|---|---|---|
| `/chat/completions` (gpt-4o-mini) | 200 | 200 |
| `/responses` (gpt-6-luna, no session) | 400 model_not_supported | 400 model_not_supported |
| `/auto` | 404 `invalid apiVersion` | 200 |

The `2026-01-09` present on one path of the Copilot Chat 0.70.0 bundle is rejected
by `/auto`. `2026-08-01` is accepted.

## Historical prompt limits (2026-10-16)

The [newer Auto routing note](2026-10-30-copilot-auto-routing.md)
records the current tier-to-model probe. This older measurement is retained
for its prompt-limit data, not as evidence of current tier assignments.

| Model | Catalog context | Historical prompt limit |
|---|---|---|---|
| gpt-6-luna | 1,000,000 | 872,000 (untested, see below) |
| mai-code-1.1-flash | 256,000 | 128,000 |

mai-flash output is 128,000, so context 256,000 = prompt 128,000 + output
128,000. Luna output is 128,000, and 1,000,000 âˆ’ 128,000 = 872,000, matching the
`max_prompt_tokens` the catalog reports.

## mai-flash prompt limit, one session

`intelligence` session, model `mai-code-1.1-flash`, prompt filled with a
repeating `alpha `.

| Characters | Prompt tokens | Result |
|---|---|---|
| 100,000 | 16,676 | pass |
| 400,000 | 66,676 | pass |
| 700,000 | 116,676 | pass |
| 760,000 | 126,676 | pass |
| 768,000 | 128,004 | 400 `prompt token count of 128004 exceeds the limit of 128000` |
| 770,000 | 128,337 | 400, same limit |

Compaction is requested exactly at 128,000 prompt tokens. No extra field is
needed to get that limit.

## Luna

`efficiency` session, prompt `Halo haii!`, selects `gpt-6-luna`. A short request
succeeds. A large prompt is rejected with `503 model_overloaded`, and the cutoff
is sharp, so this is not a busy model:

| Characters | Prompt tokens | Result |
|---|---|---|
| 30,000 | 5,010 | pass |
| 35,000 | 5,843 | pass |
| 36,000 | 6,010 | pass |
| 36,500 | 6,093 | pass |
| 37,000 | â€” | 503 `model_overloaded` |
| 40,000 and up | â€” | 503, same |

That is the limit for a single request with repeating content. A growing
conversation differs: each turn resends the entire history, `stream: true`,
`store: false`. Tokens rise by 4,820 per turn (4,815, 9,635, 14,455, â€¦) and the
server never requests compaction. One 200,000-word request passes at 800,010
tokens. 218,000 words is rejected: `prompt token count of 872004 exceeds
the limit of 872000`. The ceiling enforced is exactly the catalog's
`max_prompt_tokens`, not 6,000.

The bundle does not switch on overload. `model_overloaded` is only mapped to a
"high demand" message. The auto cache is invalidated only after the conversation
is compacted (`invalidateRouterCache`); the next request then selects a new model.
There is no re-route mid-request.

The session token is also not conversation memory, including while streaming.
Three consecutive `stream: true` requests, each 45,000 characters with different
content, using the same token, each reported `input_tokens: 15009`. The number
does not rise. The bundle sends `store: false`, so the server keeps no turns.
Compaction happens on the client.

## Compaction and re-routing in VS Code

Both are client decisions, not server responses.

Compaction: before sending, VS Code counts the tokens of the entire history
(`_getFinalElementTree`). The base budget is `modelMaxPromptTokens`, or
`contextSize` when the session has a smaller one. Tools count too, and the final
budget is `floor((budget - tool tokens) Ã— 0.9)`. When the history exceeds it, the
lowest-priority node is dropped until it fits (`removeLowestPriorityChild`).
There is no signal from the server. That is why switching to a session whose
history is already full immediately requests compaction: VS Code computed it
before that session's first request was sent.

Re-route: every new turn calls `/auto` again, unless the conversation cache is
still valid. The cache is considered valid only when all three hold: same tier,
session token not past `expires_at`, and an image-bearing request is not routed
to a model without vision (`_isCacheEntryCompatible`). The cache is force-invalidated
after compaction (`invalidateRouterCache`). Outside that, every turn waits for
`/auto` before inference â€” that is the pause at the start of every reply, and it
is not because the server queues sessions.

## gpt-4o, for comparison

Called directly on `/chat/completions`, without a session. The catalog reports
context 128,000 and output 16,384, but the limit enforced is 64,000:

| Characters | Prompt tokens | Result |
|---|---|---|
| 380,000 | 63,344 | pass |
| 383,000 | 63,844 | pass |
| 384,000 | 64,011 | 400 `exceeds the limit of 64000` |

Do not trust `max_context_window_tokens` as the prompt limit. What is enforced is
`max_prompt_tokens`, and for older models that number is smaller than the context
window minus output.
