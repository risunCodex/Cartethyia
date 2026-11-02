# Cleanup proposal — config

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 10 · kandidat dead exports: 6

## Kandidat

- `TRUSTED_PROXY_PLATFORM_TOKEN`
- `resolvePackageRoot`
- `requirePublicOrigin`
- `oauthCallbackUrl`
- `REQUEST_BODY_TRANSIENT_COPIES`
- `REQUEST_BODY_BUDGET_FRACTION`

## Catatan

resolvePackageRoot mungkin dipakai script — verifikasi dulu.

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
