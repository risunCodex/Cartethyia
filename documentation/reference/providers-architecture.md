# Providers — architecture

`src/providers/` describes every upstream the gateway can dispatch to: a small
set of declarations that four layers read. Which layer owns a fact decides
where a change goes. The procedure for adding, removing, importing, or
authenticating a provider belongs to the
[provider-catalog skill](../../.skills/cartethyia-provider-catalog/SKILL.md);
account health, cooldowns, and pool selection belong to the
[health-routing skill](../../.skills/cartethyia-health-routing/SKILL.md).

Per-provider wire notes and quirks live in
[providers-families.md](providers-families.md).

## The layers

| Layer | Owns | File |
| --- | --- | --- |
| Metadata | Identity, base URL, default wire family, service kinds, whether an account is required, JWT verification defaults | `src/providers/provider-metadata.ts` |
| Spec | Typed provider declarations for compatible API-key contracts | `src/providers/configured-provider.ts`, `src/providers/bundled-provider-manifest.ts` |
| Registry | One registration authority; lazy loader cache for adapter, auth, quota, and discovery | `src/providers/provider-registry.ts` |
| Registration source | Central provider-specific rows plus typed groups for repeated capability shapes | `src/providers/registry/capabilities-*.ts` (composed by `registry/capabilities.ts`, re-exported by `default-registry.ts`) |
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

Selection is `CredentialResolver` (`provider-credentials.ts`): the
first usable alternative in operator order; decryption and caching live in
`operations/provider-credential-service.ts`, 5 s TTL keyed on
`providerId:accountId`. `TokenEnvelope` (`provider-credentials.ts`)
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
`zcode`, `cloudflareai`, `alibabacp` in `src/providers/registry/capabilities-*.ts`). GitHub is the
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
(`discovery/discovery-roster.ts`).

Whether the dashboard offers "Fetch models" is `supportsModelDiscovery`, which
asks `registry.hasModelDiscovery(providerId)` — not whether it is a custom
provider. A bundled provider with no resolver (`gmi`, `nvidia`, `fireworks`)
reports `false`; a BYOK row reports `true` regardless. Discovery adds to the
static floor and never resets `enabled`. Catalog presence is not availability —
`/v1/models` reads the same rows.

## Quota and health

`QuotaFetcher` (`quota/quota-support.ts`) is a per-provider callback returning
`ProviderQuotaResult` (`quota-contracts.ts:27`): a plan label and windows with
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

## Where to change what

| Change | Start here |
| --- | --- |
| New provider, family, or catalog row | [Provider-catalog skill](../../.skills/cartethyia-provider-catalog/SKILL.md) |
| Identity, base URL, default wire, service kinds | `src/providers/provider-metadata.ts` |
| Wire a bundled provider's adapter/auth/quota/discovery | `src/providers/registry/capabilities-*.ts` (`PROVIDER_CAPABILITIES`; re-exported by `default-registry.ts`) |
| One provider's wire behavior | its module under `src/providers/integrations/<family>/` or `src/providers/adapters/` |
| Standard OpenAI chat/responses provider | add an `ApiKeyProviderSpec`, not an adapter (`configured-provider.ts`); per-account base-URL state via `resolveBaseUrl` (`compatible-adapter.ts`) |
| Shared HTTP/SSE adapter, registration, caching | `src/providers/adapters/`, `provider-registry.ts` |
| BYOK wire derivation, registration, SSRF | `operations/byok-wire-profile.ts` (`resolveByokWireProfile`), `operations/provider-catalog-service.ts` (`registerByokProviders`) |
| Catalog seeding, offline limits/pricing, live listing | `provider-catalog-seeder.ts` (`seedBundledModels`), `discovery/catalog/` + `models-dev-catalog.ts`, the family's `loadModelDiscovery` |
| Quota, OAuth, account health | the family's `*-quota.ts`; `src/providers/authentication/` + `*-oauth.ts`; [Health-routing skill](../../.skills/cartethyia-health-routing/SKILL.md) |
