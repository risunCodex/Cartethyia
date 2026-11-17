/**
 * Cursor `google.protobuf.Value` codec: the bytes Cursor exchanges for tool
 * schemas and call arguments.
 *
 * The invariants under test:
 * 1. The encoding is the standard Struct wire format (`1 null`, `2 double`,
 *    `3 string`, `4 bool`, `5 struct`, `6 list`) — pinned by exact bytes so a
 *    generator regression cannot silently re-encode JSON text (the failure
 *    mode that hung a live Run: a text-encoded catalog stalled the turn).
 * 2. Round-trips through the decoder.
 * 3. The decode ladder: a `Value` message decodes as one; JSON text falls
 *    back to a JSON parse; non-JSON text returns as a raw string.
 */
import { describe, expect, test } from "bun:test";
import {
  decodeProtoJsonValue,
  encodeProtoJsonValue,
} from "../../src/providers/integrations/cursor/cursor-protocol/json-value";

describe("Cursor protobuf Value — wire bytes", () => {
  test("null is tag 1 + varint 0", () => {
    expect(Array.from(encodeProtoJsonValue(null))).toEqual([0x08, 0x00]);
  });

  test("a string is tag 3 + length + utf8", () => {
    expect(Array.from(encodeProtoJsonValue("x"))).toEqual([0x1a, 0x01, 0x78]);
  });

  test("a bool is tag 4 + varint", () => {
    expect(Array.from(encodeProtoJsonValue(true))).toEqual([0x20, 0x01]);
    expect(Array.from(encodeProtoJsonValue(false))).toEqual([0x20, 0x00]);
  });

  test("a number is tag 2 + fixed64 little-endian double", () => {
    const bytes = encodeProtoJsonValue(1);
    expect(bytes[0]).toBe(0x11); // tag: field 2, wire type 1
    expect(new DataView(bytes.buffer, bytes.byteOffset + 1, 8).getFloat64(0, true)).toBe(1);
  });

  test("an object is tag 5 (struct) with per-entry key/value fields", () => {
    const bytes = encodeProtoJsonValue({ a: "b" });
    // Struct: field 5, LEN; entry: field 1 key, field 2 wrapped Value
    // (field 3 string "b").
    expect(Array.from(bytes)).toEqual([
      0x2a, 0x0a, // struct, 10 bytes
      0x0a, 0x08, // entry, 8 bytes
      0x0a, 0x01, 0x61, // key "a"
      0x12, 0x03, // value field, 3 bytes
      0x1a, 0x01, 0x62, // Value: string "b"
    ]);
    expect(decodeProtoJsonValue(bytes)).toEqual({ a: "b" });
  });

  test("an array is tag 6 (list)", () => {
    const bytes = encodeProtoJsonValue([1, "two"]);
    expect(bytes[0]).toBe(0x32); // tag: field 6, wire type 2
    expect(decodeProtoJsonValue(bytes)).toEqual([1, "two"]);
  });

  test("nested schemas round-trip", () => {
    const schema = {
      type: "object",
      properties: {
        text: { type: "string", description: "the text" },
        count: { type: "integer", minimum: 0 },
        flags: { enum: ["a", "b"] },
        nested: { type: "object", properties: { deep: { items: [1, 2.5, null, true, "s"] } } },
      },
      required: ["text"],
    };
    expect(decodeProtoJsonValue(encodeProtoJsonValue(schema))).toEqual(schema);
  });
});

describe("Cursor protobuf Value — decode ladder", () => {
  test("a Value message decodes as one", () => {
    expect(decodeProtoJsonValue(encodeProtoJsonValue({ k: [1, "x"] }))).toEqual({ k: [1, "x"] });
  });

  test("JSON text falls back to a parse", () => {
    expect(decodeProtoJsonValue(new TextEncoder().encode('{"a":2}'))).toEqual({ a: 2 });
    expect(decodeProtoJsonValue(new TextEncoder().encode('"quoted"'))).toBe("quoted");
  });

  test("non-JSON text returns as a raw string", () => {
    expect(decodeProtoJsonValue(new TextEncoder().encode("plain words"))).toBe("plain words");
  });
});
