/**
 * Shared protobufjs schema-builder helpers.
 *
 * Extracted verbatim from the vendored protocol modules that each carried the
 * same implementation: `cursor/protocol/messages.ts` (vendored from
 * `cursor-opencode-provider`, MIT) and `devin/protocol/devin-proto.ts`
 * (vendored from `oh-my-pi`, MIT). The original license texts remain in those
 * files; this module exists so future schema additions have one place to fix.
 */

import protobuf from "protobufjs";

export type FieldDef = { id: number; name: string; type: string; repeated?: boolean };
export type OneofDef = { name: string; fields: string[] };

/** Create a root Type with fields and optional oneofs, and register it. */
export function addType(
  root: protobuf.Root,
  name: string,
  fields: FieldDef[],
  oneofs?: OneofDef[],
): protobuf.Type {
  const t = new protobuf.Type(name);
  for (const f of fields) {
    t.add(new protobuf.Field(f.name, f.id, f.type, f.repeated ? "repeated" : undefined));
  }
  for (const o of oneofs ?? []) {
    t.add(new protobuf.OneOf(o.name, o.fields));
  }
  root.add(t);
  return t;
}

/** Register an enum on the root. */
export function addEnum(root: protobuf.Root, name: string, values: Record<string, number>): void {
  root.add(new protobuf.Enum(name, values));
}
