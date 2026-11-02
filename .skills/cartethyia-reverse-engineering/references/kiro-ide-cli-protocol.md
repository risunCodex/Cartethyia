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
| CLI 2.37.0 non-interactive chat hits the runtime service directly (captured via mitmproxy, 2026-11-02) | `POST https://runtime.us-east-1.kiro.dev/` (root path) with `x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`, UA `aws-sdk-rust/1.6.0 … app/AmazonQ-For-CLI`, `x-amzn-codewhisperer-optout: false`, `x-kiro-attempt: 1;max=3`, `amz-sdk-request: attempt=1; max=3`, `accept: */*` (NOT `application/vnd.amazon.eventstream`). Body is camelCase: `{conversationState:{conversationId,history,currentMessage,chatTriggerType,agentTaskType}, profileArn}` — top-level `profileArn` in body, NOT as a header; no `rootConversationId`/`agentContinuationId` in the captured request. `currentMessage.userInputMessage.userInputMessageContext` carries `envState:{operatingSystem,currentWorkingDirectory}` + `tools[]` (14 tool specs). |
| CLI management surface (captured) | `POST https://management.us-east-1.kiro.dev/?origin=KIRO_CLI&profileArn=…` with `x-amz-target: KiroControlPlaneBearerService.ListAvailableModels` (note `origin=KIRO_CLI`, vs IDE's `origin=AI_EDITOR`); `?profileArn=…&filter=MODEL_FALLBACKS` → `GetUserPreference`. |
| Response stream shape (captured, prompt-long run) | 599 frames: `initial-response` ×1, `assistantResponseEvent` ×594, `reasoningContentEvent` ×1, `metadataEvent` ×1, `contextUsageEvent` ×1, `meteringEvent` ×1; `stopReason=END_TURN`. No OpenAI `id`/`choices`/`usage` per-chunk fields — this is AWS EventStream, not OpenAI SSE. |
| `reasoningContentEvent` envelope (decoded) | Payload is `{"redactedContent":"…"}`; base64 → `.KTR~~<base64url-JSON>` → `{"encryptionRegion":null,"mintedAtMs":1793580364905,"modelHash":"yELV9xbcfwvU","slots":[],"v":1}`. Reasoning TEXT is never transmitted; adapter cannot surface reasoning. |
| No OpenAI/Messages surface in CLI binary | No `chat/completions`, `chatcmpl`, `api.openai`, `x-api-key`, `/v1/messages` strings found in `kiro-cli-strings.txt`. `No completions available` = LSP completions; `OpenAI Whisper` = voice ASR model download only. |
| Legacy AWS codewhisperer client is still bundled in the CLI | `q.{region}.amazonaws.com` hosts + `AmazonCodeWhispererStreamingService.GenerateAssistantResponse` etc. — but not the V3 surface |
| IDE is a VS Code fork | `resources/app/package.json`, `node_modules.asar` (109 MB), `out/main.js`, electron/deps |
| Inno Setup 6.4 payload is not a bare LZMA stream | 7z `[0]` is the container; LZMA offset probes 4–64 all fail; `innoextract 1.9` errors `Unexpected setup data version: 6.4.0.1`; fork 1.13.0 extracts cleanly |

Full detail: `D:\tmp\output\kiro-evidence-ledger.md` (string scan:
`D:\tmp\output\kiro-cli-strings.txt`).
