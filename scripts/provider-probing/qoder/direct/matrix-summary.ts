/**
 * Summarize a model-matrix JSONL result file into a compact table.
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/matrix-summary.ts \
 *     <results.jsonl> [--top N]
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const top = Number(process.argv[3] ?? "25");
if (!file) throw new Error("usage: matrix-summary.ts <results.jsonl> [top]");

interface Row {
  model: string;
  surface: string;
  case: string;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
  text: string;
  reasoning: string;
  finishReason: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  usage?: string;
  chunks: number;
}

const rows: Row[] = [];
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    rows.push(JSON.parse(line));
  } catch {
    // skip malformed
  }
}

console.log(`total=${rows.length}`);
console.log(`ok=${rows.filter(r => r.ok).length} fail=${rows.filter(r => !r.ok).length}`);
console.log("");

// Per model summary
const byModel = new Map<string, Row[]>();
for (const r of rows) {
  const arr = byModel.get(r.model) ?? [];
  arr.push(r);
  byModel.set(r.model, arr);
}

console.log("=== PER MODEL ===");
console.log("model       ok  fail  toolsAvg  toolsOK  finishTool  timeouts");
for (const [model, arr] of byModel) {
  const ok = arr.filter(r => r.ok).length;
  const fail = arr.length - ok;
  const toolsCalls = arr.filter(r => r.toolCalls.length > 0).length;
  const toolsOK = arr.filter(r => r.ok && r.toolCalls.length > 0).length;
  const finishTool = arr.filter(r => r.finishReason === "tool_calls").length;
  const timeouts = arr.filter(r => /timeout/i.test(r.error ?? "")).length;
  console.log(`${model.padEnd(11)} ${String(ok).padEnd(4)} ${String(fail).padEnd(5)} ${String(toolsCalls).padEnd(8)} ${String(toolsOK).padEnd(8)} ${String(finishTool).padEnd(10)} ${timeouts}`);
}

console.log("");
console.log("=== PER SURFACE ===");
for (const surface of ["ide", "grpc"]) {
  const arr = rows.filter(r => r.surface === surface);
  const ok = arr.filter(r => r.ok).length;
  const toolsCalls = arr.filter(r => r.toolCalls.length > 0).length;
  console.log(`${surface.padEnd(5)} total=${arr.length} ok=${ok} fail=${arr.length - ok} toolsCalled=${toolsCalls}`);
}

console.log("");
console.log("=== PER CASE ===");
const cases = [...new Set(rows.map(r => r.case))];
for (const c of cases) {
  const arr = rows.filter(r => r.case === c);
  const ok = arr.filter(r => r.ok).length;
  const toolsCalls = arr.filter(r => r.toolCalls.length > 0).length;
  console.log(`${c.padEnd(14)} total=${arr.length} ok=${ok} fail=${arr.length - ok} toolsCalled=${toolsCalls}`);
}

console.log("");
console.log("=== ERRORS (top) ===");
const errors = new Map<string, number>();
for (const r of rows) {
  if (!r.ok) {
    const key = `${r.surface}::${r.error ?? "unknown"}`;
    errors.set(key, (errors.get(key) ?? 0) + 1);
  }
}
for (const [k, v] of [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`  ${String(v).padEnd(4)} ${k}`);
}

console.log("");
console.log("=== FAIL ROWS (top) ===");
const fails = rows.filter(r => !r.ok).sort((a, b) => a.ms - b.ms);
for (const f of fails.slice(0, top)) {
  console.log(`  ${f.model}/${f.surface}/${f.case} status=${f.status ?? ""} err=${f.error ?? ""} ms=${f.ms}`);
}
