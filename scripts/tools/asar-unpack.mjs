// Minimal ASAR unpacker (read-only).
//
// Usage: bun scripts/tools/asar-unpack.mjs <archive.asar> <outdir> [filter-substring]
// Extracts every file whose path contains the optional filter substring.
//
// Observed on Electron app bundles (OpenCode desktop 2.2.5, nativev2 asar):
//   - Header layout: [u32 @0] = 4, [u32 @4] = header+8, [u32 @8] = header+4,
//     [u32 @12] = header JSON length, JSON starts at offset 16.
//   - `header.files` is the root *container* (name -> child), not a node with a
//     `files` property — walk its children directly or nothing is ever found.
//   - Per-file `offset` values can be either absolute or RELATIVE to the data
//     section start (16 + headerSize). OpenCode's app.asar uses relative
//     offsets; reading them as absolute yields garbage bytes. The mode is
//     detected once from the first leaf and applied to every file.
import { open } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const archive = process.argv[2];
const outDir = process.argv[3];
const filter = process.argv[4] ?? "";

const fh = await open(archive, "r");

// 16-byte pickle header, as above.
const headerBuf = Buffer.alloc(16);
await fh.read(headerBuf, 0, 16, 0);
const headerSize = headerBuf.readUInt32LE(12);
const jsonBuf = Buffer.alloc(headerSize);
await fh.read(jsonBuf, 0, headerSize, 16);
const header = JSON.parse(jsonBuf.toString("utf8"));
const dataStart = 16 + headerSize;

// Walk the file tree and emit {path, offset, size}.
function walk(node, basePath, results) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, basePath ? `${basePath}/${name}` : name, results);
    }
  } else if (node.offset !== undefined) {
    results.push({ path: basePath, offset: node.offset, size: node.size });
  }
}
const files = [];
for (const [name, child] of Object.entries(header.files)) {
  walk(child, name, files);
}
console.log(`header size=${headerSize}, dataStart=${dataStart}, files=${files.length}`);

// Detect whether `offset` values are absolute or relative to the data section.
// Read the first leaf at both interpretations and prefer the one that looks
// like real content (no NUL bytes in the head).
function looksLikeContent(buf) {
  if (buf.length === 0) return false;
  for (let i = 0; i < Math.min(buf.length, 64); i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}
let relative = false;
if (files.length > 0) {
  const first = files[0];
  const abs = Buffer.alloc(Math.min(first.size, 64));
  await fh.read(abs, 0, abs.length, Number(first.offset));
  const rel = Buffer.alloc(Math.min(first.size, 64));
  await fh.read(rel, 0, rel.length, dataStart + Number(first.offset));
  const absOk = looksLikeContent(abs);
  const relOk = looksLikeContent(rel);
  if (relOk && !absOk) relative = true;
  else if (relOk && absOk && first.path.includes("package.json")) relative = true;
  else if (relOk && absOk) relative = false;
  console.log(`offset mode: ${relative ? "relative" : "absolute"} (absOk=${absOk}, relOk=${relOk})`);
}

let matched = 0;
for (const f of files) {
  if (filter && !f.path.includes(filter)) continue;
  const dest = path.join(outDir, f.path);
  await mkdir(path.dirname(dest), { recursive: true });
  const buf = Buffer.alloc(f.size);
  const fileOffset = relative ? dataStart + Number(f.offset) : Number(f.offset);
  await fh.read(buf, 0, f.size, fileOffset);
  await writeFile(dest, buf);
  matched++;
}
console.log(`extracted ${matched} files to ${outDir}`);
await fh.close();
