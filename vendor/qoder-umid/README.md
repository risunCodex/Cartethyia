# Qoder UMID vendor directory

Native machine-identity material for the Qoder daily check-in campaign.
Everything here is extracted verbatim from the official `@qoder-ai/qodercli`
npm bundle — no recompilation, no patches (except `harness/`, which came
from the farm harness and is kept as reference/tooling).

## Layout

| Path | What |
|---|---|
| `umidpack/` | **The identity binaries, every supported OS/arch** (Linux x86-64 + arm64 ELF, macOS Intel Mach-O, Windows exe + sgsdk.dll). See `umidpack/README.md` for the per-platform playbook. This is what `src/providers/integrations/qoder/qoder-umid.ts` executes. |
| `qoder-umid-mini.tar.gz` | Linux x86-64 ELF + its eight glibc dependencies (~3.7 MB) — a WSL-importable / one-shot mini rootfs for hosts whose libraries do not match. See `MINI-BUNDLE.md`. |
| `README.md` | this file |

## Identity semantics (verified 2026-10-30 → 2026-11-04)

- Identity is a deterministic function of the seed file
  `~/.config/.locale_cfg` (Linux/WSL/macOS): delete → fresh identity,
  restore → identical identity. One seed per account; the seed bytes live in
  `provider_accounts.native_identity.seed` and are replayed under a lock.
- The Windows exe ignores seed files — it is hardware-bound (one identity per
  machine). Still a genuine SG identity.
- `vmInfo` (isVm/brand) is local-only output.

## Correction (2026-11-04) — generated identity does NOT unlock the CREDITS campaign

Earlier same-account controls suggested machine headers do not gate an existing
grant. Revalidation with the **real UMID** on campaign `act-20261102-503`
shows the opposite: the CREDITS `CLAIM_BENEFIT` campaign only appears when the
genuine bridge token is sent (`runtime-info.exe` / ELF). The generated
SHA-256 token keeps the campaign hidden. The bridge is therefore **required**
for the claim button. See
[`documentation/research/qoder/2026-10-29-qoder-credits-claims-identity.md`](../../documentation/research/qoder/2026-10-29-qoder-credits-claims-identity.md)
(Part F/G) for the full record.
