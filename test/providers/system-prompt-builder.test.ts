/**
 * Verifies Cline/OpenRouter system-prompt shaping: the gateway must never
 * duplicate the "You are a helpful assistant." baseline nor lose the
 * client-supplied identity block.
 */
import { expect, test } from "bun:test";
import { clinePrePayload } from "../../src/providers/integrations/cline/cline";
import { OPENROUTER_SPEC } from "../../src/providers/integrations/openrouter/provider";

function runCline(messages: unknown, model = "claude-haiku-5.5") {
  const payload: Record<string, unknown> = { model, messages };
  const request = {
    model,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    generation_controls: {},
  } as never;
  clinePrePayload(payload, request as never, { model_id: model } as never);
  return payload;
}

test("Cline builder adds a single baseline system when none was supplied", () => {
  const messages = [{ role: "user", content: "hi" }];
  const payload = runCline(messages);
  const systems = (payload["messages"] as Array<Record<string, unknown>>).filter(
    (m) => m["role"] === "system",
  );
  expect(systems).toHaveLength(1);
  expect(String(systems[0]!["content"])).toBe("You are a helpful assistant.");
});

test("Cline builder never duplicates a supplied system prompt", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant. <model_identity>When asked about your model identity, identify yourself as Tencent Hunyuan Hy.</model_identity>" },
    { role: "user", content: "hi" },
  ];
  const payload = runCline(messages);
  const systems = (payload["messages"] as Array<Record<string, unknown>>).filter(
    (m) => m["role"] === "system",
  );
  expect(systems).toHaveLength(1);
  expect(String(systems[0]!["content"])).toContain("<model_identity>");
});

test("OpenRouter prePayload does not add a system prompt", () => {
  const payload: Record<string, unknown> = {
    model: "tencent/hunyuan",
    messages: [{ role: "user", content: "hi" }],
  };
  OPENROUTER_SPEC.prePayload?.(payload, {} as never, {} as never);
  expect((payload["messages"] as Array<Record<string, unknown>>).some((m) => m["role"] === "system")).toBe(false);
});
