/**
 * Model Lab keeps every conversation in IndexedDB. Session storage only
 * remembers which one is open, so a reload comes back to it and a new chat
 * does not wipe the others.
 */

import { parseUserQuestion, type LabEffort, type LabImage, type LabPersona, type LabProtocol, type LabToolCall, type LabToolRound, type LabUserQuestion } from "./protocol";
import type { LabVideo } from "./media";

export interface LabUsage {
  readonly inputTokens?: number;
  readonly cachedTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly ttftMs?: number;
  readonly completionMs?: number;
}

export interface LabMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly images?: readonly LabImage[];
  readonly videos?: readonly LabVideo[];
  readonly workerModels?: readonly string[];
  readonly mediaPending?: "image" | "video";
  readonly mediaStage?: "planning" | "generating";
  readonly toolCalls?: readonly LabToolCall[];
  readonly pendingToolCalls?: readonly LabToolCall[];
  readonly toolApprovalError?: string;
  readonly toolRounds?: readonly LabToolRound[];
  readonly question?: LabUserQuestion;
  readonly selectedOption?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly status?: string;
  readonly usage?: LabUsage;
  readonly pending?: boolean;
  readonly error?: boolean;
  readonly tools?: readonly string[];
}

export interface LabDraft {
  readonly model: string;
  readonly imageWorkerModel: string;
  readonly videoWorkerModel: string;
  readonly imageSize: string;
  readonly imageCount: string;
  readonly videoSize: string;
  readonly videoCount: string;
  readonly protocol: LabProtocol;
  readonly persona: LabPersona;
  readonly systemPrompt: string;
  readonly temperature: string;
  readonly topP: string;
  readonly effort: LabEffort;
  readonly toolPermission: "ask" | "yolo";
  readonly messages: readonly LabMessage[];

}

export const EMPTY_DRAFT: LabDraft = {
  model: "",
  imageWorkerModel: "",
  videoWorkerModel: "",
  imageSize: "1024x1024",
  imageCount: "1",
  videoSize: "",
  videoCount: "1",
  protocol: "chat",
  persona: "cartethyia",
  systemPrompt: "",
  temperature: "",
  topP: "",
  effort: "high",
  toolPermission: "ask",
  messages: [],

};

const ACTIVE_KEY = "cartethyia.model-lab.active";
const LEGACY_KEY = "cartethyia.model-lab.v1";
const DB_NAME = "cartethyia.model-lab";
const DB_VERSION = 1;
const STORE = "sessions";

export interface LabSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

export interface LabSession extends LabDraft {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not open Model Lab sessions."));
  return promise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Model Lab session store rejected the request."));
  return promise;
}

function done(tx: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error("Model Lab session store failed."));
  return promise;
}

const SESSION_NAMES = ["amber", "birch", "cedar", "coral", "daisy", "ember", "flint", "frost", "hazel", "ivory", "jade", "maple", "moss", "olive", "pearl", "quartz", "reed", "sage", "slate", "willow"] as const;

export function sessionName(): string {
  const word = SESSION_NAMES[Math.floor(Math.random() * SESSION_NAMES.length)] ?? "chat";
  const stamp = Math.floor(Math.random() * 90 + 10).toString();
  return `${word}${stamp}`.slice(0, 8);
}

export function newLabSession(draft: LabDraft = EMPTY_DRAFT): LabSession {
  return { ...draft, id: nextMessageId(), title: sessionName(), updatedAt: Date.now() };
}

export async function listLabSessions(): Promise<readonly LabSessionSummary[]> {
  const db = await openDb();
  const rows = await requestToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  db.close();
  return (rows as LabSession[])
    .map((row) => ({ id: row.id, title: (row.title || "chat").slice(0, 8), updatedAt: row.updatedAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function readLabSession(id: string): Promise<LabSession | null> {
  const db = await openDb();
  const row = await requestToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
  db.close();
  return migrateLabSessionRecord(row);
}

/** Migrates older stored sessions while adding empty, independent worker selections. */
export function migrateLabSessionRecord(value: unknown): LabSession | null {
  if (value === undefined || value === null || typeof value !== "object") return null;
  const record = value as LabSession & { readonly mode?: unknown };
  const { mode: _legacyMode, ...session } = record;
  return {
    ...EMPTY_DRAFT,
    ...session,
    imageWorkerModel: modelSelection(record.imageWorkerModel),
    videoWorkerModel: modelSelection(record.videoWorkerModel),
    imageSize: mediaSize(record.imageSize, "1024x1024"),
    imageCount: mediaCount(record.imageCount),
    videoSize: mediaSize(record.videoSize, ""),
    videoCount: mediaCount(record.videoCount),
    protocol: isProtocol(record.protocol) ? record.protocol : "chat",
    persona: isPersona(record.persona) ? record.persona : "cartethyia",
    effort: isEffort(record.effort) ? record.effort : "high",
    toolPermission: isToolPermission(record.toolPermission) ? record.toolPermission : "ask",
    messages: readMessages(record.messages),
    title: (record.title || sessionName()).slice(0, 8),
  };
}

function modelSelection(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mediaSize(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length <= 32 ? value : fallback;
}

function mediaCount(value: unknown): string {
  return typeof value === "string" && /^[1-9]\d?$/.test(value) && Number(value) <= 10 ? value : "1";
}

export async function writeLabSession(session: LabSession): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({ ...session, title: session.title || sessionName(), updatedAt: Date.now() });
  await done(tx);
  db.close();
}

export async function deleteLabSession(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await done(tx);
  db.close();
}

export function readActiveSessionId(storage: Storage | undefined): string {
  if (storage === undefined) return "";
  return storage.getItem(ACTIVE_KEY) ?? "";
}

export function writeActiveSessionId(storage: Storage | undefined, id: string): void {
  if (storage === undefined) return;
  storage.setItem(ACTIVE_KEY, id);
}


function isProtocol(value: unknown): value is LabProtocol {
  return value === "chat" || value === "responses" || value === "messages";
}

function isPersona(value: unknown): value is LabPersona {
  return value === "cartethyia" || value === "unset";
}

function isEffort(value: unknown): value is LabEffort {
  return value === "auto" || value === "low" || value === "medium" || value === "high" || value === "max";
}

function isToolPermission(value: unknown): value is LabDraft["toolPermission"] {
  return value === "ask" || value === "yolo";
}

function readImages(value: unknown): readonly LabImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images = value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.dataUrl !== "string") return [];
    if (!record.dataUrl.startsWith("data:image/") && !isSecureMediaUrl(record.dataUrl)) return [];
    return [{ name: record.name, dataUrl: record.dataUrl }];
  });
  return images.length > 0 ? images : undefined;
}

function readVideos(value: unknown): readonly LabVideo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const videos = value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.src !== "string") return [];
    if (!record.src.startsWith("data:video/mp4;base64,") &&
        !record.src.startsWith("data:video/webm;base64,") &&
        !isSecureMediaUrl(record.src)) return [];
    return [{ name: record.name, src: record.src }];
  });
  return videos.length > 0 ? videos : undefined;
}

function readToolCalls(value: unknown): readonly LabToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.arguments !== "string") return [];
    return [{ id: record.id, name: record.name, arguments: record.arguments }];
  });
  return calls.length > 0 ? calls : undefined;
}

function readToolRounds(value: unknown): readonly LabToolRound[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rounds = value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.text !== "string") return [];
    const toolCalls = readToolCalls(record.toolCalls);
    if (toolCalls === undefined) return [];
    const toolResults = Array.isArray(record.toolResults)
      ? record.toolResults.flatMap((result) => {
          if (result === null || typeof result !== "object" || Array.isArray(result)) return [];
          const entry = result as Record<string, unknown>;
          if (typeof entry.toolCallId !== "string" || typeof entry.text !== "string") return [];
          return [{ toolCallId: entry.toolCallId, text: entry.text }];
        })
      : [];
    return [{
      text: record.text,
      ...(typeof record.reasoning === "string" ? { reasoning: record.reasoning } : {}),
      toolCalls,
      toolResults,
    }];
  });
  return rounds.length > 0 ? rounds : undefined;
}

function readQuestion(value: unknown): LabUserQuestion | undefined {
  try {
    return parseUserQuestion(value);
  } catch {
    return undefined;
  }
}

function isSecureMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsage(value: unknown): LabUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usage: LabUsage = {
    ...(readNumber(record.inputTokens) === undefined ? {} : { inputTokens: readNumber(record.inputTokens) }),
    ...(readNumber(record.cachedTokens) === undefined ? {} : { cachedTokens: readNumber(record.cachedTokens) }),
    ...(readNumber(record.outputTokens) === undefined ? {} : { outputTokens: readNumber(record.outputTokens) }),
    ...(readNumber(record.reasoningTokens) === undefined ? {} : { reasoningTokens: readNumber(record.reasoningTokens) }),
    ...(readNumber(record.ttftMs) === undefined ? {} : { ttftMs: readNumber(record.ttftMs) }),
    ...(readNumber(record.completionMs) === undefined ? {} : { completionMs: readNumber(record.completionMs) }),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function readMessages(value: unknown): readonly LabMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: LabMessage[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (typeof record.id !== "string" || typeof record.text !== "string") continue;
    const images = readImages(record.images);
    const videos = readVideos(record.videos);
    const toolCalls = readToolCalls(record.toolCalls);
    const pendingToolCalls = readToolCalls(record.pendingToolCalls);
    const toolRounds = readToolRounds(record.toolRounds);
    const question = readQuestion(record.question);
    const usage = readUsage(record.usage);
    const wasPending = record.pending === true;
    let restoredText = record.text;
    if (wasPending) {
      const interruption = record.mediaPending === "image" || record.mediaPending === "video"
        ? "Generation was interrupted when the page reloaded. Retry to run it again."
        : "This response was interrupted when the page reloaded. Retry to continue.";
      restoredText = restoredText.length > 0 ? `${restoredText}\n\n${interruption}` : interruption;
    }
    messages.push({
      id: record.id,
      role: record.role,
      text: restoredText,
      ...(images === undefined ? {} : { images }),
      ...(videos === undefined ? {} : { videos }),
      ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
      ...(typeof record.reasoning === "string" && record.reasoning.length > 0 ? { reasoning: record.reasoning } : {}),
      ...(wasPending ? { status: "interrupted" } : typeof record.status === "string" && record.status.length > 0 ? { status: record.status } : {}),
      ...(!wasPending && (record.mediaPending === "image" || record.mediaPending === "video") ? { mediaPending: record.mediaPending } : {}),
      ...(!wasPending && (record.mediaStage === "planning" || record.mediaStage === "generating") ? { mediaStage: record.mediaStage } : {}),
      ...(usage === undefined ? {} : { usage }),
      ...(record.error === true || wasPending ? { error: true } : {}),
      ...(Array.isArray(record.tools)
        ? { tools: record.tools.filter((tool): tool is string => typeof tool === "string") }
        : {}),
      ...(Array.isArray(record.workerModels)
        ? { workerModels: record.workerModels.filter((worker): worker is string => typeof worker === "string") }
        : {}),
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(pendingToolCalls === undefined ? {} : { pendingToolCalls }),
      ...(typeof record.toolApprovalError === "string" ? { toolApprovalError: record.toolApprovalError } : {}),
      ...(toolRounds === undefined ? {} : { toolRounds }),
      ...(question === undefined ? {} : { question }),
      ...(typeof record.selectedOption === "string" ? { selectedOption: record.selectedOption } : {}),
    });
  }
  return messages;
}

export function readLabDraft(storage: Storage | undefined): LabDraft {
  if (storage === undefined) return EMPTY_DRAFT;
  try {
    const raw = storage.getItem(LEGACY_KEY);
    if (raw === null) return EMPTY_DRAFT;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return EMPTY_DRAFT;
    const record = parsed as Record<string, unknown>;
    return {
      model: typeof record.model === "string" ? record.model : "",
      imageWorkerModel: modelSelection(record.imageWorkerModel),
      videoWorkerModel: modelSelection(record.videoWorkerModel),
      imageSize: mediaSize(record.imageSize, "1024x1024"),
      imageCount: mediaCount(record.imageCount),
      videoSize: mediaSize(record.videoSize, ""),
      videoCount: mediaCount(record.videoCount),
      protocol: isProtocol(record.protocol) ? record.protocol : "chat",
      persona: isPersona(record.persona) ? record.persona : "cartethyia",
      systemPrompt: typeof record.systemPrompt === "string" ? record.systemPrompt : "",
      temperature: typeof record.temperature === "string" ? record.temperature : "",
      topP: typeof record.topP === "string" ? record.topP : "",
      effort: isEffort(record.effort) ? record.effort : "high",
      toolPermission: isToolPermission(record.toolPermission) ? record.toolPermission : "ask",
      messages: readMessages(record.messages),

    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function nextMessageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
