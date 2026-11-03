/**
 * Turns a Model Lab conversation into the public gateway body for the wire
 * the operator picked. The lab does not invent a private protocol: chat,
 * responses, and messages are the same surfaces a client would call.
 */

export type LabProtocol = "chat" | "responses" | "messages";
export type LabEffort = "auto" | "low" | "medium" | "high" | "max";
export type LabPersona = "cartethyia" | "unset";

export interface LabQuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface LabUserQuestion {
  readonly question: string;
  readonly options: readonly LabQuestionOption[];
}

/** Validates and bounds a planner-provided question before showing choices. */
export function parseUserQuestion(value: unknown): LabUserQuestion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The ask_user_question tool returned invalid arguments.");
  }
  const record = value as Record<string, unknown>;
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (question.length === 0 || question.length > 500 || !Array.isArray(record.options) ||
      record.options.length < 2 || record.options.length > 6) {
    throw new Error("The ask_user_question tool requires one concise question and 2–6 selectable options.");
  }
  const ids = new Set<string>();
  const options = record.options.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The ask_user_question tool returned an invalid selectable option.");
    }
    const option = value as Record<string, unknown>;
    const id = typeof option.id === "string" ? option.id.trim() : "";
    const label = typeof option.label === "string" ? option.label.trim() : "";
    const description = typeof option.description === "string" ? option.description.trim() : "";
    if (id.length === 0 || id.length > 100 || ids.has(id) || label.length === 0 || label.length > 200 ||
        description.length > 500) {
      throw new Error("The ask_user_question tool returned an invalid selectable option.");
    }
    ids.add(id);
    return { id, label, ...(description.length > 0 ? { description } : {}) };
  });
  return { question, options };
}

export interface LabImage {
  readonly name: string;
  readonly dataUrl: string;
}

export interface LabTurn {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly reasoning?: string;
  readonly images?: readonly LabImage[];
  readonly toolCalls?: readonly LabToolCall[];
  readonly toolCallId?: string;
  readonly toolResultFor?: string;
}

export interface LabToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface LabToolResult {
  readonly toolCallId: string;
  readonly text: string;
}

export interface LabToolRound {
  readonly text: string;
  readonly reasoning?: string;
  readonly toolCalls: readonly LabToolCall[];
  readonly toolResults: readonly LabToolResult[];
}

export interface LabRequestSettings {
  readonly protocol: LabProtocol;
  readonly persona: LabPersona;
  readonly model: string;
  /** Model catalog output ceiling in tokens; undefined = let the gateway default. */
  readonly maxOutputTokens?: number;
  readonly systemPrompt: string;
  readonly temperature: string;
  readonly topP: string;
  readonly effort: LabEffort;
  readonly webSearchModels?: readonly string[];
  readonly imageGenerationModels?: readonly string[];
  readonly videoGenerationModels?: readonly string[];
  readonly imageSize?: string;
  readonly imageCount?: number;
  readonly videoSize?: string;
  readonly videoCount?: number;
  readonly forcedTool?: "generate_image" | "generate_video";
}

export interface BuiltLabRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

const PATH_BY_PROTOCOL: Record<LabProtocol, string> = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
};

function optionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function sampling(settings: LabRequestSettings): Record<string, number> {
  const temperature = optionalNumber(settings.temperature);
  const topP = optionalNumber(settings.topP);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
  };
}

function reasoning(protocol: LabProtocol, effort: LabEffort): Record<string, unknown> {
  if (effort === "auto") return {};
  // Chat reads a top-level scalar. Responses and Messages read `reasoning.effort`.
  // `max` is the canonical ceiling; the composer label is the same word.
  if (protocol === "chat") return { reasoning_effort: effort };
  return { reasoning: { effort } };
}

function userContent(protocol: LabProtocol, turn: LabTurn): string | readonly Record<string, unknown>[] {
  const images = turn.images ?? [];
  if (images.length === 0) return turn.text;
  if (protocol === "messages") {
    return [
      ...(turn.text.length > 0 ? [{ type: "text", text: turn.text }] : []),
      ...images.map((image) => ({ type: "image", source: { type: "url", url: image.dataUrl } })),
    ];
  }
  if (protocol === "responses") {
    return [
      ...(turn.text.length > 0 ? [{ type: "input_text", text: turn.text }] : []),
      ...images.map((image) => ({ type: "input_image", image_url: image.dataUrl })),
    ];
  }
  return [
    ...(turn.text.length > 0 ? [{ type: "text", text: turn.text }] : []),
    ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
  ];
}

function spokenTurns(turns: readonly LabTurn[]): readonly LabTurn[] {
  return turns.filter(
    (turn) =>
      turn.text.trim().length > 0 ||
      (turn.images?.length ?? 0) > 0 ||
      (turn.toolCalls?.length ?? 0) > 0 ||
      turn.role === "tool",
  );
}

function systemPrompt(settings: LabRequestSettings): string {
  const custom = settings.systemPrompt.trim();
  if (settings.persona === "unset") return custom;

  const context = [
    "You are Cartethyia, an AI assistant in Cartethyia Model Lab.",
    "Use the conversation context and attachments explicitly provided by the user. Image understanding depends on whether the selected model supports it directly — the gateway may describe an attachment through a configured vision handoff model when it does not.",
    "You can use the configured web_search, generate_image, generate_video, and ask_user_question tools. Use them when appropriate, and never claim a tool succeeded until its result confirms success.",
    // Ordering matters because the lab renders a turn as: reasoning, then your
    // text, then the tool call with its arguments, then the generated media. A
    // model that narrated before calling the tool left two disjointed blocks,
    // and one that repeated the tool's name or arguments duplicated what the
    // interface already shows. These rules keep one turn reading top-to-bottom.
    "When you use a media tool, call it in the same turn as your reply, then write your answer as that turn's text.",
    "Do not split your answer around the media, and do not repeat the tool's name or arguments in it — the interface already shows them.",
    "If you need to say what you are about to do, keep it to one short sentence before the call.",
    "Your knowledge may not be current. Be transparent about uncertainty and do not present external information as recently verified.",
    "",
    `Selected model: ${settings.model}`,
    `Selected protocol: ${settings.protocol}`,
  ].join("\n");

  return custom.length > 0
    ? `## Cartethyia Model Lab persona\n${context}\n\n## User system prompt\n${custom}`
    : `## Cartethyia Model Lab persona\n${context}`;
}

function agenticTools(settings: LabRequestSettings): readonly Record<string, unknown>[] {
  if (settings.protocol !== "chat") return [];
  const tools: Record<string, unknown>[] = [];
  const searchModels = settings.webSearchModels ?? [];
  const imageModels = settings.imageGenerationModels ?? [];
  const videoModels = settings.videoGenerationModels ?? [];
  if (searchModels.length > 0) {
    tools.push({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information relevant to the user's question.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "A concise web search query." },
            model: { type: "string", enum: searchModels, description: "Available web search model." },
          },
          required: ["query"],
        },
      },
    });
  }
  if (imageModels.length > 0) {
    const imageSettings = [
      settings.imageSize ? `size ${settings.imageSize}` : undefined,
      settings.imageCount === undefined ? undefined : `${settings.imageCount} image${settings.imageCount === 1 ? "" : "s"}`,
    ].filter((value) => value !== undefined).join(", ");
    tools.push({
      type: "function",
      function: {
        name: "generate_image",
        description: `Generate image media using the configured output settings${imageSettings ? ` (${imageSettings})` : ""}, then attach it to the response.`,
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "A detailed image-generation prompt." },
            model: { type: "string", enum: imageModels, description: "Available image generation model." },
          },
          required: ["prompt"],
        },
      },
    });
  }
  if (videoModels.length > 0) {
    const videoSettings = [
      settings.videoSize ? `size ${settings.videoSize}` : undefined,
      settings.videoCount === undefined ? undefined : `${settings.videoCount} video${settings.videoCount === 1 ? "" : "s"}`,
    ].filter((value) => value !== undefined).join(", ");
    tools.push({
      type: "function",
      function: {
        name: "generate_video",
        description: `Generate video media using the configured output settings${videoSettings ? ` (${videoSettings})` : ""}, then attach it to the response.`,
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "A detailed video-generation prompt." },
            model: { type: "string", enum: videoModels, description: "Available video-generation model." },
          },
          required: ["prompt"],
        },
      },
    });
  }
  tools.push({
    type: "function",
    function: {
      name: "ask_user_question",
      description: "Ask the user one concise follow-up question when their choice is needed to continue. Offer clear selectable options.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "One concise question for the user." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "A stable short identifier for this option." },
                label: { type: "string", description: "A concise selectable answer." },
                description: { type: "string", description: "Optional brief explanation." },
              },
              required: ["id", "label"],
              additionalProperties: false,
            },
          },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
  });
  return tools;
}

function chatTurn(turn: LabTurn): Record<string, unknown> {
  if (turn.role === "tool") {
    return { role: "tool", tool_call_id: turn.toolCallId, content: turn.text };
  }
  if (turn.role === "assistant" && turn.toolCalls !== undefined) {
    return {
      role: "assistant",
      content: turn.text.length > 0 ? turn.text : null,
      ...(turn.reasoning === undefined ? {} : { reasoning_content: turn.reasoning }),
      tool_calls: turn.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (turn.role === "assistant" && turn.toolResultFor !== undefined) {
    return { role: "tool", tool_call_id: turn.toolResultFor, content: turn.text };
  }
  return {
    role: turn.role,
    content: userContent("chat", turn),
    ...(turn.role === "assistant" && turn.reasoning !== undefined
      ? { reasoning_content: turn.reasoning }
      : {}),
  };
}


/** One friendly starter prompt on the Model Lab welcome screen. */
export interface LabPreset {
  readonly label: string;
  readonly prompt: string;
}

export const MODEL_LAB_PRESETS: readonly LabPreset[] = [
  { label: "Explain", prompt: "Jelaskan cara kerja streaming token pada API chat secara bertahap." },
  { label: "Hello", prompt: "Halo! Perkenalkan dirimu singkat dalam Bahasa Indonesia." },
  { label: "Translate", prompt: "Terjemahkan \"A smooth stream makes every thought visible\" ke Bahasa Indonesia." },
  { label: "Code", prompt: "Berikan contoh singkat membaca file JSON menggunakan Bun dan TypeScript." },
];
/** The endpoint and JSON body for one send. Empty assistant turns are dropped. */
export function buildLabRequest(turns: readonly LabTurn[], settings: LabRequestSettings): BuiltLabRequest {
  const spoken = spokenTurns(turns);
  const system = systemPrompt(settings);
  const sample = sampling(settings);
  const effort = reasoning(settings.protocol, settings.effort);

  if (settings.protocol === "messages") {
    return {
      path: PATH_BY_PROTOCOL.messages,
      body: {
        model: settings.model,
        stream: true,
        max_tokens: settings.maxOutputTokens ?? 4096,
        ...(system.length > 0 ? { system } : {}),
        messages: spoken.map((turn) => ({ role: turn.role, content: userContent("messages", turn) })),
        ...sample,
        ...effort,
      },
    };
  }

  if (settings.protocol === "responses") {
    return {
      path: PATH_BY_PROTOCOL.responses,
      body: {
        model: settings.model,
        stream: true,
        input: [
          ...(system.length > 0 ? [{ role: "system", content: system }] : []),
          ...spoken.map((turn) => ({ role: turn.role, content: userContent("responses", turn) })),
        ],
        ...sample,
        ...effort,
        ...(settings.maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: settings.maxOutputTokens }),
      },
    };
  }

  return {
    path: PATH_BY_PROTOCOL.chat,
    body: {
      model: settings.model,
      stream: true,
      messages: [
        ...(system.length > 0 ? [{ role: "system", content: system }] : []),
        ...spoken.map(chatTurn),
      ],
      ...sample,
      ...effort,
      ...(settings.maxOutputTokens === undefined ? {} : { max_tokens: settings.maxOutputTokens }),
      ...(agenticTools(settings).length > 0 ? { tools: agenticTools(settings) } : {}),
      ...(settings.forcedTool !== undefined
        ? { tool_choice: { type: "function", function: { name: settings.forcedTool } } }
        : {}),
    },
  };
}

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Splits one SSE chunk into complete events, keeping a trailing partial frame. */
export function takeSseEvents(buffer: string): { readonly events: readonly SseEvent[]; readonly rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? "";
  const events: SseEvent[] = [];
  for (const frame of frames) {
    if (frame.trim().length === 0) continue;
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part === null || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .join("");
}

/**
 * Pulls the visible text delta out of one SSE payload.
 *
 * Chat streams `choices[].delta.content`. Responses streams `delta` on
 * `response.output_text.delta`. Messages streams `delta.text` on
 * `content_block_delta`. A non-delta payload contributes nothing.
 */
export function textDelta(protocol: LabProtocol, eventName: string, payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;

  if (protocol === "chat") {
    const choices = record.choices;
    if (!Array.isArray(choices)) return "";
    return choices
      .map((choice) => {
        if (choice === null || typeof choice !== "object") return "";
        const delta = (choice as Record<string, unknown>).delta;
        if (delta === null || typeof delta !== "object") return "";
        const deltaRecord = delta as Record<string, unknown>;
        return textOf(deltaRecord.content);
      })
      .join("");
  }

  if (protocol === "responses") {
    if (eventName !== "response.output_text.delta" && record.type !== "response.output_text.delta") return "";
    return typeof record.delta === "string" ? record.delta : "";
  }

  if (eventName !== "content_block_delta" && record.type !== "content_block_delta") return "";
  const delta = record.delta;
  if (delta === null || typeof delta !== "object") return "";
  return textOf((delta as Record<string, unknown>).text);
}

/** Pulls a thinking delta. Visible answer text stays in `textDelta`. */
export function reasoningDelta(protocol: LabProtocol, eventName: string, payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (protocol === "chat") {
    const choices = record.choices;
    if (!Array.isArray(choices)) return "";
    return choices
      .map((choice) => {
        if (choice === null || typeof choice !== "object") return "";
        const delta = (choice as Record<string, unknown>).delta;
        if (delta === null || typeof delta !== "object") return "";
        const body = delta as Record<string, unknown>;
        return textOf(body.reasoning_content ?? body.reasoning);
      })
      .join("");
  }
  if (protocol === "responses") {
    const type = eventName.length > 0 ? eventName : record.type;
    if (type !== "response.reasoning_text.delta" && type !== "response.reasoning_summary_text.delta") return "";
    return typeof record.delta === "string" ? record.delta : "";
  }
  if (eventName !== "content_block_delta" && record.type !== "content_block_delta") return "";
  const delta = record.delta;
  if (delta === null || typeof delta !== "object") return "";
  const body = delta as Record<string, unknown>;
  if (body.type !== "thinking_delta") return "";
  return textOf(body.thinking);

}

/** The name of a tool the model started calling in this frame. */
export function toolCallName(protocol: LabProtocol, eventName: string, payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (protocol === "chat") {
    const choices = record.choices;
    if (!Array.isArray(choices)) return "";
    return choices
      .map((choice) => {
        if (choice === null || typeof choice !== "object") return "";
        const delta = (choice as Record<string, unknown>).delta;
        if (delta === null || typeof delta !== "object") return "";
        const calls = (delta as Record<string, unknown>).tool_calls;
        if (!Array.isArray(calls)) return "";
        return calls
          .map((call) => {
            if (call === null || typeof call !== "object") return "";
            const fn = (call as Record<string, unknown>).function;
            if (fn === null || typeof fn !== "object") return "";
            return textOf((fn as Record<string, unknown>).name);
          })
          .filter((name) => name.length > 0)
          .join(", ");
      })
      .filter((name) => name.length > 0)
      .join(", ");
  }
  if (protocol === "responses") {
    const type = eventName.length > 0 ? eventName : record.type;
    if (type !== "response.output_item.added" && type !== "response.function_call_arguments.delta") return "";
    const item = record.item;
    if (item === null || typeof item !== "object") return textOf(record.name);
    return textOf((item as Record<string, unknown>).name);
  }
  if (eventName !== "content_block_start" && record.type !== "content_block_start") return "";
  const block = record.content_block;
  if (block === null || typeof block !== "object") return "";
  if ((block as Record<string, unknown>).type !== "tool_use") return "";
  return textOf((block as Record<string, unknown>).name);
}

export interface LabUsageDelta {
  readonly inputTokens?: number;
  readonly cachedTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly status?: string;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cachedOf(usage: Record<string, unknown>): number | undefined {
  const direct = numberOf(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens);
  if (direct !== undefined) return direct;
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details;
  if (details === null || typeof details !== "object") return undefined;
  return numberOf((details as Record<string, unknown>).cached_tokens);
}

function usageOf(value: unknown): Pick<LabUsageDelta, "inputTokens" | "cachedTokens" | "outputTokens" | "reasoningTokens"> {
  if (value === null || typeof value !== "object") return {};
  const usage = value as Record<string, unknown>;
  const details = usage.output_tokens_details ?? usage.completion_tokens_details;
  const reasoning = details !== null && typeof details === "object"
    ? numberOf((details as Record<string, unknown>).reasoning_tokens)
    : numberOf(usage.reasoning_tokens);
  const inputTokens = numberOf(usage.input_tokens ?? usage.prompt_tokens);
  const cachedTokens = cachedOf(usage);
  const outputTokens = numberOf(usage.output_tokens ?? usage.completion_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

/** Reads token totals and a terminal status when a frame carries them. */
export function usageDelta(protocol: LabProtocol, eventName: string, payload: unknown): LabUsageDelta {
  if (payload === null || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  if (protocol === "chat") {
    const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
    const finish = choice !== null && typeof choice === "object"
      ? (choice as Record<string, unknown>).finish_reason
      : undefined;
    return {
      ...usageOf(record.usage),
      ...(typeof finish === "string" && finish.length > 0 ? { status: finish } : {}),
    };
  }
  if (protocol === "responses") {
    const response = record.response;
    const done = eventName === "response.completed" || record.type === "response.completed";
    const body = response !== null && typeof response === "object" ? response as Record<string, unknown> : record;
    return {
      ...usageOf(body.usage),
      ...(done ? { status: "completed" } : {}),
    };
  }
  const done = eventName === "message_stop" || record.type === "message_stop";
  const message = record.message;
  const body = message !== null && typeof message === "object" ? message as Record<string, unknown> : record;
  return {
    ...usageOf(body.usage),
    ...(done ? { status: "completed" } : {}),
  };
}

/** Reads `error.message` from a gateway JSON body, or a status fallback. */
export function errorMessage(payload: unknown, status: number): string {
  if (payload !== null && typeof payload === "object") {
    const error = (payload as Record<string, unknown>).error;
    if (error !== null && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim().length > 0) return message;
    }
    const message = (payload as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return `Request failed (${status})`;
}
