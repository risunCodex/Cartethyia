import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatBubble } from "../../src/features/studio/ChatBubble";
import { buildLabRequest, parseUserQuestion, reasoningDelta, takeSseEvents, textDelta, type LabRequestSettings } from "../../src/features/studio/protocol";
import { detectMediaIntent, parseImageGenerationResponse, parseVideoGenerationResponse, preferredImageWorker, shouldFallbackToMediaWorker } from "../../src/features/studio/media";
import { migrateLabSessionRecord } from "../../src/features/studio/session";
import { createSvgPreviewDocument } from "../../src/features/studio/svgPreview";
import { readLabStream } from "../../src/features/studio/stream";

const settings = (patch: Partial<LabRequestSettings> = {}): LabRequestSettings => ({
  protocol: "chat",
  persona: "cartethyia",
  model: "openai/gpt-4.1",
  maxOutputTokens: 131_072,
  systemPrompt: "",
  temperature: "",
  topP: "",
  effort: "auto",
  ...patch,
});

function systemText(body: Record<string, unknown>): string | undefined {
  if (typeof body.system === "string") return body.system;
  const turns = body.input ?? body.messages;
  if (!Array.isArray(turns)) return undefined;
  const systemTurn = turns.find((turn) =>
    turn !== null && typeof turn === "object" && (turn as Record<string, unknown>).role === "system",
  );
  if (systemTurn === null || typeof systemTurn !== "object") return undefined;
  const content = (systemTurn as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

describe("buildLabRequest", () => {
  test("chat puts the system prompt ahead of the turns and omits empty sampling", () => {
    const built = buildLabRequest(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "" },
      ],
      settings({ persona: "unset", systemPrompt: "be brief", temperature: "0.4" }),
    );
    expect(built.path).toBe("/v1/chat/completions");
    expect(built.body.model).toBe("openai/gpt-4.1");
    expect(built.body.stream).toBe(true);
    expect(built.body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    expect(built.body.temperature).toBe(0.4);
    expect(built.body.tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "ask_user_question" }) }),
    ]);
  });

  test("responses uses input and messages uses a top-level system field", () => {
    const turns = [{ role: "user" as const, text: "draw a cat" }];
    const responses = buildLabRequest(turns, settings({ protocol: "responses", persona: "unset", topP: "0.9", effort: "high" }));
    expect(responses.path).toBe("/v1/responses");
    expect(responses.body.input).toEqual([{ role: "user", content: "draw a cat" }]);
    expect(responses.body.top_p).toBe(0.9);
    expect(responses.body.reasoning).toEqual({ effort: "high" });

    const messages = buildLabRequest(turns, settings({ protocol: "messages", persona: "unset", systemPrompt: "stay on topic" }));
    expect(messages.path).toBe("/v1/messages");
    expect(messages.body.system).toBe("stay on topic");
    // The model catalog output ceiling replaces the fixed 4096 default.
    expect(messages.body.max_tokens).toBe(131_072);
    expect(messages.body.messages).toEqual([{ role: "user", content: "draw a cat" }]);
  });

  test("chat and responses carry the catalog output ceiling", () => {
    const turns = [{ role: "user" as const, text: "draw a cat" }];
    const chat = buildLabRequest(turns, settings({ protocol: "chat" }));
    expect(chat.path).toBe("/v1/chat/completions");
    expect(chat.body.max_tokens).toBe(131_072);

    const responses = buildLabRequest(turns, settings({ protocol: "responses", effort: "high" }));
    expect(responses.path).toBe("/v1/responses");
    expect(responses.body.max_output_tokens).toBe(131_072);

    const noLimit = buildLabRequest(turns, settings({ maxOutputTokens: undefined }));
    expect(noLimit.body.max_tokens).toBeUndefined();
    expect(noLimit.body.max_output_tokens).toBeUndefined();
  });

  test("the default persona stays stable across turns and combines the user's prompt across all wires", () => {
    for (const protocol of ["chat", "responses", "messages"] as const) {
      const turns = [{ role: "user" as const, text: "hello" }];
      const labSettings = settings({ protocol, systemPrompt: "Keep answers concise." });
      const built = buildLabRequest(turns, labSettings);
      const repeated = buildLabRequest(turns, labSettings);
      const system = systemText(built.body);
      expect(system).toContain("Cartethyia Model Lab");
      expect(system).not.toContain("Local date and time:");
      expect(systemText(repeated.body)).toBe(system);
      expect(system).toContain("Selected model: openai/gpt-4.1");
      expect(system).toContain(`Selected protocol: ${protocol}`);
      expect(system).toContain("## User system prompt\nKeep answers concise.");
      expect(system).toContain("ask_user_question tools");
      expect(system).toContain("Image understanding depends on whether the selected model supports it");
      expect(system).toContain("Your knowledge may not be current");
      if (protocol === "messages") {
        expect(typeof built.body.system).toBe("string");
      } else {
        const field = protocol === "responses" ? built.body.input : built.body.messages;
        expect(Array.isArray(field)).toBe(true);
        expect((field as readonly Record<string, unknown>[])[0]?.role).toBe("system");
      }
    }
  });

  test("unset suppresses only the built-in persona and preserves the explicit system prompt", () => {
    for (const protocol of ["chat", "responses", "messages"] as const) {
      const built = buildLabRequest(
        [{ role: "user", text: "hello" }],
        settings({ protocol, persona: "unset", systemPrompt: "Only use bullet points." }),
      );
      expect(systemText(built.body)).toBe("Only use bullet points.");
      if (protocol === "messages") {
        expect(built.body.system).toBe("Only use bullet points.");
      } else {
        const field = protocol === "responses" ? built.body.input : built.body.messages;
        expect((field as readonly Record<string, unknown>[])[0]?.role).toBe("system");
      }
    }
  });

  test("a blank sampling field is not sent as zero", () => {
    const built = buildLabRequest([{ role: "user", text: "hi" }], settings({ temperature: "  ", topP: "nope" }));
    expect(built.body.temperature).toBeUndefined();
    expect(built.body.top_p).toBeUndefined();
  });

  test("chat always exposes the selectable user-question tool", () => {
    const turns = [{ role: "user" as const, text: "hi" }];
    const chat = buildLabRequest(turns, settings());
    expect(chat.body.tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "ask_user_question" }) }),
    ]);
    for (const protocol of ["responses", "messages"] as const) {
      const built = buildLabRequest(turns, settings({ protocol }));
      expect(built.body.tools).toBeUndefined();
    }
  });

  test("agentic chat declares only configured search and image models and sends tool results", () => {
    const built = buildLabRequest(
      [
        { role: "user", text: "Find recent news and make an illustration." },
        {
          role: "assistant",
          text: "",
          reasoning: "I should search for current information first.",
          toolCalls: [{ id: "call-search", name: "web_search", arguments: "{\"query\":\"recent news\"}" }],
        },
        { role: "tool", text: "{\"results\":[]}", toolCallId: "call-search" },
      ],
      settings({
        webSearchModels: ["gemini/gemini-3-flash-preview"],
        imageGenerationModels: ["gemini/gemini-3-pro-image-preview"],
        imageSize: "1024x1024",
        imageCount: 2,
      }),
    );
    expect(built.body.tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "web_search" }) }),
      expect.objectContaining({
        function: expect.objectContaining({
          name: "generate_image",
          description: expect.stringContaining("1024x1024, 2 images"),
        }),
      }),
      expect.objectContaining({ function: expect.objectContaining({ name: "ask_user_question" }) }),
    ]);
    expect(built.body.messages).toEqual([
      { role: "system", content: expect.stringContaining("configured web_search") },
      { role: "user", content: "Find recent news and make an illustration." },
      {
        role: "assistant",
        content: null,
        reasoning_content: "I should search for current information first.",
        tool_calls: [{
          id: "call-search",
          type: "function",
          function: { name: "web_search", arguments: "{\"query\":\"recent news\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call-search", content: "{\"results\":[]}" },
    ]);
  });

  test("an explicit media request forces only its independently selected worker", () => {
    const videoModel = "workbuddy/seedance-2.5";
    const imageModel = "gemini/gemini-3-pro-image-preview";
    const imageBuilt = buildLabRequest(
      [{ role: "user", text: "Generate an image of a red kite." }],
      settings({
        imageGenerationModels: [imageModel],
        forcedTool: "generate_image",
      }),
    );
    const built = buildLabRequest(
      [{ role: "user", text: "Make a video of a paper boat sailing." }],
      settings({
        videoGenerationModels: [videoModel],
        forcedTool: "generate_video",
      }),
    );
    expect(imageBuilt.body.tool_choice).toEqual({ type: "function", function: { name: "generate_image" } });
    expect(imageBuilt.body.model).toBe("openai/gpt-4.1");
    expect(built.body.tool_choice).toEqual({ type: "function", function: { name: "generate_video" } });
    expect(built.body.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({
          name: "generate_video",
          parameters: expect.objectContaining({
            properties: expect.objectContaining({ model: { type: "string", enum: [videoModel], description: "Available video-generation model." } }),
          }),
        }),
      }),
      expect.objectContaining({ function: expect.objectContaining({ name: "ask_user_question" }) }),
    ]);
    expect(built.body.model).toBe("openai/gpt-4.1");
    expect(built.body.model).not.toBe(videoModel);
  });

  test("a planner question is validated as structured selectable options", () => {
    expect(parseUserQuestion({
      question: "Which style should I use?",
      options: [
        { id: "minimal", label: "Minimal", description: "Clean lines and few colors." },
        { id: "bold", label: "Bold" },
      ],
    })).toEqual({
      question: "Which style should I use?",
      options: [
        { id: "minimal", label: "Minimal", description: "Clean lines and few colors." },
        { id: "bold", label: "Bold" },
      ],
    });
    expect(() => parseUserQuestion({
      question: "Choose",
      options: [{ id: "same", label: "One" }, { id: "same", label: "Two" }],
    })).toThrow("invalid selectable option");
  });

  test("tool result turns resume the matching planner call in order", () => {
    const built = buildLabRequest(
      [
        { role: "user", text: "Make a cover." },
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "question-1", name: "ask_user_question", arguments: "{\"question\":\"Style?\"}" }],
        },
        { role: "tool", text: "{\"selected\":{\"id\":\"minimal\",\"label\":\"Minimal\"}}", toolCallId: "question-1" },
      ],
      settings(),
    );
    expect(built.body.messages).toEqual([
      { role: "system", content: expect.any(String) },
      { role: "user", content: "Make a cover." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "question-1",
          type: "function",
          function: { name: "ask_user_question", arguments: "{\"question\":\"Style?\"}" },
        }],
      },
      { role: "tool", tool_call_id: "question-1", content: "{\"selected\":{\"id\":\"minimal\",\"label\":\"Minimal\"}}" },
    ]);
  });

  test("media placeholders keep an accessible aspect-ratio frame while workers run", () => {
    const image = renderToStaticMarkup(createElement(ChatBubble, {
      message: { id: "image-pending", role: "assistant", text: "", mediaPending: "image" },
    }));
    const video = renderToStaticMarkup(createElement(ChatBubble, {
      message: { id: "video-pending", role: "assistant", text: "", mediaPending: "video" },
    }));
    expect(image).toContain('role="status"');
    expect(image).toContain('aria-label="Generating image"');
    expect(image).toContain("aspect-square");
    expect(image).toContain("motion-reduce:animate-none");
    expect(video).toContain("aspect-video");
  });

  test("a forced image tool is visible while the planner prepares its call", () => {
    const markup = renderToStaticMarkup(createElement(ChatBubble, {
      message: {
        id: "image-planning",
        role: "assistant",
        text: "",
        pending: true,
        status: "Calling generate_image…",
        mediaPending: "image",
        mediaStage: "planning",
        tools: ["generate_image"],
      },
    }));
    expect(markup).toContain('aria-label="Calling generate_image"');
    expect(markup).toContain("Calling generate_image…");
    expect(markup).toContain("generate_image");
    expect(markup).not.toContain("Thinking…");
  });

  test("an approved media tool shows its generating placeholder without approval actions", () => {
    const markup = renderToStaticMarkup(createElement(ChatBubble, {
      message: {
        id: "image-generating",
        role: "assistant",
        text: "",
        status: "Generating image…",
        mediaPending: "image",
        mediaStage: "generating",
      },
      onToolApproval: () => {},
    }));
    expect(markup).toContain('aria-label="Generating image"');
    expect(markup).toContain("Generating image…");
    expect(markup).not.toContain("Allow these actions?");
    expect(markup).not.toContain("Allow and run");
  });

  test("approved non-media tools show a running status without the approval prompt", () => {
    const markup = renderToStaticMarkup(createElement(ChatBubble, {
      message: {
        id: "search-running",
        role: "assistant",
        text: "",
        status: "Running approved tools…",
      },
    }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Running approved tools…");
    expect(markup).not.toContain("Allow these actions?");
  });

  test("answered planner questions start collapsed but keep an accessible disclosure control", () => {
    const markup = renderToStaticMarkup(createElement(ChatBubble, {
      message: {
        id: "answered-question",
        role: "assistant",
        text: "",
        question: {
          question: "Which style should I use?",
          options: [
            { id: "minimal", label: "Minimal" },
            { id: "bold", label: "Bold" },
          ],
        },
        selectedOption: "minimal",
      },
    }));
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Which style should I use?");
    expect(markup).toContain("Answer: Minimal");
    expect(markup).not.toContain(">Bold</span>");
  });

  test("GFM tables render with readable cells inside a horizontal scroll region", () => {
    const markup = renderToStaticMarkup(createElement(ChatBubble, {
      message: {
        id: "markdown-table",
        role: "assistant",
        text: "| Model | Status |\n| --- | --- |\n| deepseek-v4.1-flash | Ready |",
      },
    }));

    expect(markup).toContain("<table");
    expect(markup).toContain("<th");
    expect(markup).toContain("<td");
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("deepseek-v4.1-flash");
    expect(markup).toContain("Ready");
  });

  test("pending agentic tools render an inline approval prompt", () => {
    const markup = renderToStaticMarkup(createElement(ChatBubble, {
      message: {
        id: "tool-approval",
        role: "assistant",
        text: "",
        pendingToolCalls: [{
          id: "search-1",
          name: "web_search",
          arguments: "{\"query\":\"latest weather\"}",
        }],
      },
      onToolApproval: () => {},
    }));
    expect(markup).toContain("Allow these actions?");
    expect(markup).toContain("web search");
    expect(markup).toContain("latest weather");
    expect(markup).toContain("Allow and run");
    expect(markup).toContain("Deny");
  });

  test("an attached image is a wire image part, and a blank turn is kept", () => {
    const image = { name: "cat.png", dataUrl: "data:image/png;base64,Y2F0" };
    const chat = buildLabRequest([{ role: "user", text: "", images: [image] }], settings({ persona: "unset" }));
    expect(chat.body.messages).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: { url: image.dataUrl } }] },
    ]);
    const messages = buildLabRequest(
      [{ role: "user", text: "look", images: [image] }],
      settings({ protocol: "messages", persona: "unset" }),
    );
    expect(messages.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "url", url: image.dataUrl } },
        ],
      },
    ]);
  });

  describe("media workers", () => {
    test("detects explicit image and video generation requests without matching ordinary questions", () => {
      expect(detectMediaIntent("Generate an image of a small red kite.")).toBe("image");
      expect(detectMediaIntent("Buatkan video kapal kertas di laut.")).toBe("video");
      expect(detectMediaIntent("What is an image model good at?")).toBeUndefined();
    });

    test("does not mistake discussions that merely mention media for a request", () => {
      // Regression: long prompts that explain or ask about image/video
      // generation must not trigger the media pipeline — the planner answers
      // them instead, and "model asked for" decides tool use.
      expect(detectMediaIntent("Explain how to create a good prompt for generating images with AI")).toBeUndefined();
      expect(detectMediaIntent("How do I generate an image?")).toBeUndefined();
      expect(detectMediaIntent("Tolong jelaskan cara membuat aplikasi yang menampilkan gambar")).toBeUndefined();
      expect(detectMediaIntent("I want to make a website that shows images uploaded by users")).toBeUndefined();
      expect(detectMediaIntent("Draw conclusions from this data")).toBeUndefined();
      // Short, direct requests still work.
      expect(detectMediaIntent("Buatkan gambar logo sederhana")).toBe("image");
      expect(detectMediaIntent("gambarkan kucing")).toBe("image");
    });

    test("falls back to the native worker unless the planner called the requested media tool", () => {
      expect(shouldFallbackToMediaWorker("image", [])).toBe(true);
      expect(shouldFallbackToMediaWorker("image", [{ name: "web_search" }])).toBe(true);
      expect(shouldFallbackToMediaWorker("image", [{ name: "generate_image" }])).toBe(false);
      expect(shouldFallbackToMediaWorker(undefined, [])).toBe(false);
    });

    test("prefers Gemini image workers in product order then any configured worker", () => {
      expect(preferredImageWorker([
        "provider/other",
        "gemini/gemini-3.1-flash-image-preview",
        "gemini/gemini-3-pro-image-preview",
      ])).toBe("gemini/gemini-3-pro-image-preview");
      expect(preferredImageWorker(["provider/custom-image"])).toBe("provider/custom-image");
      expect(preferredImageWorker([])).toBeUndefined();
    });

    test("parses supported image MIME data and secure media URLs", () => {
      expect(parseImageGenerationResponse({
        data: [{ b64_json: "QUJD", mime_type: "image/webp" }, { url: "https://cdn.example/image.png" }],
      })).toEqual([
        { name: "generated-1.webp", dataUrl: "data:image/webp;base64,QUJD" },
        { name: "generated-2", dataUrl: "https://cdn.example/image.png" },
      ]);
      expect(() => parseImageGenerationResponse({ data: [{ url: "http://cdn.example/image.png" }] })).toThrow(/HTTPS/);
      expect(() => parseImageGenerationResponse({ data: [{ b64_json: "QUJD", mime_type: "image/svg+xml" }] })).toThrow(/unsupported media type/i);
      expect(() => parseImageGenerationResponse({ task_id: "task-1", status: "pending" })).toThrow(/asynchronous task/i);
      expect(() => parseImageGenerationResponse({ data: [{ status: "processing" }] })).toThrow(/asynchronous task/i);
    });

    test("parses video URLs and refuses malformed or asynchronous-only output", () => {
      expect(parseVideoGenerationResponse({ data: [{ url: "https://cdn.example/clip.mp4" }] })).toEqual([
        { name: "generated-1.mp4", src: "https://cdn.example/clip.mp4" },
      ]);
      expect(() => parseVideoGenerationResponse({ data: [{ status: "processing" }] })).toThrow(/asynchronous task/i);
      expect(() => parseVideoGenerationResponse({ task_id: "task-1", status: "queued" })).toThrow(/asynchronous task/i);
    });
  });

  describe("SVG preview", () => {
    test("builds a sandbox document with restrictive CSP and enforces the size and root limits", () => {
      const document = createSvgPreviewDocument('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
      expect(document).toContain("default-src 'none'");
      expect(document).toContain("script-src 'none'");
      expect(document).toContain("overflow:hidden");
      expect(document).toContain("max-width:100%;max-height:100%");
      expect(createSvgPreviewDocument("<html><script>alert(1)</script></html>")).toBeUndefined();
      expect(createSvgPreviewDocument(`<svg>${"x".repeat(100_001)}</svg>`)).toBeUndefined();
    });
  });

  describe("stored Model Lab sessions", () => {
    test("interrupted image generation reloads as an explicit error instead of an endless loader", () => {
      const migrated = migrateLabSessionRecord({
        id: "interrupted",
        title: "interrupted",
        updatedAt: 1,
        model: "openai/gpt-4.1",
        messages: [{
          id: "pending-image",
          role: "assistant",
          text: "",
          pending: true,
          mediaPending: "image",
          mediaStage: "generating",
          tools: ["generate_image"],
        }],
      });
      expect(migrated?.messages[0]).toMatchObject({
        text: "Generation was interrupted when the page reloaded. Retry to run it again.",
        status: "interrupted",
        error: true,
        tools: ["generate_image"],
      });
      expect(migrated?.messages[0]).not.toHaveProperty("pending");
      expect(migrated?.messages[0]).not.toHaveProperty("mediaPending");
    });
    test("an interrupted media request reloads as an explicit retryable error, not an endless loader", () => {
      const migrated = migrateLabSessionRecord({
        id: "interrupted",
        title: "interrupted",
        updatedAt: 1,
        model: "openai/gpt-4.1",
        messages: [{
          id: "pending-image",
          role: "assistant",
          text: "",
          pending: true,
          mediaPending: "image",
          mediaStage: "generating",
          tools: ["generate_image"],
        }],
      });
      expect(migrated?.messages[0]).toMatchObject({
        text: "Generation was interrupted when the page reloaded. Retry to run it again.",
        status: "interrupted",
        error: true,
        tools: ["generate_image"],
      });
      expect(migrated?.messages[0]).not.toHaveProperty("mediaPending");
    });

    test("older session records migrate with independent empty media-worker choices", () => {
      const migrated = migrateLabSessionRecord({
        id: "legacy",
        title: "legacy",
        updatedAt: 1,
        model: "openai/gpt-4.1",
        mode: "chat",
        messages: [],
      });
      expect(migrated).toMatchObject({
        id: "legacy",
        model: "openai/gpt-4.1",
        toolPermission: "ask",
        imageWorkerModel: "",
        videoWorkerModel: "",
        imageSize: "1024x1024",
        imageCount: "1",
        videoSize: "",
        videoCount: "1",
      });
      expect(migrated).not.toHaveProperty("mode");

      // Regression: an unset (empty) image worker must stay unset — it is never
      // auto-selected, matching the video worker. This is what keeps the
      // `generate_image` tool out of the planner's toolset until the operator
      // explicitly chooses a worker.
      expect(migrated?.imageWorkerModel).toBe("");
      expect(migrated?.videoWorkerModel).toBe("");

      const configured = migrateLabSessionRecord({
        id: "configured",
        title: "configured",
        updatedAt: 2,
        model: "openai/gpt-4.1",
        imageWorkerModel: "gemini/gemini-3-pro-image-preview",
        videoWorkerModel: "workbuddy/seedance-2.5",
        imageSize: "1536x1024",
        imageCount: "3",
        videoSize: "720p",
        videoCount: "2",
        toolPermission: "yolo",
        messages: [{
          id: "assistant-1",
          role: "assistant",
          text: "Generated",
          videos: [{ name: "clip.mp4", src: "https://cdn.example/clip.mp4" }],
          workerModels: ["workbuddy/seedance-2.5"],
          toolCalls: [{ id: "question-1", name: "ask_user_question", arguments: "{}" }],
          toolRounds: [{
            text: "",
            reasoning: "I should search for current information first.",
            toolCalls: [{ id: "question-1", name: "ask_user_question", arguments: "{}" }],
            toolResults: [{ toolCallId: "question-1", text: "{\"selected\":{\"id\":\"minimal\"}}" }],
          }],
          question: {
            question: "Which style?",
            options: [{ id: "minimal", label: "Minimal" }, { id: "bold", label: "Bold" }],
          },
          selectedOption: "minimal",
        }],
      });
      expect(configured).toMatchObject({
        imageWorkerModel: "gemini/gemini-3-pro-image-preview",
        videoWorkerModel: "workbuddy/seedance-2.5",
        imageSize: "1536x1024",
        imageCount: "3",
        videoSize: "720p",
        videoCount: "2",
        toolPermission: "yolo",
        messages: [{
          videos: [{ name: "clip.mp4", src: "https://cdn.example/clip.mp4" }],
          workerModels: ["workbuddy/seedance-2.5"],
          toolRounds: [{
            reasoning: "I should search for current information first.",
            toolResults: [{ toolCallId: "question-1", text: "{\"selected\":{\"id\":\"minimal\"}}" }],
          }],
          question: { question: "Which style?", options: expect.any(Array) },
          selectedOption: "minimal",
        }],
      });
      const approval = migrateLabSessionRecord({
        id: "approval",
        title: "approval",
        updatedAt: 3,
        toolPermission: "yolo",
        messages: [{
          id: "assistant-pending",
          role: "assistant",
          text: "",
          pendingToolCalls: [{ id: "search-2", name: "web_search", arguments: "{\"query\":\"latest news\"}" }],
          toolRounds: [{
            text: "",
            toolCalls: [{ id: "search-2", name: "web_search", arguments: "{\"query\":\"latest news\"}" }],
            toolResults: [],
          }],
        }],
      });
      expect(approval).toMatchObject({
        toolPermission: "yolo",
        messages: [{
          pendingToolCalls: [{ id: "search-2", name: "web_search", arguments: "{\"query\":\"latest news\"}" }],
          toolRounds: [{ toolCalls: [{ id: "search-2" }], toolResults: [] }],
        }],
      });
    });
  });
});

describe("stream text", () => {
  test("a split SSE frame waits for the blank line", () => {
    const first = takeSseEvents('data: {"choices":[{"delta":{"content":"hel"');
    expect(first.events).toEqual([]);
    expect(first.rest.startsWith("data:")).toBe(true);
    const second = takeSseEvents(`${first.rest}lo"}}]}\n\ndata: [DONE]\n\n`);
    expect(second.events.map((event) => event.data)).toEqual(['{"choices":[{"delta":{"content":"hel"lo"}}]}', "[DONE]"]);
  });

  test("each wire contributes only its own text delta", () => {
    expect(textDelta("chat", "message", { choices: [{ delta: { content: "yo" } }] })).toBe("yo");
    expect(textDelta("chat", "message", { choices: [{ delta: { reasoning_content: "thinking", content: "answer" } }] })).toBe("answer");
    expect(textDelta("responses", "response.output_text.delta", { delta: "yo" })).toBe("yo");
    expect(textDelta("responses", "response.created", { delta: "yo" })).toBe("");
    expect(textDelta("messages", "content_block_delta", { delta: { text: "yo" } })).toBe("yo");
    expect(textDelta("chat", "message", { choices: [{ delta: { reasoning_content: "hmm" } }] })).toBe("");
    expect(reasoningDelta("chat", "message", { choices: [{ delta: { reasoning_content: "hmm" } }] })).toBe("hmm");
    expect(reasoningDelta("messages", "content_block_delta", { delta: { type: "thinking_delta", thinking: "hmm" } })).toBe("hmm");
    expect(reasoningDelta("responses", "response.reasoning_text.delta", { delta: "hmm" })).toBe("hmm");
  });

  test("emits thinking and answer deltas together before the stream closes", async () => {
    const encoder = new TextEncoder();
    const { promise: firstDelta, resolve: resolveFirstDelta } = Promise.withResolvers<void>();
    let closeStream: (() => void) | undefined;
    let answer = "";
    let thought = "";
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        closeStream = () => controller.close();
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"hmm","content":"hello"}}]}\n\n'));
      },
    }));
    const reading = readLabStream(
      response,
      "chat",
      (delta) => {
        answer += delta;
        resolveFirstDelta();
      },
      (delta) => {
        thought += delta;
      },
      () => {},
      () => {},
      new AbortController().signal,
    );

    await firstDelta;
    expect(answer).toBe("hello");
    expect(thought).toBe("hmm");
    closeStream?.();
    await reading;
  });

  test("collects streamed chat tool-call ids, names, and JSON arguments", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"web_search","arguments":"{\\"query\\":"}}]}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"web_search","arguments":"\\"latest news\\"}"}}]}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }));
    const calls = await readLabStream(
      response,
      "chat",
      () => {},
      () => {},
      () => {},
      () => {},
      new AbortController().signal,
    );
    expect(calls).toEqual([{
      id: "call-1",
      name: "web_search",
      arguments: "{\"query\":\"latest news\"}",
    }]);
  });

  test("flushes a complete final SSE frame when the stream ends without a blank line", async () => {
    const encoder = new TextEncoder();
    let answer = "";
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"last token"}}]}'));
        controller.close();
      },
    }));

    await readLabStream(
      response,
      "chat",
      (delta) => {
        answer += delta;
      },
      () => {},
      () => {},
      () => {},
      new AbortController().signal,
    );

    expect(answer).toBe("last token");
  });
});
