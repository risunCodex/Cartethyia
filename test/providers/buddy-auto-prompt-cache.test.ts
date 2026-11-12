/**
 * Auto prompt-cache injection on the buddy family: the system turn and the
 * last user turn get an ephemeral `cache_control` when their text is long and
 * the caller declared no cache marker of its own.
 */
import { expect, test } from "bun:test";
import {
  applyBuddyAutoPromptCache,
  applyBuddySystemPrompt,
} from "../../src/providers/integrations/buddy/chat";

const LONG_TEXT = "x".repeat(2048);

function contentOf(message: Record<string, unknown>): unknown {
  return message["content"];
}

test("marks the system and last user turns when long and no explicit cache exists", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: LONG_TEXT },
    { role: "user", content: [{ type: "text", text: "short" }] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "text", text: LONG_TEXT }] },
  ];
  applyBuddyAutoPromptCache(messages);
  const system = contentOf(messages[0]!) as Array<Record<string, unknown>>;
  expect(system[0]!["cache_control"]).toEqual({ type: "ephemeral" });
  const lastUser = contentOf(messages[3]!) as Array<Record<string, unknown>>;
  expect(lastUser[0]!["cache_control"]).toEqual({ type: "ephemeral" });
  const midUser = contentOf(messages[1]!) as Array<Record<string, unknown>>;
  expect(midUser[0]!["cache_control"]).toBeUndefined();
});

test("short text is never marked", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "hi" },
    { role: "user", content: "short user" },
  ];
  applyBuddyAutoPromptCache(messages);
  expect(contentOf(messages[0]!)).toBe("hi");
  expect(contentOf(messages[1]!)).toBe("short user");
});

test("explicit cache_control anywhere disables auto-injection", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: LONG_TEXT },
    {
      role: "user",
      content: [
        { type: "text", text: LONG_TEXT, cache_control: { type: "ephemeral" } },
      ],
    },
  ];
  applyBuddyAutoPromptCache(messages);
  const system = contentOf(messages[0]!);
  expect(system).toBe(LONG_TEXT);
});

test("applyBuddySystemPrompt runs the auto-cache pass end to end", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: LONG_TEXT },
  ];
  applyBuddySystemPrompt(messages, LONG_TEXT);
  expect(messages[0]!["role"]).toBe("system");
  const system = contentOf(messages[0]!) as Array<Record<string, unknown>>;
  expect(system[0]!["cache_control"]).toEqual({ type: "ephemeral" });
  const user = contentOf(messages[1]!) as Array<Record<string, unknown>>;
  expect(user[0]!["cache_control"]).toEqual({ type: "ephemeral" });
});
