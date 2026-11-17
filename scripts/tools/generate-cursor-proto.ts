/**
 * Regenerates the Cursor protocol codec module from the vendored `.proto`
 * sources.
 *
 * Run: `bun run scripts/tools/generate-cursor-proto.ts`
 *
 * Why this exists: the previous integration hand-pinned protobufjs field
 * numbers in `protocol/schema-*.ts` (1,217 lines for the exec family alone),
 * which drifted from the vendored `agent.proto` and could only be kept honest
 * by a README ritual. The schema is now *generated*: the vendored protos are
 * the single source of truth, this script is the only writer of
 * `src/providers/integrations/cursor/cursor-protocol/generated.ts`, and
 * `test/providers/cursor-proto.test.ts` fails if the committed module and the
 * vendored protos disagree — regeneration is a checked gate, not a prayer.
 *
 * The output is a JSON descriptor (protobufjs `Root.toJSON()` form) plus
 * generated TypeScript interfaces and enum tables for every message the
 * vendored protos declare. Field names are camelCase (`keepCase: false`), so
 * `decodeMessage` output and `encodeMessage` input share one naming
 * convention.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const PROTO_SOURCES = [
  "vendor/proto/cursor/agent.proto",
  "vendor/proto/cursor/cursor-models.proto",
] as const;
const OUTPUT_REL = "src/providers/integrations/cursor/cursor-protocol/generated.ts";

/** Parses both vendored protos into one root (packages `agent.v1` + `aiserver.v1`). */
export function buildCursorProtoRoot(): protobuf.Root {
  const root = new protobuf.Root();
  for (const rel of PROTO_SOURCES) {
    const source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    protobuf.parse(source, root, { keepCase: false });
  }
  root.resolveAll();
  return root;
}

function packageNames(): string[] {
  return PROTO_SOURCES.map((rel) => {
    const source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const match = /^package\s+([\w.]+)\s*;/m.exec(source);
    return match ? match[1]! : "";
  }).filter(Boolean);
}

/**
 * Flattens a full protobuf name to a TypeScript identifier by dropping the
 * package segment(s) and joining the remaining (nested) segments with `_`:
 * `aiserver.v1.AvailableModelsResponse.ModelDetails` becomes
 * `AvailableModelsResponse_ModelDetails`.
 */
function baseFlatName(fullName: string, packages: readonly string[]): string {
  let best = "";
  for (const pkg of packages) {
    if (fullName.startsWith(pkg + ".") && pkg.length > best.length) best = pkg;
  }
  return (best ? fullName.slice(best.length + 1) : fullName).split(".").join("_");
}

function pascalCase(name: string): string {
  return name
    .split(/[._]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const SCALAR_TS: Record<string, string> = {
  double: "number",
  float: "number",
  int32: "number",
  int64: "number",
  uint32: "number",
  uint64: "number",
  sint32: "number",
  sint64: "number",
  fixed32: "number",
  fixed64: "number",
  sfixed32: "number",
  sfixed64: "number",
  bool: "boolean",
  string: "string",
  bytes: "Uint8Array | string",
};

export function generateCursorProtoModule(): string {
  const root = buildCursorProtoRoot();
  const packages = packageNames();

  // Pass 1: collect declarations and resolve flat-name collisions (two
  // packages can each declare the same base name, e.g. `ModelDetails`).
  interface MsgRec {
    type: protobuf.Type;
    flatName: string;
    fullName: string;
    oneofOf: Map<string, string>;
  }
  interface EnumRec {
    enum: protobuf.Enum;
    flatName: string;
    fullName: string;
  }
  const msgs: MsgRec[] = [];
  const ens: EnumRec[] = [];
  const walk = (ns: protobuf.NamespaceBase): void => {
    for (const obj of ns.nestedArray) {
      if (obj instanceof protobuf.Type) {
        const fullName = obj.fullName.slice(1);
        const oneofOf = new Map<string, string>();
        for (const one of obj.oneofsArray) {
          for (const f of one.fieldsArray) oneofOf.set(f.name, one.name);
        }
        msgs.push({
          type: obj,
          flatName: baseFlatName(fullName, packages),
          fullName,
          oneofOf,
        });
        walk(obj);
      } else if (obj instanceof protobuf.Enum) {
        ens.push({
          enum: obj,
          flatName: baseFlatName(obj.fullName.slice(1), packages),
          fullName: obj.fullName.slice(1),
        });
      } else if (obj instanceof protobuf.Service) {
        // Service methods are not needed at the codec layer; the RPC paths
        // live in cursor-wire.ts.
      } else if (obj instanceof protobuf.Namespace) {
        walk(obj);
      }
    }
  };
  walk(root);

  const counts = new Map<string, number>();
  for (const r of [...msgs, ...ens]) counts.set(r.flatName, (counts.get(r.flatName) ?? 0) + 1);
  const qualify = (fullName: string, flat: string): string => {
    if ((counts.get(flat) ?? 0) < 2) return flat;
    for (const p of packages) {
      if (fullName.startsWith(p + ".")) return pascalCase(p) + "_" + flat;
    }
    return flat;
  };
  for (const r of msgs) r.flatName = qualify(r.fullName, r.flatName);
  for (const r of ens) r.flatName = qualify(r.fullName, r.flatName);

  const nameOf = (resolved: protobuf.ReflectionObject | null): string | undefined => {
    if (!resolved) return undefined;
    const full = resolved.fullName.slice(1);
    return (
      msgs.find((m) => m.fullName === full)?.flatName ?? ens.find((e) => e.fullName === full)?.flatName
    );
  };

  // Pass 2: emit.
  const out: string[] = [];
  out.push("// @generated by scripts/tools/generate-cursor-proto.ts — DO NOT EDIT.");
  out.push("//");
  out.push("// Source of truth: " + PROTO_SOURCES.join(", "));
  out.push("// Regenerate: `bun run scripts/tools/generate-cursor-proto.ts`");
  out.push("//");
  out.push("// Field names are camelCase; `decodeMessage` output and `encodeMessage`");
  out.push("// input both use them. 64-bit fields decode to `number` (the decoder uses");
  out.push("// `longs: Number`); values above 2^53 lose precision and none of Cursor's");
  out.push("// counters get near it. `bytes` fields are `Uint8Array` on the way out and");
  out.push("// `Uint8Array | string` (base64) on the way in.");
  out.push("");
  out.push("/** JSON descriptor in protobufjs `Root.toJSON()` form. */");
  out.push("export const CURSOR_PROTO_DESCRIPTOR_JSON: string =");
  out.push("  " + JSON.stringify(JSON.stringify(root.toJSON())) + ";");
  out.push("");
  out.push("// ── enums ──");
  out.push("");
  for (const rec of ens) {
    out.push(`/** \`${rec.fullName}\` value table. */`);
    out.push(`export const ${rec.flatName} = {`);
    for (const [name, value] of Object.entries(rec.enum.values)) out.push(`  ${name}: ${value},`);
    out.push("} as const;");
    out.push(`export type ${rec.flatName}Name = keyof typeof ${rec.flatName};`);
    out.push(`export const ${rec.flatName}Names: Record<number, string> = {`);
    for (const [name, value] of Object.entries(rec.enum.values)) out.push(`  ${value}: "${name}",`);
    out.push("};");
    out.push("");
  }
  out.push("// ── messages ──");
  out.push("");
  for (const rec of msgs) {
    out.push(`/** \`${rec.fullName}\` */`);
    out.push(`export interface ${rec.flatName} {`);
    for (const f of [...rec.type.fieldsArray].sort((a, b) => a.id - b.id)) {
      const isMap = f instanceof protobuf.MapField;
      let valueTs: string;
      let wireDoc: string;
      const resolved = f.resolvedType;
      const resolvedName = nameOf(resolved);
      if (resolved && resolvedName) {
        valueTs = resolved instanceof protobuf.Enum ? "number" : resolvedName;
        wireDoc = resolved.fullName.slice(1);
      } else {
        const t = f.type;
        valueTs = SCALAR_TS[t] ?? "unknown";
        wireDoc = t;
      }
      if (isMap) {
        const mapField = f as protobuf.MapField;
        const keyTs = SCALAR_TS[mapField.keyType] ?? "string";
        out.push(`  /** field ${f.id}: map<${mapField.keyType}, ${wireDoc}> */`);
        out.push(`  ${f.name}?: Record<${keyTs}, ${valueTs}>;`);
      } else {
        const oneofNote = rec.oneofOf.get(f.name) ? ` (oneof \`${rec.oneofOf.get(f.name)}\`)` : "";
        out.push(
          `  /** field ${f.id}: ${f.repeated ? `repeated ${wireDoc}` : wireDoc}${oneofNote} */`,
        );
        out.push(`  ${f.name}?: ${f.repeated ? `${valueTs}[]` : valueTs};`);
      }
    }
    out.push("}");
    out.push("");
  }
  out.push("/** Every generated message interface name. */");
  out.push("export type CursorProtoMessageName =");
  for (const rec of msgs) out.push(`  | "${rec.flatName}"`);
  out.push("  ;");
  out.push("");
  return out.join("\n") + "\n";
}

if (import.meta.main) {
  const source = generateCursorProtoModule();
  writeFileSync(path.join(REPO_ROOT, OUTPUT_REL), source, "utf8");
  console.log(`wrote ${OUTPUT_REL} (${source.length} bytes)`);
}
