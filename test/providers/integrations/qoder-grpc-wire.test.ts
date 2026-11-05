/**
 * Regression tests for the Qoder gRPC wire mapping.
 *
 * The gRPC surface is protobuf: response `delta.tool_calls` elements arrive
 * as decoded `google.protobuf.Struct` values ({fields: {k: {stringValue:
 * …}}}) — NOT the plain OpenAI shape. Before the decode fix, the translator
 * read `tc.function.name`/`tc.id` directly and dropped every tool call, which
 * made the upstream's `finish_reason=tool_calls` look like an empty-handed
 * stream (retry "empty-handed"). These tests pin the decode + the request
 * builder's tool shape.
 */
import { expect, test } from "bun:test";
import {
  fromProtoStruct,
  buildQoderGrpcRequest,
  qoderGrpcMetadata,
  qoderGrpcChannelOptions,
  QoderToolCallBuffer,
  resolveQoderToolFragmentId,
  type QoderToolFragmentState,
} from "../../../src/providers/integrations/qoder/qoder-grpc";

test("qoderGrpcMetadata sends exactly the donor's gRPC key set", () => {
  const auth = {
    userId: "u1",
    userName: "",
    userType: "personal_standard",
    securityOauthToken: "tok-secret",
    refreshToken: "",
    machineId: "machine-secret",
  };
  const md = qoderGrpcMetadata(auth);
  const keys = Object.keys(md.getMap()).sort();
  expect(keys).toEqual(
    ["authorization", "cosy-clienttype", "cosy-machinehostname", "cosy-machineos", "cosy-version", "x-request-id", "x-session-id"].sort(),
  );
  // The donor never sends machine token/type on gRPC (HTTP-only identity).
  expect(md.get("cosy-machinetoken")).toHaveLength(0);
  expect(md.get("cosy-machinetype")).toHaveLength(0);
  expect(md.get("cosy-version")[0]).toBe("1.1.80");
  expect(md.get("cosy-clienttype")[0]).toBe("5");
  expect(md.get("cosy-machineos")[0]).toMatch(/^(aarch64|x86_64|arm|x64)_/);
  expect(md.get("authorization")[0]).toBe("Bearer tok-secret");
});

test("qoderGrpcChannelOptions mirrors the donor channel options", () => {
  const opts = qoderGrpcChannelOptions("api2-v2.qoder.sh");
  expect(opts["grpc.enable_http_proxy"]).toBe(0);
  expect(opts["grpc.default_authority"]).toBe("api2-v2.qoder.sh");
  expect(opts["grpc.ssl_target_name_override"]).toBe("api2-v2.qoder.sh");
  expect(opts["grpc.max_receive_message_length"]).toBe(32 * 1024 * 1024);
  expect(opts["grpc.max_send_message_length"]).toBe(32 * 1024 * 1024);
});

test("fromProtoStruct decodes a Struct-wrapped tool-call fragment", () => {
  // Captured live from the upstream (2026-11-04) — first chunk of a call:
  // fields are Value tagged unions, with the `kind` metadata protobufjs adds.
  const chunk = {
    fields: {
      function: {
        structValue: {
          fields: {
            arguments: { stringValue: "", kind: "stringValue" },
            name: { stringValue: "kalkulator", kind: "stringValue" },
          },
        },
        kind: "structValue",
      },
      id: { stringValue: "call_6860ac93243c41ec99285621", kind: "stringValue" },
      index: { numberValue: 0, kind: "numberValue" },
      type: { stringValue: "function", kind: "stringValue" },
    },
  };

  const decoded = fromProtoStruct(chunk);
  expect(decoded["id"]).toBe("call_6860ac93243c41ec99285621");
  expect(decoded["index"]).toBe(0);
  expect(decoded["type"]).toBe("function");
  const fn = decoded["function"] as Record<string, unknown>;
  expect(fn["name"]).toBe("kalkulator");
  expect(fn["arguments"]).toBe("");
});

test("fromProtoStruct decodes continuation fragments (empty id, only index)", () => {
  const chunk = {
    fields: {
      function: {
        structValue: {
          fields: {
            arguments: { stringValue: '{"expression": "17*23"}', kind: "stringValue" },
          },
        },
        kind: "structValue",
      },
      id: { stringValue: "", kind: "stringValue" },
      index: { numberValue: 0, kind: "numberValue" },
      type: { stringValue: "function", kind: "stringValue" },
    },
  };

  const decoded = fromProtoStruct(chunk);
  expect(decoded["id"]).toBe("");
  expect(decoded["index"]).toBe(0);
  const fn = decoded["function"] as Record<string, unknown>;
  expect(fn["arguments"]).toBe('{"expression": "17*23"}');
});

test("fromProtoStruct handles nested struct values", () => {
  const struct = {
    fields: {
      parameters: {
        structValue: {
          fields: {
            type: { stringValue: "object", kind: "stringValue" },
          },
        },
        kind: "structValue",
      },
    },
  };
  const decoded = fromProtoStruct(struct);
  const params = decoded["parameters"] as Record<string, unknown>;
  expect(params["type"]).toBe("object");
});

test("buildQoderGrpcRequest wraps tool fields in proto shapes", () => {
  const request = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  } as never;
  const legacy = {
    messages: [
      { role: "user", content: "hi" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "kalkulator",
          description: "Menghitung operasi aritmatika.",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string" },
            },
            required: ["expression"],
          },
        },
      },
    ],
    parameters: { tool_choice: "auto" },
  };
  const built = buildQoderGrpcRequest("qfmodel", request, "u", 1_000_000, legacy);

  expect(built["stream"]).toBe(true);
  // Donor mirror: `parallel_tool_calls` and `max_tokens` are sent only when
  // the caller set them; the business block has no `scene` field (not in the
  // proto).
  expect(built["parallel_tool_calls"]).toBeUndefined();
  expect(built["max_tokens"]).toBeUndefined();
  expect(built["tool_choice"]).toEqual({ stringValue: "auto" });
  const business = built["metadata"] as Record<string, unknown>;
  expect((business["business"] as Record<string, unknown>)?.["scene"]).toBeUndefined();

  const tools = built["tools"] as Array<Record<string, unknown>>;
  expect(tools).toHaveLength(1);
  const fn = (tools[0]!["function"] as Record<string, unknown>)!;
  expect(fn["name"]).toBe("kalkulator");
  expect(fn["description"]).toEqual({ value: "Menghitung operasi aritmatika." });
  // parameters must be a Struct { fields }, not a raw JSON object.
  const params = fn["parameters"] as Record<string, unknown>;
  expect(params["fields"]).toBeTypeOf("object");
  const fields = params["fields"] as Record<string, unknown>;
  expect(fields["type"]).toEqual({ stringValue: "object" });
  expect(fields["properties"]).toEqual({
    structValue: {
      fields: {
        expression: {
          structValue: {
            fields: { type: { stringValue: "string" } },
          },
        },
      },
    },
  });
});

test("buildQoderGrpcRequest omits undefined tool optionals", () => {
  const request = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  } as never;
  const legacy = {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: { name: "n" },
      },
    ],
  };
  const built = buildQoderGrpcRequest("qfmodel", request, "u", 1_000_000, legacy);
  const tools = built["tools"] as Array<Record<string, unknown>>;
  const fn = (tools[0]!["function"] as Record<string, unknown>)!;
  expect(fn["description"]).toBeUndefined();
  expect(fn["strict"]).toBeUndefined();
  expect(built["tool_choice"]).toBeUndefined();
  expect(built["parallel_tool_calls"]).toBeUndefined();
});

test("buildQoderGrpcRequest mirrors the caller's parallel_tool_calls", () => {
  const request = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  } as never;
  const legacy = {
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    parameters: { parallel_tool_calls: true },
  };
  const built = buildQoderGrpcRequest("qfmodel", request, "u", 1_000_000, legacy);
  expect(built["parallel_tool_calls"]).toEqual({ value: true });

  const legacyFalse = { ...legacy, parameters: { parallel_tool_calls: false } };
  const builtFalse = buildQoderGrpcRequest("qfmodel", request, "u", 1_000_000, legacyFalse);
  expect(builtFalse["parallel_tool_calls"]).toEqual({ value: false });
});

test("buildQoderGrpcRequest omits tool_choice=required (upstream rejects it)", () => {
  // Verified live 2026-11-05 (model matrix 150/150): the gRPC surface
  // rejects `tool_choice: "required"` with 400/406/422 on most models
  // (dmodel/dfmodel/qmodel_38max/mmodel/cmodel). It must be omitted — the
  // neutral prompt carries the intent instead.
  const request = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  } as never;
  const legacy = {
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    parameters: { tool_choice: "required" },
  };
  const built = buildQoderGrpcRequest("qfmodel", request, "u", 1_000_000, legacy);
  expect(built["tool_choice"]).toBeUndefined();

  // `auto` and named choices are still sent.
  const autoLegacy = { ...legacy, parameters: { tool_choice: "auto" } };
  expect(buildQoderGrpcRequest("qfmodel", request, "u", 1_000_000, autoLegacy)["tool_choice"]).toEqual({ stringValue: "auto" });
});

test("buildQoderGrpcRequest sends max_tokens only when the caller set it", () => {
  const request = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  } as never;
  const base = {
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  };
  const built = buildQoderGrpcRequest("qfmodel", request, "u", 1_000_000, base);
  expect(built["max_tokens"]).toBeUndefined();

  const withMax = { ...base, parameters: { max_tokens: 4096 } };
  const builtMax = buildQoderGrpcRequest("qfmodel", request, "u", 1_000_000, withMax);
  expect(builtMax["max_tokens"]).toEqual({ value: 4096 });
  const ctx = (builtMax["metadata"] as Record<string, unknown>)["context"] as Record<string, unknown>;
  expect(ctx["context_length"]).toBeUndefined();

  const withCtx = { ...base, parameters: { context_length: 200000 } };
  const builtCtx = buildQoderGrpcRequest("qfmodel", request, "u", 1_000_000, withCtx);
  const ctx2 = (builtCtx["metadata"] as Record<string, unknown>)["context"] as Record<string, unknown>;
  expect(ctx2["context_length"]).toBe("200000");
});

test("QoderToolCallBuffer maps a tool-call delta pass-through (donor $Dl)", () => {
  // The donor's `$Dl` forwards each `delta.tool_calls` element as-is: id,
  // index, name, and the raw arguments fragment — no buffering, no repair.
  // The mapper must preserve the exact wire bytes.
  const buf = new QoderToolCallBuffer();

  const first = buf.consume({ id: "toolu_bdrk_01LWy342jVdAP", index: 0, name: "kalkulator", args: "" });
  expect(first.callId).toBe("toolu_bdrk_01LWy342jVdAP");
  expect(first.index).toBe(0);
  expect(first.name).toBe("kalkulator");
  expect(first.arguments).toBe("");

  // A continuation fragment without id keeps its own raw args.
  const continuation = buf.consume({ index: 0, args: '{"expression": "17*23"}' });
  expect(continuation.callId).toBe("call_0");
  expect(continuation.arguments).toBe('{"expression": "17*23"}');
  expect(continuation.name).toBeUndefined();

  // A second parallel call with its own id stays distinct.
  const second = buf.consume({ id: "toolu_bdrk_01XvnKVT5a7X3", index: 1, name: "get_waktu", args: '{"zona": "Asia/Jakarta"}' });
  expect(second.callId).toBe("toolu_bdrk_01XvnKVT5a7X3");
  expect(second.arguments).toBe('{"zona": "Asia/Jakarta"}');
});

test("resolveQoderToolFragmentId pins continuation fragments to the current call", () => {
  // The gRPC upstream echoes `id: ""` on continuation chunks; without
  // pinning the client would see an empty-arguments call plus orphaned
  // fragments (regression found live 2026-11-05 via opencode→CarteLocal).
  const state: QoderToolFragmentState = {};

  // Announce: fragment carries id+name, args empty.
  const first = resolveQoderToolFragmentId(state, "toolu_bdrk_01ABC");
  expect(first).toBe("toolu_bdrk_01ABC");

  // Continuation: no id — attaches to the active call.
  const cont = resolveQoderToolFragmentId(state, undefined);
  expect(cont).toBe("toolu_bdrk_01ABC");

  // Next announce switches the active call.
  const second = resolveQoderToolFragmentId(state, "toolu_bdrk_01XYZ");
  expect(second).toBe("toolu_bdrk_01XYZ");
  const secondCont = resolveQoderToolFragmentId(state, undefined);
  expect(secondCont).toBe("toolu_bdrk_01XYZ");
});

test("resolveQoderToolFragmentId handles parallel calls (announce then fragments, index always 0)", () => {
  // Live wire (2026-11-05, parallel get_weather ×2):
  //   {id: A, index:0, args:""}           announce A
  //   {id:"", index:0, args:'{"city": "Jakar'}   fragment A
  //   {id:"", index:0, args:'ta'}                fragment A
  //   {id:"", index:0, args:'"}'                 fragment A
  //   {id: B, index:0, args:""}           announce B
  //   {id:"", index:0, args:'{"city": "Band'}   fragment B
  const state: QoderToolFragmentState = {};

  const a = resolveQoderToolFragmentId(state, "toolu_bdrk_01A");
  expect(a).toBe("toolu_bdrk_01A");
  const aFrag1 = resolveQoderToolFragmentId(state, undefined);
  const aFrag2 = resolveQoderToolFragmentId(state, undefined);
  const aFrag3 = resolveQoderToolFragmentId(state, undefined);
  expect(aFrag1).toBe("toolu_bdrk_01A");
  expect(aFrag2).toBe("toolu_bdrk_01A");
  expect(aFrag3).toBe("toolu_bdrk_01A");

  const b = resolveQoderToolFragmentId(state, "toolu_bdrk_01B");
  expect(b).toBe("toolu_bdrk_01B");
  const bFrag = resolveQoderToolFragmentId(state, undefined);
  expect(bFrag).toBe("toolu_bdrk_01B");
});

test("QoderToolCallBuffer forwards glued arguments verbatim (no repair)", () => {
  // The donor never splits or repairs glued JSON: if the upstream sends
  // `{"a":1}{"b":2}` in one arguments string, it reaches the client exactly
  // like that. The mapper must not alter it.
  const buf = new QoderToolCallBuffer();
  const call = buf.consume({ id: "call_A", index: 0, name: "t1", args: '{"a":1}{"b":2}{"c":3}' });
  expect(call.arguments).toBe('{"a":1}{"b":2}{"c":3}');
});
