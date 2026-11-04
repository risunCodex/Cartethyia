import { expect, test } from "bun:test";
import { buildQoderRequest, buildQoderIdeRequest } from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest, ToolDefinition } from "../../../src/protocol/canonical-model";

/**
 * The upstream is only able to call a tool it was told about.
 *
 * Without a `tools` array the model has no declaration to work from, so it
 * improvises markup in its prose instead of emitting a structured call. That
 * call is neither runnable nor recoverable, because on neither side was it ever
 * a call — so this is the field that has to be right.
 */

const CONFIG = {
  id: "m",
  display_name: "M",
  max_input_tokens: 128_000,
  is_vl: false,
  is_reasoning: false,
};

const AUTH = {
  userId: "u",
  userName: "n",
  userType: "t",
  securityOauthToken: "s",
  refreshToken: "r",
  machineId: "m",
};

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: [{ kind: "text", text: "read it" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

const READ: ToolDefinition = {
  name: "Read",
  description: "Read a file",
  jsonSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
};

function bodyOf(req: CanonicalRequest): Record<string, unknown> {
  return buildQoderRequest("m", req, CONFIG, AUTH);
}

test("a declared tool reaches the upstream as a function declaration", () => {
  const body = bodyOf(request({ tools: [READ] }));
  const tools = body["tools"] as Array<Record<string, unknown>>;
  expect(tools).toHaveLength(1);
  expect(tools[0]?.["type"]).toBe("function");
  const fn = tools[0]?.["function"] as Record<string, unknown>;
  expect(fn["name"]).toBe("Read");
  expect(fn["description"]).toBe("Read a file");
  expect(fn["parameters"]).toEqual(READ.jsonSchema);
  expect(fn["strict"]).toBeUndefined();
});

test("a tool with no schema still declares an object schema", () => {
  // The upstream will not accept a declaration without one, and a tool the
  // model cannot call is worse than a permissive one it can.
  const body = bodyOf(request({ tools: [{ name: "Bare", jsonSchema: undefined }] }));
  const fn = (body["tools"] as Array<Record<string, unknown>>)[0]?.["function"] as Record<string, unknown>;
  expect(fn["parameters"]).toEqual({ type: "object", properties: {} });
});

test("a tool kind the upstream cannot express is dropped, not forwarded", () => {
  // Forwarding it makes Qoder reject the whole turn during deserialization,
  // which loses every tool in the request rather than just this one.
  const body = bodyOf(
    request({
      tools: [READ, { name: "search", jsonSchema: {}, tool_type: "web_search" }],
    }),
  );
  const tools = body["tools"] as Array<Record<string, unknown>>;
  expect(tools).toHaveLength(1);
  expect((tools[0]?.["function"] as Record<string, unknown>)["name"]).toBe("Read");
});

test("no tools still declares an empty array", () => {
  // Omitting the field makes Qoder fall back to the desktop agent's own
  // toolset, which then leaks to a caller that declared none. Sending an
  // empty array is what keeps that from happening.
  const body = bodyOf(request());
  expect(body["tools"]).toEqual([]);
  expect(body["tool_choice"]).toBeUndefined();
});

test("a declaration always carries a function object", () => {
  // A flat name at the top level is rejected with "'function' is a required
  // property", failing the whole request rather than just one tool.
  const body = bodyOf(request({ tools: [{ name: "Flat", jsonSchema: {} }] }));
  const first = (body["tools"] as Array<Record<string, unknown>>)[0];
  expect(first?.["type"]).toBe("function");
  expect(typeof first?.["function"]).toBe("object");
});

test("tool_choice required survives as required", () => {
  // Silently downgrading to `auto` would let the model answer in prose when the
  // caller needed a call.
  const body = bodyOf(request({ tools: [READ], tool_choice: "required" }));
  expect(body["tool_choice"]).toBe("required");
});

test("a named tool_choice is sent as a bare name", () => {
  // The upstream only accepts a string. Given the object form it ignores the
  // field, and the model then calls the tool with no arguments filled in.
  const body = bodyOf(request({ tools: [READ], tool_choice: { type: "tool", name: "Read" } }));
  expect(body["tool_choice"]).toBe("Read");
});

test("an unnamed tool_choice falls back to auto", () => {
  // An empty name is not a name the upstream can match, so it becomes `auto`
  // rather than being sent as a blank string.
  const body = bodyOf(request({ tools: [READ], tool_choice: { type: "tool", name: "  " } }));
  expect(body["tool_choice"]).toBe("auto");
});

test("allowed_tools collapses to its direction", () => {
  // No chat-completions equivalent exists, so the requirement is preserved even
  // though the name list is not.
  const body = bodyOf(
    request({ tools: [READ], tool_choice: { type: "allowed_tools", mode: "required", names: ["Read"] } }),
  );
  expect(body["tool_choice"]).toBe("required");
});

test("parallel calls are stated explicitly", () => {
  const body = bodyOf(request({ tools: [READ] }));
  expect(body["parallel_tool_calls"]).toBe(true);
});

// ── IDE surface (`model/v1/chat/completions`) ───────────────────────────────
// The unpacked desktop client (worker `PFn`) injects `tools` into the modern
// surface; without it the upstream sees no toolset and answers with a DSML
// text block instead of a structured `tool_calls`. These pin that the IDE
// request carries the same declarations as the legacy one.

function ideBodyOf(req: CanonicalRequest): Record<string, unknown> {
  return buildQoderIdeRequest("m", req, CONFIG, AUTH);
}

test("the IDE request carries the declared tools", () => {
  const body = ideBodyOf(request({ tools: [READ] }));
  const tools = body["tools"] as Array<Record<string, unknown>>;
  expect(tools).toHaveLength(1);
  expect(tools[0]?.["type"]).toBe("function");
  const fn = tools[0]?.["function"] as Record<string, unknown>;
  expect(fn["name"]).toBe("Read");
  expect(fn["description"]).toBe("Read a file");
  // Donor mirror: the tool schema is forwarded as-is — no hardening.
  expect(fn["parameters"]).toEqual(READ.jsonSchema);
  expect(fn["strict"]).toBeUndefined();
});

test("the IDE request omits tools when none are declared", () => {
  // Unlike the legacy surface — which sends `tools: []` to suppress the
  // desktop agent's own toolset — the modern surface only injects `tools`
  // when there is something to declare (worker `PFn`: `n.length>0 &&`).
  const body = ideBodyOf(request());
  expect(body["tools"]).toBeUndefined();
});

test("the IDE request preserves tool_choice via the parameters passthrough", () => {
  // The modern surface reads `tool_choice` through `parameters` (worker
  // `vyl`), not at the top level like the legacy builder.
  const body = ideBodyOf(request({ tools: [READ], tool_choice: "required" }));
  const parameters = body["parameters"] as Record<string, unknown> | undefined;
  expect(parameters?.["tool_choice"]).toBe("required");
  expect(body["tool_choice"]).toBeUndefined();
});
