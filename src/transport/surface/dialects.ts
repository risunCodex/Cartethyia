import type {
  GenerationControls,
  ReasoningIntent,
  ResponseFormat,
  ToolChoice,
} from "../../protocol/canonical-model";
import { REASONING_EFFORTS } from "../../protocol/canonical-model";
import { readString, readBoolean, readNumber } from "../../protocol/codecs";
import { isRecord } from "../../protocol/codecs";
import { completeRequiredSchema } from "../../protocol/codecs";
import type { ToolDefinition } from "../../protocol/canonical-model";
import {
  TOOL_DECLARATIONS_MAX,
  validateToolName,
  validateToolSchemaBounds,
} from "../../protocol/tool-schema";

/** Tool-definition dialects preserve each surface's distinct wire fields. */
type ToolDialect = "chat" | "responses" | "messages";

/**
 * Parses a tool definition from one wire dialect.
 *
 * The parser intentionally keeps dialect-specific field precedence and does
 * not normalize message content or tool calls across surfaces.
 */
export function parseToolDefinition(
  value: unknown,
  dialect: ToolDialect,
): ToolDefinition | undefined {
  if (!isRecord(value)) return undefined;

  if (dialect === "messages") {
    const tool = value["tool"];
    if (isRecord(tool)) return parseToolObject(tool, "messages");
    return parseToolObject(value, "messages");
  }
  return parseToolObject(value, dialect);
}

function parseToolObject(item: Record<string, unknown>, dialect: ToolDialect): ToolDefinition | undefined {
  let name = readString(item, "name");
  if (name === undefined && dialect === "responses") {
    const type = readString(item, "type");
    if (type !== undefined) name = type;
  }
  // Both dialects accept a `function`/`custom` envelope. Reading it only on
  // Chat meant a Chat-shaped tool on the Responses surface took its name from
  // `type` ("function") instead of the tool's real name, and its schema from
  // the whole tool object.
  const chatWrapper = isRecord(item["function"])
    ? item["function"]
    : isRecord(item["custom"])
      ? item["custom"]
      : undefined;
  if (chatWrapper !== undefined) {
    const wrapperName = readString(chatWrapper, "name");
    if (wrapperName !== undefined) name = wrapperName;
  }
  // A hosted tool on an OpenAI-compatible wire is declared as a bare
  // `{"type": "web_search"}` with no `name` and no `function` envelope. It is
  // still a real tool, and dropping it here silently turned a search request
  // into a search-less one, so the type supplies the name.
  if (name === undefined) {
    const declaredType = readString(item, "type");
    if (declaredType === undefined) return undefined;
    name = declaredType;
  }
  // F-2: the name contract is enforced once here, for every dialect.
  validateToolName(name);

  let description = readString(item, "description");
  if (chatWrapper !== undefined) {
    const wrapperDescription = readString(chatWrapper, "description");
    if (wrapperDescription !== undefined) description = wrapperDescription;
  }

  let schema: unknown;
  if (dialect === "chat") {
    const custom = item["custom"];
    if (isRecord(custom)) {
      schema = custom["format"] ?? custom["jsonSchema"] ?? {};
    } else {
      const functionValue = item["function"];
      schema = isRecord(functionValue)
        ? functionValue["parameters"] ??
          functionValue["jsonSchema"] ??
          functionValue["parametersJsonSchema"] ??
          {}
        : // The Responses flat spelling (`{type:"function", parameters:…}`) is
          // common here too; without this a tool arrived with an empty schema
          // and the upstream rejected it.
          item["parameters"] ?? item["input_schema"] ?? item["parametersJsonSchema"] ?? {};
    }
  } else if (dialect === "responses") {
    // A Responses caller may still send the Chat-shaped envelope — the two
    // spellings are interchangeable in the wild. Unwrap it the way the Chat
    // dialect does before falling back to the flat Responses spelling; taking
    // `schema = item` instead ships the whole tool object upstream as the
    // parameter schema and comes back as `invalid_function_parameters`
    // (CodeBuddy 11129).
    const wrapped = isRecord(item["function"]) ? item["function"] : undefined;
    schema =
      item["input_schema"] ??
      item["parameters"] ??
      item["parametersJsonSchema"] ??
      (wrapped !== undefined
        ? wrapped["parameters"] ??
          wrapped["input_schema"] ??
          wrapped["jsonSchema"] ??
          wrapped["parametersJsonSchema"] ??
          {}
        : undefined);
    // F-8: the flat tool with no schema key. A hosted/native declaration is
    // real without one; a FUNCTION tool with neither schema nor wrapper is
    // malformed — shipping the whole tool object as the parameter schema
    // (the old fallback) reached the upstream as invalid_function_parameters.
    if (schema === undefined) {
      const declaredType = readString(item, "type");
      if (declaredType !== undefined && classifyNativeToolType(declaredType) !== "provider") {
        schema = {};
      } else {
        throw new Error(
          `Responses tool "${readString(item, "name") ?? "unnamed"}" requires parameters, input_schema, or a function envelope`,
        );
      }
    }
  } else {
    schema = item["input_schema"] ?? item["inputSchema"] ?? {};
  }

  const strict =
    (chatWrapper !== undefined ? readBoolean(chatWrapper, "strict") : undefined) ??
    readBoolean(item, "strict");
  // F-7: a JSON-Schema-legal boolean root (`true`), array, or number became an
  // empty parameter schema with no signal. No supported upstream wire accepts
  // a boolean schema, so the declaration is refused, naming the tool. A
  // custom-grammar STRING root is legitimate (Chat `custom.format`) and stays.
  if (!isRecord(schema) && typeof schema !== "string")
    throw new Error(`tool "${name}" schema must be a JSON object (or a custom-grammar string)`);
  // F-1: schema size/depth/count bounds are enforced once here, at the single
  // choke point every dialect parses through, before normalization can grow
  // the structure further.
  validateToolSchemaBounds(name, schema);
  const result: ToolDefinition = {
    name,
    jsonSchema: isRecord(schema)
      ? (completeRequiredSchema(schema) as Record<string, unknown>)
      : {},
  };

  if (description !== undefined) result.description = description;
  if (strict !== undefined) result.strict = strict;
  if (Array.isArray(item["input_examples"]))
    result.input_examples = item["input_examples"].filter(isRecord);
  if (typeof item["defer_loading"] === "boolean") result.defer_loading = item["defer_loading"];
  if (Array.isArray(item["allowed_callers"])) {
    result.allowed_callers = item["allowed_callers"].filter(
      (caller): caller is "direct" | "programmatic" =>
        caller === "direct" || caller === "programmatic",
    );
  }
  if (dialect === "chat" && isRecord(item["function"])) {
    const fn = item["function"];
    if (result.input_examples === undefined && Array.isArray(fn["input_examples"]))
      result.input_examples = fn["input_examples"].filter(isRecord);
    if (result.defer_loading === undefined && typeof fn["defer_loading"] === "boolean")
      result.defer_loading = fn["defer_loading"];
    if (result.allowed_callers === undefined && Array.isArray(fn["allowed_callers"])) {
      result.allowed_callers = fn["allowed_callers"].filter(
        (caller): caller is "direct" | "programmatic" =>
          caller === "direct" || caller === "programmatic",
      );
    }
  }

  const type = readString(item, "type");
  if (dialect === "chat" && type === "custom") result.tool_type = "custom";
  else if (type !== undefined && type !== "function" && type !== "tool")
    result.tool_type = classifyNativeToolType(type);
  else if (type === "function" || type === "tool") result.tool_type = "function";
  else if (type !== undefined) result.tool_type = "function";
  if (type !== undefined && type.startsWith("web_search_")) result.native_type = type;
  // F-9: a hosted declaration's wire fields are allowlisted per native type
  // and captured verbatim, so the supporting encoders can re-emit them
  // configured instead of forwarding a bare type.
  if (result.tool_type !== undefined && result.tool_type !== "function" && result.tool_type !== "custom") {
    const allowlist =
      result.tool_type === "provider" || result.tool_type === "computer_use"
        ? HOSTED_TOOL_FIELDS.computer_use
        : HOSTED_TOOL_FIELDS[result.tool_type];
    const fields: Record<string, unknown> = {};
    if (allowlist !== undefined) {
      for (const field of allowlist) {
        if (item[field] !== undefined) fields[field] = item[field];
      }
    }
    // An Anthropic-shaped hosted tool states its knobs at the top level too
    // (`max_uses`, `max_content_tokens`); both dialects' parsers see them.
    for (const field of HOSTED_TOOL_FIELDS.anthropic ?? []) {
      if (item[field] !== undefined && fields[field] === undefined) fields[field] = item[field];
    }
    if (Object.keys(fields).length > 0) result.hosted_fields = fields;
  }
  return result;
}

/**
 * F-9: the wire fields each hosted tool family carries, allowlisted per type.
 * A field on the item that no allowlist names is dropped — an unvalidated
 * field never reaches an upstream.
 */
const HOSTED_TOOL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  mcp: ["server_label", "server_url", "allowed_tools", "headers", "require_approval"],
  web_search: ["search_context_size", "filters", "user_location"],
  file_search: ["vector_store_ids", "max_num_results", "ranking_options", "filters"],
  code_execution: ["container"],
  computer_use: ["display_width", "display_height", "environment"],
  anthropic: ["max_uses", "max_content_tokens", "cache_control", "strict"],
};

function classifyNativeToolType(type: string): Exclude<ToolDefinition["tool_type"], undefined> {
  if (
    type === "web_search" ||
    type === "web_search_preview" ||
    type === "web_search_preview_2025_03_11" ||
    type === "web_search_options"
  )
    return "web_search";
  if (type === "file_search") return "file_search";
  if (type === "code_interpreter" || type === "code_execution") return "code_execution";
  if (type === "computer_use_preview") return "computer_use";
  if (type === "mcp") return "mcp";
  return "provider";
}

const TOOL_DIALECT_LABELS: Readonly<Record<ToolDialect, string>> = {
  chat: "Chat",
  responses: "Responses",
  messages: "Messages",
};

/**
 * Dialect-unified `tools[]` ingress (proposal F-3).
 *
 * One field, three former verdicts: the Chat adapter silently dropped
 * entries that failed to parse (a typo'd tool vanished while the client
 * believed the model could call it), Responses filtered them the same way,
 * and Messages threw. An empty array was dropped by Chat and forwarded by
 * Responses. Every dialect now gives the same three answers:
 *
 * - a non-array `tools` is a 400;
 * - every entry must parse — a malformed tool is refused, never swallowed;
 * - an empty array carries no tools at all, so it normalizes to `undefined`.
 */
export function parseToolsArray(
  value: unknown,
  dialect: ToolDialect,
): ToolDefinition[] | undefined {
  if (value === undefined || value === null) return undefined;
  const label = TOOL_DIALECT_LABELS[dialect];
  if (!Array.isArray(value)) throw new Error(`${label} tools must be an array`);
  if (value.length === 0) return undefined;
  if (value.length > TOOL_DECLARATIONS_MAX)
    throw new Error(
      `${label} tools carries ${value.length} declarations; the limit is ${TOOL_DECLARATIONS_MAX}`,
    );
  // F-2: two tools with one name pair the ledger against the first while
  // every provider takes the last — a duplicate is a client bug, refused
  // here instead of silently misbehaving.
  const names = new Set<string>();
  return value.map((entry) => {
    const parsed = parseToolDefinition(entry, dialect);
    if (parsed === undefined) throw new Error(`${label} tool failed to parse`);
    if (names.has(parsed.name))
      throw new Error(`${label} tools declares "${parsed.name}" more than once`);
    names.add(parsed.name);
    return parsed;
  });
}

export const CANONICAL_REASONING_EFFORTS: ReadonlySet<string> = new Set(REASONING_EFFORTS);

function isReasoningEffort(value: unknown): value is NonNullable<ReasoningIntent["effort"]> {
  return typeof value === "string" && CANONICAL_REASONING_EFFORTS.has(value as NonNullable<ReasoningIntent["effort"]>);
}

const SERVICE_TIERS = new Set(["auto", "default", "flex", "scale", "priority", "fast"]);

function isServiceTier(value: unknown): value is string {
  return typeof value === "string" && SERVICE_TIERS.has(value);
}

/**
 * F-16: one shared `service_tier` rule for every surface — a tier the
 * canonical model knows lands in `controls.service_tier`; anything else is
 * forwarded verbatim as an extension instead of getting one of three
 * per-surface verdicts (forwarded / dropped / restricted). What a route does
 * with the value stays the projection layer's job.
 */
export function applyServiceTier(
  controls: GenerationControls,
  value: unknown,
  extensionKey: `extension:${string}`,
): void {
  if (typeof value !== "string" || value.length === 0) return;
  if (isServiceTier(value)) controls.service_tier = value;
  else controls[extensionKey] = value;
}

// F-11: stop-sequence bounds — both OpenAI and Anthropic cap stop sequences
// at 4, and an entry long enough to be useful never exceeds 64 characters.
const STOP_MAX_SEQUENCES = 4;
const STOP_MAX_SEQUENCE_LENGTH = 64;

/**
 * F-11: one shared `stop` verdict per surface. The Chat surface accepted any
 * all-string array unbounded, Messages forwarded arrays with numbers or
 * objects in them, and Responses dropped the field silently. Every dialect
 * now answers the same way: strings only, each 1..64 characters, at most 4
 * entries — else a 400 naming what arrived.
 */
export function parseStopSequences(
  value: unknown,
  label: string,
): string | readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value.length === 0 || value.length > STOP_MAX_SEQUENCE_LENGTH)
      throw new Error(
        `${label} stop sequence must be 1..${STOP_MAX_SEQUENCE_LENGTH} characters`,
      );
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    if (value.length > STOP_MAX_SEQUENCES)
      throw new Error(
        `${label} stop accepts at most ${STOP_MAX_SEQUENCES} sequences; received ${value.length}`,
      );
    for (const entry of value) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > STOP_MAX_SEQUENCE_LENGTH)
        throw new Error(
          `${label} stop sequences must be strings of 1..${STOP_MAX_SEQUENCE_LENGTH} characters`,
        );
    }
    return value as readonly string[];
  }
  throw new Error(`${label} stop must be a string or an array of strings`);
}

/** F-6: `allowed_tools` selections accept at most this many entries. */
const TOOL_CHOICE_MAX_ALLOWED = 32;

/**
 * F-6: cross-checks a parsed `tool_choice` against the declared tools.
 *
 * A named selection that no declared tool satisfies used to be forwarded
 * verbatim — the upstream answered with its own opaque error, or a router
 * candidate silently downgraded the choice. Both spellings (`tool` and
 * `custom`) and every `allowed_tools` entry must name a declared tool; an
 * empty name is refused.
 */
export function validateToolChoice(
  choice: ToolChoice,
  tools: readonly ToolDefinition[] | undefined,
): void {
  const declared = new Set((tools ?? []).map((tool) => tool.name));
  const requireDeclared = (name: string, label: string): void => {
    if (name.trim().length === 0) throw new Error(`${label} names an empty tool`);
    if (!declared.has(name))
      throw new Error(`${label} names tool "${name}" which is not among the declared tools`);
  };
  if (typeof choice === "string") {
    if (choice.trim().length === 0) throw new Error("tool_choice must not be empty");
    return;
  }
  if (choice.type === "tool") requireDeclared(choice.name, "tool_choice");
  else if (choice.type === "custom") requireDeclared(choice.name, "tool_choice");
  else if (choice.type === "allowed_tools") {
    if (choice.names.length > TOOL_CHOICE_MAX_ALLOWED)
      throw new Error(
        `tool_choice allowed_tools accepts at most ${TOOL_CHOICE_MAX_ALLOWED} entries; received ${choice.names.length}`,
      );
    for (const name of choice.names) requireDeclared(name, "tool_choice allowed_tools");
  }
}

/**
 * Dialect-unified tool_choice parser. Accepts string literals across all wires,
 * unwraps function/custom wrappers leniently, extracts allowed_tools names from both
 * `entry.function.name` (Chat wire) and `entry.name` (Responses wire), and enforces
 * strict-throw for Messages vs lenient-undefined for Chat/Responses.
 */
export function parseToolChoice(value: unknown, dialect: ToolDialect): ToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") return value;
  if (!isRecord(value)) {
    if (dialect === "messages") throw new Error("Messages tool_choice must be a string or object");
    return undefined;
  }
  const type = readString(value, "type");
  // Messages dialect aliases
  if (type === "auto") return "auto";
  if (type === "none") return "none";
  if (type === "any") return "required";

  if (type === "allowed_tools" && Array.isArray(value["tools"])) {
    const tools = value["tools"] as unknown[];
    const names = tools.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const fn = isRecord(entry["function"]) ? entry["function"] : entry;
      const name = readString(fn, "name");
      return name !== undefined ? [name] : [];
    });
    const mode = readString(value, "mode") === "required" ? ("required" as const) : ("auto" as const);
    return { type: "allowed_tools", mode, names };
  }
  if (type === "custom") {
    const customObj = isRecord(value["custom"]) ? value["custom"] : value;
    const name = readString(customObj, "name");
    if (name !== undefined) return { type: "custom", name };
  }
  if (type === "function" || type === "tool") {
    const fnObj = isRecord(value["function"]) ? value["function"] : value;
    const name = readString(fnObj, "name");
    if (name !== undefined) return { type: "tool", name };
  }
  if (dialect === "messages") throw new Error("Messages tool_choice has an unsupported type");
  return undefined;
}

/**
 * Normalized reasoning parser. Reads nested `reasoning` object (Responses wire)
 * and top-level `reasoning_effort`/`reasoning_level`/`summary_mode` scalars (Chat wire).
 */
export function parseReasoningIntent(body: Record<string, unknown>): ReasoningIntent | undefined {
  const reasoningObj = isRecord(body["reasoning"]) ? body["reasoning"] : undefined;
  const rawEffort = reasoningObj
    ? readString(reasoningObj, "effort")
    : (readString(body, "reasoning_effort") ?? readString(body, "reasoning_level"));
  const rawSummaryMode = reasoningObj
    ? (readString(reasoningObj, "summary_mode") ?? readString(reasoningObj, "summary"))
    : readString(body, "summary_mode");
  const rawSummaryText = reasoningObj ? readString(reasoningObj, "summary") : undefined;
  // F-13: an effort the caller spelled but the canonical model does not know
  // is a 400 naming the value — silently dropping it produced a request with
  // no thinking where thinking was explicitly requested.
  if (typeof rawEffort === "string" && !isReasoningEffort(rawEffort))
    throw new Error(
      `reasoning effort "${rawEffort}" is not one of: ${REASONING_EFFORTS.join(", ")}`,
    );
  const reasoning: ReasoningIntent = {};
  if (isReasoningEffort(rawEffort)) reasoning.effort = rawEffort;
  if (reasoningObj) {
    const mode = readString(reasoningObj, "mode");
    if (mode === "standard" || mode === "pro") reasoning.mode = mode;
    const context = readString(reasoningObj, "context");
    if (context === "current_turn" || context === "all_turns") reasoning.context = context;
    const thinkingType = readString(reasoningObj, "thinking_type");
    if (thinkingType === "enabled" || thinkingType === "adaptive" || thinkingType === "disabled")
      reasoning.thinking_type = thinkingType;
    const budget = readNumber(reasoningObj, "budget_tokens");
    if (budget !== undefined) {
      // F-13: the same floor the Messages thinking parser enforces — a
      // sub-floor budget passed Chat/Responses and failed (or was ignored)
      // upstream.
      if (!Number.isInteger(budget) || budget < 1024)
        throw new Error("reasoning budget_tokens must be an integer of at least 1024");
      reasoning.budget_tokens = budget;
    }
  }
  if (rawSummaryMode === "auto" || rawSummaryMode === "concise" || rawSummaryMode === "detailed") {
    reasoning.summary_mode = rawSummaryMode;
  }
  if (rawSummaryText !== undefined && rawSummaryText !== "auto" && rawSummaryText !== "concise" && rawSummaryText !== "detailed") {
    reasoning.summary = rawSummaryText;
  }
  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

/**
 * Normalized response_format parser. Supports OpenAI `body.response_format` and
 * Responses `body.text.format`. Returns undefined if `json_schema` schema payload is missing.
 *
 * F-12: one verdict for the field on every surface — an unknown `type` is a
 * 400 naming the value (silently dropping it produced json-mode-less output
 * for a typo'd client), and a `json_schema` format requires a record schema
 * within the F-1 tool-schema bounds and a non-empty `name` of at most 64
 * characters.
 */
export function parseResponseFormat(formatValue: unknown): ResponseFormat | undefined {
  if (!isRecord(formatValue)) return undefined;
  const type = readString(formatValue, "type");
  if (type === "json_object") return { type: "json_object" };
  // The Responses `text.format` default is the plain-text format; it carries
  // no canonical intent and parses to no response_format.
  if (type === "text") return undefined;
  if (type !== "json_schema")
    throw new Error(
      `response_format type ${JSON.stringify(type ?? null)} is not supported; use "json_object" or "json_schema"`,
    );
  const schemaObj = isRecord(formatValue["json_schema"]) ? formatValue["json_schema"] : formatValue;
  const schema = schemaObj["schema"] ?? schemaObj["json_schema"];
  if (!isRecord(schema))
    throw new Error("response_format json_schema requires a schema object");
  validateToolSchemaBounds("response_format", schema);
  const strict = readBoolean(schemaObj, "strict");
  const name = readString(schemaObj, "name");
  if (name !== undefined) {
    if (name.trim().length === 0)
      throw new Error("response_format json_schema name must not be empty");
    if (name.length > 64)
      throw new Error("response_format json_schema name must be at most 64 characters");
  }
  const description = readString(schemaObj, "description");
  return {
    type: "json_schema",
    schema,
    ...(typeof strict === "boolean" ? { strict } : {}),
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof description === "string" ? { description } : {}),
  };
}
