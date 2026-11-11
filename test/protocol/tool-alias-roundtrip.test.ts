/**
 * Tool-name alias round trip: the Claude Messages builder records the renames
 * it applies (OAuth underscore prefixing) on the canonical request, and the
 * response decoder restores them exactly.
 *
 * This mirrors the two-way alias pattern of the OpenCode free-tier fingerprint
 * (conceal on the way out, restore on the way back) — but with an explicit
 * per-request registry instead of a fixed-prefix guess, so a caller that
 * already uses the prefix (`_bash`) round-trips verbatim instead of being
 * double-prefixed and silently restored to the wrong name.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest, ContentPart } from "../../src/protocol/canonical-model";
import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import { claudeResponseToEvents } from "../../src/protocol/response/messages";
import { recordToolAliases, toolAliasesFor, restoreToolNameFor } from "../../src/protocol/codecs";

function requestWithTools(tools: { name: string }[]): CanonicalRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" } satisfies ContentPart] }],
    tools: tools.map((tool) => ({
      name: tool.name,
      description: "t",
      jsonSchema: { type: "object", properties: {} },
    })),
    generation_controls: {},
    stream: false,
    source_surface: "messages",
  };
}

describe("tool alias round trip (Claude Messages)", () => {
  test("an OAuth builder records the rename on the request", () => {
    const request = requestWithTools([{ name: "my_tool" }]);
    const payload = canonicalToClaudeMessagesPayload(request, { isOAuth: true });
    const sent = payload.tools as { name: string }[];
    expect(sent[0]?.name).toBe("_my_tool");
    expect(toolAliasesFor(request)).toEqual([{ sent: "_my_tool", original: "my_tool" }]);
  });

  test("a non-OAuth builder records nothing", () => {
    const request = requestWithTools([{ name: "my_tool" }]);
    const payload = canonicalToClaudeMessagesPayload(request, { isOAuth: false });
    const sent = payload.tools as { name: string }[];
    expect(sent[0]?.name).toBe("my_tool");
    expect(toolAliasesFor(request)).toEqual([]);
  });

  test("built-in tool names are never renamed nor recorded", () => {
    const request = requestWithTools([{ name: "web_search" }]);
    const payload = canonicalToClaudeMessagesPayload(request, { isOAuth: true });
    const sent = payload.tools as { name: string }[];
    expect(sent[0]?.name).toBe("web_search");
    expect(toolAliasesFor(request)).toEqual([]);
  });

  test("restore returns the original name for a recorded rename", () => {
    const request = requestWithTools([{ name: "my_tool" }]);
    canonicalToClaudeMessagesPayload(request, { isOAuth: true });
    expect(restoreToolNameFor(request, "_my_tool")).toBe("my_tool");
  });

  test("an already-prefixed caller tool round-trips verbatim", () => {
    // `_already` gains a second underscore on the wire (`__already`) because
    // OAuth prefixing applies to every non-built-in name; the recorded alias
    // restores `_already` exactly — never `already`.
    const request = requestWithTools([{ name: "_already" }]);
    const payload = canonicalToClaudeMessagesPayload(request, { isOAuth: true });
    const sent = payload.tools as { name: string }[];
    expect(sent[0]?.name).toBe("__already");
    expect(toolAliasesFor(request)).toEqual([{ sent: "__already", original: "_already" }]);
    expect(restoreToolNameFor(request, "__already")).toBe("_already");
  });

  test("response decoder restores a renamed tool_use name", () => {
    const request = requestWithTools([{ name: "my_tool" }]);
    canonicalToClaudeMessagesPayload(request, { isOAuth: true });

    const json = {
      id: "msg_1",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "_my_tool",
          input: {},
        },
      ],
      stop_reason: "tool_use",
      usage: {},
    };
    const events = claudeResponseToEvents(json, request, true);
    const toolCall = events.find((event) => event.type === "tool_call_delta");
    expect(toolCall).toBeDefined();
    const name = toolCall?.type === "tool_call_delta" ? toolCall.name : undefined;
    expect(name).toBe("my_tool");
  });

  test("decoder without a registered alias falls back to prefix stripping", () => {
    const request = requestWithTools([{ name: "_already" }]);
    // No builder ran, so no aliases are recorded; the OAuth fallback strips
    // exactly one underscore, which is correct for a name we prefixed.
    const json = {
      id: "msg_1",
      content: [{ type: "tool_use", id: "toolu_1", name: "__already", input: {} }],
      stop_reason: "tool_use",
      usage: {},
    };
    const events = claudeResponseToEvents(json, request, true);
    const toolCall = events.find((event) => event.type === "tool_call_delta");
    const name = toolCall?.type === "tool_call_delta" ? toolCall.name : undefined;
    expect(name).toBe("_already");
  });

  test("recordToolAliases is idempotent per request", () => {
    const request = requestWithTools([{ name: "a" }, { name: "b" }]);
    recordToolAliases(request, [{ sent: "_a", original: "a" }]);
    recordToolAliases(request, [{ sent: "_a", original: "a" }]);
    expect(toolAliasesFor(request)).toEqual([{ sent: "_a", original: "a" }]);
  });

  test("ambiguity between already and prefixed names resolves via the registry", () => {
    // A caller that declares both `already` and `_already` sends `_already`
    // and `__already` on the wire. Without the registry, `_already` would
    // restore to `already` (the prefix-strip guess), which is wrong for the
    // caller that meant `_already`. The registry restores each exactly.
    const request = requestWithTools([{ name: "already" }, { name: "_already" }]);
    canonicalToClaudeMessagesPayload(request, { isOAuth: true });
    expect(restoreToolNameFor(request, "_already")).toBe("already");
    expect(restoreToolNameFor(request, "__already")).toBe("_already");
  });
});
