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

## Unknown / next steps

- Chat endpoint paths (`/model/v1/...`, `/algo/api/v2/...`) do not appear as
  plain literals in the scanned bundles; they may sit inside the obfuscated
  string table or be fetched like the IDE does. Decode the string table or
  capture the wire (mitmproxy recipe in the skill) before claiming either.
- This note records the unpack and static survey only; no live probe was run.
