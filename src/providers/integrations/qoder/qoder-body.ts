/**
 * Shared canonical→Qoder message helpers.
 *
 * Kept in a separate module so both transports (`qoder.ts` HTTP and
 * `qoder-grpc.ts`) build and flatten message content the same way.
 */
import type { ContentPart, ToolChoice, ToolDefinition } from "../../../protocol/canonical-model";

/** Joins text/tool-result content of one canonical message into plain text. */
export function flattenCanonicalContent(content: readonly ContentPart[]): string {
  return content
    .filter((b) => b.kind === "text" || b.kind === "toolResult")
    .map((b) => {
      if (b.kind === "text") return b.text;
      if (b.kind === "toolResult") return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      return "";
    })
    .join("\n");
}

/**
 * Projects the canonical tools onto Qoder's chat-completions `tools` array
 * (the same OpenAI-shaped declaration both the HTTP and the gRPC surface
 * expect).
 *
 * Without this the upstream is never told a tool exists, so a model that wants
 * one improvises markup in its prose (`<Read file_path="..." />`) instead of
 * emitting a structured call — the call is then neither runnable nor
 * recoverable, because it never was a call on either side.
 *
 * Only `function` tools are representable upstream. Anything else is dropped
 * rather than forwarded: Qoder rejects an unknown variant during
 * deserialization and fails the whole turn, which is worse than omitting a
 * tool the model could not have used anyway.
 */
export function qoderTools(
  tools: readonly ToolDefinition[] | undefined,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools ?? []) {
    if (tool.tool_type !== undefined && tool.tool_type !== "function") continue;
    // The upstream requires `tools[].function` to be an object. A flat
    // declaration naming the tool at the top level is rejected outright with
    // "'function' is a required property, expected an object", which fails the
    // whole request rather than just this tool.
    out.push({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description === undefined ? { description: "" } : { description: tool.description }),
        parameters: tool.jsonSchema ?? { type: "object", properties: {} },
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    });
  }
  return out;
}

/**
 * Projects the canonical tool choice onto the upstream's field.
 *
 * The upstream only accepts a string here (both surfaces). Given the object
 * form `{type:"function",function:{name}}` it ignores the field, and the model
 * then calls the tool with no arguments filled in.
 *
 * `allowed_tools` has no chat-completions equivalent, so it collapses to the
 * direction it already names rather than being dropped: a caller that asked for
 * `required` must not silently get `auto`.
 */
export function qoderToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.type === "tool" || choice.type === "custom") {
    const name = choice.name.trim();
    return name.length > 0 ? name : "auto";
  }
  return choice.mode;
}
