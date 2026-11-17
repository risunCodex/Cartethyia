/**
 * Qoder wire/tool-call audit probe (scratch, read-only on production).
 *
 * Merged from the former `qoder-raw-wire-probe.ts` and
 * `qoder-toolcall-audit-probe.ts`:
 *
 *  - Part 1 verifies `qoderBodyToCanonicalEvents` against the EXACT raw wire
 *    captured from live qoder/ultimate parallel tool calls (2026-11-04).
 *  - Part 2 simulates the EXACT buffering logic from
 *    `qoder-grpc.ts` (`qoderGrpcToCanonicalEvents` inner tool-call buffering,
 *    extracted verbatim) and from `qoder.ts` (`qoderBodyToCanonicalEvents`,
 *    real function, via SSE frames), looking for conditions where fragments
 *    are lost / swapped / merged across calls, producing invalid JSON
 *    arguments at the client.
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/inspect/qoder-wire-audit.ts
 */

import { qoderBodyToCanonicalEvents } from "../../../../src/providers/integrations/qoder/qoder";

// ── Part 1: raw wire verification (former qoder-raw-wire-probe.ts) ──────────

const chunkA = {
  id: "chatcmpl-3a6d5bb6",
  object: "chat.completion.chunk",
  model: "ultimate",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "toolu_bdrk_01Cp6XWebrUcyDU8MDfJKNVP",
            type: "function",
            function: {
              name: "kalkulator",
              arguments: '{"expression": "17*23"}{"zona": "Asia/Jakarta"}',
            },
          },
        ],
      },
      finish_reason: null,
    },
  ],
};

const chunkB = {
  id: "chatcmpl-3a6d5bb6",
  object: "chat.completion.chunk",
  model: "ultimate",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "toolu_bdrk_01K2QvzpA3SEj7mewA3KtSQ6",
            type: "function",
            function: { name: "get_waktu", arguments: "" },
          },
        ],
      },
      finish_reason: null,
    },
  ],
};

const chunkC = {
  id: "chatcmpl-3a6d5bb6",
  object: "chat.completion.chunk",
  model: "ultimate",
  choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
};

async function runRawWireCheck(): Promise<void> {
  console.log("=== Part 1: raw wire verification ===");
  const lines = [chunkA, chunkB, chunkC]
    .map((c) => `data: ${JSON.stringify(c)}`)
    .join("\n\n") + "\n\n";

  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(lines));
      controller.close();
    },
  });

  const events: Array<Record<string, unknown>> = [];
  for await (const e of qoderBodyToCanonicalEvents(body, new AbortController().signal, "ultimate")) {
    events.push(e as unknown as Record<string, unknown>);
  }

  console.log("EVENTS:");
  for (const e of events) {
    console.log(JSON.stringify(e));
  }
  console.log("---");
  const calls = events.filter((e) => e["type"] === "tool_call_delta");
  console.log(`tool_call_delta count: ${calls.length}`);
  for (const c of calls) {
    const args = (c["arguments_delta"] as string) ?? "";
    let valid = true;
    try {
      JSON.parse(args);
    } catch {
      valid = false;
    }
    console.log(`  id=${String(c["call_id"]).slice(0, 16)} name=${String(c["name"])} argsValid=${valid} args=${args.slice(0, 120)}`);
  }
}

// ── Part 2: buffering audit (former qoder-toolcall-audit-probe.ts) ──────────

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

async function runBufferingAudit(): Promise<void> {
  console.log("\n=== Part 2: tool-call buffering audit ===");
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

  // Scenario G2: continuation with index that does NOT match any buffered call.
  {
    const deltas = [
      { id: "call_0", index: 0, name: "read", function: { arguments: '{"path":' } },
      { function: { arguments: '"a"}' } },
      { index: 5, function: { arguments: ',"x":1}' } },
    ];
    const out = simulateGrpcBuffer(deltas);
    const joined = (out.find((c) => c.callId === "call_0") ?? { arguments: "" }).arguments;
    let parsed = false;
    try { JSON.parse(joined); parsed = true; } catch { /* not valid */ }
    note("G2 unknown-index continuation falls back to lastSeen", parsed,
      `joined=${JSON.stringify(joined)}`);
  }

  // Scenario G3: a continuation chunk whose `id` is non-empty but DIFFERENT
  // from the established id, with the same index.
  {
    const deltas = [
      { id: "call_0", index: 0, name: "read", function: { arguments: '{"path":' } },
      { id: "call_0", index: 0, function: { arguments: '"a"' } },
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

  // Scenario G4: name changes with same id.
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

  // Scenario S1: SSE real function — same-id refragments (re-identified).
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

  // Scenario S2: SSE — interleaved parallel where the second call appears first
  // in a multi-element delta, then continuation by index.
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

  // Scenario S3: SSE — continuation by index where the FIRST chunk had NO index.
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
  // the SAME index (upstream re-identification).
  {
    const ev = await collectSse([
      sseFrame({ tool_calls: [{ function: { arguments: '{"a":', name: "echo" }, id: "call_0", index: 0, type: "function" }] }),
      sseFrame({ tool_calls: [{ function: { arguments: '1,' }, id: "call_0", index: 0, type: "function" }] }),
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

  // Scenario S5: SSE — name flips mid-stream on same id.
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

  // Scenario S6: SSE / gRPC — two parallel calls with NO id and NO index.
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
  // established, continuation WITHOUT index.
  {
    const ev = await collectSse([
      sseFrame({ tool_calls: [{ function: { arguments: '{"a":', name: "read" }, id: "call_0", index: 0, type: "function" }] }),
      sseFrame({ tool_calls: [{ function: { arguments: '{"b":', name: "read" }, id: "call_1", index: 1, type: "function" }] }),
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
}

await runRawWireCheck();
await runBufferingAudit();
