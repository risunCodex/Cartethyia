# Model name forms

Four different strings get called "the model" when debugging a request. Mixing
them up produces confident wrong conclusions, so this page fixes what each one
means and where it comes from.

## The four forms

| Form | Example | Who writes it |
|---|---|---|
| Requested | `bansos/deepseek-v4.1-flash(max)` | the client |
| Canonical (bare) | `bansos/deepseek-v4.1-flash` | `parseThinkingSuffix` |
| Routed candidate | `deepseek-v4.1-flash` | routing, from `RouteCandidate.model_id` |
| Displayed | `bansos/deepseek-v4.1-flash (max)` | the Request Detail view |

## The effort suffix: `(max)` vs ` (max)`

**The space matters, and it is not cosmetic.**

- `model(max)` — **no space** — is the syntax a client actually sends. It is a
  supported feature: a thinking-effort level carried in the model name.
  `parseThinkingSuffix` (`src/protocol/translation/thinking.ts`) strips it
  before anything reads the model name, because alias resolution, the
  allowlist, the prefix check, and routing all match against registered ids and
  a name carrying `(max)` would fail every one of them. It is stripped on the
  canonical request, not in a provider adapter, which is what makes the syntax
  global: at that point no provider has been chosen yet.
- `model (max)` — **with a space** — is never sent by a client. It is the
  gateway's own annotation in the Request Detail view: the recorded model name
  beside the effort level it detected. Treat the space as the marker for "this
  string is display, not wire".

So `bansos/deepseek-v4.1-flash (max)` in Request Detail means the client asked
for `bansos/deepseek-v4.1-flash(max)`. Do not read the space as a client bug,
and do not paste the spaced form into a replay — it will not resolve.

`formatThinkingSuffix` is the documented inverse of the parser and emits the
**spaceless** form (`model(level)`). It is currently used only by the provider
detail model probe (`Models.tsx`); the Request Detail annotation reaches its
spaced form by another path, so do not assume the two share an implementation.

## The prefix is stripped before dispatch, and that is correct

A client sends `bansos/deepseek-v4.1-flash`. Upstream receives
`deepseek-v4.1-flash`. That is **not** a bug and must not be "fixed".

`bansos` is not a provider — it is a **combo name**. Combos are tenant-scoped
records (`/console/api/routing/combos`) that expand to member models served by
real providers, for example:

```
bansos/deepseek-v4.1-flash -> ["cb/deepseek-v4.1-flash", "cbcn/deepseek-v4.1-flash"]
```

Routing resolves the combo, expands its members, and picks a candidate. Every
dispatch path then sends `candidate.model_id`, which is the **bare** model id,
with `provider_id` held separately on the candidate. Upstreams have never seen
and must never see the combo prefix.

The consequence for debugging: **a missing prefix in `providerRequest` is
normal**. Compare the requested name against the candidate's provider instead
of expecting the prefix to survive.

## When a prefix is a real bug

The prefix is only meaningful as a combo name or a provider id. It stops being
meaningful when:

- **the combo does not exist.** `bansos/claude-sonnet-5` is not a registered
  combo, so `candidateMatches` looks for a provider literally named `bansos`
  and finds none: `model_not_found`, `errorOrigin: cartethyia`,
  `providerId: null` — the request never reached a provider. The same model
  under its real provider (`github/claude-sonnet-5`) resolves and fails as
  `accounts_unavailable` instead. Different error, different owner.
- **the tenant does not match.** Combo lookup is
  `snapshot.combos[tenantId]?.[resolvedModel]`. A null or wrong tenant id
  yields no combo map, so the requested name is used verbatim and the prefix is
  treated as a provider id — the same failure as above.
- **a member has more than one slash.** `parseModel` splits on the *first*
  slash only, so `cline/cline-free/mimo-v2.6-flash` is provider `cline` with
  model `cline-free/mimo-v2.6-flash`. That matches how the catalog stores it,
  but it means a nested-looking id is not a nested route.

## Reading a failure

- `errorOrigin: cartethyia` + `model_not_found` + `providerId: null` — routing
  rejected it before any provider was involved. Suspect the name, the combo
  registration, or the tenant scope; not the upstream.
- `accounts_unavailable` — the name resolved and combo expansion worked; no
  account in the pool can serve it right now. A routing or payload bug is ruled
  out by this error alone.
- An upstream `4xx` with the bare model id — the prefix stripping was correct;
  bisect the payload instead.

To see what the instance can actually route, compare `/v1/models` against
`/console/api/routing/combos`. They are not the same list: a combo can be
registered yet absent from `/v1/models` when no account can serve it.
