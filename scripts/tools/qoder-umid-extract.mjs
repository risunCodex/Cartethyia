// Extract the Qoder machine-identity bridge (runtime-info) from the official
// CLI's npm package — the same recipe the donor hub proved (`_install_umid.py`):
//
//   1. read npm registry metadata for `@qoder-ai/qodercli` (zero deps),
//   2. download the tarball (sha512-integrity checked),
//   3. locate `package/bundle/qoder-worker-runtime.mjs`,
//   4. scan every long base64 literal (>= 4000 chars),
//   5. identify each blob by magic bytes (ELF e_machine / Mach-O cputype /
//      PE MZ+DLL / WASM) — never by position,
//   6. write the matching component(s) for --platform/--arch into the data
//      dir: <dataDir>/qoder-umid/<platform>-<arch>/runtime-info[.exe] (+ the
//      Windows sgsdk.dll sibling, selected by its IMAGE_FILE_DLL flag).
//
// The bridge output is machine-scoped (identical for any/absent account on
// one host), so one component per host per platform is the whole deployment.
//
// Usage: bun scripts/tools/qoder-umid-extract.mjs [--platform linux|darwin|win32] [--arch x64|arm64] [--dest <dir>] [--dry-run]
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveDataDir } from "../../src/persistence/db-mode.js";

const REGISTRY_URL = "https://registry.npmjs.org/@qoder-ai/qodercli";
const USER_AGENT = "Cartethyia-umid-installer";
const BUNDLE_MEMBER = "package/bundle/qoder-worker-runtime.mjs";
const BLOB_MIN_LEN = 4000;
const SIZE_MIN = 400 * 1024;
const SIZE_MAX = 2 * 1024 * 1024;

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const ELF_EM_X86_64 = 0x3e;
const ELF_EM_AARCH64 = 0xb7;
const MACHO_MAGIC_LE = [0xfe, 0xed, 0xfa, 0xcf]; // 64-bit little-endian
const MACHO_CPU_X86_64 = 0x01000007;
const MACHO_CPU_ARM64 = 0x0100000c;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function starts(b, o, magic) { return magic.every((m, i) => b[o + i] === m); }

function identify(buf) {
  if (starts(buf, 0, ELF_MAGIC)) {
    const machine = u16le(buf, 18);
    if (machine === ELF_EM_X86_64) return { platform: "linux", arch: "x64", name: "runtime-info" };
    if (machine === ELF_EM_AARCH64) return { platform: "linux", arch: "arm64", name: "runtime-info" };
    return null;
  }
  if (starts(buf, 0, MACHO_MAGIC_LE)) {
    const cpu = u32le(buf, 4);
    if (cpu === MACHO_CPU_ARM64) return { platform: "darwin", arch: "arm64", name: "runtime-info" };
    if (cpu === MACHO_CPU_X86_64) return { platform: "darwin", arch: "x64", name: "runtime-info" };
    return null;
  }
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    // PE: e_lfanew → COFF header at +4; characteristics bit 0x2000 = DLL.
    const peOff = u32le(buf, 0x3c);
    if (peOff + 24 > buf.length || buf[peOff] !== 0x50 || buf[peOff + 1] !== 0x45) return null;
    const machine = u16le(buf, peOff + 4);
    const characteristics = u16le(buf, peOff + 22);
    const isDll = (characteristics & 0x2000) !== 0;
    if (machine !== 0x8664) return null;
    if (isDll) return { platform: "win32", arch: "x64", name: "sgsdk.dll", dll: true };
    return { platform: "win32", arch: "x64", name: "runtime-info.exe" };
  }
  if (starts(buf, 0, WASM_MAGIC)) return { platform: "wasm", arch: "wasm", name: "component.wasm" };
  return null;
}

function parseArgs(argv) {
  const args = { platform: process.platform, arch: process.arch === "arm64" ? "arm64" : "x64", dest: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--platform") args.platform = argv[++i];
    else if (argv[i] === "--arch") args.arch = argv[++i];
    else if (argv[i] === "--dest") args.dest = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const meta = await (await fetch(REGISTRY_URL, { headers: { "user-agent": USER_AGENT } })).json();
const latest = meta["dist-tags"]?.latest;
const version = meta.versions?.[latest];
if (!version) throw new Error("npm metadata: no latest version");
const tarballUrl = version.dist.tarball;
const integrity = version.dist.integrity;
console.log(`@qoder-ai/qodercli ${latest} → ${tarballUrl}`);

const tarball = Buffer.from(await (await fetch(tarballUrl, { headers: { "user-agent": USER_AGENT } })).arrayBuffer());
if (integrity) {
  const [algo, expectedB64] = integrity.split("-", 2);
  const digest = createHash(algo === "sha512" ? "sha512" : "sha1").update(tarball).digest("base64");
  if (digest !== expectedB64) throw new Error("tarball integrity mismatch");
  console.log(`integrity ${algo} verified`);
}

// Extract the member with the system tar (bsdtar ships with Windows 10+, GNU
// tar with every Linux/macOS); a JS tar parser is not worth the surface.
const work = mkdtempSync(join(tmpdir(), "qoder-umid-"));
writeFileSync(join(work, "cli.tgz"), tarball);
// GNU tar treats `C:\…` as a remote host: `--force-local` on Windows.
const tarArgs = process.platform === "win32"
  ? ["--force-local", "-xzf", join(work, "cli.tgz"), "-C", work, BUNDLE_MEMBER]
  : ["-xzf", join(work, "cli.tgz"), "-C", work, BUNDLE_MEMBER];
const ex = spawnSync("tar", tarArgs, { stdio: "pipe" });
if (ex.status !== 0) throw new Error(`tar extract failed: ${ex.stderr?.toString().slice(0, 400)}`);
const bundlePath = join(work, BUNDLE_MEMBER);
const bundle = readFileSync(bundlePath, "utf8");

console.log(`bundle: ${(bundle.length / 1e6).toFixed(1)} MB; scanning base64 literals >= ${BLOB_MIN_LEN} chars…`);
const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const found = new Map(); // key -> {buf, id}
const re = /[A-Za-z0-9+/=]{4000,}/g;
for (const m of bundle.matchAll(re)) {
  const raw = m[0].replace(/=+$/, "");
  if (raw.length % 4 === 1) continue; // invalid base64 length
  let buf;
  try {
    buf = Buffer.from(raw, "base64");
  } catch { continue; }
  if (buf.length < SIZE_MIN || buf.length > 10 * SIZE_MAX) continue;
  const id = identify(buf);
  if (!id) continue;
  const key = `${id.platform}/${id.arch}/${id.name}`;
  // size heuristic (hub-proven): real runtime-info components are 0.4–2 MB;
  // the 7.3 MB PE is the SG SDK DLL, kept separately by its DLL flag.
  if (!id.dll && (buf.length < SIZE_MIN || buf.length > SIZE_MAX)) continue;
  const existing = found.get(key);
  if (!existing || (!existing.buf.equals(buf) && buf.length > 0 && !existing.buf.length)) found.set(key, { buf, id });
  else if (!existing.buf.equals(buf) && buf.length > existing.buf.length) found.set(key, { buf, id });
}

const wanted = [];
for (const [key, { buf, id }] of found) {
  if (id.platform !== args.platform || id.arch !== args.arch) continue;
  wanted.push({ key, buf, id });
}
if (wanted.length === 0) {
  console.log("no matching component for", `${args.platform}/${args.arch}`);
  console.log("available:", [...found.keys()].join(", "));
  process.exit(1);
}
if (args.dryRun) {
  for (const w of wanted) console.log(`[dry-run] ${w.id.name}: ${w.buf.length} B`);
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}
const destDir = resolve(args.dest ?? join(resolveDataDir(), "qoder-umid", `${args.platform}-${args.arch}`));
mkdirSync(destDir, { recursive: true });
for (const w of wanted) {
  const out = join(destDir, w.id.name);
  writeFileSync(out, w.buf, { mode: 0o755 });
  console.log(`wrote ${out} (${w.buf.length} B)`);
}
rmSync(work, { recursive: true, force: true });
console.log(`done → ${destDir}`);
