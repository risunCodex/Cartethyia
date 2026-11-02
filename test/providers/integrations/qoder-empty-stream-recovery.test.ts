/**
 * Qoder's IDE surface sometimes answers a full normal stop with reasoning only
 * and no output text/tool calls. `fetchQoderIdeWithEmptyRecovery` must replay
 * such a stream (bounded) instead of surfacing a thought-only "completion".
 */
import { describe, expect, test } from "bun:test";
import { fetchQoderIdeWithEmptyRecovery } from "../../../src/providers/integrations/qoder/qoder";

function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const DONE = "[DONE]";
const REASONING = JSON.stringify({
  choices: [{ index: 0, delta: { reasoning_content: "thinking…" }, finish_reason: null }],
});
const TEXT = JSON.stringify({
  choices: [{ index: 0, delta: { content: "2 + 2 = 4." }, finish_reason: null }],
});
const TERMINAL = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });

describe("Qoder IDE empty-stream recovery", () => {
  test("returns the first stream that carries real output", async () => {
    let calls = 0;
    const req = async () => {
      calls += 1;
      if (calls === 1) return sseResponse([REASONING, DONE]);
      return sseResponse([REASONING, TEXT, TERMINAL, DONE]);
    };
    const res = await fetchQoderIdeWithEmptyRecovery(req, new AbortController().signal);
    expect(calls).toBe(2);
    const text = await res.text();
    expect(text).toContain("2 + 2 = 4.");
  });

  test("does not replay a meaningful stream", async () => {
    let calls = 0;
    const req = async () => {
      calls += 1;
      return sseResponse([TEXT, TERMINAL, DONE]);
    };
    const res = await fetchQoderIdeWithEmptyRecovery(req, new AbortController().signal);
    expect(calls).toBe(1);
    const text = await res.text();
    expect(text).toContain("2 + 2 = 4.");
  });

  test("bounds replays and returns the last stream", async () => {
    let calls = 0;
    const req = async () => {
      calls += 1;
      return sseResponse([REASONING, DONE]);
    };
    const res = await fetchQoderIdeWithEmptyRecovery(req, new AbortController().signal, 2);
    expect(calls).toBe(3);
    const text = await res.text();
    expect(text).toContain("thinking…");
  });
});
