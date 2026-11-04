# umidpack — unified native identity binaries (all OS/arch)

Extracted verbatim from the official `@qoder-ai/qodercli` bundle
(`package/bundle/qoder-worker-runtime.mjs`, base64-embedded blobs — the same
technique as the donor hub's `_install_umid.py`). One directory tree, every
supported target, no network fetch at deploy time.

## Targets

| Path | Platform | Format | Deps |
|---|---|---|---|
| `elf-x86_64/runtime-info` | Linux x86-64 | ELF | libstdc++/libm/libpthread/libdl/libc (glibc ≤ 2.28) — see `../qoder-umid-mini.tar.gz` for the bundled libs |
| `elf-aarch64/runtime-info` | Linux arm64 | ELF | same set (musl hosts need gcompat) |
| `macho-x86_64/runtime-info` | macOS Intel | Mach-O | only `/usr/lib/libSystem.B.dylib` (+ libz, libobjc, libsqlite3 — all present on every macOS) |
| `runtime-info.exe` + `sgsdk.dll` | Windows x64 | PE | the pair must sit in one directory (DLL is the SG engine) |

CLI contract (upstream, donor-verified):

```
runtime-info <env>                        # linux
printf '{"account":"<uid>"}\n' | runtime-info <env> --account-stdin   # darwin / win32
```

`env`: 0 default, 3 current CLI, 4 desktop. Output: one JSON line
`{machineToken, machineType, machineCode, vmInfo, …}`.

## Identity semantics (verified 2026-10-30)

- The identity is a deterministic function of the seed file
  `~/.config/.locale_cfg` (same path on Linux/macOS/WSL; the Windows exe
  ignores it and is hardware-bound, one identity per machine).
- Seed deleted → fresh identity; seed restored → identical identity. One
  seed per account, portable across OS hosts.
- macOS/WSL/Linux report `isVm:false` on normal hosts; `vmInfo` is local-only
  output and is never sent upstream (only the six `cosy-machine*` headers are).

## Platform playbook

| Host | How to run |
|---|---|
| Linux x86-64 | run `elf-x86_64/runtime-info` directly; if the host lacks glibc ≥ 2.28 libs, use `../qoder-umid-mini.tar.gz` |
| Linux arm64 | run `elf-aarch64/runtime-info` (glibc host) |
| macOS | run the Mach-O for the arch directly (self-contained against OS libs) |
| Windows | run `runtime-info.exe` with `sgsdk.dll` beside it (hardware-bound identity) |
| Any host with WSL | import `../qoder-umid-mini.tar.gz` (`wsl --import`) or run via `LD_LIBRARY_PATH` one-shot |
