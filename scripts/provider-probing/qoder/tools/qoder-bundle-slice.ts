/**
 * Dev helper: prints slices of the unpacked Qoder client bundle around a
 * keyword occurrence. The bundle is a 35 MB single-line minified file, so
 * line-based tools are useless — offset slicing is the only practical way to
 * inspect it.
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/tools/qoder-bundle-slice.ts <keyword> [before] [after] [maxHits]
 *
 * Examples:
 *   bun run scripts/provider-probing/qoder/tools/qoder-bundle-slice.ts "function QFn" 200 1200 3
 *   bun run scripts/provider-probing/qoder/tools/qoder-bundle-slice.ts "cosy-clienttype" 400 600 5
 */
import { readFileSync } from "node:fs";

const BUNDLE = "D:/tmp/unpacked/qoder/Qoder-unpacked/npm-package/package/bundle/qoder-worker-runtime.mjs";

const kw = process.argv[2];
if (kw === undefined) {
  console.error("usage: bun run scripts/provider-probing/qoder/tools/qoder-bundle-slice.ts <keyword> [before] [after] [maxHits]");
  process.exit(1);
}
const before = Number(process.argv[3] ?? 400);
const after = Number(process.argv[4] ?? 800);
const maxHits = Number(process.argv[5] ?? 10);

const src = readFileSync(BUNDLE, "utf8");
let i = 0;
let n = 0;
while ((i = src.indexOf(kw, i)) !== -1 && n < maxHits) {
  const s = Math.max(0, i - before);
  const e = Math.min(src.length, i + kw.length + after);
  console.log(`=== #${n + 1} @${i} ===`);
  console.log(src.slice(s, e));
  console.log("---");
  i += kw.length;
  n += 1;
}
if (n === 0) console.log(`(no hits for keyword ${JSON.stringify(kw)})`);
