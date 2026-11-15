/**
 * JSON-Schema normalization for tool declarations: the helpers that rewrite a
 * caller-supplied tool `parameters`/`input_schema` root into a shape strict
 * upstreams accept — an explicit object schema with a `required` list — and
 * the Anthropic keyword allowlist that drops wire-unsupported schema keys.
 *
 * All walks thread `RewriteWalk` from `rewrite.ts`, so a schema nested past
 * the depth bound is forwarded unchanged rather than overflowing the stack.
 */
import { isRecord } from "./wire-readers";
import { descend, ROOT_WALK, shouldStop, type RewriteWalk } from "./rewrite";

// Tool ingress bounds (proposal F-1).
//
// The whole-body ingress guard (`MAX_JSON_DEPTH = 64` in rewrite.ts) measures
// the envelope, not the schema a tool declares — a megabyte-deep or
// ten-thousand-property schema fits inside it and reaches every provider
// codec, poisoning retries and replay. These bounds sit at ingress, above
// every known provider limit, so a legitimate declaration passes untouched
// and per-provider clamps keep theirs.

/** Serialized JSON-Schema size ceiling for one tool declaration. */
export const TOOL_SCHEMA_MAX_BYTES = 64 * 1024;
/** Nesting ceiling for one tool declaration's schema. */
export const TOOL_SCHEMA_MAX_DEPTH = 24;
/** Items ceiling for any single array inside a tool schema. */
export const TOOL_SCHEMA_MAX_ARRAY_ITEMS = 512;
/** Tools declared per request. */
export const TOOL_DECLARATIONS_MAX = 256;

/**
 * Tool-name contract at ingress (proposal F-2).
 *
 * Both OpenAI and Anthropic enforce `^[a-zA-Z0-9_-]{1,64}$` on tool names, so
 * a name outside `^[A-Za-z0-9_-]{1,128}$` fails upstream anyway — the gateway
 * 400 just says so before the round-trip. The bound sits above the providers'
 * so per-provider clamps keep theirs. Renamed traffic (OAuth tool aliases)
 * produces charset-safe names and is unaffected.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Validates one tool name at ingress, naming the offender in the error. */
export function validateToolName(name: string): void {
  if (name.trim().length === 0) throw new Error("tool name must not be empty");
  if (!TOOL_NAME_PATTERN.test(name))
    throw new Error(
      `tool name "${name.length > 64 ? `${name.slice(0, 64)}…` : name}" must match ^[A-Za-z0-9_-]{1,128}$`,
    );
}

/**
 * Validates one tool schema against the ingress bounds, naming the tool.
 * Accepts any root (a custom-grammar string passes trivially); only record
 * and array structures carry depth/count.
 */
export function validateToolSchemaBounds(toolName: string, schema: unknown): void {
  if (typeof schema === "string") return;
  const serialized = JSON.stringify(schema);
  if (serialized !== undefined && serialized.length > TOOL_SCHEMA_MAX_BYTES)
    throw new Error(
      `tool "${toolName}" schema is ${serialized.length} bytes; the limit is ${TOOL_SCHEMA_MAX_BYTES}`,
    );
  walkSchemaBounds(toolName, schema, 0);
}

function walkSchemaBounds(toolName: string, value: unknown, depth: number): void {
  if (depth > TOOL_SCHEMA_MAX_DEPTH)
    throw new Error(
      `tool "${toolName}" schema is nested deeper than ${TOOL_SCHEMA_MAX_DEPTH} levels`,
    );
  if (Array.isArray(value)) {
    if (value.length > TOOL_SCHEMA_MAX_ARRAY_ITEMS)
      throw new Error(
        `tool "${toolName}" schema carries an array with ${value.length} items; the limit is ${TOOL_SCHEMA_MAX_ARRAY_ITEMS}`,
      );
    for (const item of value) walkSchemaBounds(toolName, item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>))
      walkSchemaBounds(toolName, child, depth + 1);
  }
}


// Anthropic tool-schema sanitization

const SUPPORTED_SCHEMA_KEYS: Readonly<Record<string, true>> = Object.freeze({
  $ref: true,
  $defs: true,
  definitions: true,
  type: true,
  enum: true,
  const: true,
  description: true,
  title: true,
  default: true,
  properties: true,
  required: true,
  additionalProperties: true,
  items: true,
  anyOf: true,
  oneOf: true,
  allOf: true,
  minItems: true,
  maxItems: true,
  minLength: true,
  maxLength: true,
  pattern: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  minProperties: true,
  maxProperties: true,
});

/**
 * True when a schema string carries a backslash before an underscore.
 *
 * Some clients emit a property or pattern key containing a literal `\_` (an
 * escaped underscore). Upstreams reject it, so the escape has to be stripped —
 * and stripping it can collapse two previously distinct keys onto the same
 * name, which is why {@link mergeCollidingKeys} exists below.
 */
function hasUnderscoreEscape(value: string): boolean {
  return /\\+_/.test(value);
}

/**
 * Merges map entries whose normalized keys collide, rather than overwriting.
 *
 * `allOf` accepts boolean schemas, so neither constraint is lost — a plain
 * overwrite would silently drop one of two rules the caller actually sent.
 */
function mergeCollidingKeys(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const existing = merged[key];
    if (existing === undefined) {
      merged[key] = value;
      continue;
    }
    merged[key] = { allOf: [existing, value] };
  }
  return merged;
}

/** One schema map's keys, with `\_` escapes stripped and collisions merged. */
function normalizeSchemaMapKeys(map: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(map);
  if (!entries.some(([key]) => hasUnderscoreEscape(key))) return map;
  return mergeCollidingKeys(
    entries.map(([key, value]) => [key.replace(/\\+_/g, "_"), value] as const),
  );
}

export function sanitizeSchemaForAnthropic(value: unknown): unknown {
  return sanitizeSchemaWalk(value, ROOT_WALK);
}

function sanitizeSchemaWalk(value: unknown, walk: RewriteWalk): unknown {
  if (Array.isArray(value)) {
    if (shouldStop(walk, value)) return value;
    const inner = descend(walk, value);
    return value.map((entry) => sanitizeSchemaWalk(entry, inner));
  }
  if (!isRecord(value)) return value;
  if (shouldStop(walk, value)) return value;
  const inner = descend(walk, value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // Property names are user-defined schema keys, not JSON-Schema keywords;
    // preserve them while sanitizing each property's schema recursively.
    if (key === "properties" && isRecord(child)) {
      out.properties = Object.fromEntries(
        // Escaped-underscore keys are normalized first: two names differing only
        // by an escape would otherwise survive as two properties and be rebuilt
        // into a `required` list the upstream rejects.
        Object.entries(normalizeSchemaMapKeys(child)).map(([name, schema]) => [
          name,
          sanitizeSchemaWalk(schema, inner),
        ]),
      );
      continue;
    }
    // `patternProperties` is deliberately NOT re-emitted: it is absent from
    // `SUPPORTED_SCHEMA_KEYS` because the Anthropic wire does not accept it, and
    // writing it here would be undone by the keyword filter a few lines down
    // anyway. Its keys are still walked below, so nested schemas are sanitized
    // and an escaped-underscore key inside one is still normalized.
    // Drop wire-unsupported keywords so a strict upstream never 400s on
    // them — but never invent caller text to say so. The dropped names are
    // debug-logged by the caller-facing builder when that matters.
    if (!SUPPORTED_SCHEMA_KEYS[key]) continue;
    out[key] = sanitizeSchemaWalk(child, inner);
  }
  const properties = out.properties;
  if (isRecord(properties)) {
    out.type ??= "object";
    // A-Carte's Anthropic-compatible endpoint validates tool schemas as
    // strict objects: every declared property must also appear in required.
    // Rebuild from the sanitized property names so dropped/unknown entries
    // cannot leave an invalid required list behind.
    out.required = Object.keys(properties);
  }
  return out;
}

/**
 * JSON Schema keywords. A parameter root containing any of these is already a
 * schema object, not a legacy property-name → schema map.
 */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema", "$id", "$ref", "$anchor", "$dynamicRef", "$dynamicAnchor", "$defs",
  "$vocabulary", "$comment", "definitions", "type", "properties", "patternProperties",
  "additionalProperties", "unevaluatedProperties", "propertyNames", "required",
  "dependentRequired", "dependentSchemas", "dependencies", "minProperties", "maxProperties",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "items", "prefixItems",
  "additionalItems", "contains", "unevaluatedItems", "minItems", "maxItems", "uniqueItems",
  "minContains", "maxContains", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "minLength", "maxLength", "pattern", "format", "contentEncoding",
  "contentMediaType", "contentSchema", "enum", "const", "title", "description", "default",
  "examples", "deprecated", "readOnly", "writeOnly",
]);

/** The JSON Schema primitive type names. */
const SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "string", "number", "integer", "boolean", "object", "array", "null",
]);

/**
 * Rewrites one legacy tool parameter root into an explicit object schema.
 *
 * Two shapes reach here and are both rejected upstream as-is:
 *
 * - **An empty root.** `{}` carries no `type`, and a schema with no type is not
 *   a schema the upstream will accept — it answers `invalid_function_parameters`
 *   (CodeBuddy `11129`).
 * - **A legacy property-name → schema map.** Every field names a parameter and
 *   carries its own boolean `required` flag, with no `{"type":"object",
 *   "properties":…}` wrapper around them. Old clients in the wild still emit
 *   this; the upstream wants the wrapper and the `required` array.
 *
 * Anything ambiguous is returned **untouched**. A root that already holds schema
 * keywords, or one whose fields do not all look like `{type: <primitive>}`
 * entries, is left alone: guessing there would rewrite a valid schema into a
 * wrong one, which is worse than the refusal it was trying to avoid.
 */
export function normalizeToolParameterRoot(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (Object.keys(value).length === 0) return { type: "object", properties: {} };
  // Schema keywords (or an extension/annotation key) mean this is a real
  // schema object already, not a property map.
  if (SCHEMA_KEYWORDS.has(Object.keys(value)[0] ?? "")) return value;
  if (Object.keys(value).some((name) => SCHEMA_KEYWORDS.has(name))) return value;
  if (Object.keys(value).some((name) => name.startsWith("$") || name.startsWith("x-")))
    return value;
  const entries = Object.entries(value);
  // A legacy map is identified by its per-field boolean `required`. Without at
  // least one, this is not recognisably the legacy shape.
  if (!entries.some(([, field]) => isRecord(field) && typeof field["required"] === "boolean"))
    return value;
  if (
    !entries.every(
      ([, field]) =>
        isRecord(field) &&
        typeof field["type"] === "string" &&
        SCHEMA_TYPES.has(field["type"]) &&
        (!("required" in field) || typeof field["required"] === "boolean"),
    )
  )
    return value;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of entries) {
    const copy = { ...(field as Record<string, unknown>) };
    if (copy["required"] === true) required.push(name);
    delete copy["required"];
    properties[name] = copy;
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Defaults a tool schema's `required` list to all declared properties while
 * preserving an explicit list, including optional properties.
 *
 * Also normalizes a legacy parameter root first (see
 * {@link normalizeToolParameterRoot}), so a caller sending an empty root or a
 * property-name → schema map still ships a schema the upstream accepts.
 */
export function completeRequiredSchema(value: unknown): unknown {
  return completeRequiredWalk(normalizeToolParameterRoot(value), ROOT_WALK);
}

function completeRequiredWalk(value: unknown, walk: RewriteWalk): unknown {
  if (Array.isArray(value)) {
    if (shouldStop(walk, value)) return value;
    const inner = descend(walk, value);
    return value.map((entry) => completeRequiredWalk(entry, inner));
  }
  if (!isRecord(value)) return value;
  if (shouldStop(walk, value)) return value;
  const inner = descend(walk, value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "properties" && isRecord(child)) {
      out.properties = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, completeRequiredWalk(schema, inner)]),
      );
      continue;
    }
    out[key] = completeRequiredWalk(child, inner);
  }
  if (isRecord(out.properties) && !Array.isArray(out.required)) {
    out.required = Object.keys(out.properties);
  }
  return out;
}
