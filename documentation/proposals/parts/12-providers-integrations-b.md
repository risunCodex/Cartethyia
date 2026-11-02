# Report 12 — providers integrations B (github→zcode)

Scope scanned completely (every `.ts` file read): `src/providers/integrations/{github,grok,inception,kilo,kimi,kiro,muse,opencode,openrouter,qoder,trae,xai,xiaomi-mimo,zcode}` — 55 files. All usage claims below were verified by grepping the whole repo (`src/`, `test/`, `scripts/`, `dashboard/src/`). Some shared findings already captured in Report 11 are cross-referenced rather than duplicated.

---

## DEAD-CODE (exported symbols never referenced anywhere else in the repo)

1. **`hasFreshGrokRateLimit`** — `src/providers/integrations/grok/grok-ratelimit-store.ts:66`. Exported; the only reference in the repo is its own definition. Callers use `storedGrokRateLimit` directly. Fix: remove (or keep private if a future caller appears).

2. **`probeFrameHeader`** — `src/providers/integrations/grok/grok-quota-frame.ts:20`. Exported, but the only reference is internal (line 142 inside `findDataFramePayload`). Fix: drop `export` (module-private).

3. **`GROK_BILLING_SOURCE`** — `src/providers/integrations/grok/grok-quota.ts:291` (`export { BILLING_SOURCE as GROK_BILLING_SOURCE }`). Not referenced anywhere. Fix: remove the re-export.

4. **`MUSE_QUOTA_SOURCE`** — `src/providers/integrations/muse/muse-quota.ts:136` (`export { SOURCE as MUSE_QUOTA_SOURCE }`). Not referenced anywhere. Fix: remove the re-export.

5. **`requestMuseCodeKey` re-export** — `src/providers/integrations/muse/muse-oauth.ts:202`. The function is used internally (lines 160, 191); the re-export is imported nowhere. Fix: remove the re-export.

6. **`QODER_MODEL_CONFIGS`** — `src/providers/integrations/qoder/qoder.ts:121`. Exported; never imported anywhere (only mentioned in comments — `qoder-catalog.ts:75`, self-comment at `qoder.ts:1599`). The real rosters live in `qoder-catalog.ts` (`QODER_INTL_MODEL_CONFIGS`/`QODER_CN_MODEL_CONFIGS`). Fix: remove, or keep module-private if used for lookup (it isn't).

7. **`isForeignQoderModel` + `QODER_INTL_EXCLUSIVE` + `QODER_CN_EXCLUSIVE`** — `src/providers/integrations/qoder/qoder-realm.ts:129-146`. All exported; no references anywhere. Fix: remove all three.

8. **`QODER_LOGIN_URL`, `QODER_USERINFO_URL`** — `src/providers/integrations/qoder/qoder-oauth.ts:114,116`. Exported; never referenced (per-realm URLs are built dynamically by `qoderOAuthUrls`, line 125). `QODER_DEVICE_TOKEN_URL` (line 115) is used internally as `tokenUrl` — keep. Fix: drop the two unused exports.

9. **`buildCurrentTimeLine`** — `src/providers/integrations/kiro/kiro-request.ts:225`. Exported; no reference anywhere (the comment at line 202 references it by name, the function itself is dead). Fix: remove.

10. **`buildTraeModelListBody` + `TRAE_MODEL_LIST_ENDPOINT`** — `src/providers/integrations/trae/trae-protocol.ts:275,281`. Exported; no references (discovery builds its `{type:"chat"}` body inline at `trae.ts:526`). Fix: remove both.

11. **`traeStaticModels`** — `src/providers/integrations/trae/trae-catalog.ts:139`. Exported; no references (registry imports the two roster consts directly). Fix: remove.

12. **Trae unused path constants** — `src/providers/integrations/trae/trae-realm.ts:91,126,128,131,132`: `TRAE_TEMP_TOKEN_PATH`, `TRAE_ACTIVITY_PATH`, `TRAE_PAY_STATUS_PATH`, `TRAE_CHECKIN_STATUS_PATH`, `TRAE_CHECKIN_CLAIM_PATH`. Exported; no references anywhere (leftover scaffolding of surfaces not wired). Fix: remove the five exports.

13. **`QODER_ENV_CODES`, `hasGenuineBridge`, `readCurrentQoderSeed`, `resetQoderNativeIdentityCache`** — `src/providers/integrations/qoder/qoder-umid.ts:41,95,282,305`. All exported; no references anywhere (`resetQoderNativeIdentityCache` is a no-op by its own comment). Fix: remove all four.

14. **xAI named OAuth re-exports** — `src/providers/integrations/xai/xai-oauth.ts:47-50,59`: `XAI_CLIENT_ID`, `XAI_DEVICE_URL`, `XAI_TOKEN_URL`, `XAI_USERINFO_URL`, `XAI_SCOPE`. Each is used only within the same module; the only cross-module consumer is `grok-oauth.ts:11` importing `XAI_AUTH_SERVER`. Fix: keep `export { XAI_AUTH_SERVER }` only; drop the five named exports.

15. **`KIRO_DEFAULT_CONTEXT_WINDOW`** — `src/providers/integrations/kiro/kiro-catalog.ts:132`. Exported; used only internally (line 128). Fix: drop `export`.

16. **`KILO_API_BASE_URL`** — `src/providers/integrations/kilo/kilo-oauth.ts:33`. Exported; only used to derive other module-local constants; never imported. Fix: drop `export`.

---

## DUPLICATION (same logic written more than once; consolidation candidates)

1. **Session-cache estimator duplicated verbatim** — `src/providers/integrations/kiro/kiro-cache.ts:14-111` and `src/providers/integrations/trae/trae-cache.ts:14-110` are effectively identical (same `MAX_SESSIONS = 512`, `hashOf`, `sessionFor`, `remember`, longest-prefix match, bounded eviction). Fix: extract one shared `providers/shared/session-cache.ts` module and have both adapters call it.

2. **AWS region regex defined 4× in kiro** — `AWS_REGION_PATTERN` is duplicated in `kiro.ts:78`, `kiro-discovery.ts:28`, `kiro-quota.ts:49`, `kiro-oauth.ts:73` (identical `/^[a-z]{2}-[a-z]+-\d{1,2}$/`). Fix: define once in `kiro-catalog.ts` (or a shared kiro-constants module) and import.

3. **Device-OAuth poll "read body → parse → classify → reason" repeated** — grok-oauth.ts:191-217, xai-oauth.ts:174-204, kimi-oauth.ts:166-197, kiro-oauth.ts:525-539, qoder-oauth.ts:392-429, kilo-oauth.ts:147-167 each hand-roll the same text→JSON→`devicePollBackoff`→reason selection. The shared store already provides `devicePollBackoff`/`parseDeviceAuthStart`; add a shared `pollDeviceResponse(response, interval?, opts)` helper in `authentication/oauth-flow-store` to unify the pattern.

4. **String-escape loop in two copies** — `escapeJsonRawNewlines` (`qoder.ts:554`) and `escapeControlInsideStrings` (`qoder-text-tools.ts:40`) implement the same char-by-char newline-inside-string escaping. Fix: share one helper (export from `qoder-text-tools.ts` and import in `qoder.ts`).

---

## BLOAT (redundant branches/wrappers, dead fields)

1. **`qoderStructuredTools(_realm)`** — `src/providers/integrations/qoder/qoder.ts:793`. Wrapper returning literal `true` with an unused parameter; call sites at lines 820/878. Fix: replace with a module const `true` (or inline) and delete the function.

2. **`MODERN_PROFILE.chatUrl` never read** — `src/providers/integrations/qoder/qoder.ts:96,108`. The field is set but no code reads it (dispatch uses `qoderIdeChatUrl` / `qoderInferenceCandidates`). Fix: drop the dead field; the remaining profile flags could also be plain consts since none change.

3. **`drainQoderResponse` hand-parses SSE** — `src/providers/integrations/qoder/qoder.ts:1207-1279`. It re-splits frames (`/\r?\n\r?\n/`, `data:` lines) although `decodeQoderSseEvents` (`qoder-sse.ts:58`) already exists and is what the stream path uses. Fix: reuse `decodeQoderSseEvents` for the drain analysis.

4. **Two similar credential-hash helpers in github** — `githubCredentialKey` (`github.ts:185-194`) and `#autoDecisionCacheKey` (`github.ts:586-596`) both parse the credential and sha256 host+token with near-identical shapes. Fix: have `#autoDecisionCacheKey` reuse `githubCredentialKey` + tier/session suffix.

---

## ANTI-PATTERN (typing holes, unsafe/misleading patterns)

1. **`(context.outbound_fetch as unknown as typeof fetch)` double-cast** — `qoder.ts:1709` (also `trae.ts:197`, `kiro.ts:394`). Casts `ValidatedOutboundFetch` through `unknown` to `typeof fetch`. Fix: add one typed accessor (e.g. `resolveOutboundFetch(context, fallback)`) on `ProviderDispatchContext` — see Report 11 DUPLICATION #7; this is the same finding in this scope.

2. **`as unknown as BodyInit` / `as unknown as HeadersInit`** — `qoder.ts:402,449`, `qoder-catalog.ts:467`. The COSY fetcher types are narrower than `RequestInit`; the casts hide the mismatch. Fix: type `QoderFetcher` and the discovery `fetcher` to accept `RequestInit` so the casts go away.

3. **`Math.random()` in PKCE verifier length** — `src/providers/integrations/qoder/qoder-oauth.ts:237`. `43 + Math.floor(Math.random() * 86)` picks the length; bytes come from `randomBytes` so it is not a cryptographic break, but mixing `Math.random()` into an OAuth flow is a smell. Fix: use a fixed length (e.g. 64) or draw the length from `randomBytes`.

4. **Variable shadowing in `replayQoderNativeIdentity`** — `src/providers/integrations/qoder/qoder-umid.ts:259`: `const seed = seedPath(); writeFileSync(seed, seed, "utf8")` shadows the `seed` parameter. It works but is a typo hazard and inconsistent with the macho branch (`seedPathStr`, line 269). Fix: rename the local (e.g. `const seedFilePath = seedPath()`).

---

## OPTIMIZATION-OPP (re-computation per call)

1. **GitHub credential hash recomputed multiple times per dispatch** — `githubCredentialKey` is invoked by `githubModelRoute` (line 222), `recordGithubModelRoutes` (line 200), and `#autoDecisionCacheKey` (line 591) — each re-parses the credential and re-runs sha256. Fix: memoize the key per credential string (small bounded map, as the route map already is).

2. **`resolveKiroConversationId` called twice per dispatch** — `src/providers/integrations/kiro/kiro.ts:377-378` computes it for both `conversationId` and `rootConversationId` (two identical function calls). Fix: compute once, reuse.

3. **Fresh `TextDecoder` on hot paths** — `github.ts:433,516,633,682`, `qoder.ts`, `trae.ts:193`, `kiro.ts:349` each allocate a new `TextDecoder` per dispatch. Fix: hoist module-level `const decoder = new TextDecoder()` (same fix as Report 11 OPTIMIZATION #3, which applies here too).

---

## STALE (obsolete/duplicated constants, leftover scaffolding)

1. **`KIRO_GENERATE_PATH` duplicated** — `src/providers/integrations/kiro/kiro-discovery.ts:53` re-declares the constant that `kiro-catalog.ts:13` already exports. Fix: import from `kiro-catalog.ts` instead of re-declaring.

2. **Trae unused path constants** — the five `TRAE_*` path constants in `trae-realm.ts` (see DEAD-CODE #12) are stale scaffolding for surfaces this adapter never calls.

3. **Qoder global endpoint constants as an older layer** — `qoder-oauth.ts:113-116` (`QODER_LOGIN_URL`, `QODER_DEVICE_TOKEN_URL`, `QODER_USERINFO_URL`) duplicate the intl values the realm table derives in `qoderOAuthUrls` (line 125). The globals predate the realm table; only `DEVICE_TOKEN_URL` is still wired (as `tokenUrl`). Fix: drop the two unused globals and consider sourcing `tokenUrl` from `qoderOAuthUrls`.

---

## OK — parts verified clean

- **`inception/provider.ts`** — minimal spec; `INCEPTION_SPEC`/`INCEPTION_MODELS`/`discoverInceptionFreeModels` all wired in `default-registry.ts`; free-tier pinning coherent; no dead exports.
- **`openrouter/`** — `OPENROUTER_SPEC`/`OPENROUTER_MODELS`/`OPENROUTER_FREE_MODELS`/`discoverOpenrouterModels`/`discoverOpenrouterFreeModels` wired; `clineReasoningReplayPrepares` reused properly; OAuth client (minimal PKCE, durable key) is small and clean.
- **`zcode/`** — `ZCODE_SPEC`/`ZCODE_MODELS`/`discoverZcodeModels` wired; manual two-stage OAuth flow is well-structured with envelope unwrap; no dead exports.
- **`xiaomi-mimo/xiaomi.ts`** — tiny spec+catalog; both `XIAOMIPG_SPEC`/`XIAOMITP_SPEC` and shared `XIAOMI_MODELS` wired; clean.
- **`xai/`** — adapter + `xai-discovery.ts` neat; `XAI_EFFORT_MAP` is single-source; only the named re-exports flagged above are dead.
- **`muse/`** — adapter/quota/oauth coherent; envelope codec shared via `security/credential-codec`; only the re-export flagged above is dead.
- **`kilo/`** — adapter/oauth/discovery coherent; `decodeKiloCredential` shared in `credential-codec`; only `KILO_API_BASE_URL` export is dead.
- **`kimi/`** — bootstrap table + `lookupKimiPromptCacheKey` hashing centralized; adapter delegates to the shared Claude Messages pipeline; no dead exports.
- **`github/`, `grok/`, `kiro/`, `qoder/`, `trae/`** — the core dispatch/stream/decoder translations are carefully maintained and consistent with documented upstream facts; flagged items above are the only concrete cleanup opportunities found.

---

## Summary counts

| Severity | Count |
| --- | --- |
| DEAD-CODE | 16 |
| DUPLICATION | 4 |
| BLOAT | 4 |
| ANTI-PATTERN | 4 |
| OPTIMIZATION-OPP | 3 |
| STALE | 3 |
| **Total** | **34** |
