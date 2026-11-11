# Providers

`src/providers/` describes every upstream the gateway can dispatch to: a small
set of declarations that four layers read. Which layer owns a fact decides
where a change goes. The procedure for adding, removing, importing, or
authenticating a provider belongs to the
[provider-catalog skill](../../.skills/cartethyia-provider-catalog/SKILL.md);
account health, cooldowns, and pool selection belong to the
[health-routing skill](../../.skills/cartethyia-health-routing/SKILL.md).

## The layers

| Layer | Owns | File |
| --- | --- | --- |
| Metadata | Identity, base URL, default wire family, service kinds, whether an account is required, JWT verification defaults | `src/providers/provider-metadata.ts` |
| Spec | Typed provider declarations for compatible API-key contracts | `src/providers/configured-provider.ts`, `src/providers/configured-openai-providers.ts` |
| Registry | One registration authority; lazy loader cache for adapter, auth, quota, and discovery | `src/providers/provider-registry.ts` |
| Registration source | Central provider-specific rows plus typed groups for repeated capability shapes | `src/providers/default-registry.ts` |
| Adapter | Provider wire bytes | `src/providers/adapters/base-adapter.ts`, `src/providers/adapters/compatible-adapter.ts` |
| Integration | Per-provider adapter, catalog, OAuth client, quota collector | `src/providers/integrations/<family>/` |
| Discovery | Live model listing and one-shot probes | `src/providers/discovery/` |
| Operations | Seeding, BYOK wiring, account health, CLI identity, versions | `src/providers/operations/` |
| Quota | Provider billing windows | `src/providers/quota/` |

The split matters because a provider is reached through *dynamic* `import()`:
`PROVIDER_CAPABILITIES` holds no adapter instance, only loaders, and nothing in
`integrations/` is evaluated until dispatch/probe/refresh — so "grep finds no
static import" is not evidence a module is dead. Ordinary API-key integration
files stay directly under `integrations/`; subfolders group families with
multiple related modules (Buddy: `buddy/codebuddy/`).

## Boot, and bundled vs BYOK

`buildProductionDeps()` (`src/boot/dependencies.ts`) runs, in order:
seed bundled providers (additive upsert) → retire unbundled rows (boot-only
delete) → register bundled modules synchronously (only loaders are lazy) →
resolve live upstream hosts (closure over the registry, so late registrations
still get SSRF bindings) → register BYOK rows → seed static catalogs into
`models`.

**Bundled** means the id is in `RAW_BUNDLED_PROVIDER_METADATA`
(`provider-metadata.ts`) — that is the whole test (`isBundledProviderId`,
`provider-contracts.ts`); `BUNDLED_PROVIDER_MODULES` throws at module load if
an id has metadata but no implementation.

**BYOK** (custom/configured) means a `providers` row carrying a `base_url`:
tenant-owned, slug must not collide with a bundled id, always dispatched through
`OpenAICompatibleAdapter` — no bespoke wire, no OAuth, no quota collector. Its
wire contract comes from `resolveByokWireProfile`
(`operations/byok-wire-profile.ts`) — the authority; re-hardcoding wire
mappings elsewhere is the recurring bug the catalog skill warns about.
Re-registration is idempotent by fingerprint: `upsert`
(`provider-registry.ts`) drops the cached adapter, so editing a BYOK row from
the console changes dispatch without a restart.

## Credentials and auth

`CredentialKind` is a closed union: `none`, `api_key`, `oauth`,
`scoped_access_token`, `workload_identity` (`provider-contracts.ts`). The
storage enum is narrower — `api_key`, `oauth`, `none` (`schema.ts`,
`credentialKind`).

| Shape | Where the secret lives | Where the rest lives |
| --- | --- | --- |
| API key | `provider_accounts.credential_ciphertext` (encrypted) | — |
| OAuth | same column, access token | `provider_oauth_states` (`schema.ts`): refresh ciphertext, optional client-secret ciphertext, `expires_at`, refresh lease |
| Device code | mints one of the two above | — |
| No credential | nothing; `requires_account = false` (and, where the endpoint must not see any bearer, `credential_forwarding: "never"`) | — |

`provider_accounts.auth_state` (`schema.ts`) holds non-secret per-account
upstream configuration — region, profile ARN, OAuth client id, token endpoint —
traveling beside the secret in `ResolvedCredential.auth_state`, because a
single opaque credential string cannot express both.

Selection is `CredentialResolver` (`provider-credential-resolver.ts`): the
first usable alternative in operator order; decryption and caching live in
`operations/provider-credential-service.ts`, 5 s TTL keyed on
`providerId:accountId`. `TokenEnvelope` (`provider-credential-envelope.ts`)
strips one explicitly identified prefix — `Bearer `, `OAuth `, `provider:` —
so an adapter never emits `Bearer Bearer`; it is separate because adapters
consume it and the registry imports adapters (the reverse edge would cycle).

Three auth client shapes:

| Shape | Base class | Family examples |
| --- | --- | --- |
| Browser PKCE | `OAuthClient.buildAuthorizeUrl`/`exchangeCode` (`authentication/oauth-client.ts`) | claude, antigravity, openrouter, zcode, kiro |
| Device code (RFC 8628) | `OAuthDeviceFlow` (`authentication/oauth-device-flow.ts`) | codex, github, grok, xai, kimi, cline, kilo, muse, qoder, factory, kiro, cb/cbcn |
| No OAuth | plain key path; `probeApiKeyConnectivity` is the account test (`quota/quota-support.ts`) | openai, anthropic, mistral, meta, most compatible API-key providers |

Whether a refresher is registered is per-family and deliberate: a grant that is
absent or dead registers none (a refresh call that always throws turns a
recoverable 401 into a permanent one — see `kilo`, `qoder`, `openrouter`,
`zcode`, `cloudflareai`, `alibabacp` in `default-registry.ts`). GitHub is the
opposite: its Copilot token is short-lived and re-minted, so it registers one.
Issuers with a JWKS (`grok`, `xai`) declare `issuer`/`jwksUrl`; providers
without one get registered-claim validation only.

## Discovery and catalog

A model becomes routable when a `models` row exists with `enabled = true` and
its provider row is enabled and not retired. Two writers produce those rows.

**Static catalogs.** Each bundled module declares `loadModels`, usually built
with `defineModel` (`provider-model-definition.ts`), which resolves limits and
pricing against the offline base catalog and leaves capability flags to the
caller — capability does not fall back, because an invented default is worse
than a stated false. The offline catalog is a single generated, brotli-packed
binary blob (`discovery/catalog/catalog-blob.ts`, read by
`discovery/catalog/catalog-format.ts` behind `models-dev-catalog.ts`); refresh
with `bun run scripts/tools/generate-models.ts`; id remaps live in
`CATALOG_PROVIDER_IDS`. `seedBundledModels` writes rows as
`source: 'builtin'`, prunes retired pairs, and reconciles capability drift
while leaving operator-owned `enabled` alone.

**Live discovery.** `loadModelDiscovery` is a `ProviderModelDiscovery`
(`discovery/discovery-types.ts`); most OpenAI-compatible providers reuse
`fetchOpenAICompatibleModels`. Per-account catalogs are scoped by the
credential's plan (`integrations/kiro/kiro-discovery.ts`); static rows are only
an offline seed. Persisted rows get `source: 'discovered'` or `'auto_free'`
(`discovery/probing-service.ts`).

Whether the dashboard offers "Fetch models" is `supportsModelDiscovery`, which
asks `registry.hasModelDiscovery(providerId)` — not whether it is a custom
provider. A bundled provider with no resolver (`gmi`, `nvidia`, `fireworks`)
reports `false`; a BYOK row reports `true` regardless. Discovery adds to the
static floor and never resets `enabled`. Catalog presence is not availability —
`/v1/models` reads the same rows.

## Quota and health

`QuotaFetcher` (`quota/quota-support.ts`) is a per-provider callback returning
`ProviderQuotaResult` (`quota-contracts.ts:22`): a plan label and windows with
percentages and reset times, resolved lazily through the registry. Each window
is explicitly `pooled` credit or, by default, an independent quota. Pooled
balances sum per account before applying a credit/percent floor; independent
windows (5-hour, weekly) are checked separately and block at zero; a percent
floor also applies to each independent window, while a credit floor applies
only to the pooled balance. A missing reading is not proof that allowance is
gone, and `totalRemainingCredit` ignores independent usage limits even when
they expose absolute `used`/`limit`.

Health state lives on `provider_accounts` via `healthColumns()`
(`schema.ts`): status, `cooldown_until`, per-model cooldowns, last error
category. Cooldown classes, recovery sweeps, leases, and pool selection are
owned by the [health-routing skill](../../.skills/cartethyia-health-routing/SKILL.md).

The quota cache: 1,024 in-process entries, 15-minute TTL, optional Redis shared
tier, attempt and successful-fetch timestamps recorded separately. A failed
refresh retains a successful reading for up to 30 minutes while exposing the
refresh error — never replaces usable quota with an empty result.
`quota-refresh-sweep` runs every minute, refreshes entries at least eight
minutes old — half the 15-minute cache TTL, so a reading is refreshed roughly
twice per window instead of three times — and bounds each pass to 40 accounts /
45 seconds (set in `src/boot/dependencies.ts`). See
[Usage floor](../features/04-usage-floor.md) for how readings affect eligibility.

## Per-family notes

Verified in code only. `bespokeWire` = the adapter frames its own protocol, not a canonical codec (`provider-metadata.ts`).

| Family | What is non-standard |
| --- | --- |
| kiro | Bespoke (`provider-metadata.ts`). AWS EventStream wire over the Kiro runtime service (`https://runtime.{region}.kiro.dev/generateAssistantResponse`), no chat-shaped endpoint; reasoning arrives as its own event or `<thinking>` markers in text. Browser PKCE only (IdC/Builder-ID via AWS SSO OIDC `authorization_code` + loopback; social via the vendor's sign-in service). |
| github | Base URL is only a fallback: the real host comes from the Copilot token's `proxy-ep` claim per dispatch. Short-lived token, real refresher. The account label is the GitHub login, read from `api.github.com/user` with a plain user agent — the Copilot client headers draw a 400 there, and a missing login makes every account share one label so the next login replaces the row. The device dialog polls on one timer and waits out `slow_down`; a second poll inside GitHub's interval burns the device code. |
| antigravity | Google OAuth, but the wire is a Gemini payload wrapped in an agent envelope POSTed to `v1internal:{generate,stream}GenerateContent` — no per-model path. Image generation uses the same envelope with `responseModalities: ["IMAGE"]`; `/v1/search` adds Google Search grounding. |
| muse | Device-code login yields an OAuth token, exchanged by `POST /muse-code/key` for the `api_key` the backend accepts; the stored `oauth` secret is a `{oauthAccessToken, apiKey}` JSON blob. |
| meta | A plain developer-dashboard API key, no OAuth (`default-registry.ts`, `meta` row). |
| claude / codex | Subscription OAuth on Messages / Responses. Codex also serves websearch; its image path is a Responses `image_generation` tool on a chat carrier, without the chat identity envelope. A catalog row is not an entitlement — a ChatGPT account can reject the tool. |
| gemini | `x-goog-api-key` header, per-model `:generateContent`/`:streamGenerateContent` paths; not OpenAI-shaped. Image generation uses the same path. |
| xai / grok | Same issuer and JWKS, different surfaces: `grok` is the free Grok Build CLI proxy, `xai` is the paid API (`provider-metadata.ts`, `grok`/`xai` rows). |
| kilo | Resells the OpenRouter catalog behind a `{accessToken, orgId}` JSON credential. No refresh grant. |
| qoder | Device flow whose refresh endpoint answers 403; no refresher. Two realms (`qoder`, `qodercn`) with separate gateways, OAuth clients, and rosters. Upstream keys are opaque slots (`dfmodel`, `cmodel`), so the catalog publishes caller-facing names instead (`deepseek-v4.1-flash`, `cantus`); dispatch translates them back — see `integrations/qoder/qoder-virtual.ts`. `/model/list` states no output limit, so ceilings come per row. Free tier is read from upstream's own `is_free`, not hardcoded. Transport split: free `lite` slots use the legacy COSY surface; billed slots use gRPC (`ChatCompletionStream`, the only surface that carries 1M-token context). The gRPC wire is protobuf — request `tools`/`tool_choice`/`parallel_tool_calls` and response `delta.tool_calls` use Struct/Value wrapper shapes, not OpenAI JSON (see `documentation/research/qoder/archive/qoder-research-archive-2026-11-11.zip` — `2026-11-05-qoder-tool-calling.md` — and `documentation/research/qoder/2026-11-05-qoder-model-matrix.md`). |
| trae / traecn | Two disjoint surfaces that share no model id: chat (`/api/ide/v1/llm_raw_chat`, keyed by `model_name`) and agent (`/api/agent/v3/llm_utils_chat`, keyed by `config_name` + `config_source` + `function: solo_agent`). The intl catalog is agent-only, because neither surface serves the other's ids. Current behavior is owned by the Trae provider implementation and its tests. |
| cline | Discovery reads only `recommended` + `free` — the pass roster would write subscription rows an operator's account can only 401 on. |
| openrouter / zcode | PKCE ends by minting a **durable API key**, not an access token; no refresher. |
| xiaomi-mimo | Two ids: `xiaomipg`, `xiaomitp`, both key-based. MiMo Studio browser-cookie login is not supported. |
| cb / cbcn | One billing system: `BUDDY_PROVIDER_IDS` names the family for health, request prep, and daily check-in. CN mirrors intl on `copilot.tencent.com` plus recent CN model additions. See the [catalog-fetch procedure](../../.skills/cartethyia-provider-catalog/SKILL.md#fetch-a-buddy-model-catalog). |
| opencode / opencode-zen / opencode-go | Three tiers on `opencode.ai`: free and Zen dispatch on `/inference/v1` (free: `requires_account: false`, `ipScopedRateLimit: true` — 429 cools the pool, not the account; Zen: billed), Go on the separate `/zen/go/v1` base. The `/zen/v1/models` listing is the catalog surface for free/Zen (`/inference/v1/models` answers 404), see `integrations/opencode/provider.ts`. A dispatch carrying more than 128 tool definitions is clamped before it is sent: definitions the conversation already called are kept, and the rest fill the remaining slots in their original order. Upstream refuses the unclamped list. Every tier's dispatch carries the client-identity fingerprint (`integrations/opencode/fingerprint.ts`). The free tier requires the 11-tool agent set and `stream: true`; it sends **no `Authorization` header** (the anonymous `Bearer public` sentinel is no longer sent — verified live 2026-11-02: the same captured flow answers 200 with or without it). Upstream refuses a free dispatch outright from a blocked egress IP — a datacenter address is refused, so free-tier dispatch needs an egress proxy, not a header change. |
| exa / parallel | `serviceKinds: ["websearch"]` only; served by `/v1/search`, never the chat pipeline. No account uses the public MCP; a stored API key uses the higher-limit HTTP API. |
| deepseek | Bundled API-key provider on the Anthropic Messages adapter at `/anthropic/v1/messages`; its OpenAI-compatible `/v1/models` discovery is separate (`deepseek.ts`). |
| mistral, fireworks, nvidia, gmi, ollamacloud | Shared configured OpenAI-compatible spec rows. |
| factory | WorkOS device code against a proxy that multiplexes four wires by model family (`dispatch` branches on `wire_family`). Credential `{accessToken, orgId}` — org id is the JWT's `external_org_id` claim, sent as `X-Factory-Org-Id`; host comes from the account's residency region. Real refresh grant exists, and the token request is issued in the client because the shared helper drops `refresh_token`. |
| cloudflareai | A gateway, not a model host: account and gateway slugs are path segments of the base URL, stored with the token, built at dispatch time. Auth is `cf-aig-authorization`. Messages wire only. No refresh grant. |
| alibabacp | International and mainland-China plans on different hosts with non-interchangeable keys; region stored with the token and resolved to a base URL ending `/compatible-mode/v1`, so endpoint paths are unprefixed. No refresh grant. |
| dashscope | Alibaba's mainland DashScope coding host, plain bearer on `https://coding.dashscope.aliyuncs.com/v1`. Distinct from `alibabacp` (Token Plan on `token-plan.*.maas.aliyuncs.com`). Live `/v1/models` discovery plus an 8-row static floor. |
| factory / cloudflareai / alibabacp catalogs | Static rosters in `integrations/*/*-models.ts`; none publishes a listable endpoint, so the catalog is the list. Limits come from the base catalog via `models-dev-catalog.ts` remaps; capability is declared per row. |
| cursor | Bespoke (`provider-metadata.ts`). Connect-RPC over protobuf on a bidirectional HTTP/2 stream, so it uses the validated `outbound_http2` capability rather than `fetch`. The Run origin comes from `GetServerConfig` per dispatch, not from the metadata base URL (which serves auth and catalog only). Its tool loop spans two client requests on one upstream Run, so the Run and its account/pool slot outlive the request that opened them — see [Cursor provider](../features/08-cursor-provider.md). No quota collector: no endpoint is established. The `x-cursor-client-version` identity is `cli-<version>-<sha7>` and is **discovered** from the official download API (`VERSION_SOURCES.cursor`), which is the only source returning both halves; the constant in `cursor-shared.ts` is only what a cold process sends before the first fetch. |

## Commandcode Go and ZCode Start Plan

Commandcode Go is a subscription tier of `commandcode`, not another provider.
Requests use the CLI generation envelope and NDJSON response. Quota reads are
organization-scoped; monthly allowance, purchased/free credits, and independent
five-hour/weekly limits remain separate. Purchased credits are not capped by
the monthly plan allowance. An unknown allowance cap does not erase a known
spendable balance.
An upstream reset timestamp of zero means no reset deadline is available, not
a reset in January 1970.

`zcode-start` (displayed as **ZCode Start**) is separate from `zcode` (the regular Z.AI Coding Plan). Sign in
with its device flow or import the ZCode login JWT; a Coding Plan API key or
the short-lived Z.AI access token is not interchangeable. There is no refresh
grant: sign in again if the session is expired or revoked. Requests use
`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`, bearer auth,
ZCode identity headers and the three-block client prompt. Caller instructions
are appended inside the third block, not discarded or sent as a fourth block.

Quota reads `GET /api/v1/zcode-plan/billing/balance`. Each balance keeps its
`capabilities` model IDs, owning `user_plan_id`/`plan_id`, entitlement period,
`total_units`, `used_units`, `remaining_units`, and activation/expiry times.
Alternative grants can fund the same model; a spent grant cannot disable an
unrelated model. Future grants show **Not started yet** and their start time,
but cannot fund requests. Expired grants cannot fund requests even if their
last reported remaining amount was positive. Missing usage is unknown, not zero.
The dashboard summarizes multiple Start Plan grants as **Start +N** (no popup),
with full upstream names in the badge title. Window headings show grant and
period without a model caption. Known names are displayed as **Start** and
**Global Build**; other promo/referral names remain unchanged. Stored quota
and routing identities are not renamed. Future windows stay visible.
Timeout, network and unreadable-JSON quota failures remain distinct; a timeout
does not advance the account failure streak.
A successful balance is authoritative: a model with no matching grant is not
eligible. Dashboard availability follows the same grant lifetimes and treats
same-model grants as alternatives, rather than showing a spent sibling as an
account-wide zero balance.
Generation business-error envelopes are failures even when the upstream HTTP
status is 200; they must not produce successful empty completions.

The **Claim gifts** button in the provider account row is an explicit manual
action; quota cards do not expose gift claims. It reads marketing banners and billing preview, then
posts each offered `plan_id` to `/api/v1/zcode-plan/billing/claim`. Claim codes
`0`, `1003`, and `3007` mean claimed, already claimed, and CAPTCHA respectively.
Complete CAPTCHA in the ZCode app. Unknown/unreadable replies are failures;
mixed outcomes are partial, never an unconditional success. A successful
no-data preview is a valid empty list. New grants invalidate both the live cache
and the persisted quota snapshot used after a cold start.

Automatic claims are **off by default**. Set `CARTETHYIA_ZCODE_AUTO_CLAIM=true`
to opt active accounts in; the first pass runs after 24 hours and repeats daily.
Each daily pass drains the eligible accounts in bounded pages; the page size
does not defer the remaining accounts to another day.
`CARTETHYIA_DISABLED_TASKS=zcode-gift-claim` still disables that task. Manual
claim remains available independently. Disabled/cooling accounts are not
automatically claimed, and this scheduler does not enable them.

### Upstream reference

The [Magpie ZCode integration](https://github.com/yetone/magpie) and its
[`opencode-zcode-auth` package](https://www.npmjs.com/package/@magpie-community/opencode-zcode-auth/v/0.1.42)
document the billing shapes, `capabilities` model mapping, legitimate empty
preview and claim codes. Magpie's `-Trial` suffix distinguishes gifts from
Coding Plan entries in its combined picker; upstream requests use raw model
IDs. The separate `zcode-start` provider keeps those raw IDs without a fallback
that spends the regular Coding Plan.

Commandcode plan entitlement is model-specific: a `MODEL_NOT_IN_PLAN` refusal
rests the selected model rather than invalidating the account. The provider's
[Go plan roster](https://commandcode.ai/docs/plans/go) is the entitlement
reference, not the unfiltered model catalog.

## Where to change what

| Change | Start here |
| --- | --- |
| New provider, family, or catalog row | [Provider-catalog skill](../../.skills/cartethyia-provider-catalog/SKILL.md) |
| Identity, base URL, default wire, service kinds | `src/providers/provider-metadata.ts` |
| Wire a bundled provider's adapter/auth/quota/discovery | `src/providers/default-registry.ts` (`PROVIDER_CAPABILITIES`) |
| One provider's wire behavior | its module under `src/providers/integrations/<family>/` or `src/providers/adapters/` |
| Standard OpenAI chat/responses provider | add an `ApiKeyProviderSpec`, not an adapter (`configured-provider.ts`); per-account base-URL state via `resolveBaseUrl` (`compatible-adapter.ts`) |
| Shared HTTP/SSE adapter, registration, caching | `src/providers/adapters/`, `provider-registry.ts` |
| BYOK wire derivation, registration, SSRF | `operations/byok-wire-profile.ts` (`resolveByokWireProfile`), `operations/provider-catalog-service.ts` (`registerByokProviders`) |
| Catalog seeding, offline limits/pricing, live listing | `provider-catalog-seeder.ts` (`seedBundledModels`), `discovery/catalog/` + `models-dev-catalog.ts`, the family's `loadModelDiscovery` |
| Quota, OAuth, account health | the family's `*-quota.ts`; `src/providers/authentication/` + `*-oauth.ts`; [Health-routing skill](../../.skills/cartethyia-health-routing/SKILL.md) |

