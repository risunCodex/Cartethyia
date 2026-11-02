/**
 * Vision handoff end-to-end: when a request carries an image but the selected
 * model is not image-capable and the tenant configured `visionHandoffModels`,
 * the gateway describes the image with the vision model and injects the
 * description as text into the original request. The original model still
 * answers; only the image travels.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { getDb } from "../../src/persistence/boot";
import { consoleSettings } from "../../src/persistence/schema";
import { bumpSettingsRevision } from "../../src/persistence/settings-revision";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe, requireDatabase } from "../helpers/database";

requireDatabase();

/**
 * A chat request carrying one image alongside text. The image is a URL
 * reference (not inline bytes), so attachment integrity leaves it untouched.
 */
function chatWithImage(model: string): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          {
            type: "image_url",
            image_url: "https://example.com/a.png",
          },
        ],
      },
    ],
    stream: false,
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
  // The dispatch path reads preferences through the revision-keyed cache; a
  // raw write like this must bump the revision to be observed (the store's
  // own update() does this, but the fixture bypasses the store).
  bumpSettingsRevision();
}

dbDescribe("vision handoff", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;
  let textOnly: { providerId: string; modelId: string; accountId: string };
  let vision: { providerId: string; modelId: string; accountId: string };

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    textOnly = {
      providerId: world.providerId,
      modelId: world.modelId,
      accountId: world.accountId,
    };
    vision = await world.addProvider({
      modelId: "vision-model",
      modelOptions: { wireFamily: "chat", endpointPath: "/v1/chat/completions" },
    });
    gateway.setRoutes([
      // The main model is text-only: no image capability.
      {
        providerId: textOnly.providerId,
        modelId: textOnly.modelId,
        accountId: textOnly.accountId,
        capabilities: { text: true, tools: true },
      },
      // The vision model advertises the full permissive profile (image incl.).
      {
        providerId: vision.providerId,
        modelId: vision.modelId,
        accountId: vision.accountId,
      },
    ]);
    gateway.adapter(textOnly.providerId);
    gateway.adapter(vision.providerId);
    await writeVisionHandoffModels(world.tenantId, [`${vision.providerId}/${vision.modelId}`]);
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  test("a text-only model receives the image description as text, not a placeholder", async () => {
    const response = await gateway.json(
      "/v1/chat/completions",
      chatWithImage(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);

    const visionAdapter = gateway.adapters.get(vision.providerId)!;
    const mainAdapter = gateway.adapters.get(textOnly.providerId)!;

    // The vision model was called exactly once with the image; the sub-request
    // is non-streaming and carries no history.
    expect(visionAdapter.dispatches).toHaveLength(1);
    const visionCall = visionAdapter.dispatches[0]!;
    expect(visionCall.request.stream).toBe(false);
    const userTurn = visionCall.request.messages.find((m) => m.role === "user");
    expect(userTurn?.content.some((part) => part.kind === "image")).toBe(true);
    // No history and no tools in the sub-request.
    expect(visionCall.request.messages).toHaveLength(1);
    expect(visionCall.request.tools).toBeUndefined();

    // The main model received the description text in place of the image.
    expect(mainAdapter.dispatches).toHaveLength(1);
    const mainCall = mainAdapter.dispatches[0]!;
    const allParts = mainCall.request.messages.flatMap((m) => m.content);
    expect(allParts.some((part) => part.kind === "image")).toBe(false);
    expect(
      allParts.some(
        (part) => part.kind === "text" && part.text.includes("Hello from Cartethyia"),
      ),
    ).toBe(true);
    expect(allParts.some((part) => part.kind === "text" && part.text === "[image]")).toBe(false);
  });

  test("an empty vision model list keeps the legacy [image] placeholder path", async () => {
    const visionCallsBefore = gateway.adapters.get(vision.providerId)!.dispatches.length;
    const mainCallsBefore = gateway.adapters.get(textOnly.providerId)!.dispatches.length;
    await writeVisionHandoffModels(world.tenantId, []);
    const response = await gateway.json(
      "/v1/chat/completions",
      chatWithImage(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);

    const visionAdapter = gateway.adapters.get(vision.providerId)!;
    expect(visionAdapter.dispatches.length).toBe(visionCallsBefore); // no handoff call

    const mainAdapter = gateway.adapters.get(textOnly.providerId)!;
    expect(mainAdapter.dispatches.length).toBe(mainCallsBefore + 1);
    const mainCall = mainAdapter.dispatches[mainAdapter.dispatches.length - 1]!;
    const allParts = mainCall.request.messages.flatMap((m) => m.content);
    expect(allParts.some((part) => part.kind === "text" && part.text === "[image]")).toBe(true);
  });

  test("a vision-capable model keeps the real image (no handoff)", async () => {
    await writeVisionHandoffModels(world.tenantId, [`${vision.providerId}/${vision.modelId}`]);
    const visionCallsBefore = gateway.adapters.get(vision.providerId)!.dispatches.length;
    const response = await gateway.json(
      "/v1/chat/completions",
      chatWithImage(`${vision.providerId}/${vision.modelId}`),
      { token: world.token },
    );
    expect(response.status).toBe(200);

    const visionAdapter = gateway.adapters.get(vision.providerId)!;
    expect(visionAdapter.dispatches.length).toBe(visionCallsBefore + 1);
    const directCall = visionAdapter.dispatches[visionAdapter.dispatches.length - 1]!;
    const allParts = directCall.request.messages.flatMap((m) => m.content);
    expect(allParts.some((part) => part.kind === "image")).toBe(true);
  });
});
