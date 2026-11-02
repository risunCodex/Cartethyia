# Qoder UMID portable mini-Linux bundle

A ~3.7 MB bundle that runs the genuine Alibaba SG UMID bridge
(`runtime-info`, Linux x86-64) anywhere WSL works — with **no distro install
and no repo checkout**. This is the "bundled mini-Linux" deliverable: the ELF
plus exactly the eight shared libraries it needs, packed as a WSL-importable
tar.

## Why this exists

The mini bundle provides the vendor's Linux UMID bridge for research and
surfaces that need a stable native identity. Later same-account controls found
that daily CREDITS claims do not require a genuine identity: generated, random,
empty, and omitted machine headers all exposed an existing grant. The bridge
does not create a missing grant. See
[`documentation/research/qoder/2026-10-29-qoder-credits-claims-identity.md`](../../documentation/research/qoder/2026-10-29-qoder-credits-claims-identity.md).

## Contents of `qoder-umid-mini.tar.gz`

| Path | What |
|---|---|
| `opt/umid/runtime-info` | the SG bridge ELF (652 KB) |
| `lib/x86_64-linux-gnu/` | `libc.so.6`, `libstdc++.so.6`, `libm.so.6`, `libpthread.so.0`, `libgcc_s.so.1`, `librt.so.1`, `libdl.so.2` |
| `lib64/ld-linux-x86-64.so.2` | dynamic loader |

The ELF requires GLIBC ≤ 2.28 — the bundled libs satisfy it. No package
manager, no other files.

## Usage A — one-shot from an existing WSL (no import needed)

```powershell
wsl -e bash -lc "mkdir -p /tmp/umid-mini && tar -xzf /mnt/c/path/qoder-umid-mini.tar.gz -C /tmp/umid-mini && rm -f ~/.config/.locale_cfg && LD_LIBRARY_PATH=/tmp/umid-mini/lib/x86_64-linux-gnu /tmp/umid-mini/opt/umid/runtime-info 3"
```

Prints one JSON line: `{machineToken, machineType, machineCode, vmInfo}`.

## Usage B — import as its own distro (isolated, one command)

```powershell
wsl --import QoderUMID C:\qoder-umid qoder-umid-mini.tar.gz --version 2
wsl -d QoderUMID -e bash -lc "mkdir -p ~/.config && rm -f ~/.config/.locale_cfg && LD_LIBRARY_PATH=/lib/x86_64-linux-gnu /opt/umid/runtime-info 3"
wsl --unregister QoderUMID   # cleanup
```

Note: inside the imported distro the loader path is `/lib64/…` already, so
`LD_LIBRARY_PATH` is often unnecessary there; it is required when running the
binary straight from `/tmp` inside an existing distro.

## Seed semantics

Identity is a deterministic function of the seed file
`~/.config/.locale_cfg` inside whichever distro runs the bridge. Delete the
seed → fresh identity; restore the seed → the same identity again. One seed
per account; store the seed bytes beside the account.

## Why not qemu-user on Windows

qemu-user maps Linux syscalls 1:1 onto the host OS; Windows is not POSIX, so
user-mode emulation of a Linux ELF under Windows does not work. WSL (which
this bundle rides on) is the practical minimal Linux on Windows.
