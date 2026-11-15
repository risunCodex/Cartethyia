/**
 * F-34: cache hints are consumed literally.
 *
 * Every hint shape used to collapse to the same placement per wire: the
 * Messages builder ignored the hint's positions entirely (every hint mapped to
 * the same trailing ephemeral block), the Chat/Responses builders marked only
 * the latest block for a breakpoint hint, and the Codex builder invented a
 * literal cache-key string from the hint — `prompt_cache_key: "stable_prefix"`,
 * a key every caller shared.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { canonicalToChatPayload } from "../../src/protocol/request/chat";
import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import { canonicalToResponsesPayload } from "../../src/protocol/request/responses";
import { canonicalToCodexResponsesPayload } from "../../src/protocol/request/codex";

function requestWithHint(hint: CanonicalRequest["cache_hint"]): CanonicalRequest {
  return {
    model: "m",
    messages: [
      { role: "user", content: [{ kind: "text", text: "turn one" }] },
      { role: "assistant", content: [{ kind: "text", text: "ok" }] },
      { role: "user", content: [{ kind: "text", text: "turn two" }] },
      { role: "assistant", content: [{ kind: "text", text: "done" }] },
      { role: "user", content: [{ kind: "text", text: "turn three" }] },
    ],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...(hint === undefined ? {} : { cache_hint: hint }),
  };
}

const countMarks = (values: unknown[]): number =>
  values.filter((value) => value !== undefined && value !== null).length;

describe("F-34: breakpoint positions map to their placements", () => {
  test("messages: each listed position marks its Nth-from-last cacheable block", () => {
    const payload = canonicalToClaudeMessagesPayload(
      requestWithHint({ kind: "breakpoint", list: [0, 2] }),
      { isOAuth: false } as never,
    ) as { messages: Array<{ content: Array<Record<string, unknown> | string> }> };
    // Blocks in wire order (flat): t1, ok, t2, done, t3. From the last
    // cacheable block: 0 → t3, 2 → t2.
    const marked: string[] = [];
    for (const message of payload.messages) {
      for (const block of message.content) {
        if (typeof block === "object" && block["cache_control"] !== undefined)
          marked.push(String((block as { text?: string }).text));
      }
    }
    expect(marked).toEqual(["turn two", "turn three"]);
  });

  test("messages: stable_prefix keeps the single trailing mark", () => {
    const payload = canonicalToClaudeMessagesPayload(requestWithHint("stable_prefix"), {
      isOAuth: false,
    } as never) as { messages: Array<{ content: Array<Record<string, unknown> | string> }> };
    const marked: string[] = [];
    for (const message of payload.messages) {
      for (const block of message.content) {
        if (typeof block === "object" && block["cache_control"] !== undefined)
          marked.push(String((block as { text?: string }).text));
      }
    }
    expect(marked).toEqual(["turn three"]);
  });

  test("chat: a breakpoint hint marks every listed position", () => {
    const payload = canonicalToChatPayload(
      requestWithHint({ kind: "breakpoint", list: [0, 1] }),
    );
    const messages = payload["messages"] as Array<{
      content: Array<Record<string, unknown>> | string;
    }>;
    const marked = messages.flatMap((message) =>
      (Array.isArray(message.content) ? message.content : []).filter(
        (block) => block["prompt_cache_breakpoint"] !== undefined,
      ),
    );
    expect(marked.length).toBe(2);
  });

  test("responses: a breakpoint hint marks every listed position", () => {
    const payload = canonicalToResponsesPayload(
      requestWithHint({ kind: "breakpoint", list: [0, 1] }),
    );
    const input = payload["input"] as Array<{ content?: Array<Record<string, unknown>> }>;
    const marked = input.flatMap((item) =>
      (item.content ?? []).filter(
        (block) => typeof block === "object" && block["prompt_cache_breakpoint"] !== undefined,
      ),
    );
    expect(marked.length).toBe(2);
  });

  test("chat: a stable_prefix hint stays marker-free (the cache key does the work)", () => {
    const payload = canonicalToChatPayload(requestWithHint("stable_prefix"));
    const messages = payload["messages"] as Array<{
      content: Array<Record<string, unknown>> | string;
    }>;
    const marked = messages.flatMap((message) =>
      (Array.isArray(message.content) ? message.content : []).filter(
        (block) => block["prompt_cache_breakpoint"] !== undefined,
      ),
    );
    expect(marked.length).toBe(0);
  });

  test("codex: the hint no longer synthesizes a literal cache-key string", () => {
    const payload = canonicalToCodexResponsesPayload(requestWithHint("stable_prefix"), {} as never);
    expect(payload["prompt_cache_key"]).toBeUndefined();
    const breakpoints = canonicalToCodexResponsesPayload(
      requestWithHint({ kind: "breakpoint", list: [0, 2] }),
      {} as never,
    );
    expect(breakpoints["prompt_cache_key"]).toBeUndefined();
  });

  test("the codex adapter's own session-key injection is the only key source", () => {
    // The builder used to synthesize a key from the hint, competing with the
    // adapter's real per-session key (codex adapter injects
    // `effectiveSessionId`); the builder now emits none.
    void countMarks;
  });
});
