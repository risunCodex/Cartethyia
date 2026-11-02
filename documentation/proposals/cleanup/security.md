# Cleanup proposal — security

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 21 · kandidat dead exports: 18

## Kandidat

- `Lihat output audit penuh (tambahan: api-key-auth, admission, outbound-headers, dll).`

## Catatan

Kontrak auth sensitif — verifikasi ekstra sebelum privatisasi.

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
