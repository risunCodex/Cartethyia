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
import { clearCachedVisionDescriptions } from "../../src/transport/vision-handoff-cache";
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
    clearCachedVisionDescriptions();
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
    await gateway.setRoutes([
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
    // streams internally and carries no history.
    expect(visionAdapter.dispatches).toHaveLength(1);
    const visionCall = visionAdapter.dispatches[0]!;
    expect(visionCall.request.stream).toBe(true);
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

  test("older image-carrying history turns are dropped from the image set, but trailing context is carried", async () => {
    await writeVisionHandoffModels(world.tenantId, [`${vision.providerId}/${vision.modelId}`]);
    const visionBefore = gateway.adapters.get(vision.providerId)!.dispatches.length;
    const response = await gateway.json(
      "/v1/chat/completions",
      {
        model: world.qualifiedModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "earlier turn with an image" },
              { type: "image_url", image_url: "https://example.com/old.png" },
            ],
          },
          { role: "assistant", content: "ok" },
          {
            role: "user",
            content: [
              { type: "text", text: "and now this one" },
              { type: "image_url", image_url: "https://example.com/active.png" },
            ],
          },
        ],
        stream: false,
      },
      { token: world.token },
    );
    expect(response.status).toBe(200);

    // The vision sub-request carries the ACTIVE image turn plus the trailing
    // conversation context (so the vision model knows what the chat is about),
    // but the OLD image itself must not be re-sent.
    const visionAdapter = gateway.adapters.get(vision.providerId)!;
    expect(visionAdapter.dispatches.length).toBe(visionBefore + 1);
    const visionCall = visionAdapter.dispatches[visionAdapter.dispatches.length - 1]!;
    expect(visionCall.request.messages.length).toBeGreaterThan(0);
    const visionContent = visionCall.request.messages[visionCall.request.messages.length - 1]!.content;
    expect(visionContent.some((part) => part.kind === "image" && String((part as { payload: unknown }).payload).includes("active.png"))).toBe(true);
    expect(visionContent.some((part) => part.kind === "image" && String((part as { payload: unknown }).payload).includes("old.png"))).toBe(false);

    // The main request: active turn carries the description; the older turn's
    // image is dropped (not described, not left as an image).
    const mainAdapter = gateway.adapters.get(world.providerId)!;
    const mainCall = mainAdapter.dispatches[mainAdapter.dispatches.length - 1]!;
    const olderTurn = mainCall.request.messages[0]!;
    expect(olderTurn.content.some((part) => part.kind === "image")).toBe(false);
    // Option E: the older image is not silently deleted — a marker tells the
    // main model something was there.
    expect(olderTurn.content.some((part) => part.kind === "text" && part.text === "[image omitted]")).toBe(true);
    expect(olderTurn.content.some((part) => part.kind === "text" && part.text === "[image]")).toBe(false);
    const activeTurn = mainCall.request.messages[2]!;
    expect(activeTurn.content.some((part) => part.kind === "image")).toBe(false);
    expect(
      activeTurn.content.some(
        (part) => part.kind === "text" && part.text.includes("Hello from Cartethyia"),
      ),
    ).toBe(true);
    // The description is explicitly framed as the vision model's description of
    // the attached image, so the main model does not treat it as user prose.
    expect(
      activeTurn.content.some(
        (part) =>
          part.kind === "text" &&
          part.text.includes("A vision model described it for you") &&
          part.text.includes("Hello from Cartethyia"),
      ),
    ).toBe(true);
  });

  test("a repeated image set is served from the cache (no second vision call)", async () => {
    await writeVisionHandoffModels(world.tenantId, [`${vision.providerId}/${vision.modelId}`]);
    // First request warms the cache.
    const first = await gateway.json(
      "/v1/chat/completions",
      chatWithImage(world.qualifiedModel),
      { token: world.token },
    );
    expect(first.status).toBe(200);
    const visionAfterFirst = gateway.adapters.get(vision.providerId)!.dispatches.length;

    // Second identical request must not call the vision model again.
    const second = await gateway.json(
      "/v1/chat/completions",
      chatWithImage(world.qualifiedModel),
      { token: world.token },
    );
    expect(second.status).toBe(200);
    expect(gateway.adapters.get(vision.providerId)!.dispatches.length).toBe(visionAfterFirst);

    // The main model still receives the same description text.
    const mainAdapter = gateway.adapters.get(world.providerId)!;
    const mainCall = mainAdapter.dispatches[mainAdapter.dispatches.length - 1]!;
    const allParts = mainCall.request.messages.flatMap((m) => m.content);
    expect(allParts.some((part) => part.kind === "image")).toBe(false);
    expect(
      allParts.some(
        (part) => part.kind === "text" && part.text.includes("Hello from Cartethyia"),
      ),
    ).toBe(true);
  });
});
