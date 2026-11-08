/**
 * Perch wire protocol: model-call body builder, SSE parsing, summary.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import {
  PERCH_SAFFRON_SYSTEM_PROMPT,
  buildPerchModelCallBody,
  parsePerchSse,
  summarizePerchStream,
} from "../../src/providers/integrations/perch/perch-protocol";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "standard",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

describe("PERCH_SAFFRON_SYSTEM_PROMPT", () => {
  test("carries the Saffron signature", () => {
    expect(PERCH_SAFFRON_SYSTEM_PROMPT).toContain("Saffron");
    expect(PERCH_SAFFRON_SYSTEM_PROMPT.length).toBeGreaterThan(400);
  });

  test("is a bundled literal, matching the research copy", () => {
    // The standalone binary has no .txt asset on disk; a readFileSync()-backed
    // constant silently becomes the short fallback and the upstream answers
    // `403 perch_surface_required`. This guards the shipped value itself.
    const researchCopy = readFileSync(
      path.join(import.meta.dir, "../../src/providers/integrations/perch/saffron-system-prompt.txt"),
      "utf8",
    );
    expect(PERCH_SAFFRON_SYSTEM_PROMPT).toBe(researchCopy);
  });
});

describe("buildPerchModelCallBody", () => {
  test("builds the CLI turn envelope", () => {
    const body = buildPerchModelCallBody(request(), "standard 1m", {
      userId: "u1",
      workspaceId: "w1",
      orgId: "o1",
      planCode: "pilot",
      runId: "run-1",
    });
    expect(body["roostModelChoice"]).toBe("standard 1m");
    expect(body["clientSurface"]).toBe("cli");
    expect(body["runId"]).toBe("run-1");
    expect(body["resendAfterOutput"]).toBe(true);
    expect(body["strictManual"]).toBe(false);
    const req = body["request"] as { messages: { role: string; content: string }[]; temperature: number; maxTokens: number };
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages[0]?.content).toBe(PERCH_SAFFRON_SYSTEM_PROMPT);
    expect(req.messages[1]?.role).toBe("user");
    expect(req.messages[1]?.content).toBe("hello");
    expect(req.temperature).toBe(0.6);
    expect(req.maxTokens).toBe(32000);
    const attribution = body["attribution"] as Record<string, unknown>;
    expect(attribution["userId"]).toBe("u1");
    expect(attribution["workspaceId"]).toBe("w1");
    expect(attribution["source"]).toBe("cli");
  });

  test("keeps Saffron as the opener when the caller supplies a system turn", () => {
    const body = buildPerchModelCallBody(
      request({ system: [{ kind: "text", text: "You are a helpful assistant." }] }),
      "standard",
      { userId: null, workspaceId: null, orgId: null, planCode: null, runId: "r" },
    );
    const req = body["request"] as { messages: { role: string; content: string }[] };
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages[0]?.content).toBe(
      `${PERCH_SAFFRON_SYSTEM_PROMPT}\n\nYou are a helpful assistant.`,
    );
  });

  test("uses the unmodified Saffron prefix when the probe injects it", () => {
    const body = buildPerchModelCallBody(
      request({ system: [{ kind: "text", text: PERCH_SAFFRON_SYSTEM_PROMPT }] }),
      "standard",
      { userId: null, workspaceId: null, orgId: null, planCode: null, runId: "r" },
    );
    const req = body["request"] as { messages: { role: string; content: string }[] };
    expect(req.messages[0]?.content).toBe(PERCH_SAFFRON_SYSTEM_PROMPT);
  });

  test("skips empty non-text parts", () => {
    const body = buildPerchModelCallBody(
      request({
        messages: [
          { role: "user", content: [{ kind: "text", text: "" }, { kind: "text", text: "only me" }] },
        ],
      }),
      "standard",
      { userId: null, workspaceId: null, orgId: null, planCode: null, runId: "r" },
    );
    const req = body["request"] as { messages: { role: string; content: string }[] };
    expect(req.messages).toHaveLength(2);
    expect(req.messages[1]?.content).toBe("only me");
  });

  test("honors generation controls", () => {
    const body = buildPerchModelCallBody(
      request({ generation_controls: { temperature: 0.2, max_tokens: 1024 } }),
      "standard",
      { userId: null, workspaceId: null, orgId: null, planCode: null, runId: "r" },
    );
    const req = body["request"] as { temperature: number; maxTokens: number };
    expect(req.temperature).toBe(0.2);
    expect(req.maxTokens).toBe(1024);
  });
});

describe("parsePerchSse", () => {
  test("parses answer_delta and done frames", () => {
    const sse = [
      'data: {"type":"keepalive"}',
      'data: {"type":"answer_delta","text":"pong"}',
      'data: {"type":"done","ok":true,"text":"pong","model":"m1","usage":{}}',
      "",
    ].join("\n");
    const events = parsePerchSse(sse);
    expect(events.map((e) => e.type)).toEqual(["keepalive", "answer_delta", "done"]);
  });

  test("ignores non-JSON lines", () => {
    const events = parsePerchSse(": comment\ndata: not-json\ndata: {\"type\":\"done\",\"ok\":true}\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("done");
  });
});

describe("summarizePerchStream", () => {
  test("assembles the answer and metadata", () => {
    const sse = [
      'data: {"type":"answer_delta","text":"po"}',
      'data: {"type":"answer_delta","text":"ng"}',
      'data: {"type":"done","ok":true,"text":"pong","model":"deepseek-v4.1-flash-1017","provider":"perch","usage":{"inputTokens":61,"outputTokens":4,"totalTokens":6593}}',
      "",
    ].join("\n");
    const result = summarizePerchStream(parsePerchSse(sse));
    expect(result.ok).toBe(true);
    expect(result.text).toBe("pong");
    expect(result.model).toBe("deepseek-v4.1-flash-1017");
    expect(result.usage?.["totalTokens"]).toBe(6593);
  });

  test("surfaces upstream errors", () => {
    const sse = [
      'data: {"type":"model_call_failed","error":"Model busy","errorCode":"capacity_reached"}',
      "",
    ].join("\n");
    const result = summarizePerchStream(parsePerchSse(sse));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Model busy");
    expect(result.errorCode).toBe("capacity_reached");
  });
});
