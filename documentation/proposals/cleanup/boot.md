# Cleanup proposal — boot

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 5 · kandidat dead exports: 4

## Kandidat

- `ProductionAppDeps`
- `ShutdownState`
- `ShutdownHooks`
- `ElyxiaServer`

## Catatan

Umumnya tipe deps config — cek apakah dipakai sebagai type DI lintas modul; privatkan bila internal-only.

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
