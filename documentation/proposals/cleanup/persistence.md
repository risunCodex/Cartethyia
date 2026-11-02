# Cleanup proposal — persistence

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 23 · kandidat dead exports: 40

## Kandidat

- `ConnectionUrlSpec`
- `QueryRows`
- `requireDatabaseUrl`
- `startPoolShrinker`
- `prepareAuthStatements`
- `resolveSqliteMigrationsFolder`
- `ReadinessStatus`
- `CloseRedisOptions`
- `TENANT_STATUSES`
- `TenantStatus`
- `tenantRefNullable`
- `tenantRefRequired`
- `tenantRefPrimaryKey`
- `tenantCascadeSetNull`
- `createdAtColumn`
- `updatedAtColumn`
- `timestampColumns`
- `healthColumns`
- `networkPoolKind`
- `healthEntityKind`
- `telemetrySourceSurface`
- `telemetryStatus`
- `ProviderPoolAccount`
- `poolRoutingStrategy`
- `SHARE_LINK_KINDS`
- `TELEMETRY_USAGE_IDENTITY_TYPES`
- `SharedCacheNamespace`
- `InvalidationNotice`
- `SortOrderTable`
- `ShareLinkRecord`
- `ShareLinkToken`
- `ShareApiKeyRow`
- `ShareHandoffRow`
- `ShareLinkResolution`
- `SharedApiKeyMaterial`
- `SharedApiKeyIssueResult`
- `CachedPreferencesReaderOptions`
- `TtlCacheOptions`
- `TtlCacheEntry`
- `TtlCacheFamilyOptions`

## Catatan

schema.ts export banyak yang dipakai Drizzle (kolom) — JANGAN privatkan kolom table (tenantRef*, createdAtColumn dll) karena dipakai `models`/`providers` dsb. Kandidat sejati hanya helper helperang tak direferensikan.

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
