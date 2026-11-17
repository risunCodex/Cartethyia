/**
 * Runtime codec over the generated Cursor protocol schema.
 *
 * The generated module (`./generated.ts`) is pure data: a JSON descriptor plus
 * interface/enum declarations. This module owns the singleton protobuf root
 * built from that descriptor and the two call shapes the integration uses —
 * `encodeMessage` for request frames and `decodeMessage` for server frames.
 *
 * Decode options are fixed and load-bearing: `defaults: true` so absent
 * scalars read as proto3 defaults instead of `undefined` (pump code branches
 * on oneof-member presence, and `toObject` only materialises the member that
 * is set), `json: true` for camelCase keys, `longs: Number` so 64-bit counters
 * are plain numbers.
 */
import protobuf from "protobufjs";
import { CURSOR_PROTO_DESCRIPTOR_JSON } from "./generated";

let root: protobuf.Root | null = null;

/** The singleton schema root built from the generated descriptor. */
export function cursorProtoRoot(): protobuf.Root {
  if (root === null) {
    root = protobuf.Root.fromJSON(JSON.parse(CURSOR_PROTO_DESCRIPTOR_JSON) as protobuf.INamespace);
    root.resolveAll();
  }
  return root;
}

/**
 * Encodes a plain object as `typeName`'s protobuf wire form. `fromObject`
 * accepts camelCase keys (the generated convention), base64 strings for
 * `bytes`, and plain numbers for 64-bit fields.
 */
export function encodeMessage(typeName: string, message: Record<string, unknown>): Uint8Array {
  const type = cursorProtoRoot().lookupType(typeName);
  const err = type.verify(message);
  if (err) throw new Error(`invalid message for ${typeName}: ${err}`);
  return type.encode(type.fromObject(message)).finish();
}

/**
 * Decodes a protobuf payload as `typeName` into a plain camelCase object.
 * Only the set member of a oneof is materialised, so branch on presence.
 */
export function decodeMessage<T = Record<string, unknown>>(
  typeName: string,
  data: Uint8Array,
): T {
  const type = cursorProtoRoot().lookupType(typeName);
  const decoded = type.decode(data);
  return type.toObject(decoded, {
    defaults: true,
    json: true,
    longs: Number,
  }) as T;
}
