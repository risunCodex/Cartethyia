# Reverse-engineering techniques: unpack, string-scan, beautify, wire capture

General toolkit for figuring out what a closed-source client (CLI, desktop
app, or SDK) does, without launching it — and for capturing its real outbound
wire when static inspection cannot pin the exact request shape. These
techniques were proven on real vendors (Kiro, Cursor, CodeBuddy, OpenCode,
Grok); per-provider findings live in `documentation/research/` (see below).

## 0. Working order

1. **Get the artifact** (installer/exe/dmg/msi) — prefer the version the
   vendor currently ships.
2. **Unpack it** (static inspection only — never launch) — see §1.
3. **String-scan** the unpacked bundles and binaries — see §2.
4. **Beautify** minified JS to make it readable — see §3.
5. **Capture the real wire** when you need byte-level proof — see §4.
6. Keep evidence in scratch (`D:\tmp\scratch\`); never commit credentials —
   redact `authorization` headers before adding samples to the repo.

## 1. Unpacking artifacts

| Artifact | Tool / recipe |
|---|---|
| `.dmg` (macOS) | `7z x <file>.dmg` → `4.hfs` (HFS+), then `7z x 4.hfs` → app volume |
| `.exe` (Inno Setup) | `innoextract` (use a recent fork for Setup ≥6.4; 1.9 errors on 6.4.0.1). **`innoextract 1.13.0` extracts 6.4 fine** (proven on Qoder IDE 1.38 — no manual LZMA needed). For 6.4+ when 1.13 is unavailable use the manual LZMA recovery below — `7z x` only yields the compressed container `[0]` (not a bare LZMA stream) |
| `.msi` | `7z x` → unpacked payload (may contain a single-file executable) |
| `app.asar` (Electron) | `bun scripts/tools/asar-unpack.mjs <app.asar> <outdir>`. Nativev2 header: `[u32 @0]=4`, `[u32 @4]=header+8`, `[u32 @8]=header+4`, `[u32 @12]=header JSON length`, JSON begins at offset 16. **Offsets are relative to the data section start (`16 + headerSize`), not absolute** — reading them absolute yields garbage (verified) |
| Single-file Bun/Rust executables | `7z x` often extracts embedded bundles; otherwise string-scan the binary directly (see §2) |

### Inno Setup ≥6.4 (e.g. Antigravity IDE 2.6.0)

`innoextract 1.9` errors on Setup 6.4.0.1 ("Unexpected setup data
version"). Manual recovery works. There are **two independent payloads**:
the setup headers (file table) and the data blob. Proven on
Antigravity IDE 2.6.0 (Google VS Code fork).

**A. Loader offset table — where everything lives.**
Inno ≥5.1.5 stores offsets in a PE resource named `11111` (RCDATA).
`7z x` extracts it (`.rsrc\0\RCDATA\11111`, 44 bytes). Parse per
innoextract `src/loader/offsets.cpp`:
- magic 12B (`rDlPtS\xcd\xe6\xd7{\x0b*` for 5.1.5+), revision u32 (=1),
  then (checksum-fed) u32s: `exe_offset`, `exe_compressed_size` (=0 for
  ≥4.1.6), `exe_uncompressed_size`, `exe_crc32`, `header_offset`,
  `data_offset`, trailing `expected_checksum`.
- Verify: `header_offset` holds the 64-byte version string
  (`Inno Setup Setup Data (6.4.0.1)`); `data_offset` points at the
  `zlb\x1A` data container.

**B. Setup-header block (file table).**
At `header_offset + 64` is the block header:
`[crc32 u32][stored_size u32][compression u8]` (compression 1 = LZMA1;
crc32 covers the next 5 bytes — verified). The following `stored_size`
bytes are **NOT one LZMA stream**: they are chunked blocks, each
`[crc32 u32][payload up to 4096B]` (last chunk shorter). Strip each crc,
concatenate — the result is a raw LZMA1 stream (`5D ...` props, no size
header). Decompress with Python `lzma.FORMAT_RAW` (filters lc/lp/pb from
prop byte, dict_size u32 LE). Output is the setup header: UTF-16LE binary
strings then counts (language/message/permission/type/component/task/
directory/file/data_entry/icon/ini/registry/delete/uninstall_delete/run/
uninstall_run).
- **Caveat.** Inno 6.4 field order differs from 6.1: observed non-numeric
  bytes where 6.1 expects counts (ASCII `IFPS` lands in the
  permission_count slot; file_count read 0 despite a huge data blob). Treat
  6.4 as an unknown variant — do not trust 6.1 offsets.

**C. Data blob.**
`data_offset` is the data container: `zlb\x1A` + raw LZMA1 (props
immediately, no size header). Build a standalone 13-byte header (5 prop
bytes + 8×0xFF unknown size) and feed it to `7z x` → decompresses to a
~950 MB concatenated payload (often begins MZ; Electron / VS-Code-fork
apps carry `resources/` files sequentially in it). This is the file
content; names/offsets come from the header file table (B).

PowerShell gotcha: `[0]` in a path is treated as a wildcard character
class — use `-LiteralPath` (or `Resolve-Path -LiteralPath`) when reading
files named like `[0]`.

### Qoder IDE desktop (Inno Setup 6.4, v1.38.0)

Source binary: `D:\tmp\binaries\QoderIDEUserSetup-x64.exe` (207,886,256 B,
produced 2026-11-02). `innoextract 1.13.0` extracts it in one pass — no
manual LZMA recovery needed.

```
innoextract-1.13.0-windows.exe --extract --output-dir <dst> QoderIDEUserSetup-x64.exe
```

Output layout (Electron / VS Code fork):

- `code$GetDestDir\Qoder IDE.exe` (226 MB Electron shell)
- `code$GetDestDir\resources\app\` — unpacked app (this fork ships **unpacked**,
  no `app.asar`)
  - `product.json` — `nameShort: "Qoder"`, `dataFolderName: ".qoder"`,
    `win32AppUserModelId: "AlibabaCloud.Qoder"`, version 1.38.0
  - `package.json` — `Qoder IDE` / `1.38.0`
  - `out\lingma\agents-window\agents-window.desktop.main.js` (56 MB) — agent UI
  - `out\lingma\aura-buddy\` etc.
  - `out\vs\workbench\workbench.desktop.main.js`, `out\vs\code\electron-utility\sharedProcess\sharedProcessMain.js`
  - `node_modules\@ali\qoder-config-service-sdk\` — config service SDK
- `app\tools\inno_updater.exe`, `vcruntime140.dll` — installer tools

Wire takeaways (Qoder IDE 1.38):

- **Hosts**: `center.qoder.sh` (big-model/center), `openapi.qoder.sh`
  (business), `qts2.qoder.sh` (quest — deprecated), `api2.qoder.sh`
  (dynamic region default). CN: `gateway.qoder.com.cn` / `openapi.qoder.com.cn`.
- **Dynamic endpoints**: the IDE does NOT hardcode the chat host. It calls
  `GET /algo/api/v2/service/region/endpoints` (on center) and reads
  `preferredInferenceNode.endpoint` (fallback `api2.qoder.sh`). Inference URLs
  are built as `<inferenceEndpoint> + path` (e.g. voice polish
  `/api/v2/service/voice/polish`, WebSocket `/api/v2/service/ws/asr`,
  telemetry `/apm`).
- Legacy COSY chat (`/algo/api/v2/service/pro/sse/agent_chat_generation`) and
  the modern `/model/v1/chat/completions` are **not present** as literals in
  the 1.38 bundles — chat now goes through the region-resolved inference
  endpoint. The Cartethyia adapter still defaults to `/model/v1/chat/completions`
  on `api2-v2.qoder.sh` with COSY fallback; see
  `documentation/research/qoder/2026-11-01-qoder-chat-wire-verification.md`.

## 2. String scanning

- Use a **streamed string scanner** (Bun) over the binary/bundles to dump
  readable ASCII/UTF-8 runs — hostnames, paths, header names, error strings,
  env-var names, operation names all survive.
- **Do not trust string scans alone for the body.** Struct fields in the
  binary (e.g. snake_case `conversation_state`, `profile_arn`) can differ from
  the actual wire (camelCase `awsJson1_0`). The captured body is the truth.
- Strings give you *what* exists; only a capture (or the source) tells you the
  exact wire shape.

## 3. Beautifying minified JS

- Hashed/minified JS bundles (Rolldown/esbuild) are readable after formatting —
  string literals survive, they are not byte-encrypted.
- `scripts/provider-probing/lib/beautify.ts` is a small beautifier built for
  byte-corrupted / truncated input (it never throws; it degrades gracefully).
  Use it to reformat extracted builder regions before reading them.
- Search for behavior markers rather than reading linearly: e.g. `baseURL`,
  `/inference`, header builders, `User-Agent` construction, auth builders.
- See [`minified-and-encrypted-parsing.md`](minified-and-encrypted-parsing.md)
  for the full recipe: surviving strings, carving JSON from concatenated blobs
  (balanced-brace scanner), and handling encrypted/packed streams.

## 4. Capturing a client's HTTPS traffic (Windows, Rust/Electron/CLI)

Working recipe for capturing the *real* outbound HTTPS requests when static
inspection can't pin the wire: header names, exact paths, request bodies.

### When to use

- String-scan gives operation names / hosts but not the exact request body,
  path, or header set.
- Direct HTTP guesses at an endpoint keep 403/401-ing.
- You need byte-level proof of what the client sends, not a reconstruction.

### Recipe

1. **Tools.** `mitmproxy`/`mitmdump` (Python pip; on this box
   `C:\Users\Aria\AppData\Local\Programs\Python\Python312\Scripts\`),
   `certutil` (OS). Optional `openssl`.
2. **Generate the CA.**
   ```ps
   mitmdump --set confdir="D:\tmp\scratch\mitmproxy" --version
   ```
   creates `mitmproxy-ca-cert.cer`, `mitmproxy-ca.pem`, etc.
3. **Trust the CA in the Windows root store.**
   ```ps
   certutil -user -addstore Root "D:\tmp\scratch\mitmproxy\mitmproxy-ca-cert.cer"
   ```
   - Use `certutil -user`, **not** `Import-Certificate` (that pops a UI
     prompt and fails non-interactively).
   - Even Rust clients honor this: `rustls-native-certs` (0.8.x) reads the
     Windows root store, so the CA works without touching Mozilla roots.
4. **Start the proxy, saving flows.**
   ```ps
   mitmdump -p 18443 --set confdir="D:\tmp\scratch\mitmproxy" `
     --flow-detail 2 -w "D:\tmp\scratch\kiro-mitm-flows"
   ```
   Run it in the background; logs stream to the shell output file.
5. **Point the client at the proxy.**
   ```ps
   $env:HTTPS_PROXY="http://127.0.0.1:18443"
   $env:HTTP_PROXY ="http://127.0.0.1:18443"
   $env:NO_PROXY=""
   ```
   Hyper/reqwest/Rust AWS SDK clients honor these. Expect a few benign
   CONNECTs first (update check, telemetry, OAuth); the interesting flows are
   usually the last ones.
6. **Run the client under a strict timeout.** If it hangs, the dumper shows
   retries (same CONNECT repeating). That is a signal the proxy answered but
   failed the TLS handshake — check the CA install, not the client.
7. **Extract bodies to UTF-8 files** (the dumper's console output chokes on
   non-cp1252 characters like `\u2192` and truncates big bodies):
   ```python
   # extract_flows.py  <flows>  <outdir>
   from mitmproxy.io import FlowReader
   from mitmproxy import http
   import os, sys
   outdir = sys.argv[2]; os.makedirs(outdir, exist_ok=True)
   with open(sys.argv[1], "rb") as f:
       for i, flow in enumerate(FlowReader(f).stream()):
           if not isinstance(flow, http.HTTPFlow): continue
           req = flow.request
           target = req.headers.get("x-amz-target", "").replace("/", "_")
           name = f"{i+1:03d}-{target or 'misc'}.txt"
           with open(os.path.join(outdir, name), "w", encoding="utf-8") as w:
               w.write(f"URL: {req.method} {req.pretty_url}\n")
               w.write(f"TARGET: {target}\n")
               w.write(f"UA: {req.headers.get('user-agent','')}\n")
               w.write(f"BODY({len(req.content or b'')}B):\n")
               w.write((req.content or b"").decode("utf-8", "replace") + "\n")
   ```
   `req.raw_content` may be `None` for requests with no body — guard it.

### Pitfalls (all hit live)

- **`AWS_ENDPOINT_URL` does NOT reliably redirect Rust AWS SDK clients.** The
  Kiro CLI ignored it (still hit prod) despite the SDK supporting the env var —
  the codegen client's endpoint override or `ignore_configured_endpoint_urls`
  wins. Don't build the capture plan around it.
- **A naive echo/dump server hangs the client.** Replying to CONNECT with a
  plain `{}` leaves the TLS handshake unresolved; the client retries until
  timeout. The proxy MUST terminate TLS (that is what mitmproxy does with its
  CA).
- **`Import-Certificate` is not scriptable** (UI prompt). Use
  `certutil -user -addstore Root`.
- **Save flows with `-w`.** `--flow-detail` console output alone loses data on
  encoding errors; replay with `mitmdump -nr <flows> --flow-detail 4` or the
  Python extractor above.
- **Version segment in the UA matters upstream.** When replaying a captured
  flow, note its `user-agent` needs the version segment (e.g.
  `opencode/latest/2.2.0/cli`) before replaying.

## 5. Where per-provider findings live

The evidence ledgers produced with these techniques are consolidated in
`documentation/research/<provider>/`:

| Provider | Research files |
|---|---|
| Kiro | `documentation/research/kiro/` — `2026-11-02-kiro-ide-cli-protocol.md` (unpack evidence), `kiro-wire-protocol.md`, `2026-11-02-kiro-wire-verification.md` |
| OpenCode | `documentation/research/opencode/` — `2026-11-02-desktop-2.2.5-binary-evidence.md` (unpack + capture + replay), `2026-11-02-opencode-free-tier.md` |
| Cursor | `documentation/research/cursor/2026-10-20-cursor-run-protocol.md` |
| CodeBuddy | `documentation/research/buddy/2026-10-19-codebuddy-chat-dispatch-headers.md` — plus `2026-11-02-codebuddy-cli-2.179.2-unpack-wire-audit.md` and `2026-11-02-workbuddy-desktop-unpack-wire-audit.md` |
| Qoder | `documentation/research/qoder/` — `2026-10-29-qoder-credits-claims-identity.md`, `2026-11-01-qoder-chat-wire-verification.md` (+ newer dated files in the same dir). Qoder IDE desktop 1.38.0 unpack: `D:\tmp\unpacked\qoder\qoder-ide-inno\` — `code$GetDestDir` (Electron), `out/lingma` (agent), 1.13.0 innoextract |
| Grok | `documentation/research/grok/2026-11-02-grok-build-1.0.70-unpack.md` |
| Copilot | `documentation/research/copilot/` — `2026-10-15-copilot-chat-capability-map.md`, `-context-probe`, `-auto-routing`, `-auto-responses-500-repair-throw` |
| Antigravity | unpack complete (Inno Setup 6.4 manual two-payload recovery, §1; `product.json` 44,752B carved; extension `google-antigravity` v0.0.1 located; OAuth endpoints `accounts.google.com`/`oauth2.googleapis.com` found). Wire-protocol research → `documentation/research/antigravity/` when written |

## Cleanup

Stop the proxy process when done (`Stop-Process` on the mitmdump PID). Keep
the flow file + extracted bodies in scratch (`D:\tmp\scratch\`) as evidence;
do not commit credentials — redact `authorization` headers before adding any
sample to the repo.
