# Qoder Desktop 0.5.12 (Windows x64) — unpack evidence

Date: 2026-11-16. Artifact: `D:\tmp\binaries\Qoder-win-x64-user.exe` (268,556,040 B,
timestamps 2026-11-14). Static inspection only — never launched.

## Packaging changed: NSIS / electron-builder, not Inno Setup

The 1.38.0 IDE shipped as Inno Setup 6.4 (`innoextract 1.13.0`). This desktop
build is **Nullsoft (NSIS)**: `b'Nullsoft'` at offset 77,788, PE sections
`.text/.rdata/.data/.ndata/.rsrc` with a tiny 26 KB `.text` — the classic
electron-builder NSIS stub. `innoextract` refuses it ("Not a supported Inno
Setup installer"). Recipe that worked (two layers):

```
7z e Qoder-win-x64-user.exe -o<stage> '$PLUGINSDIR/app-64.7z'   # layer 1: NSIS payload
7z x <stage>/app-64.7z -o<app>                                  # layer 2: Electron tree
```

Layer 1 also carries `$PLUGINSDIR/QoderInstallerHelper.exe`,
`QoderReplacementUninstaller.exe`, `qoder-owned-files.json` (62 KB, file manifest).

## Result

`D:\tmp\unpacked\qoder\app\` — Electron tree (`Qoder.exe`, chromium DLLs) plus:

- `resources/app.asar` (unpacked with `scripts/tools/asar-unpack.mjs`; relative
  offsets, 6,097 files) → `D:\tmp\unpacked\qoder\asar\`
- `resources/app.asar.unpacked/node_modules` (native modules stay outside the asar)
- `resources/app-update.yml` — updater feed

## Identity

- `package.json` (inside asar): `name: "qoder"`, `version: "0.5.12"`, `main:
  ./out/main/index.js`.
- Structure: `out/main` (17 MB), `out/preload` (2.7 MB), `out/renderer` (90 MB).
  Largest bundles: `out/main/electronMain.js` (16.1 MB),
  `out/renderer/assets/CAGvh22m.js` (16.7 MB), plus worker chunks.

## Wire-relevant observations (static only)

- **No hardcoded Qoder hosts** in `out/main` or the top renderer bundle — the
  only `https://*.qoder.*` literals are placeholders (`example.vpc.qoder.com.cn`,
  `*.qoder.invalid`). Hosts are resolved at runtime, consistent with the 1.38
  IDE finding (region endpoint resolution, `preferredInferenceNode`).
- **The Cosy header family survives as literals** in `electronMain.js`:
  `Cosy-Version`, `Cosy-ClientType`, `Cosy-User`, `Cosy-Key`, `Cosy-Date`,
  `Cosy-Paid-Confirmed`, `Cosy-MachineToken`, and `cosyVersion:` field
  assignments — same identity surface the 0.5.7 evidence documented.
- **`electronMain.js` is string-table obfuscated** (obfuscator.io style):
  calls like `this[n(52517,48887)]` index an encoded string array; the array
  holds base64-encoded UTF-8 CJK strings (e.g. `5PIV5zcM5BYa…` decodes to
  Chinese text). Header names survive because the *decoded* strings are
  referenced; surrounding logic needs the string-table decoder before it reads.
  The 2026-11-11 worker capture remains the cheaper path to byte-level chat
  wire truth.
- Collaboration/REST surface in the clear (renderer side): ~24
  `/api/v1|v2/collaboration/*` paths (projects, discussions, agent-profiles,
  presence-connections, …) — separate from the model/chat endpoints.
- `"qoder-cn"` literal present — a realm/product flag alongside the
  international build, consistent with the qodercn provider split.

## Decode follow-up (same day): the string table is broken open

`electronMain.js` uses the obfuscator.io string-table scheme: `SW()` returns a
65,394-entry array; `W(i,e)` decodes entry `i-146` (custom base64 →
`decodeURIComponent`); `t(a,e) = W(a+523,e)`; every function scope declares a
local wrapper (`function n(f,r){return t(r-498,f)}`) that folds its offsets
into the index. The second argument is unused except as a cache-key salt.

Deobfuscator (scratch, `D:\tmp\scratch\qoder-deobf\deobf2.mjs`, Bun + acorn):
extract SW/W/t verbatim into a sandbox, parse once, register every per-scope
wrapper in walk 1, resolve each `t(...)` call chain to its numeric index in
walk 2 (nested wrappers resolve dynamically), splice the decoded string
literal in place. **337,487 strings inlined** (residual 115); output
`out/main/electronMain.dec.js`. Ground-truth vocabulary dump:
`D:\tmp\unpacked\qoder\strings-main.txt` (all 65,394 entries decoded).
Known limitation: a small subset of property-key accesses decoded to a wrong
array entry (scope-name collisions in the minifier); markers quoted below
were verified against the raw array dump, which is unambiguous.

## Wire facts 0.5.12 (decoded main process) — differences vs 0.5.7

- **Region resolution:** both `/algo/api/v2/service/region/endpoints` and
  `/algo/api/v5/service/region/endpoints` are live literals (0.5.7 evidence
  had v3; the v2/v5 pair suggests staged rollout with per-region versioning).
  Also `/algo/api/v1/ping`, `/algo/api/v1/version`, and a relative `"/algo"`
  prefix joined onto resolved hosts.
- **Hardcoded gateways (new as literals):** `https://center.qoder.sh/algo/`
  (intl center), `https://gateway.qoder.com.cn/algo/` (CN),
  `https://test-gateway.qoder.com.cn/algo/` and
  `https://test-ops2.qoder.sh/algo/` (test rigs), plus `.qoder.cn` /
  `.qoder.com.cn` realm suffixes.
- **Cosy header family grew:** `Cosy-Version`, `Cosy-ClientType`,
  `Cosy-User`, `Cosy-Key`, `Cosy-Date`, `Cosy-Paid-Confirmed`,
  `Cosy-MachineToken`, `Cosy-MachineId`, **plus new in 0.5.12**:
  `X-Cosy-Encrypt`, `Cosy-MachineCode`, `Cosy-MachineHostname`,
  `Cosy-MachineOS`, `Cosy-MachineType`, `Cosy-Business-Product`.
- **A machine-identity subsystem** (`machineIdentityService`,
  `resolveMachineIdentity`, `getHostMachineIdentifier`,
  `sessionMachineId`, `hostMachineIdentifier`) now backs the machine headers;
  a Chinese in-bundle note confirms `machineId` is a stable device identity
  gated behind an explicit `system.machineId.read` SDK permission.
- One dispatch path pairs `x-gw-user-id` with `Cosy-MachineId` +
  `Cosy-MachineToken` on a gateway fetch (`/algo`-rooted host with the
  trailing `/algo/?$` suffix stripped).
- **Chat paths are still absent from the main-process strings** (no
  `agent_chat_generation`, no `/model/v1/chat/completions`): the chat wire
  remains on the region-resolved inference endpoint, consistent with IDE 1.38
  and the 0.5.7 wire capture. The renderer bundle carries no Qoder hosts
  either (only `*.qoder.invalid` placeholders).

## Unknown / next steps

- Chat endpoint paths (`/model/v1/...`, `/algo/api/v2/...`) do not appear as
  plain literals in the scanned bundles; they may sit inside the obfuscated
  string table or be fetched like the IDE does. Decode the string table or
  capture the wire (mitmproxy recipe in the skill) before claiming either.
- This note records the unpack and static survey only; no live probe was run.
