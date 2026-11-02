/**
 * Regression: vision handoff must trigger when the selected model cannot carry
 * images, across request shapes Model Lab actually sends (streaming, tools).
 * Mirrors the reported case: `cb/glm-5.3-flash` (text-only) + image, with a
 * configured vision handoff model.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { getDb } from "../../src/persistence/boot";
import { consoleSettings } from "../../src/persistence/schema";
import { bumpSettingsRevision } from "../../src/persistence/settings-revision";
import { clearCachedVisionDescriptions } from "../../src/transport/vision-handoff-cache";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe, requireDatabase } from "../helpers/database";

requireDatabase();

function chatWithImage(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          { type: "image_url", image_url: "https://example.com/a.png" },
        ],
      },
    ],
    stream: false,
    ...extra,
  };
}

async function writeVisionHandoffModels(tenantId: string, models: readonly string[]): Promise<void> {
  await getDb()
    .insert(consoleSettings)
    .values({ tenantId, preferences: { visionHandoffModels: models }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: consoleSettings.tenantId,
      set: { preferences: { visionHandoffModels: models }, updatedAt: new Date() },
    });
  bumpSettingsRevision();
}

dbDescribe("vision handoff regression", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;
  let vision: { providerId: string; modelId: string; accountId: string };

  beforeAll(async () => {
    clearCachedVisionDescriptions();
    world = await createWorld();
    gateway = await createTestGateway();
    vision = await world.addProvider({
      modelId: "gemini-3-flash-solo",
      modelOptions: { wireFamily: "chat", endpointPath: "/v1/chat/completions" },
    });
    gateway.setRoutes([
      // The selected model is text-only: no image capability.
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
        capabilities: { text: true, tools: true },
      },
      // The vision handoff model advertises the full permissive profile.
      {
        providerId: vision.providerId,
        modelId: vision.modelId,
        accountId: vision.accountId,
      },
    ]);
    gateway.adapter(world.providerId);
    gateway.adapter(vision.providerId);
    await writeVisionHandoffModels(world.tenantId, [`${vision.providerId}/${vision.modelId}`]);
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  test("streaming request with image still handoffs (stream: true)", async () => {
    const visionBefore = gateway.adapters.get(vision.providerId)!.dispatches.length;
    const response = await gateway.json("/v1/chat/completions", chatWithImage(world.qualifiedModel, { stream: true }), {
      token: world.token,
    });
    expect(response.status).toBe(200);
    expect(gateway.adapters.get(vision.providerId)!.dispatches.length).toBe(visionBefore + 1);
    const main = gateway.adapters.get(world.providerId)!.dispatches.at(-1)!;
    const parts = main.request.messages.flatMap((m) => m.content);
    expect(parts.some((p) => p.kind === "image")).toBe(false);
    expect(parts.some((p) => p.kind === "text" && p.text === "[image]")).toBe(false);
  });

  test("request with tools and image still handoffs", async () => {
    const visionBefore = gateway.adapters.get(vision.providerId)!.dispatches.length;
    const response = await gateway.json(
      "/v1/chat/completions",
      {
        // A different image than the streaming test above: the handoff cache
        // is keyed by the active image set, so exercising the tool path with
        // the same image would (correctly) be served from the cache instead of
        // dispatching a fresh vision call.
        model: world.qualifiedModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this image?" },
              { type: "image_url", image_url: "https://example.com/tools.png" },
            ],
          },
        ],
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }],
        stream: false,
      },
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(gateway.adapters.get(vision.providerId)!.dispatches.length).toBe(visionBefore + 1);
    const main = gateway.adapters.get(world.providerId)!.dispatches.at(-1)!;
    const parts = main.request.messages.flatMap((m) => m.content);
    expect(parts.some((p) => p.kind === "image")).toBe(false);
    expect(parts.some((p) => p.kind === "text" && p.text === "[image]")).toBe(false);
  });
});
