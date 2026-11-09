# Part 06 — Provider core contracts, registry, adapters, metadata, discovery and catalogs (deep audit)

## Scope

Read-only audit of `src/providers/provider-*.ts` (core contracts and registry
layer), `src/providers/adapters/**`, and `src/providers/discovery/**` for
concrete, worthwhile consolidation opportunities (bloat, duplication,
unnecessary work, maintenance complexity) that preserve behavior. Priority
constraints from the operator: memory/state integrity and valid fallback
behavior win over cleanup; never propose removing apparently duplicated logic
unless the copies share the same contract, state scope, ordering, error
semantics, and safety boundary. Files were inspected as source plus tests;
codegraph was used first for symbol/call-path mapping, then direct
`Read`/`Grep` for detail. No source, test, config, documentation (other than
this report file), or git state was modified.

## Current-flow evidence (traced)

- **Registry authority** `src/providers/provider-registry.ts` is the single
  lazy-loader cache for adapters, authentication, quota collectors, and model
  discovery. `register`/`upsert`/`unregister` mutate `#registrations`,
  `#loaded`, `#authentication`, `#quotaCollectors`, `#modelDiscovery`, and
  bump `#revision`; `resolve`/`loadOne` share `#loadRegistration`
  (`provider-registry.ts:325`) which is single-flight (`#loading`), asserts
  provider identity (`assertAdapterIdentity:116`), records metrics, and caches
  into `#loaded`. `resolveAuthentication` (`:231`), `resolveQuotaCollector`
  (`:283`), and `resolveModelDiscovery` (`:302`) each implement the identical
  cached-load-with-single-flight pattern.
- **Module assembly** `src/providers/default-registry.ts` composes
  `PROVIDER_CAPABILITIES` (per-provider lazy loaders) with
  `BUNDLED_PROVIDER_METADATA` into `BUNDLED_PROVIDER_MODULES` (`:948`), and
  `createDefaultProviderRegistry` (`:973`) registers them. Discovery-backed
  API-key providers are wired through `createDiscoveryBackedProviderCapabilities`
  (`configured-provider.ts:230`).
- **Metadata helpers** `src/providers/provider-metadata.ts` exports thirteen
  id-keyed lookups; ten re-scan the 73-entry `BUNDLED_PROVIDER_METADATA`
  array with `.find((candidate) => candidate.id === providerId)`:
  `providerCredentialUrl:630`, `providerCredentialHint:638`,
  `providerOperatorNotice:643`, `providerDisplayName:648`,
  `providerServiceKinds:681`, `providerBaseUrl:710`,
  `providerDefaultWireFamily:746`, `providerUsesBespokeWire:756`,
  `providerRequiresAccount:761`, `providerJwtVerification:770`, and a further
  one (`providerUpstreamHost:777`) delegates to `providerBaseUrl`. Two
  predicates were already moved to prebuilt sets
  (`ADAPTER_USER_AGENT_PROVIDER_IDS:616`,
  `IP_SCOPED_RATE_LIMIT_PROVIDER_IDS:788`), which is the pattern F1 extends
  to the remaining ten helpers.
- **Routing consumption** `src/transport/routing/route-catalog.ts` reads
  `providerUsesBespokeWire` inside `buildCapabilityProfile` (`route-catalog.ts:129`)
  per model row during snapshot rebuilds (profile memoized per row by
  `capabilityProfileFor:182`), and `providerHasAdapterUserAgent` in
  `resolveRouteUserAgent` (`:212`). `isBundledProviderId`
  (`provider-contracts.ts:452`) does an `Array.includes` over `BUNDLED_PROVIDER_IDS`
  (a 73-element array, `provider-contracts.ts:14`) and runs on the per-candidate
  dispatch path (`proxy-request.ts`, `route-catalog.ts`).
- **Discovery** `src/providers/discovery/models-dev-catalog.ts` resolves model
  metadata from a lazily decompressed, memoized packed catalog
  (`catalogCache:151`); `openai-model-discovery.ts` `fetchOpenAICompatibleModels`
  (`:26`) is the shared OpenAI-compatible `/models` fetcher used by the default
  registry, `probing-service.ts:820`, and the openai/xai/zcode/gemini/inception/
  inferhub/opencode/openrouter integrations. Discovery results persist through
  `ProviderProbingService.persistDiscoveredModels` (`probing-service.ts:969`).

## Findings

### F1 — Ten metadata predicates re-scan the bundled metadata array per call; two already use prebuilt sets (CONFIRMED)

- **Severity:** LOW · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `src/providers/provider-metadata.ts` exports thirteen id-keyed
  helpers; ten call
  `BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)`
  on every invocation (`providerBaseUrl:710`, `providerDefaultWireFamily:746`,
  `providerRequiresAccount:761`, `providerUsesBespokeWire:756`,
  `providerJwtVerification:770`, `providerDisplayName:648`,
  `providerCredentialUrl:630`, `providerCredentialHint:638`,
  `providerOperatorNotice:643`, `providerServiceKinds:681`), and
  `providerUpstreamHost:777` adds a second scan via `providerBaseUrl`.
  `providerHasAdapterUserAgent:621` and
  `providerRateLimitIsIpScoped:803` already read prebuilt
  `ReadonlySet`s. The array has 73 entries, so each call is a 73-element scan.
  `providerUsesBespokeWire` runs inside `buildCapabilityProfile`
  (`route-catalog.ts:129`) per model row on every route-snapshot rebuild, and
  `isBundledProviderId` (`provider-contracts.ts:452`, an `Array.includes` over
  `BUNDLED_PROVIDER_IDS`) runs per candidate on the dispatch path.
- **Why it is real duplication.** The repeated `.find()` is one pattern
  maintained in ten places, each with its own fallback semantics (throw vs
  `undefined` vs default literal). The two set-based predicates prove the
  intended idiom already exists elsewhere in the same file; the remaining ten
  did not get the same treatment. A single id-keyed index removes the repeated
  scan and keeps one lookup path for all of them.
- **Proposal.** Build one
  `const PROVIDER_METADATA_BY_ID = new Map(BUNDLED_PROVIDER_METADATA.map((m) => [m.id, m]))`
  next to `BUNDLED_PROVIDER_METADATA` (`provider-metadata.ts:593`) and rewrite
  the nine helpers to `PROVIDER_METADATA_BY_ID.get(providerId)`, preserving each
  helper's exact fallback (`providerBaseUrl` throws `Unknown builtin provider`;
  `providerDefaultWireFamily`/`providerRequiresAccount`/`providerUsesBespokeWire`
  default to `"chat"`/`true`/`false`; `providerJwtVerification` defaults `{}`;
  display/credential helpers return `undefined`). Optionally export the same map
  (or a `Set` built from `BUNDLED_PROVIDER_IDS`) and back
  `isBundledProviderId` with O(1) membership instead of `Array.includes`.
- **State/fallback analysis.** Read-only constants; no persisted state, no
  mutation. Map lookup returns the identical row objects, so every helper's
  fallback branch (unknown id / absent field) is unchanged. No ordering or
  safety boundary exists to preserve.
- **Fallback risk.** None, provided each helper keeps its distinct fallback
  (the throw in `providerBaseUrl` is load-bearing and must not become
  `undefined`).
- **Verification.** `test/providers/provider-services.test.ts` pins
  `providerServiceKinds` incl. the BYOK widening; `test/providers/registry-metadata-bijection.test.ts`
  and `test/providers/generic-provider-completeness.test.ts` iterate the full
  metadata table and must pass unchanged; `test/providers/adapter-user-agent.test.ts`
  pins `providerHasAdapterUserAgent`. Add one assertion that
  `providerBaseUrl` still throws for an unknown id and that
  `providerDefaultWireFamily`/`providerRequiresAccount`/`providerUsesBespokeWire`
  still default for it.

### F2 — Discovery-backed API-key providers are enumerated three times in producer code plus a divergent test copy (CONFIRMED)

- **Severity:** LOW · **Effort:** M · **Behavior change:** no.
- **Mechanism.** The same "discovery-backed OpenAI-compatible bearer provider"
  list exists in four places:
  - `GENERIC_API_KEY_SPECS` (`configured-provider.ts:121`) and
    `VERSIONED_ROOT_API_KEY_SPECS` (`:154`) declare the 21 + 7 spec rows.
  - `DISCOVERY_BACKED_PROVIDER_SPECS` (`configured-provider.ts:184`) restates
    21 ids, each picking a spec from one of the two maps.
  - `createDiscoveryBackedProviderCapabilities` (`configured-provider.ts:230`)
    hand-lists the same 21 ids again, calling
    `discoveryBackedCapabilities(...)` per provider.
  - `test/providers/generic-provider-completeness.test.ts:38-59` maintains a
    fourth copy (`DISCOVERY_BACKED`) — which already diverges from the producer
    table: it includes `coreweave` (which bypasses the shared helper and is
    defined inline in `default-registry.ts:800`), omits `dashscope` (which is
    in the producer table and registered via `discoveryBackedCapabilities` at
    `default-registry.ts:843`), and omits `larprouter` (which is in the
    producer table).
- **Why it is real duplication.** Adding one discovery-backed aggregator
  requires editing three producer lists plus the test list; the test list has
  already drifted, which is exactly the failure mode the completeness test
  exists to prevent.
- **Proposal.** Export one canonical tuple, e.g.
  `DISCOVERY_BACKED_PROVIDER_IDS` (the 21 ids from
  `DISCOVERY_BACKED_PROVIDER_SPECS`), derive `createDiscoveryBackedProviderCapabilities`
  via `Object.fromEntries(DISCOVERY_BACKED_PROVIDER_IDS.map((id) => [id, discoveryBackedCapabilities(id, specFor(id), openAIModelDiscovery)]))`
  with a single `specFor(id)` that consults `GENERIC_API_KEY_SPECS` then
  `VERSIONED_ROOT_API_KEY_SPECS`, and have the completeness test import the
  canonical constant instead of the hand-written list (keeping its two special
  cases `coreweave`/`dashscope` explicit where their registration genuinely
  differs).
- **State/fallback analysis.** Module-level constants and a generated record;
  no state. Each provider keeps exactly its current spec row, endpoint paths,
  lazy adapter loader, and discovery loader, so registration behavior is
  unchanged. Object key order does not matter for `Record` semantics.
- **Fallback risk.** Low — the only hazard is mis-deriving `specFor` for the
  one id that exists in both tables (none do today); the generation must throw
  on an id absent from both maps so a future typo fails at module load.
- **Verification.** `test/providers/generic-provider-completeness.test.ts`
  must pass unchanged (each id still has a spec, a registry entry, a discovery
  resolver, and an endpoint path); add one test that the generated
  `createDiscoveryBackedProviderCapabilities` keys equal
  `DISCOVERY_BACKED_PROVIDER_IDS` exactly.

### F3 — `ProviderRegistry.snapshot()` and `ProviderRegistrySnapshot` are dead code; `#revision` is write-only (CONFIRMED)

- **Severity:** LOW · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `ProviderRegistry.snapshot()` (`provider-registry.ts:349`)
  returns a `ProviderRegistrySnapshot` (`:129`) built from `#revision` and
  `#loaded`. Codegraph and full-tree `Grep` find zero callers in `src/`,
  `test/`, or `scripts/`: the only reference to `ProviderRegistrySnapshot` is
  its own declaration, and no code reads `#revision` except `snapshot()`.
  `#revision` is incremented in `register:165`, `upsert:203`,
  `unregister:175`, and `#loadRegistration:339`, so with `snapshot()` removed
  it becomes write-only state. Routing and console projections read provider
  facts from the DB (`route-catalog.ts:487` builds `requiresAccountById` from
  `providerRows`), not from this registry snapshot.
- **Why it is dead.** The method and its type have no consumer in production
  or tests; the revision counter exists solely to serve them.
- **Proposal.** Remove `snapshot()`, `ProviderRegistrySnapshot`, and the
  `#revision` field and its four increments. If a future consumer needs a
  cheap registry version, reintroduce the counter at that time (the four
  mutators are the natural bump sites).
- **State/fallback analysis.** Removal of unused code touches no persisted
  state and no fallback branch; the mutators' core behavior (map updates,
  cache invalidation on `upsert`/`unregister`) is untouched.
- **Fallback risk.** None.
- **Verification.** No test references `snapshot()` or `ProviderRegistrySnapshot`
  (verified by grep). `test/providers/registry-integration-parity.test.ts` and
  `test/providers/registry-metadata-bijection.test.ts` exercise registration and
  metadata and must pass unchanged; a typecheck confirms no dangling references.

### F4 — Identical JSON-credential token extraction duplicated verbatim in two discovery closures (CONFIRMED)

- **Severity:** MED · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `src/providers/default-registry.ts` contains two byte-identical
  blocks that unwrap a possibly-JSON credential into a raw token:
  - `traeDiscovery` (`default-registry.ts:71-81`): `secret.startsWith("{")` →
    `JSON.parse` in `try/catch` (swallow) → find first of
    `["accessToken", "access_token", "token"]` that is a non-empty string →
    else keep the raw secret.
  - the free-pi discovery closure (`default-registry.ts:556-566`): the same
    block verbatim.
  Related but distinct implementations exist in `src/providers/integrations/trae/trae.ts:78-91`
  (`extractToken`, adds `"x-ide-token"` to the key list) and
  `src/providers/integrations/trae/trae-oauth.ts:615-635` (`firstString`).
- **Why it is real duplication.** The two closures are textually identical and
  share the same contract (secret-string → token string, `{`-JSON unwrap with
  a swallowed parse failure, same key order, same fallback to the raw secret).
  This is credential parsing — a security-relevant boundary — kept in two
  copies inside one file; a future change to accepted keys or the envelope gate
  would silently split Trae's discovery from free-pi's.
- **Proposal.** Add one shared helper, e.g.
  `extractJsonEnvelopeToken(secret: string): string` in
  `src/providers/provider-credentials.ts` (the existing single home for token
  envelope handling), implementing exactly the two blocks' behavior (startsWith
  `{`` gate, `try/catch` swallow, key order `accessToken`/`access_token`/`token`,
  non-empty-string guard, raw-secret fallback), and call it from both closures.
  Leave `trae.ts`/`trae-oauth.ts` untouched — their key sets and returns differ
  and are intentionally richer.
- **State/fallback analysis.** Pure function of the secret string; no state,
  no ordering. Both current call sites pass the trimmed secret and use the
  returned token identically, so a shared helper preserves behavior by
  construction.
- **Fallback risk.** None. The malformed-JSON path (swallow → raw secret) and
  the empty-token path (fall back to raw secret) are copied exactly.
- **Verification.** `test/providers/trae.test.ts` and
  `test/providers/freepi-oauth-identity.test.ts` exercise both discovery paths;
  add one unit test asserting the helper matches both copies on the same inputs
  (plain token, `{...}` JSON with each key spelling, malformed JSON, empty
  value, unknown keys).

### F5 — Provider-family id sets duplicated across operations and workers despite a canonical export (CONFIRMED)

- **Severity:** MED · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `BUDDY_PROVIDER_IDS` is exported from
  `provider-metadata.ts:520` with a docstring explaining it exists so a fourth
  sibling cannot be added in one place and silently missed elsewhere. Yet:
  - `src/providers/operations/account-tier.ts:23-26` re-declares
    `const BUDDY_PROVIDER_IDS: ReadonlySet<string> = new Set(["cb", "cbcn"])`
    instead of importing it.
  - The Qoder family `["qoder", "qodercn"]` is re-declared in
    `account-tier.ts:27`, `src/workers/daily-checkin.ts:54`,
    `src/providers/integrations/qoder/qoder-checkin.ts:37`, and
    `src/providers/integrations/qoder/claim-qoder-credits.ts:37`.
  - The Trae family `["trae", "traecn"]` is re-declared in
    `account-tier.ts:22` (canonical realm keys exist in
    `QODER_REALMS`/`TRAE_REALMS`, already imported by `provider-metadata.ts:2-3`).
- **Why it is real duplication.** The Buddy copy directly contradicts the
  file's own centralization principle, and the Qoder/Trae copies are four more
  places a new realm or sibling must be updated. The comment in
  `provider-metadata.ts:511-519` states the failure mode precisely.
- **Proposal.** Export `TRAE_PROVIDER_IDS` and `QODER_PROVIDER_IDS` from
  `provider-metadata.ts` (derived from the realm tables' keys) beside
  `BUDDY_PROVIDER_IDS`, and have `account-tier.ts`, `daily-checkin.ts`,
  `qoder-checkin.ts`, and `claim-qoder-credits.ts` import them. Keep the
  differential policy logic (plan-string tiers, credit claims) local; only the
  id sets are shared. The `daily-checkin.ts` comment about avoiding heavy
  static imports is satisfied because `provider-metadata.ts` is a light module
  (it already imports only the realm constants).
- **Verification.** `test/providers/cooldown-rules.test.ts` pins tier mapping;
  the daily check-in and credit-claim tests pin membership for the Qoder and
  Buddy sets. Add one assertion that the exported sets equal the current local
  sets, so a future realm addition must update both or the test fails.
- **State/fallback analysis.** Read-only `ReadonlySet`s; no state, no
  fallback branches. Membership is identical, so tier classification and
  check-in/credit gating are unchanged.
- **Fallback risk.** None for the Buddy set (same members). For Qoder/Trae,
  the new exports must be built from the realm tables so a future realm change
  updates every consumer at once — that is the point of the change.
- **Verification.** `test/providers/cooldown-rules.test.ts` and the account-tier
  consumers pin tier mapping; the daily check-in and credit-claim paths pin
  membership. Add one assertion that `BUDDY_PROVIDER_IDS`,
  `TRAE_PROVIDER_IDS`, and `QODER_PROVIDER_IDS` match the current local sets.

### F6 — `loadOne` vs `resolve` near-duplicate with one consumer and opposite cache semantics (PLAUSIBLE)

- **Severity:** LOW · **Effort:** S · **Behavior change:** yes, unless the
  probe path is deliberately kept cache-bypassing.
- **Mechanism.** `ProviderRegistry.loadOne` (`provider-registry.ts:208`) and
  `resolve` (`:221`) are nearly identical; they differ only in that `resolve`
  returns the cached adapter from `#loaded`, while `loadOne` skips the cache
  and always runs `#loadRegistration` (which single-flights `#loading` but
  rebuilds the adapter after a completed load). `loadOne` has exactly one
  caller: `resolveProbeAdapter` (`src/providers/discovery/probe-phases.ts:485`),
  which uses `undefined` (not registered) to fall back to a hand-built BYOK
  adapter. No test references `loadOne`.
- **Why it is a smell.** Two public entry points with nearly identical bodies
  and opposite cache semantics; a reader must notice that `loadOne` ignores the
  adapter cache. The probe's force-reload is not documented as intentional and
  has no observable benefit for bundled providers (loaders are dynamic-import
  memoized, so rebuilding constructs a cheap config holder).
- **Proposal.** Either (a) have `resolveProbeAdapter` call `resolve` and rely
  on the shared cache — behavior-equivalent in practice (same adapter factory,
  same identity assertion, same error propagation), or (b) keep the
  force-reload intent but make it explicit: rename to `loadFresh` (or add a
  documented `force` parameter to `resolve`) and comment why probes need a
  fresh load. Do not silently merge without deciding which semantic probes
  should have.
- **State/fallback analysis.** `loadOne` currently re-runs
  `registration.load()` per probe; `resolve` would reuse the cached adapter.
  No persisted state is involved — both paths cache into `#loaded` and keep the
  same single-flight and identity-assert behavior. The `undefined`-for-unregistered
  contract is identical, so the BYOK fallback in `resolveProbeAdapter` is
  unaffected either way.
- **Fallback risk.** Low. The only observable differences are adapter instance
  identity and a wasted loader re-evaluation per probe; neither changes wire
  behavior for bundled providers. If option (a) is chosen, verify the probe
  tests still pass.
- **Verification.** `test/providers/provider-probe.test.ts` and the probe
  suites (`test/providers/probe-mode.test.ts`, `probe-verdict-classification.test.ts`,
  `probe-capture-policy.test.ts`) exercise `resolveProbeAdapter` end-to-end and
  must pass unchanged under either option.

## Excluded / unverified suspects

- **Integration directories (`src/providers/integrations/**`)** — the adapter
  and client implementations for each provider are a separate audit area; only
  their registration seams in `default-registry.ts` were reviewed here.
- **`src/providers/quota/**` and `src/providers/authentication/**`** — quota
  snapshot persistence (`quota/snapshot.ts`), the quota cache, and OAuth
  session/refresh state are owned by other audit parts; the only cross-cut
  reviewed is the registry's `resolveQuotaCollector`/`resolveAuthentication`
  caching (which correctly invalidates on `upsert`/`unregister`).
- **`src/providers/operations/**`** — account health, cooldown, provider
  catalog seeder/service, and BYOK registration are part of the 07 part; their
  interactions with the registry (`registerByokProviders`, `syncByokProvider`,
  `refreshActiveProviderCatalogs`) were read only to confirm the registry cache
  contract is respected.
- **`src/providers/search/**`** — search providers are adapted through
  `createSearchAdapter` and registered in `default-registry.ts` (`exa`,
  `parallel`); their adapter internals are outside the listed globs.
- **`provider-usage.ts` / `repriceUsage`** — billing repricing is a separate
  area; it consumes `modelsDevCatalog.costFor` (reviewed for correctness of
  fallback, not consolidated).
- **`PackedCatalog` metadata cache and `ModelsDevCatalog`** — already lazy,
  bounded (2048 entries), and single-flight (`catalogCache` memo); no
  duplication found worth acting on.
- **`providerHasAdapterUserAgent`/`providerRateLimitIsIpScoped`** — already use
  prebuilt sets; they are the model F1 extends to the remaining helpers.
- **`trae.ts` `extractToken` vs `trae-oauth.ts` `firstString`** — similar
  intent, different key sets and return shapes; left out of F4 per the
  no-duplicate-behavior rule.

## Validation

- Method: codegraph symbol/call-path mapping first (registry internals, blast
  radius, and the `ProviderRegistrySnapshot` dead-reference check), then direct
  source reads for every finding, plus full-tree `Grep` for consumers of each
  duplicated symbol (`providerBaseUrl`/`providerDefaultWireFamily`/etc.,
  `DISCOVERY_BACKED_PROVIDER_SPECS`, `snapshot()`, `loadOne`, the two
  `["accessToken", ...]` blocks, and the family id sets). No code was executed
  or modified.
- The evidence quoted is from current on-disk source at the commit shown in
  git status (`0c012b1e`, branch `dev`).
- Tests referenced exist in the tree and pin the behaviors each finding
  preserves; none were run (read-only audit).

## Open questions

- F2: should `coreweave` and `dashscope` (which intentionally bypass the
  shared discovery-backed helper) be folded into the canonical
  `DISCOVERY_BACKED_PROVIDER_IDS` list with per-id overrides, or stay explicit
  special cases in `default-registry.ts`? Folding them in makes the producer
  table and the completeness test list one constant, but changes the meaning
  of "discovery-backed" from "uses the helper" to "has live discovery".
- F6: should the probe deliberately keep a cache-bypassing load (option b), or
  is shared-cache `resolve` acceptable? The answer decides whether
  `loadOne` is deleted or renamed/parameterized.
- F5: should the Trae/Qoder family sets live in `provider-metadata.ts` next to
  `BUDDY_PROVIDER_IDS`, or in a smaller dedicated module to keep
  `provider-metadata.ts` free of realm imports if the realm tables grow?

## Execution status

Implementasi kampaian (2026-11-09), verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **F1 (M-18) — ✅.** `BUNDLED_PROVIDER_BY_ID: ReadonlyMap` built once at
  module load; all ten per-call `.find()` predicates converted to `Map.get()`.
  `BUNDLED_PROVIDER_IDS` is now a `ReadonlySet`, making `isBundledProviderId`
  O(1).
- **F2 (M-19) — ✅.** Canonical `DISCOVERY_BACKED_PROVIDER_IDS` export
  (derived from `DISCOVERY_BACKED_PROVIDER_SPECS` keys, 21 ids);
  `createDiscoveryBackedProviderCapabilities` iterates it; the drifted test copy
  was replaced with the canonical import (drift resolved: `coreweave` removed,
  `larprouter` + `dashscope` added).
- **F3 (M-20) — ✅.** Dead `ProviderRegistrySnapshot`/`snapshot()`/`#revision`
  removed; zero callers verified by grep.
- **F4 (M-21) — ✅.** `extractJsonCredentialToken` extracted next to the
  canonical owner; both duplicate discovery closures now call it.
- **F5 (M-22) — ✅ (cross-cluster closure in Phase 3).** `account-tier.ts` now
  imports `BUDDY_PROVIDER_IDS` (provider-metadata), `QODER_CHECKIN_PROVIDER_IDS`
  (qoder-checkin), and `TRAE_PROVIDER_IDS` (new canonical export in
  `trae-realm.ts`); the three local copies were deleted.
- **F6 — ⛔ (retained, plausible-unverified).** `loadOne` has distinct
  force-refresh cache semantics; merging needs a semantic decision, deferred.
