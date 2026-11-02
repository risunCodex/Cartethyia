# Report 02 — console/api-keys, auth, audit, backup

Audited directories (every `.ts` file read in full):
- `src/console/api-keys/` — `share-popup-image.ts`, `routes.ts`, `contracts.ts`, `bucket-spend.ts`, `ban-constants.ts`
- `src/console/audit/` — `store.ts`, `routes.ts`, `contracts.ts`
- `src/console/auth/` — `lockout.ts`, `credentials.ts`, `audit-recorder.ts`, `account-reset.ts`, `account-reset-store.ts`, `access.ts`, `session-service.ts`, `session-resolver.ts`, `row-coercion.ts`, `setup-service.ts`, `session.ts`, `user-store.ts`
- `src/console/backup/` — `validate.ts`, `store.ts`, `service.ts`, `routes.ts`, `nine-router.ts`, `export-endpoint.ts`, `contracts.ts`, `9router-map.ts`

Each finding cites file + line. Dead-code claims were verified with repo-wide grep over `src/`, `test/`, `scripts/`, `dashboard/src/`. No files were modified.

---

## DEAD-CODE

1. **[DEAD-CODE] `src/console/backup/store.ts:1269` — `export { and, eq }`.**
   A trailing re-export of Drizzle operators from a domain store module. Repo-wide grep shows no consumer imports `and`/`eq` from `backup/store` (all other importers use `"drizzle-orm"` directly, e.g. `setup-service.ts:6`, `cli-tools/store.ts:1`). Looks like leftover scaffolding.
   *Fix:* delete the line and the import if unused; verify nothing imports it (grep `from ".../backup/store"`).

2. **[DEAD-CODE] `src/console/backup/export-endpoint.ts:112` — `export { BACKUP_SECTIONS }`.**
   Re-exports `BACKUP_SECTIONS` from `contracts`. Nothing imports it from `export-endpoint` (grep: only `contracts.ts`, `validate.ts`, `service.ts` use the canonical export). Dead re-export — the module already imports it for its own use.
   *Fix:* remove the re-export.

---

## DUPLICATION

3. **[DUPLICATION] `src/console/api-keys/ban-constants.ts:31` vs `dashboard/src/lib/ban-durations.ts:16` — the ban-duration list is hand-copied.**
   `BAN_DURATION_CHOICES` (server) and the dashboard's `BAN_DURATION_CHOICES` are byte-identical (`60/360/720/1440/10080/null`). The dashboard already imports the *pure* `API_KEY_BAN_REASONS` from the same source (`dashboard/src/data/contracts.ts:132`), and `ban-constants.ts` is deliberately free of `node:*` imports, so the dashboard can import the durations the same way. The comment at `ban-durations.ts:4-8` claims "mirrored … rather than declared twice" but it *is* declared twice.
   *Fix:* re-export `BAN_DURATION_CHOICES` from `dashboard/src/data/contracts.ts` and derive `dashboard/src/lib/ban-durations.ts` from it (or delete the dashboard copy and import directly).

4. **[DUPLICATION] `src/console/backup/store.ts:389-402` — identical JSDoc block duplicated on `backupJsonChunks`.**
   The same doc comment appears twice, verbatim (one says "membrane-incrementally", the next "written incrementally" — same content).
   *Fix:* keep one block.

5. **[DUPLICATION] `src/console/backup/store.ts:717-724` — duplicate JSDoc on `existingEventFileKeys`.**
   Two back-to-back doc comments describe the same function ("Reads the natural keys …" then "Natural keys already present in the event file …").
   *Fix:* keep one.

6. **[DUPLICATION] `src/console/auth/session.ts:268-280` and `:283-295` — the two failed-login branches are copy-paste.**
   The "unknown / inactive user" and "wrong password" arms are algorithmically identical: `recordFailure` → if `isBanned` set 429 + `retry-after` + `lockedOutMessage`, else 401 + `failedLoginMessage`. Only the audit reason string differs (`"unknown_user"` vs `"invalid_password"`).
   *Fix:* extract one helper, e.g. `rejectLogin(lockoutService, lockoutKey, reason, set): Promise<LoginResponse>`, and call it twice.

7. **[DUPLICATION] Conditional-omit spread idiom repeated across three sites.**
   The `...(x === undefined ? {} : { x })` field-omission pattern is repeated ~20× inside `updateKey` (`api-keys/routes.ts:289-333`), ~20× in `createKey` (`routes.ts:175-197`), and ~18× in `sanitizeApiKeyResponse` (`api-keys/contracts.ts:433-456`). Maintaining three hand-rolled copies of the same object-shaping logic invites drift (one field added to one copy and not the others).
   *Fix:* a tiny shared helper such as `pickDefined<T>(obj: T): Partial<T>` (or `omitUndefined`) used by all three sites.

8. **[DUPLICATION] `src/console/backup/routes.ts:202-213` vs `:289-300` — the 413 body-limit check is duplicated verbatim.**
   `/import` and `/inspect` both re-measure `content-length` and re-serialized body against `MAX_BACKUP_BYTES` and return the same 413 shape.
   *Fix:* extract `enforceBodyLimit(request, body, set): boolean` and call from both routes.

9. **[DUPLICATION] `src/console/backup/store.ts:854-874` vs `:900-926` — conflict handling written twice in `insertRows`.**
   The `ignoreConflicts` / `conflictTarget` branch logic inside the per-row `insertOne` is re-implemented inside the bulk `insertChunk` with only the statement shape differing (single row vs chunk). If the conflict rules change, both paths must change.
   *Fix:* extract the `onConflictDoNothing`/`onConflictDoUpdate` decision into one helper that takes a statement builder, used by both paths.

10. **[DUPLICATION] `src/console/api-keys/contracts.ts:252-261` — `resolveKeyPrefix` and `resolveShareKeyPrefix` are near-identical.**
    Both trim, fall back to a default constant, and return the string; only the default differs.
    *Fix:* one parameterized `resolvePrefix(raw, fallback)`; keep two thin wrappers if call sites benefit from the distinct names.

---

## BLOAT

11. **[BLOAT] `src/console/api-keys/routes.ts:213-423` — `updateKey` is a ~210-line monolith.**
    It interleaves mode-conversion logic (`251-281`), the ~45-line conditional-spread patch builder (`289-333`), cache invalidation, tighten/new-limit analysis (`366-415`), and audit. The `tightened`/`isNewLimit` closures and the `limitsChanged` computation could be extracted; the credential-patch branch (`251-281`) is its own clearly-bounded concern.
    *Fix:* split into `buildCredentialPatch(current, patch, modeChanged, prefixChanged)` and `limitDelta(...)` helpers; the route keeps orchestration.

---

## ANTI-PATTERN

12. **[ANTI-PATTERN] `src/console/auth/session-service.ts:76` — silent fallback on failed row coercion.**
    `return persisted ?? ({ ...newSession } as unknown as ConsoleSession);` — if `sessionRecord` returns `undefined` (driver returned an unshaped row), the method *pretends success* and returns the input object cast to `ConsoleSession`, masking a driver/schema mismatch. `assertMutationApplied` (line 74) already refuses a failed insert, so this fallback contradicts that posture.
    *Fix:* throw when `persisted` is undefined (mirror `assertMutationApplied`), or at minimum log loudly.

13. **[ANTI-PATTERN] `src/console/api-keys/routes.ts:96-98` — `.catch(() => 0)` swallows telemetry errors in `listKeys`.**
    `sumFamilyTelemetryConsumed(...).catch(() => 0)` reports a share template's spend as 0 when the sum query fails, under-reporting consumed tokens in the console list with no signal.
    *Fix:* log the failure (and consider surfacing a degraded flag) instead of silently returning 0; at minimum use the existing logger.

14. **[ANTI-PATTERN] Pervasive `as unknown as CartethyiaDatabase` transaction casts.**
    `backup/store.ts:899`, `:1073`, `:1226`; `auth/setup-service.ts:174`; `auth/session.ts:529`. Each is individually commented/justified (Drizzle nested-transaction typing), but the pattern is repeated five times across the audited areas and is a type hole every time.
    *Fix:* if the driver offers a typed transaction handle, centralize the cast once (e.g. a `tx(db, fn)` wrapper in the persistence layer) so raw casts are not scattered.

15. **[ANTI-PATTERN] `src/console/auth/row-coercion.ts:27,40` — unchecked `as unknown as` casts.**
    `sessionRecord`/`userRecord` do partial runtime checks (string/boolean fields, dates) but then cast the *entire* object through `as unknown as ConsoleSession`/`ConsoleUser`, letting unvalidated fields through. `sessionRecord` even spreads `...value` so arbitrary extra keys survive.
    *Fix:* construct the result object explicitly field-by-field after validation, so the output shape is exactly the checked one.

16. **[ANTI-PATTERN] `src/console/auth/lockout.ts:146` — empty `catch { }` in `logBanAudit`.**
    Documented as best-effort, but a failed audit write is completely invisible (no log line, unlike `audit-recorder.ts` which logs). For a security-relevant event (`security.ip_banned`), total silence is worse.
    *Fix:* `log.error(...)` in the catch, matching `audit-recorder.ts:79`.

---

## OPTIMIZATION-OPP

17. **[OPTIMIZATION-OPP] `src/console/backup/store.ts:344` (`encodeRow`) and `:678` (`toValues`) call `columnIndex(table)` once per row; `sealedColumns(table)` allocates a new `Set` per call.**
    `columnIndex` builds a fresh Map by iterating every column; `sealedColumns` (`contracts.ts:174-176`) returns `new Set(...)` each call. The export path calls `encodeRow` per row across potentially hundreds of thousands of rows (`EXPORT_PAGE_ROWS` paging), so this is an avoidable allocation per row. (`columnNames`/`droppedColumns` are already WeakMap-cached in `contracts.ts`.)
    *Fix:* cache `columnIndex` per table in a `WeakMap<Table, …>` (same pattern as `COLUMN_CACHE`), and cache `sealedColumns` the same way.

18. **[OPTIMIZATION-OPP] `src/console/api-keys/routes.ts:821` and `:841` — `banKey`/`unbanKey` re-fetch the record after mutating.**
    Both do `store.get` → `store.ban/unban` → `store.get` again just to return the sanitized response. The second read is avoidable.
    *Fix:* have `store.ban`/`store.unban` return the updated row (or derive the response from the pre-fetch + known mutation).

19. **[OPTIMIZATION-OPP] `src/console/api-keys/routes.ts:796` — ban-duration `Set` rebuilt on every ban request.**
    `new Set(BAN_DURATION_CHOICES.map(c => c.minutes))` is recomputed per call. It is a constant.
    *Fix:* hoist to module scope (next to `SHARED_CHILD_SORT_COLUMNS`).

20. **[OPTIMIZATION-OPP] `src/console/backup/validate.ts:105` (`columnTypes`) and `:125` (`requiredColumns`) are computed per table without caching.**
    Both iterate `getTableColumns` and allocate Maps/Sets. They run once per table per validation (not per row), so impact is modest — but they are the only helpers in `contracts`/`validate` that skip the cache pattern used by `columnNames`/`droppedColumns`.
    *Fix:* add a `WeakMap<Table, …>` cache, consistent with `COLUMN_CACHE`.

---

## STALE

21. **[STALE] `src/console/api-keys/contracts.ts:150` / `routes.ts:1026` — `BanApiKeyRequest.reasonLabel` is accepted but never used.**
    The ban route body schema accepts `reasonLabel`, the dashboard sends it (`dashboard/src/features/usage/sections/request-detail-drawer.tsx:275`), but `banKey` never reads it — the audit detail records only `reason` (`routes.ts:819`). The field is inert wire surface.
    *Fix:* either persist/audit it (store it on the ban record or include in audit detail) or drop it from the schema and the dashboard call site.

22. **[STALE] `src/console/backup/9router-map.ts:110` — `REFUSED_PROXY_KINDS` is an empty object; the refuse-branch in `nine-router.ts:482-486` is dead logic.**
    `REFUSED_PROXY_KINDS` is always `{}`, so `refused = REFUSED_PROXY_KINDS[rawKind]` is always `undefined` and the "refused" branch can never fire. The code is written to handle refusals that the data model never produces.
    *Fix:* either populate the map with genuinely refused kinds (if any exist) or delete the branch and the constant, replacing it with the existing "unknown type" path.

23. **[STALE] Name collision: `BackupExportResult` is declared twice with different shapes.**
    `src/console/backup/contracts.ts:495` defines `BackupExportResult = { payload, counts }`; `src/console/backup/export-endpoint.ts:40` defines a *different* `BackupExportResult = { path, bytes, counts }` (the file-write result). Same name, unrelated shapes, in sibling modules.
    *Fix:* rename the endpoint-local interface (e.g. `BackupExportFileResult`) to remove the ambiguity.

---

## Summary counts

| Severity | Count |
| --- | --- |
| DEAD-CODE | 2 |
| DUPLICATION | 8 |
| BLOAT | 1 |
| ANTI-PATTERN | 5 |
| OPTIMIZATION-OPP | 4 |
| STALE | 3 |
| **Total** | **23** |

---

## OK — verified clean

- **`api-keys/ban-constants.ts`** — pure, well-isolated, single source for reasons (dashboard re-imports it). Clean.
- **`api-keys/share-popup-image.ts`** — pure sniffing module, no Node imports, well-commented. Clean.
- **`api-keys/bucket-spend.ts`** — single family-sum query, documented `EXISTS` approach. Clean.
- **`api-keys/contracts.ts`** — exports all referenced (`DEFAULT_API_KEY_PREFIX`, `SHARED_CHILD_HINT_MAX_LENGTH`, `parseRequest`, `mapShareLinkResponse`, `prepareCustomKey`, etc. all have consumers); `DEFAULT_API_KEY_LABEL` used by setup + tests. Clean apart from the items above.
- **`audit/`** — `store.ts`, `routes.ts`, `contracts.ts` all small, focused, no dead exports (`DrizzleAuditReadStore`, `createAuditRoutes` used in `domain-registration.ts:140,260`). Clean.
- **`auth/access.ts`, `auth/credentials.ts`, `auth/account-reset.ts`, `auth/account-reset-store.ts`** — minimal and correct; all exports referenced (`resetConsoleAuthState` used in `boot/app.ts:613` + tests; `createConsoleAccountResetHandler` used in `boot/app.ts:610`). Clean.
- **`auth/user-store.ts`** — tiny, used by `setup-service.ts` and `session.ts`. Clean.
- **`auth/session-resolver.ts`** — `resolveConsoleAccess`/`resolveConsoleUser`/`readSessionCookie` all consumed by `console-router.ts` / `session.ts`. Clean.
- **`backup/nine-router.ts`** — conversions are thorough and reported; no dead exports (`convert9RouterBackup` used by `service.ts:49`; `ImportReport` re-exported to dashboard). Clean.
- **`backup/service.ts`, `backup/validate.ts`, `backup/contracts.ts`** — exports all used; caching in `contracts.ts` (`COLUMN_CACHE`, `DROPPED_CACHE`) is good practice. Clean apart from the specific findings above.
- **`backup/routes.ts`** — route wiring is consistent; the only finding is the duplicated 413 check (#8).
