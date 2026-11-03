import { Code2, Languages, Lightbulb, MessageCircle, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { useAllModelsCatalog, type FlatModelEntry } from "../../components/ModelPicker";

import { useApiKeys, useRevealApiKey } from "../../hooks/api-keys";
import { ChatBubble } from "./ChatBubble";
import { Composer } from "./Composer";
import { buildLabRequest, errorMessage, MODEL_LAB_PRESETS, parseUserQuestion, type LabImage, type LabToolCall, type LabToolRound, type LabTurn, type LabUserQuestion } from "./protocol";
import { detectMediaIntent, parseImageGenerationResponse, parseVideoGenerationResponse, preferredImageWorker, shouldFallbackToMediaWorker, type GeneratedMedia, type LabMediaIntent, type LabVideo } from "./media";
import { EMPTY_DRAFT, deleteLabSession, listLabSessions, newLabSession, nextMessageId, readActiveSessionId, readLabDraft, readLabSession, writeActiveSessionId, writeLabSession, type LabDraft, type LabMessage, type LabSession, type LabSessionSummary } from "./session";
import { SettingsDrawer } from "./SettingsDrawer";
import { readLabStream } from "./stream";

const STARTER_ICONS: Readonly<Record<string, LucideIcon>> = {
  Explain: Lightbulb,
  Hello: MessageCircle,
  Translate: Languages,
  Code: Code2,
};

const MAX_AGENTIC_CALLS = 4;
const MAX_AGENTIC_ROUNDS = 4;

function availableToolModels(
  catalog: readonly FlatModelEntry[],
  serviceKind: "websearch" | "imageGeneration" | "videoGeneration",
  selectedModel: string,
): string[] {
  const providerId = selectedModel.split("/")[0];
  return catalog
    .filter((entry) => entry.kind === "model" && entry.entry.enabled && entry.entry.serviceKind === serviceKind)
    .sort((left, right) => {
      const leftPreferred = left.providerId === providerId ? 0 : 1;
      const rightPreferred = right.providerId === providerId ? 0 : 1;
      if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      return left.qualified.localeCompare(right.qualified);
    })
    .map((entry) => entry.qualified);
}

function toolArguments(call: LabToolCall): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new Error(`The ${call.name} tool returned invalid arguments.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${call.name} tool arguments must be an object.`);
  }
  return value as Record<string, unknown>;
}

function plannedMediaPrompt(call: LabToolCall, fallback: string): string {
  try {
    const prompt = toolArguments(call).prompt;
    if (typeof prompt === "string" && prompt.trim().length > 0 && prompt.trim().length <= 4000) {
      return prompt.trim();
    }
  } catch {
    return fallback;
  }
  return fallback;
}

async function postNativeService(
  path: string,
  body: Record<string, unknown>,
  token: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(response.ok
      ? "The gateway returned invalid JSON for an agentic tool."
      : `The gateway returned HTTP ${response.status} for an agentic tool.`);
  }
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return payload;
}

/**
 * Picks the media worker a tool call should actually use.
 *
 * A planner that saw `generate_image` in an earlier turn will call it again
 * even when the tool is not declared in this request's tool list — which is
 * exactly what happens when the operator changes the worker and the enum now
 * names a different model, or when no worker is configured at all. Refusing
 * outright with "unavailable image-generation model" killed the turn for a
 * mismatch the lab can resolve on its own, and it only ever reproduced with
 * prior chat history: a fresh chat never called the undeclared tool.
 *
 * So the requested model is honoured when it is one this request declared;
 * otherwise the configured worker wins, and only when there is no worker at
 * all is this an error worth surfacing.
 */
export function resolveMediaModel(
  requested: unknown,
  declared: readonly string[],
  configured: string,
  intent: "image" | "video",
): string {
  if (typeof requested === "string" && declared.includes(requested)) return requested;
  if (configured.length > 0) return configured;
  const fallback = declared[0];
  if (fallback !== undefined) return fallback;
  throw new Error(`No enabled ${intent}-generation model is configured.`);
}

async function executeAgenticTool(
  call: LabToolCall,
  models: { readonly webSearch: readonly string[]; readonly imageGeneration: readonly string[]; readonly videoGeneration: readonly string[] },
  draft: LabDraft,
  token: string,
  signal: AbortSignal,
): Promise<GeneratedMedia & { readonly text: string; readonly workerModel?: string }> {
  const args = toolArguments(call);
  if (call.name === "web_search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query.length === 0 || query.length > 1000) throw new Error("Web search requires a query under 1,000 characters.");
    const model = typeof args.model === "string" ? args.model : models.webSearch[0];
    if (model !== undefined && !models.webSearch.includes(model)) {
      throw new Error("The model requested an unavailable web-search model.");
    }
    if (model === undefined) throw new Error("No enabled web-search model is configured.");
    const payload = await postNativeService("/v1/search", { model, query, max_results: 5 }, token, signal);
    return { text: JSON.stringify(payload).slice(0, 8000) };
  }
  if (call.name === "generate_image") {
    const model = resolveMediaModel(args.model, models.imageGeneration, draft.imageWorkerModel, "image");
    const result = await generateMedia("image", args.prompt, model, draft.imageSize, draft.imageCount, token, signal);
    return { ...result, text: `Image generated by ${model}.`, workerModel: model };
  }
  if (call.name === "generate_video") {
    const model = resolveMediaModel(args.model, models.videoGeneration, draft.videoWorkerModel, "video");
    const result = await generateMedia("video", args.prompt, model, draft.videoSize, draft.videoCount, token, signal);
    return { ...result, text: `Video generated by ${model}.`, workerModel: model };
  }
  throw new Error(`The model requested unsupported tool "${call.name}".`);
}

async function generateMedia(
  intent: LabMediaIntent,
  rawPrompt: unknown,
  model: string,
  size: string,
  count: string,
  token: string,
  signal: AbortSignal,
): Promise<GeneratedMedia> {
  const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
  if (prompt.length === 0 || prompt.length > 4000) {
    throw new Error(`${intent === "image" ? "Image" : "Video"} generation requires a prompt under 4,000 characters.`);
  }
  const generationCount = parseMediaCount(count, intent);
  const generationSize = size.trim();
  if (generationSize.length > 32) {
    throw new Error(`${intent === "image" ? "Image" : "Video"} size must be 32 characters or fewer.`);
  }
  if (intent === "image") {
    const payload = await postNativeService(
      "/v1/images/generations",
      { model, prompt, ...(generationSize.length > 0 ? { size: generationSize } : {}), n: generationCount },
      token,
      signal,
    );
    return { images: parseImageGenerationResponse(payload) };
  }
  const payload = await postNativeService(
    "/v1/videos/generations",
    { model, prompt, ...(generationSize.length > 0 ? { size: generationSize } : {}), n: generationCount },
    token,
    signal,
  );
  return { videos: parseVideoGenerationResponse(payload) };
}

function parseMediaCount(value: string, intent: LabMediaIntent): number {
  if (!/^[1-9]\d?$/.test(value) || Number(value) > 10) {
    throw new Error(`${intent === "image" ? "Image" : "Video"} count must be an integer from 1 to 10.`);
  }
  return Number(value);
}

function configuredMediaCount(value: string): number | undefined {
  return /^[1-9]\d?$/.test(value) && Number(value) <= 10 ? Number(value) : undefined;
}

async function executeConfiguredMedia(
  intent: LabMediaIntent,
  prompt: string,
  model: string,
  draft: LabDraft,
  token: string,
  signal: AbortSignal,
): Promise<GeneratedMedia & { readonly text: string; readonly workerModel: string }> {
  const media = intent === "image"
    ? await generateMedia(intent, prompt, model, draft.imageSize, draft.imageCount, token, signal)
    : await generateMedia(intent, prompt, model, draft.videoSize, draft.videoCount, token, signal);
  return {
    ...media,
    text: `${intent === "image" ? "Image" : "Video"} generated by ${model}.`,
    workerModel: model,
  };
}



/**
 * Model Lab.
 *
 * The page itself does not scroll. The transcript is the only scroller, so a
 * wheel at the end of the bubbles stops there instead of dragging the console
 * page. The composer stays docked under the bubbles.
 */
export function StudioPage(): ReactNode {
  const [session, setSession] = useState<LabSession>(() => newLabSession());
  const [sessions, setSessions] = useState<readonly LabSessionSummary[]>([]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<readonly LabImage[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const answeredQuestionsRef = useRef(new Set<string>());
  const toolApprovalInProgressRef = useRef(new Set<string>());
  const keys = useApiKeys();
  const reveal = useRevealApiKey();
  const modelCatalog = useAllModelsCatalog(true);
  const draft = session;
  const setDraft = (next: LabDraft | ((current: LabDraft) => LabDraft)) => {
    setSession((current) => {
      const resolved = typeof next === "function" ? next(current) : { ...current, ...next };
      return { ...current, ...resolved, title: current.title, updatedAt: Date.now() };
    });
  };

  const refreshSessions = async () => {
    setSessions(await listLabSessions());
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const active = readActiveSessionId(window.sessionStorage);
      const existing = active.length > 0 ? await readLabSession(active) : null;
      const legacy = readLabDraft(window.sessionStorage);
      const opened = existing ?? newLabSession(legacy.messages.length > 0 ? legacy : EMPTY_DRAFT);
      if (cancelled) return;
      setSession(opened);
      writeActiveSessionId(window.sessionStorage, opened.id);
      await writeLabSession(opened);
      if (!cancelled) setSessions(await listLabSessions());
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeActiveSessionId(window.sessionStorage, session.id);
    const handle = window.setTimeout(() => {
      void writeLabSession(session).then(() => refreshSessions());
    }, 250);
    return () => window.clearTimeout(handle);
  }, [session, hydrated]);

  useEffect(() => {
    if (!hydrated || session.imageWorkerModel.length === 0) return;
    const models = availableToolModels(modelCatalog.items, "imageGeneration", "");
    // A worker this catalog does not offer is a stale selection — a model the
    // provider dropped, or one that was never synced here. Left alone it makes
    // every later image request fail, because the worker is what gates the
    // tool's declaration. Re-point it at a model that exists. An empty
    // selection is respected (unset = no image worker), never auto-selected,
    // matching how the video worker behaves.
    if (models.length > 0 && !models.includes(session.imageWorkerModel)) {
      const replacement = preferredImageWorker(models);
      if (replacement === undefined) return;
      setSession((current) => ({ ...current, imageWorkerModel: replacement, updatedAt: Date.now() }));
    }
  }, [hydrated, modelCatalog.items, session.imageWorkerModel]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (node === null || !stickRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [draft.messages, sending]);

  const patch = (next: Partial<LabDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const replaceMessage = (id: string, next: LabMessage) => {
    setDraft((current) => ({
      ...current,
      messages: current.messages.map((message) => (message.id === id ? next : message)),
    }));
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const send = async (override?: { readonly text: string; readonly history: readonly LabMessage[]; readonly images?: readonly LabImage[]; readonly resumeToolResult?: boolean }) => {
    const text = (override?.text ?? input).trim();
    const outgoingImages = override === undefined ? images : override.images ?? [];
    const defaultKey = (keys.data ?? []).find((key) => key.enabled && key.revokedAt === undefined && key.isDefault);
    if ((text.length === 0 && outgoingImages.length === 0) || sending || draft.model.length === 0 || defaultKey === undefined) return;
    const user: LabMessage = override === undefined
      ? {
          id: nextMessageId(),
          role: "user",
          text,
          model: draft.model,
          ...(outgoingImages.length > 0 ? { images: outgoingImages } : {}),
        }
      : override.history[override.history.length - 1] ?? {
          id: nextMessageId(),
          role: "user",
          text,
          model: draft.model,
        };
    const mediaIntent = override?.resumeToolResult === true ? undefined : detectMediaIntent(text);
    const mediaTool = mediaIntent === undefined ? undefined : `generate_${mediaIntent}` as const;
    const assistantId = nextMessageId();
    const assistant: LabMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      model: draft.model,
      status: mediaTool === undefined ? "streaming" : `Calling ${mediaTool}…`,
      pending: true,
      ...(mediaIntent === undefined ? {} : { mediaPending: mediaIntent, mediaStage: "planning" as const }),
      ...(mediaTool === undefined ? {} : { tools: [mediaTool] }),
    };
    const history = override?.history ?? [...draft.messages, user];
    if (override === undefined) {
      setInput("");
      setImages([]);
    }
    stickRef.current = true;
    setSending(true);
    setDraft((current) => ({ ...current, messages: [...history, assistant] }));

    const controller = new AbortController();
    abortRef.current = controller;
    const tools = new Set<string>();
    const generatedImages: LabImage[] = [];
    const generatedVideos: LabVideo[] = [];
    const workerModels = new Set<string>();
    const toolRounds: LabToolRound[] = [];
    let mediaWorkerExecuted = false;
    const paint = (next: { text: string; reasoning: string; status: string; pending?: boolean; usage?: LabMessage["usage"]; error?: boolean; tools?: readonly string[]; images?: readonly LabImage[]; videos?: readonly LabVideo[]; workerModels?: readonly string[]; mediaPending?: "image" | "video"; mediaStage?: "planning" | "generating"; question?: LabUserQuestion; toolCalls?: readonly LabToolCall[]; pendingToolCalls?: readonly LabToolCall[]; toolApprovalError?: string; toolRounds?: readonly LabToolRound[] }) => {
      replaceMessage(assistantId, {
        id: assistantId,
        role: "assistant",
        text: next.text,
        model: draft.model,
        status: next.status,
        ...(next.reasoning.length > 0 ? { reasoning: next.reasoning } : {}),
        ...(next.usage === undefined ? {} : { usage: next.usage }),
        ...(next.pending === true ? { pending: true } : {}),
        ...(next.error === true ? { error: true } : {}),
        ...(next.tools !== undefined && next.tools.length > 0 ? { tools: next.tools } : {}),
        ...(next.images !== undefined && next.images.length > 0 ? { images: next.images } : {}),
        ...(next.videos !== undefined && next.videos.length > 0 ? { videos: next.videos } : {}),
        ...(next.workerModels !== undefined && next.workerModels.length > 0 ? { workerModels: next.workerModels } : {}),
        ...(next.mediaPending === undefined ? {} : { mediaPending: next.mediaPending }),
        ...(next.mediaStage === undefined ? {} : { mediaStage: next.mediaStage }),
        ...(next.question === undefined ? {} : { question: next.question }),
        ...(next.toolCalls === undefined ? {} : { toolCalls: next.toolCalls }),
        ...(next.pendingToolCalls === undefined ? {} : { pendingToolCalls: next.pendingToolCalls }),
        ...(next.toolApprovalError === undefined ? {} : { toolApprovalError: next.toolApprovalError }),
        ...(next.toolRounds === undefined ? {} : { toolRounds: next.toolRounds }),
      });
    };
    let queuedPaint: Parameters<typeof paint>[0] | undefined;
    let paintFrame: number | undefined;
    const schedulePaint = (next: Parameters<typeof paint>[0]) => {
      queuedPaint = next.pending === true && mediaIntent !== undefined && !mediaWorkerExecuted
        ? {
            ...next,
            ...(next.mediaPending === undefined ? { mediaPending: mediaIntent } : {}),
            ...(next.mediaStage === undefined ? { mediaStage: "planning" as const } : {}),
            tools: [...new Set([...(next.tools ?? []), `generate_${mediaIntent}`])],
            status: next.status === "streaming" ? `Calling generate_${mediaIntent}…` : next.status,
          }
        : next;
      if (paintFrame !== undefined) return;
      paintFrame = requestAnimationFrame(() => {
        paintFrame = undefined;
        const latest = queuedPaint;
        queuedPaint = undefined;
        if (latest !== undefined) paint(latest);
      });
    };
    const flushPaint = () => {
      if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
      paintFrame = undefined;
      const latest = queuedPaint;
      queuedPaint = undefined;
      if (latest !== undefined) paint(latest);
    };
    try {
      const revealed = await reveal.mutateAsync({ keyId: defaultKey.id });
      const availableImages = availableToolModels(modelCatalog.items, "imageGeneration", draft.model);
      const availableVideos = availableToolModels(modelCatalog.items, "videoGeneration", draft.model);
      const toolModels = {
        webSearch: availableToolModels(modelCatalog.items, "websearch", draft.model),
        imageGeneration: draft.imageWorkerModel.length > 0 && availableImages.includes(draft.imageWorkerModel)
          ? [draft.imageWorkerModel]
          : [],
        videoGeneration: draft.videoWorkerModel.length > 0 && availableVideos.includes(draft.videoWorkerModel)
          ? [draft.videoWorkerModel]
          : [],
      };
      const selectedWorker = mediaIntent === "image" ? draft.imageWorkerModel : draft.videoWorkerModel;
      const enabledWorkers = mediaIntent === "image" ? availableImages : availableVideos;
      if (mediaIntent !== undefined && (selectedWorker.length === 0 || !enabledWorkers.includes(selectedWorker))) {
        throw new Error(`No enabled ${mediaIntent}-generation worker is selected in Chat settings.`);
      }
      const requestSettings = {
        ...draft,
        protocol: "chat" as const,
        webSearchModels: toolModels.webSearch,
        imageGenerationModels: toolModels.imageGeneration,
        videoGenerationModels: toolModels.videoGeneration,
        imageSize: draft.imageSize,
        imageCount: configuredMediaCount(draft.imageCount),
        videoSize: draft.videoSize,
        videoCount: configuredMediaCount(draft.videoCount),
      };
      const turns: LabTurn[] = history.flatMap((message): LabTurn[] => {
        if (message.toolRounds !== undefined) {
            return message.toolRounds.flatMap((toolRound) => [
              {
                role: "assistant" as const,
                text: toolRound.text,
                ...(toolRound.reasoning === undefined ? {} : { reasoning: toolRound.reasoning }),
                toolCalls: toolRound.toolCalls,
              },
              ...toolRound.toolResults.map((result) => ({
                role: "tool" as const,
                text: result.text,
                toolCallId: result.toolCallId,
              })),
            ]);
        }
        if (message.toolCalls !== undefined) {
            return [{
              role: "assistant" as const,
              text: message.text,
              ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
              toolCalls: message.toolCalls,
            }];
        }
        return [{
            role: message.role,
            text: message.text,
            ...(message.role === "assistant" && message.reasoning !== undefined
              ? { reasoning: message.reasoning }
              : {}),
            ...(message.images === undefined ? {} : { images: message.images }),
        }];
      });
      const startedAt = performance.now();
      let accumulated = "";
      let reasoning = "";
      let firstTokenAt: number | undefined;
      let usage: LabMessage["usage"] = {};
      let status = "streaming";
      let round = 0;
      let totalToolCalls = 0;
      let waitingQuestion: LabUserQuestion | undefined;
      const runMediaFallback = async () => {
        if (mediaIntent === undefined) return;
        const worker = mediaIntent === "image" ? toolModels.imageGeneration[0] : toolModels.videoGeneration[0];
        if (worker === undefined) {
          throw new Error(`No enabled ${mediaIntent}-generation worker is selected in Chat settings.`);
        }
        schedulePaint({
          text: accumulated,
          reasoning,
          status: `Generating ${mediaIntent}…`,
          pending: true,
          usage,
          mediaPending: mediaIntent,
          mediaStage: "generating",
          tools: [...tools],
          images: generatedImages,
          videos: generatedVideos,
          workerModels: [...workerModels],
        });
        const result = await executeConfiguredMedia(mediaIntent, text, worker, draft, revealed.secret, controller.signal);
        tools.add(`generate_${mediaIntent}`);
        workerModels.add(worker);
        if (result.images !== undefined) generatedImages.push(...result.images);
        if (result.videos !== undefined) generatedVideos.push(...result.videos);
        accumulated = accumulated.length > 0 ? `${accumulated}\n\n${result.text}` : result.text;
        schedulePaint({
          text: accumulated,
          reasoning,
          status: "Media generated",
          pending: true,
          usage,
          tools: [...tools],
          images: generatedImages,
          videos: generatedVideos,
          workerModels: [...workerModels],
        });
        mediaWorkerExecuted = true;
      };
      const markFirstToken = () => {
        if (firstTokenAt === undefined) firstTokenAt = performance.now();
      };
      for (;;) {
      let calls: readonly LabToolCall[];
      let roundReasoning = "";
      try {
      const built = buildLabRequest(turns, {
        ...requestSettings,
        ...(mediaWorkerExecuted ? { imageGenerationModels: [], videoGenerationModels: [] } : {}),
        ...(round === 0 && mediaTool !== undefined ? { forcedTool: mediaTool } : {}),
      });
      const response = await fetch(built.path, {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          Authorization: `Bearer ${revealed.secret}`,
        },
        body: JSON.stringify(built.body),
      });
      calls = await readLabStream(
        response,
        requestSettings.protocol,
        (delta) => {
          markFirstToken();
          accumulated += delta;
          schedulePaint({ text: accumulated, reasoning, status, pending: true, usage });
        },
        (thought) => {
          markFirstToken();
          roundReasoning += thought;
          reasoning += thought;
          schedulePaint({ text: accumulated, reasoning, status, pending: true, usage });
        },
        (next) => {
          usage = {
            ...usage,
            ...(next.inputTokens === undefined ? {} : { inputTokens: next.inputTokens }),
            ...(next.cachedTokens === undefined ? {} : { cachedTokens: next.cachedTokens }),
            ...(next.outputTokens === undefined ? {} : { outputTokens: next.outputTokens }),
          };
          if (next.status !== undefined) status = next.status;

        },
        () => {},
        controller.signal,
      );
      } catch (error) {
        if (mediaIntent === undefined || mediaWorkerExecuted || controller.signal.aborted) throw error;
        await runMediaFallback();
        break;
      }
      if (calls.length === 0) {
        if (!mediaWorkerExecuted && shouldFallbackToMediaWorker(mediaIntent, calls)) await runMediaFallback();
        break;
      }
      if (!mediaWorkerExecuted && shouldFallbackToMediaWorker(mediaIntent, calls)) {
        await runMediaFallback();
        break;
      }
      if (round >= MAX_AGENTIC_ROUNDS || totalToolCalls + calls.length > MAX_AGENTIC_CALLS) {
        throw new Error("Planner run stopped after reaching its tool-call limit.");
      }
      round += 1;
      totalToolCalls += calls.length;
      if (draft.toolPermission === "ask" && calls.some((call) => call.name !== "ask_user_question")) {
        if (calls.filter((call) => call.name === "ask_user_question").length > 1) {
          throw new Error("The planner asked more than one question at a time.");
        }
        const actionCalls = calls.filter((call) => call.name !== "ask_user_question");
        for (const call of calls) tools.add(call.name);
        toolRounds.push({
          text: accumulated,
          ...(roundReasoning.length > 0 ? { reasoning: roundReasoning } : {}),
          toolCalls: calls,
          toolResults: [],
        });
        flushPaint();
        paint({
          text: accumulated,
          reasoning,
          status: "Waiting for tool approval",
          usage,
          tools: [...tools],
          toolCalls: calls,
          pendingToolCalls: actionCalls,
          toolRounds,
        });
        return;
      }
      turns.push({
        role: "assistant",
        text: "",
        ...(roundReasoning.length > 0 ? { reasoning: roundReasoning } : {}),
        toolCalls: calls,
      });
      const toolResults: LabToolRound["toolResults"][number][] = [];
      for (const call of calls) {
        if (call.name === "ask_user_question") {
          if (waitingQuestion !== undefined) throw new Error("The planner asked more than one question at a time.");
          waitingQuestion = parseUserQuestion(toolArguments(call));
          tools.add(call.name);
          continue;
        }
        tools.add(call.name);
        schedulePaint({
          text: accumulated,
          reasoning,
          status: `Running ${call.name}…`,
          pending: true,
          usage,
          ...(call.name === "generate_image" ? { mediaPending: "image" as const } : {}),
          ...(call.name === "generate_video" ? { mediaPending: "video" as const } : {}),
          ...(call.name === "generate_image" || call.name === "generate_video" ? { mediaStage: "generating" as const } : {}),
          tools: [...tools],
          images: generatedImages,
          videos: generatedVideos,
          workerModels: [...workerModels],
        });
        const result = mediaIntent !== undefined && call.name === mediaTool
          ? await executeConfiguredMedia(
              mediaIntent,
              plannedMediaPrompt(call, text),
              mediaIntent === "image" ? toolModels.imageGeneration[0] ?? "" : toolModels.videoGeneration[0] ?? "",
              draft,
              revealed.secret,
              controller.signal,
            )
          : await executeAgenticTool(call, toolModels, draft, revealed.secret, controller.signal);
        if (result.images !== undefined) generatedImages.push(...result.images);
        if (result.videos !== undefined) generatedVideos.push(...result.videos);
        if (result.workerModel !== undefined) workerModels.add(result.workerModel);
        if (call.name === mediaTool) mediaWorkerExecuted = true;
        turns.push({ role: "tool", text: result.text, toolCallId: call.id });
        toolResults.push({ toolCallId: call.id, text: result.text });
        schedulePaint({
          text: accumulated,
          reasoning,
          status: "Waiting for model…",
          pending: true,
          usage,
          tools: [...tools],
          images: generatedImages,
          videos: generatedVideos,
          workerModels: [...workerModels],
        });
      }
      toolRounds.push({
        text: accumulated,
        ...(roundReasoning.length > 0 ? { reasoning: roundReasoning } : {}),
        toolCalls: calls,
        toolResults,
      });
      if (waitingQuestion !== undefined) {
        flushPaint();
        paint({
          text: accumulated,
          reasoning,
          status: "Waiting for your answer",
          question: waitingQuestion,
          toolCalls: calls,
          tools: [...tools],
          images: generatedImages,
          videos: generatedVideos,
          workerModels: [...workerModels],
          toolRounds,
        });
        return;
      }
      }
      const finishedAt = performance.now();
      flushPaint();
      paint({
        text: accumulated.length > 0 ? accumulated : "No text came back.",
        reasoning,
        status: status === "streaming" ? "completed" : status,
        ...(generatedImages.length > 0 ? { images: generatedImages } : {}),
        ...(generatedVideos.length > 0 ? { videos: generatedVideos } : {}),
        ...(tools.size > 0 ? { tools: [...tools] } : {}),
        ...(workerModels.size > 0 ? { workerModels: [...workerModels] } : {}),
        ...(toolRounds.length > 0 ? { toolRounds } : {}),
        usage: {
          ...usage,
          ...(firstTokenAt === undefined ? {} : { ttftMs: Math.round(firstTokenAt - startedAt) }),
          completionMs: Math.round(finishedAt - startedAt),
        },
      });
    } catch (error) {
      const stopped = controller.signal.aborted;
      flushPaint();
      paint({
        text: stopped ? "Stopped." : error instanceof Error ? error.message : "Request failed",
        reasoning: "",
        status: stopped ? "stopped" : "error",
        ...(stopped ? {} : { error: true }),
        ...(generatedImages.length > 0 ? { images: generatedImages } : {}),
        ...(generatedVideos.length > 0 ? { videos: generatedVideos } : {}),
        ...(tools.size > 0 ? { tools: [...tools] } : {}),
        ...(workerModels.size > 0 ? { workerModels: [...workerModels] } : {}),
        ...(toolRounds.length > 0 ? { toolRounds } : {}),
      });
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  const defaultKey = (keys.data ?? []).find((key) => key.isDefault);
  const hasDefaultKey = defaultKey?.enabled === true && defaultKey.revokedAt === undefined;
  const canSend = (input.trim().length > 0 || images.length > 0) && !sending && draft.model.length > 0 && hasDefaultKey;
  const canSendStarter = !sending && draft.model.length > 0 && hasDefaultKey;
  const hasDraftToSend = input.trim().length > 0 || images.length > 0;
  let sendBlockMessage: string | null = null;
  if (keys.isPending) {
    sendBlockMessage = "Checking the default gateway API key…";
  } else if (keys.isError) {
    sendBlockMessage = "Could not load API keys. Retry the check before sending.";
  } else if (defaultKey === undefined) {
    sendBlockMessage = "The default gateway API key is missing. Complete first-boot setup before sending.";
  } else if (!hasDefaultKey) {
    sendBlockMessage = "The default gateway API key is disabled or revoked. Enable or rotate it before sending.";
  }
  const sendStarter = (text: string) => {
    if (!canSendStarter) return;
    const user: LabMessage = {
      id: nextMessageId(),
      role: "user",
      text,
      model: draft.model,
    };
    setInput("");
    setImages([]);
    void send({ text, history: [...draft.messages, user], images: [] });
  };
  const answerQuestion = (message: LabMessage, optionId?: string) => {
    const call = message.toolCalls?.find((toolCall) => toolCall.name === "ask_user_question");
    const selected = optionId === undefined
      ? undefined
      : message.question?.options.find((option) => option.id === optionId);
    if (
      sending ||
      message.selectedOption !== undefined ||
      answeredQuestionsRef.current.has(message.id) ||
      call === undefined
    ) return;
    if (optionId !== undefined && selected === undefined) return;
    const cancelled = optionId === undefined;
    const selectedId = selected?.id ?? "cancelled";
    const selectedLabel = selected?.label ?? "";
    const toolResult = JSON.stringify(
      cancelled
        ? { cancelled: true, message: "The user skipped this question. Continue without a selection." }
        : { cancelled: false, selected: { id: selectedId, label: selectedLabel } },
    );
    const toolRounds = (message.toolRounds ?? []).map((round) => (
      round.toolCalls.some((toolCall) => toolCall.id === call.id)
        ? { ...round, toolResults: [...round.toolResults, { toolCallId: call.id, text: toolResult }] }
        : round
    ));
    const updated = {
      ...message,
      selectedOption: selectedId,
      toolRounds,
    };
    const history = draft.messages.map((item) => (item.id === message.id ? updated : item));
    answeredQuestionsRef.current.add(message.id);
    setDraft((current) => ({ ...current, messages: history }));
    void send({
      text: cancelled ? "The user skipped the follow-up question." : selectedLabel,
      history,
      resumeToolResult: true,
    });
  };
  const answerToolApproval = async (message: LabMessage, approved: boolean) => {
    if (
      sending ||
      toolApprovalInProgressRef.current.has(message.id) ||
      message.pendingToolCalls === undefined ||
      message.pendingToolCalls.length === 0
    ) return;
    const pendingCalls = message.pendingToolCalls;
    const pendingMediaCall = approved
      ? pendingCalls.find((call) => call.name === "generate_image" || call.name === "generate_video")
      : undefined;
    let pendingMediaIntent: LabMediaIntent | undefined;
    if (pendingMediaCall?.name === "generate_image") pendingMediaIntent = "image";
    else if (pendingMediaCall?.name === "generate_video") pendingMediaIntent = "video";
    const roundIndex = message.toolRounds?.findIndex((round) =>
      pendingCalls.some((call) => round.toolCalls.some((roundCall) => roundCall.id === call.id)),
    ) ?? -1;
    const originalRound = message.toolRounds?.[roundIndex];
    if (originalRound === undefined) return;

    const questionCall = originalRound.toolCalls.find((call) => call.name === "ask_user_question");
    let question: LabUserQuestion | undefined;
    try {
      if (questionCall !== undefined) question = parseUserQuestion(toolArguments(questionCall));
    } catch (error) {
      replaceMessage(message.id, {
        ...message,
        toolApprovalError: error instanceof Error ? error.message : "The planner returned an invalid question.",
      });
      return;
    }
    toolApprovalInProgressRef.current.add(message.id);

    const results = [...originalRound.toolResults];
    const generatedImages = [...(message.images ?? [])];
    const generatedVideos = [...(message.videos ?? [])];
    const workerModels = new Set(message.workerModels ?? []);
    const tools = new Set(message.tools ?? []);
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    let runningStatus = "Skipping tools…";
    if (approved) {
      runningStatus = pendingMediaIntent === undefined
        ? "Running approved tools…"
        : `Generating ${pendingMediaIntent}…`;
    }
    replaceMessage(message.id, {
      ...message,
      status: runningStatus,
      pendingToolCalls: undefined,
      mediaPending: pendingMediaIntent,
      mediaStage: pendingMediaIntent === undefined ? undefined : "generating",
      toolApprovalError: undefined,
    });

    const updateApprovalMessage = (remaining: readonly LabToolCall[], error?: string) => {
      const nextRounds = [...(message.toolRounds ?? [])];
      nextRounds[roundIndex] = { ...originalRound, toolResults: results };
      replaceMessage(message.id, {
        ...message,
        toolRounds: nextRounds,
        status: error === undefined
          ? question !== undefined && remaining.length === 0
            ? "Waiting for your answer"
            : remaining.length > 0
              ? "Waiting for approval"
              : "Waiting for model…"
          : "Approval failed",
        ...(remaining.length === 0 ? { pendingToolCalls: undefined } : { pendingToolCalls: remaining }),
        ...(error === undefined ? { toolApprovalError: undefined } : { toolApprovalError: error }),
        mediaPending: undefined,
        mediaStage: undefined,
        ...(question === undefined || remaining.length > 0 ? {} : { question, status: "Waiting for your answer" }),
        ...(remaining.length === 0 && question === undefined ? { status: "Waiting for model…" } : {}),
        ...(generatedImages.length > 0 ? { images: generatedImages } : {}),
        ...(generatedVideos.length > 0 ? { videos: generatedVideos } : {}),
        ...(workerModels.size > 0 ? { workerModels: [...workerModels] } : {}),
        ...(tools.size > 0 ? { tools: [...tools] } : {}),
      });
      return nextRounds;
    };

    let completed = false;
    try {
      let token = "";
      if (approved) {
        const defaultKey = (keys.data ?? []).find((key) => key.enabled && key.revokedAt === undefined && key.isDefault);
        if (defaultKey === undefined) throw new Error("The default gateway API key is unavailable.");
        token = (await reveal.mutateAsync({ keyId: defaultKey.id })).secret;
      }
      const userText = [...draft.messages]
        .reverse()
        .find((item) => item.role === "user")?.text ?? "";
      const mediaIntent = detectMediaIntent(userText);
      const mediaTool = mediaIntent === undefined ? undefined : `generate_${mediaIntent}`;
      const allImages = availableToolModels(modelCatalog.items, "imageGeneration", draft.model);
      const allVideos = availableToolModels(modelCatalog.items, "videoGeneration", draft.model);
      const toolModels = {
        webSearch: availableToolModels(modelCatalog.items, "websearch", draft.model),
        imageGeneration: draft.imageWorkerModel.length > 0 && allImages.includes(draft.imageWorkerModel)
          ? [draft.imageWorkerModel]
          : [],
        videoGeneration: draft.videoWorkerModel.length > 0 && allVideos.includes(draft.videoWorkerModel)
          ? [draft.videoWorkerModel]
          : [],
      };

      for (const call of pendingCalls) {
        if (controller.signal.aborted) throw new Error("Stopped");
        tools.add(call.name);
        if (!approved) {
          results.push({
            toolCallId: call.id,
            text: JSON.stringify({ denied: true, message: "The user denied this tool call. Continue without running it." }),
          });
          continue;
        }
        const result = mediaIntent !== undefined && call.name === mediaTool
          ? await executeConfiguredMedia(
              mediaIntent,
              plannedMediaPrompt(call, userText),
              mediaIntent === "image" ? toolModels.imageGeneration[0] ?? "" : toolModels.videoGeneration[0] ?? "",
              draft,
              token,
              controller.signal,
            )
          : await executeAgenticTool(call, toolModels, draft, token, controller.signal);
        if (result.images !== undefined) generatedImages.push(...result.images);
        if (result.videos !== undefined) generatedVideos.push(...result.videos);
        if (result.workerModel !== undefined) workerModels.add(result.workerModel);
        results.push({ toolCallId: call.id, text: result.text });
      }

      const remaining = originalRound.toolCalls.filter((call) =>
        call.name !== "ask_user_question" &&
        !results.some((result) => result.toolCallId === call.id),
      );
      const nextRounds = updateApprovalMessage(remaining);
      const history = draft.messages.map((item) => item.id === message.id
        ? {
            ...item,
            toolRounds: nextRounds,
            ...(remaining.length === 0 ? { pendingToolCalls: undefined } : { pendingToolCalls: remaining }),
            mediaPending: undefined,
            mediaStage: undefined,
            ...(question === undefined || remaining.length > 0 ? {} : { question, status: "Waiting for your answer" }),
            ...(remaining.length === 0 && question === undefined ? { status: "Waiting for model…" } : {}),
            ...(generatedImages.length > 0 ? { images: generatedImages } : {}),
            ...(generatedVideos.length > 0 ? { videos: generatedVideos } : {}),
            ...(workerModels.size > 0 ? { workerModels: [...workerModels] } : {}),
            ...(tools.size > 0 ? { tools: [...tools] } : {}),
          }
        : item);
      if (remaining.length === 0 && question === undefined) {
        setSending(false);
        abortRef.current = null;
        completed = true;
        void send({
          text: userText || "Continue after tool approval.",
          history,
          resumeToolResult: true,
        });
      } else {
        setSending(false);
        abortRef.current = null;
      }
    } catch (error) {
      const resolvedIds = new Set(results.map((result) => result.toolCallId));
      const remaining = pendingCalls.filter((call) => !resolvedIds.has(call.id));
      updateApprovalMessage(remaining, error instanceof Error ? error.message : "Tool execution failed.");
    } finally {
      toolApprovalInProgressRef.current.delete(message.id);
      if (!completed) {
        abortRef.current = null;
        setSending(false);
      }
    }
  };

  return (
    <Card className="flex-auto min-h-0 h-route max-h-route flex flex-col overflow-hidden overscroll-none">
      <CardBody className="flex-auto min-h-0 p-0 gap-0">
        <div className="flex flex-auto min-h-0 min-w-0 flex-row max-medium:flex-col">
        <div className="flex-auto min-w-0 min-h-0 flex flex-col">
          <div
          ref={scrollerRef}
          className="scroll-region flex-auto min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain flex flex-col"
          onScroll={(event) => {
            const node = event.currentTarget;
            stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          }}
        >
          {draft.messages.length === 0 ? (
            <div className="flex-auto flex flex-col items-center justify-center gap-4 px-8 py-12 text-center text-text-tertiary text-body leading-normal [&_p]:m-0">
              <p className="text-text-primary text-title font-semibold">Model Lab</p>
              <p>Pick a model, then try a starter.</p>
              <div className="flex flex-wrap justify-center gap-4 mt-4">
                {MODEL_LAB_PRESETS.map((preset) => {
                  const Icon = STARTER_ICONS[preset.label] ?? MessageCircle;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      className="h-15 px-6 inline-flex items-center gap-3 border border-border-strong rounded-pill bg-surface-1 text-text-secondary text-caption cursor-pointer transition-[border-color,background-color,color] duration-150 ease-spring hover:border-accent hover:bg-active-pill hover:text-text-primary disabled:opacity-40 disabled:cursor-default"
                      disabled={!canSendStarter}
                      onClick={() => sendStarter(preset.prompt)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="w-full max-w-380 mx-auto px-8 py-9 pb-6 flex flex-col gap-5">
              {draft.messages.map((message, index) => (
                <ChatBubble
                  key={message.id}
                  message={message}
                  continuation={
                    message.role === "assistant" &&
                    draft.messages[index - 1]?.role === "assistant" &&
                    draft.messages[index - 1]?.model === message.model
                  }
                  showStats={
                    message.role === "assistant" &&
                    (draft.messages[index + 1] === undefined || draft.messages[index + 1]?.role === "user")
                  }
                  onRetry={
                    message.question !== undefined &&
                    message.selectedOption !== undefined &&
                    draft.messages[index + 1]?.role === "assistant" &&
                    draft.messages[index + 1]?.error === true
                      ? () => {
                          const history = draft.messages.slice(0, index + 1);
                          const selected = message.question?.options.find((option) => option.id === message.selectedOption);
                          void send({
                            text: message.selectedOption === "cancelled" ? "The user skipped the follow-up question." : selected?.label ?? "The user answered the follow-up question.",
                            history,
                            resumeToolResult: true,
                          });
                        }
                      : message.role === "user" &&
                        draft.messages[index + 1]?.role === "assistant" &&
                        draft.messages[index + 1]?.error === true
                      ? () => {
                          const history = draft.messages.slice(0, index + 1);
                          void send({
                            text: message.text,
                            history,
                            ...(message.images === undefined ? {} : { images: message.images }),
                          });
                        }
                      : undefined
                  }
                  retryDisabled={sending || !hasDefaultKey || draft.model.length === 0}
                  onQuestionAnswer={(question, optionId) => answerQuestion(question, optionId)}
                  onQuestionCancel={(question) => answerQuestion(question)}
                  onToolApproval={(approval, approved) => void answerToolApproval(approval, approved)}
                  questionDisabled={sending || !hasDefaultKey || draft.model.length === 0}
                  onEdit={message.role === "user" ? (text) => {
                    const next = { ...message, text };
                    const history = [...draft.messages.slice(0, index), next];
                    setDraft((current) => ({ ...current, messages: history }));
                    void send({ text, history, ...(message.images === undefined ? {} : { images: message.images }) });
                  } : undefined}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex-none w-full max-w-380 mx-auto px-6 pb-2">
          {draft.model.length > 0 && hasDraftToSend && sendBlockMessage !== null ? (
            <div role={keys.isError ? "alert" : "status"} className="mb-2 flex flex-wrap items-center justify-between gap-2 px-2 text-caption text-status-warn">
              <span>{sendBlockMessage}</span>
              {keys.isError ? (
                <Button variant="secondary" size="sm" type="button" onClick={() => void keys.refetch()}>
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
          <Composer
            model={draft.model}
            sessionTitle={session.title}
            onOpenSessions={() => setSessionsOpen(true)}

            onModel={(model) => patch({ model })}
            value={input}
            onChange={setInput}
            images={images}
            onImages={setImages}
            sending={sending}
            canSend={canSend}
            onSend={() => void send()}
            onStop={stop}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
        </div>
        <SettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          draft={draft}
          onChange={patch}
          chatModel={draft.model}
          catalog={modelCatalog.items}
          effortDisabled={!hydrated}
        />
              </div>
      </CardBody>
      <Dialog open={sessionsOpen} onClose={() => setSessionsOpen(false)} title="Chat sessions">
        <div className="scroll-region flex flex-col gap-3 max-h-180 overflow-auto">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              const created = newLabSession({
                ...EMPTY_DRAFT,
                model: draft.model,
                effort: draft.effort,
                imageWorkerModel: draft.imageWorkerModel,
                videoWorkerModel: draft.videoWorkerModel,
                imageSize: draft.imageSize,
                imageCount: draft.imageCount,
                videoSize: draft.videoSize,
                videoCount: draft.videoCount,
                toolPermission: draft.toolPermission,
              });
              setSession(created);
              setInput("");
              setImages([]);
              setSessionsOpen(false);
            }}
          >
            New chat
          </Button>
          {/* The session list is a column, so a bare <p> sits flush left.
              Center it like every other empty state in the dashboard. */}
          {sessions.length === 0 ? (
            <p className="self-center text-center text-caption text-text-tertiary">No chats yet.</p>
          ) : sessions.map((item) => (
            <div key={item.id} className={item.id === session.id ? "flex items-center gap-4 rounded-control p-2 bg-accent-soft" : "flex items-center gap-4 rounded-control p-2"}>
              <button
                type="button"
                className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left border-0 bg-transparent text-text-primary text-body px-4 py-3 cursor-pointer"
                onClick={() => {
                  void readLabSession(item.id).then((loaded) => {
                    if (loaded === null) return;
                    setSession(loaded);
                    setSessionsOpen(false);
                  });
                }}
              >
                {item.title}
              </button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => {
                  void deleteLabSession(item.id).then(async () => {
                    if (item.id === session.id) setSession(newLabSession({
                      ...EMPTY_DRAFT,
                      model: draft.model,
                      imageWorkerModel: draft.imageWorkerModel,
                      videoWorkerModel: draft.videoWorkerModel,
                      imageSize: draft.imageSize,
                      imageCount: draft.imageCount,
                      videoSize: draft.videoSize,
                      videoCount: draft.videoCount,
                      toolPermission: draft.toolPermission,
                    }));
                    setSessions(await listLabSessions());
                  });
                }}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      </Dialog>
    </Card>
  );

}

export default StudioPage;
