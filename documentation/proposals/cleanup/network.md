# Cleanup proposal — network

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 19 · kandidat dead exports: 12

## Kandidat

- `Http2BidiResponse`
- `ValidatedFetchOptions`
- `RESERVED_ENDPOINT_CONFIG_KEYS`
- `PoolByteTotals`
- `PoolAgentResolverDeps`
- `DEFAULT_PROXY_CONCURRENCY`
- `effectiveConcurrency`
- `PoolSelectionFailureReason`
- `PoolCapacitySnapshot`
- `PoolHealthSnapshot`
- `EgressVerdict`
- `RetryOptions`

## Catatan

Sebagian tipe helper murni — privatkan.

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
