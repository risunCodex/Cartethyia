# Kiro IDE/CLI unpack — evidence ledger

Dated evidence ledger for the Kiro client investigation (2026-11-01).
Revalidate before using these observations to change current behavior.

Builds pinned (inspected statically only, never launched):
- Kiro CLI: `kiro-cli-x86_64-pc-windows-msvc.msi` → unpacked `KiroCliExe`
  (466 MB, PE, Bun single-file executable) self-reports **kiro-cli/2.37.0**.
- Kiro IDE: `kiro-ide-1.4.62-stable-win32-x64.exe` (Inno Setup 6.4.0.1) →
  `resources/app/package.json` = **Kiro 1.4.62**, `distro d0fd3324…`,
  license `AWS-IPL` (VS Code fork / CodeWhisperer family).

Tools used: 7-Zip 26.05, innoextract 1.13.0 (fork release, SHA256 verified
against GitHub release digest), streamed string scanner (Bun), custom ASAR
reader.

## Key findings

| Finding | Evidence |
|---|---|
| The CLI (Rust/Bun) and the IDE (Electron) are different products | CLI UA `Kiro-CLI` / crate paths `crates\chat-cli-v2\…`; IDE UA is `KiroIDE-{v}-{machineId}` |
| CLI machine identity rides `x-kiro-machineid` header | `x-kiro-machineid` in string scan; IDE-only salts (`KotlinNativeAPI/`, `KiroAPIKey/`, `KiroFallback/`) are absent from the CLI binary |
| CLI V3 traffic goes through KAS/ACP control plane | `KIRO_KAS_ENDPOINT`, `KIRO_KAS_CONTROL_PLANE_ENDPOINT`, `KIRO_KAS_REGION`, `--control-plane-endpoint`, service `mavis-control-plane`; extension methods `_kiro.dev/session/*`, `_kiro.dev/commands/*`, `kiro/auth/getAccessToken` |
| Legacy AWS codewhisperer client is still bundled in the CLI | `q.{region}.amazonaws.com` hosts + `AmazonCodeWhispererStreamingService.GenerateAssistantResponse` etc. — but not the V3 surface |
| IDE is a VS Code fork | `resources/app/package.json`, `node_modules.asar` (109 MB), `out/main.js`, electron/deps |
| Inno Setup 6.4 payload is not a bare LZMA stream | 7z `[0]` is the container; LZMA offset probes 4–64 all fail; `innoextract 1.9` errors `Unexpected setup data version: 6.4.0.1`; fork 1.13.0 extracts cleanly |

Full detail: `D:\tmp\output\kiro-evidence-ledger.md` (string scan:
`D:\tmp\output\kiro-cli-strings.txt`).
