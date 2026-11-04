/**
 * Qoder tool-call buffering audit probe (scratch, read-only on production).
 *
 * Simulates the EXACT buffering logic from:
 *  - src/providers/integrations/qoder/qoder-grpc.ts (qoderGrpcToCanonicalEvents
 *    inner tool-call buffering, extracted verbatim)
 *  - src/providers/integrations/qoder/qoder.ts (qoderBodyToCanonicalEvents,
 *    real function, via SSE frames)
 *
 * Goal: find conditions where fragments are lost / swapped / merged across
 * calls, producing invalid JSON arguments at the client.
 */

import { qoderBodyToCanonicalEvents } from "../../src/providers/integrations/qoder/qoder";

// ── Verbatim gRPC buffering logic (extracted from qoder-grpc.ts) ─────────────
function simulateGrpcBuffer(deltas: Array<{
  id?: string;
  index?: number;
  name?: string;
  arguments?: string;
}>): Array<{ callId: string; index: number; name?: string; arguments: string }> {
  const toolCallBuffer = new Map<
    string,
    { index: number; name: string | undefined; arguments: string }
  >();
  let lastSeenToolId: string | undefined;
  let lastSeenToolName: string | undefined;

  const drainToolCalls = () => {
    const out: Array<{ callId: string; index: number; name?: string; arguments: string }> = [];
    for (const [callId, buffered] of toolCallBuffer) {
      out.push({
        callId,
        index: buffered.index,
        ...(buffered.name === undefined ? {} : { name: buffered.name }),
        arguments: buffered.arguments,
      });
    }
    toolCallBuffer.clear();
    return out;
  };

  for (const tc of deltas) {
    const fn = (tc as Record<string, unknown>)["function"] as Record<string, unknown> | undefined;
    const index = typeof tc.index === "number" ? tc.index : undefined;
    const declaredId =
      typeof tc.id === "string" && tc.id.trim().length > 0 ? tc.id.trim() : undefined;
    const fragName =
      typeof fn?.name === "string" && fn.name.trim().length > 0 ? fn.name.trim() : undefined;
    const fragArgs = typeof fn?.arguments === "string" ? fn.arguments : undefined;

    const callId = (() => {
      if (declaredId !== undefined) {
        if (index !== undefined) {
          if (!toolCallBuffer.has(declaredId)) {
            toolCallBuffer.set(declaredId, { index, name: fragName, arguments: "" });
          }
        }
        lastSeenToolId = declaredId;
        if (fragName !== undefined) lastSeenToolName = fragName;
        return declaredId;
      }
      if (index !== undefined) {
        for (const [id, buffered] of toolCallBuffer) {
          if (buffered.index === index) return id;
        }
      }
      if (lastSeenToolId !== undefined && (fragName === undefined || lastSeenToolName === fragName)) {
        return lastSeenToolId;
      }
      return `call_${String(index ?? 0)}`;
    })();

    const existing = toolCallBuffer.get(callId);
    if (existing) {
      existing.index = index ?? existing.index;
      if (fragName !== undefined) existing.name = fragName;
      if (fragArgs !== undefined) existing.arguments += fragArgs;
    } else {
      toolCallBuffer.set(callId, {
        index: index ?? 0,
        name: fragName,
        arguments: fragArgs ?? "",
      });
    }
  }

  return drainToolCalls();
}

// ── SSE real-function harness ────────────────────────────────────────────────
function sseFrame(delta: Record<string, unknown>, finishReason?: string): string {
  const chunk = {
    choices: [{ delta, index: 0, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
  };
  return `data:${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(chunk) })}\n\n`;
}

async function collectSse(chunks: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  const out: Array<Record<string, unknown>> = [];
  for await (const e of qoderBodyToCanonicalEvents(stream, new AbortController().signal, "m")) {
    out.push(e as unknown as Record<string, unknown>);
  }
  return out;
}

const toolEvents = (ev: readonly Record<string, unknown>[]) =>
  ev.filter((e) => e["type"] === "tool_call_delta");

// ── Scenarios ────────────────────────────────────────────────────────────────
const results: string[] = [];
const note = (label: string, ok: boolean, detail: string) => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}: ${detail}`);
};

// Scenario G1: two parallel calls interleaved, continuations carry only index.
{
  const deltas = [
    { id: "call_0", index: 0, name: "read", function: { arguments: '{"path":' } },
    { id: "call_1", index: 1, name: "write", function: { arguments: '{"content":' } },
    { index: 1, function: { arguments: '"b"}' } },
    { index: 0, function: { arguments: '"a"}' } },
  ];
  const out = simulateGrpcBuffer(deltas);
  const byId = new Map<string, string>();
  for (const c of out) byId.set(c.callId, (byId.get(c.callId) ?? "") + c.arguments);
  const readOk = byId.get("call_0") === '{"path":"a"}';
  const writeOk = byId.get("call_1") === '{"content":"b"}';
  note("G1 interleaved parallel calls (index continuation)", readOk && writeOk,
    JSON.stringify(Object.fromEntries(byId)));
}

// Scenario G2: continuation with index that does NOT match any buffered call
// (e.g. index renumbering, or index omitted then present).
{
  const deltas = [
    { id: "call_0", index: 0, name: "read", function: { arguments: '{"path":' } },
    // continuation WITHOUT index → falls back to lastSeenToolId (ok)
    { function: { arguments: '"a"}' } },
    // continuation WITH index 5 (never seen) → fallback: no match, lastSeen
    // id matches (no name) → call_0. OK.
    { index: 5, function: { arguments: ',"x":1}' } },
  ];
  const out = simulateGrpcBuffer(deltas);
  const joined = (out.find((c) => c.callId === "call_0") ?? { arguments: "" }).arguments;
  let parsed = false;
  try { JSON.parse(joined); parsed = true; } catch { /* not valid */ }
  note("G2 unknown-index continuation falls back to lastSeen", parsed,
    `joined=${JSON.stringify(joined)}`);
}

// Scenario G3: THE KEY ONE — a continuation chunk whose `id` is non-empty but
// DIFFERENT from the established id, with the same index. In gRPC, declaredId
// wins: a NEW map entry is created (index matches existing → but declaredId is
// a new key, so `toolCallBuffer.has(declaredId)` is false → set new entry).
// Fragment then lands under the new id; original call keeps its partial args.
{
  const deltas = [
    { id: "call_0", index: 0, name: "read", function: { arguments: '{"path":' } },
    { id: "call_0", index: 0, function: { arguments: '"a"' } },
    // Upstream re-identifies with a fresh id (some bridges do this)
    { id: "call_0b", index: 0, function: { arguments: ',"x":1}' } },
  ];
  const out = simulateGrpcBuffer(deltas);
  const byId = new Map<string, string>();
  for (const c of out) byId.set(c.callId, byId.get(c.callId) ?? "" + c.arguments);
  const joined = [...byId.values()].join("");
  let parsed = false;
  try { JSON.parse(joined); parsed = true; } catch { /* not valid */ }
  note("G3 re-identified id splits one call into two fragments", parsed,
    `ids=${JSON.stringify([...byId.keys()])} joined=${JSON.stringify(joined)}`);
}

// Scenario G4: name changes with same id (should not merge vs name discriminator).
{
  const deltas = [
    { id: "call_0", index: 0, name: "read", function: { arguments: '{"path":' } },
    { id: "call_0", index: 0, name: "write", function: { arguments: '"a"}' } },
  ];
  const out = simulateGrpcBuffer(deltas);
  const c0 = out.find((c) => c.callId === "call_0");
  note("G4 same-id name flip", c0?.name === "write",
    `name=${JSON.stringify(c0?.name)} args=${JSON.stringify(c0?.arguments)}`);
}

// Scenario G5: SSE real function — interleaved parallel calls with empty-id
// continuations, exactly like the existing tests but with an extra twist: a
// continuation chunk that carries BOTH a fresh id and an index, mid-stream.
{
  const ev = await collectSse([
    sseFrame({ tool_calls: [{ function: { arguments: '{"a":', name: "echo" }, id: "call_00", index: 0, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '1}' }, id: "call_00", index: 0, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '{"b":', name: "echo" }, id: "call_00", index: 0, type: "function" }] }),
    sseFrame({}, "tool_calls"),
  ]);
  const deltas = toolEvents(ev);
  const byId = new Map<string, string>();
  for (const d of deltas) {
    const id = String(d["call_id"]);
    byId.set(id, (byId.get(id) ?? "") + String(d["arguments_delta"]));
  }
  const joined = [...byId.values()].join("");
  let parsed = false;
  try { JSON.parse(joined); parsed = true; } catch { /* not valid */ }
  note("S1 same-id refragments (re-identified)", parsed,
    `join=${JSON.stringify(joined)} ids=${JSON.stringify([...byId.keys()])} deltas=${deltas.length} raw=${JSON.stringify(deltas)}`);
}

// Scenario S2: SSE real function — interleaved parallel where the second call
// appears first in a multi-element delta, then continuation by index.
{
  const ev = await collectSse([
    sseFrame({
      tool_calls: [
        { function: { arguments: '{"p":', name: "read" }, id: "call_a", index: 0, type: "function" },
        { function: { arguments: '{"p":', name: "write" }, id: "call_b", index: 1, type: "function" },
      ],
    }),
    sseFrame({ tool_calls: [{ function: { arguments: '2"}' }, index: 1, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '1"}' }, index: 0, type: "function" }] }),
    sseFrame({}, "tool_calls"),
  ]);
  const deltas = toolEvents(ev);
  const byId = new Map<string, string>();
  for (const d of deltas) {
    const id = String(d["call_id"]);
    byId.set(id, (byId.get(id) ?? "") + String(d["arguments_delta"]));
  }
  const aOk = byId.get("call_a") === '{"p":1"}';
  const bOk = byId.get("call_b") === '{"p":2"}';
  note("S2 SSE interleaved parallel", aOk && bOk,
    JSON.stringify(Object.fromEntries(byId)));
}

// Scenario S3: SSE — continuation by index where index is present but the
// FIRST chunk had NO index (index undefined). Then indexId pinning never
// happened; continuation with index → `indexIds.has(index)` false → fallback
// lastSeenToolId (no name → matches). OK.
{
  const ev = await collectSse([
    sseFrame({ tool_calls: [{ function: { arguments: '{"a":', name: "echo" }, id: "call_0", type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '1}' }, index: 0, type: "function" }] }),
    sseFrame({}, "tool_calls"),
  ]);
  const deltas = toolEvents(ev);
  const joined = deltas.map((d) => String(d["arguments_delta"])).join("");
  let parsed = false;
  try { JSON.parse(joined); parsed = true; } catch { /* not valid */ }
  note("S3 index-after-absent-index", parsed, `joined=${JSON.stringify(joined)}`);
}

// Scenario S4: SSE — a continuation chunk that carries a DIFFERENT id with
// the SAME index (upstream re-identification). In qoder.ts, declaredId wins
// and pins `indexIds.set(index, newId)` — this REBINDS the index to the new
// id. Subsequent index-based continuations now go to the new id. If any
// previous fragment was on the old id, they are now split across two calls.
{
  const ev = await collectSse([
    sseFrame({ tool_calls: [{ function: { arguments: '{"a":', name: "echo" }, id: "call_0", index: 0, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '1,' }, id: "call_0", index: 0, type: "function" }] }),
    // upstream re-identifies the same wire call with a fresh id
    sseFrame({ tool_calls: [{ function: { arguments: '"b":2}' }, id: "call_0b", index: 0, type: "function" }] }),
    sseFrame({}, "tool_calls"),
  ]);
  const deltas = toolEvents(ev);
  const byId = new Map<string, string>();
  for (const d of deltas) {
    const id = String(d["call_id"]);
    byId.set(id, (byId.get(id) ?? "") + String(d["arguments_delta"]));
  }
  const pieces = [...byId.values()];
  const joined = pieces.join("");
  let parsed = false;
  try { JSON.parse(joined); parsed = true; } catch { /* not valid */ }
  note("S4 id re-identification splits call", parsed,
    `ids=${JSON.stringify([...byId.keys()])} joined=${JSON.stringify(joined)}`);
}

// Scenario S5: SSE — name flips mid-stream on same id (should keep name sticky?
// In qoder.ts, name is overwritten silently on every fragment: `existing.name =
// fragName` if present). If upstream sends wrong name mid-stream, final name
// may be wrong but args are intact.
{
  const ev = await collectSse([
    sseFrame({ tool_calls: [{ function: { arguments: '{"a":', name: "read" }, id: "call_0", index: 0, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '1}', name: "write" }, id: "call_0", index: 0, type: "function" }] }),
    sseFrame({}, "tool_calls"),
  ]);
  const deltas = toolEvents(ev);
  note("S5 name flip same id", deltas.length === 1 && deltas[0]?.["name"] === "write",
    `name=${JSON.stringify(deltas[0]?.["name"])} args=${JSON.stringify(deltas[0]?.["arguments_delta"])}`);
}

// Scenario S6: SSE / gRPC — two parallel calls with NO id and NO index at all
// (upstream omits both). Both fall back to `call_0`, merging their arguments.
{
  const ev = await collectSse([
    sseFrame({ tool_calls: [{ function: { arguments: '{"a":', name: "read" }, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '1}' }, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '{"b":', name: "write" }, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '2}' }, type: "function" }] }),
    sseFrame({}, "tool_calls"),
  ]);
  const deltas = toolEvents(ev);
  const joined = deltas.map((d) => String(d["arguments_delta"])).join("");
  let parsed = false;
  try { JSON.parse(joined); parsed = true; } catch { /* not valid */ }
  note("S6 no-id no-index parallel calls merge", parsed,
    `deltas=${deltas.length} joined=${JSON.stringify(joined)} ids=${JSON.stringify(deltas.map((d) => d["call_id"]))}`);
}

// Scenario S7: SSE / gRPC — two parallel calls to the SAME tool, second call
// established, continuation WITHOUT index (no name either). The fallback
// `lastSeenToolId` attaches to the last call, so the fragment lands on the
// wrong call (arguments swapped).
{
  const ev = await collectSse([
    sseFrame({ tool_calls: [{ function: { arguments: '{"a":', name: "read" }, id: "call_0", index: 0, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '{"b":', name: "read" }, id: "call_1", index: 1, type: "function" }] }),
    // index-less, id-less continuation — belongs to call_0 by upstream order
    sseFrame({ tool_calls: [{ function: { arguments: '1}' }, type: "function" }] }),
    sseFrame({ tool_calls: [{ function: { arguments: '2}' }, type: "function" }] }),
    sseFrame({}, "tool_calls"),
  ]);
  const deltas = toolEvents(ev);
  const byId = new Map<string, string>();
  for (const d of deltas) {
    const id = String(d["call_id"]);
    byId.set(id, (byId.get(id) ?? "") + String(d["arguments_delta"]));
  }
  note("S7 same-name index-less continuation attaches to last call",
    byId.get("call_0") === '{"a":1}' && byId.get("call_1") === '{"b":2}',
    JSON.stringify(Object.fromEntries(byId)));
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
if (failed.length > 0) {
  console.log(`\n${failed.length} scenario(s) show a weakness — inspect above.`);
} else {
  console.log("\nAll scenarios behaved as currently implemented (no surprises).");
}
