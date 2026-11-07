import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildCodeBuddyUserAgent } from "../../src/providers/operations/client-versions";

type MediaCommand = "image" | "video" | "video-status";

interface MediaOptions {
  readonly command: MediaCommand;
  readonly prompt?: string;
  readonly model?: string;
  readonly size: string;
  readonly output?: string;
  readonly credentialsFile?: string;
  readonly account?: string;
  readonly taskId?: string;
  readonly waitForVideo: boolean;
  readonly timeoutSeconds: number;
  readonly baseUrl: string;
}

interface ProviderEnvelope {
  readonly code?: string | number;
  readonly msg?: string;
  readonly message?: string;
  readonly requestId?: string;
  readonly data?: unknown;
}

interface VideoTask {
  readonly id?: string;
  readonly status?: string;
  readonly url?: string;
}

const DEFAULT_BASE_URL = "https://www.codebuddy.ai/v2";
const DEFAULT_IMAGE_MODEL = "gpt-image-2.5-sunburst";
const DEFAULT_VIDEO_MODEL = "seedance-2.5";
const DEFAULT_IMAGE_SIZE = "1024x1024";
const VIDEO_POLL_INTERVAL_MS = 3_000;
const VALUE_OPTIONS = new Set([
  "--prompt",
  "--model",
  "--size",
  "--output",
  "--credentials",
  "--account",
  "--task-id",
  "--timeout-seconds",
  "--base-url",
]);

function usage(): string {
  return [
    "Generate CodeBuddy media directly and save finished files locally.",
    "",
    "Usage:",
    "  bun run scripts/tools/media.ts image --prompt \"A black cat on a sofa\" [options]",
    "  bun run scripts/tools/media.ts video --prompt \"A cat jumping onto a sofa\" [--no-wait] [options]",
    "  bun run scripts/tools/media.ts video-status --task-id <id> [options]",
    "",
    "Options:",
    "  --model <id>             Provider model (image: gemini-3.1-flash-image; video: seedance-2.5)",
    "  --size <WxH>             Image dimensions (default: 1024x1024)",
    "  --output <path>          Output file (default: a timestamped file on Desktop)",
    "  --credentials <path>     CodeBuddy account-export JSON",
    "  --account <label>        Account label from the export, when more than one is active",
    "  --base-url <url>         API base (default: https://www.codebuddy.ai/v2)",
    "  --no-wait                Return the task ID without polling (polling is on by default)",
    "  --timeout-seconds <n>    Video polling limit (default: 180)",
    "",
    "Authentication:",
    "  Set CODEBUDDY_ACCESS_TOKEN, or pass --credentials (and optionally --account).",
    "  Credentials are never printed. Generation requests are not retried automatically.",
  ].join("\n");
}

function parseOptions(args: string[]): MediaOptions | "help" {
  const [commandValue, ...rest] = args;
  if (commandValue === "--help" || commandValue === "-h" || commandValue === undefined) return "help";
  if (commandValue !== "image" && commandValue !== "video" && commandValue !== "video-status") {
    throw new Error(`Unknown command "${commandValue}". Run with --help for usage.`);
  }

  const values = new Map<string, string>();
  let waitForVideo = true;
  let waitOptionPresent = false;
  let noWaitOptionPresent = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--wait") {
      waitOptionPresent = true;
      continue;
    }
    if (argument === "--no-wait") {
      noWaitOptionPresent = true;
      waitForVideo = false;
      continue;
    }
    if (argument === "--help" || argument === "-h") return "help";
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument "${argument}".`);
    if (!VALUE_OPTIONS.has(argument)) throw new Error(`Unknown option "${argument}".`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  if (waitOptionPresent && noWaitOptionPresent) {
    throw new Error("--wait and --no-wait cannot be used together.");
  }
  if ((waitOptionPresent || noWaitOptionPresent) && commandValue !== "video") {
    throw new Error("Video wait options are only valid for video.");
  }
  if (values.has("--task-id") && commandValue !== "video-status") {
    throw new Error("--task-id is only valid for video-status.");
  }

  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? "180");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error("--timeout-seconds must be an integer from 1 to 3600.");
  }

  const baseUrl = values.get("--base-url") ?? process.env.CODEBUDDY_API_BASE ?? DEFAULT_BASE_URL;
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.hostname !== "127.0.0.1" && parsedBaseUrl.hostname !== "localhost") {
    throw new Error("--base-url must use HTTPS, except for localhost.");
  }
  const prompt = values.get("--prompt");
  const model = values.get("--model");
  const output = values.get("--output");
  const credentialsFile = values.get("--credentials");
  const account = values.get("--account");
  const taskId = values.get("--task-id");

  return {
    command: commandValue,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(model !== undefined ? { model } : {}),
    size: values.get("--size") ?? DEFAULT_IMAGE_SIZE,
    ...(output !== undefined ? { output } : {}),
    ...(credentialsFile !== undefined ? { credentialsFile } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    waitForVideo,
    timeoutSeconds,
    baseUrl: baseUrl.replace(/\/+$/, ""),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelopeOf(value: unknown): ProviderEnvelope {
  if (!isRecord(value)) throw new Error("Provider returned a non-object response.");
  return value;
}

async function accessTokenOf(options: MediaOptions): Promise<string> {
  const environmentToken = process.env.CODEBUDDY_ACCESS_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  const filePath = options.credentialsFile ?? process.env.CODEBUDDY_CREDENTIALS_FILE;
  if (!filePath) {
    throw new Error("Set CODEBUDDY_ACCESS_TOKEN or provide --credentials <export.json>.");
  }

  const parsed: unknown = JSON.parse(await readFile(resolve(filePath), "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) {
    throw new Error("Credential export must contain an accounts array.");
  }

  const accounts = parsed.accounts.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      entry.providerId === "cb" &&
      entry.status === "active" &&
      typeof entry.accessToken === "string" &&
      entry.accessToken.length > 0,
  );
  let account: Record<string, unknown> | undefined;
  if (options.account) {
    account = accounts.find((entry) => entry.label === options.account);
  } else if (accounts.length === 1) {
    account = accounts[0];
  }

  if (!account || typeof account.accessToken !== "string") {
    throw new Error(
      options.account
        ? "No active CodeBuddy account matched --account."
        : `Expected one active CodeBuddy account; found ${accounts.length}. Specify --account <label>.`,
    );
  }
  return account.accessToken;
}

function requestHeaders(token: string, accept: string): Headers {
  return new Headers({
    authorization: `Bearer ${token}`,
    accept,
    "content-type": "application/json",
    "user-agent": buildCodeBuddyUserAgent("IDE"),
    "x-product": "SaaS",
    "x-ide-type": "IDE",
    "x-ide-name": "IDE",
    "x-domain": "www.codebuddy.ai",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    "x-conversation-id": crypto.randomUUID(),
    "x-request-id": crypto.randomUUID().replaceAll("-", ""),
  });
}

async function requestJson(
  url: string,
  token: string,
  init: RequestInit,
): Promise<{ readonly response: Response; readonly payload: ProviderEnvelope }> {
  const response = await fetch(url, {
    ...init,
    headers: requestHeaders(token, init.headers instanceof Headers ? init.headers.get("accept") ?? "application/json" : "application/json"),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Provider returned HTTP ${response.status} with a non-JSON response.`);
  }
  const envelope = envelopeOf(payload);
  const providerCode = envelope.code;
  if (!response.ok || (providerCode !== undefined && providerCode !== 0 && providerCode !== "0")) {
    const message = envelope.msg ?? envelope.message ?? `HTTP ${response.status}`;
    const requestId = envelope.requestId ? ` (request ${envelope.requestId})` : "";
    throw new Error(`CodeBuddy request failed: ${message}${requestId}`);
  }
  return { response, payload: envelope };
}

function dataRecord(payload: ProviderEnvelope): Record<string, unknown> {
  if (!isRecord(payload.data)) throw new Error("Provider response did not contain a data object.");
  return payload.data;
}

function mediaUrl(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function imageExtension(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return ".gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return ".webp";
  if (bytes.subarray(4, 8).toString() === "ftyp" && ["avif", "avis"].includes(bytes.subarray(8, 12).toString())) return ".avif";
  return undefined;
}

function videoExtension(bytes: Buffer, contentType: string): string | undefined {
  if (bytes.subarray(4, 8).toString() === "ftyp") return ".mp4";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return ".webm";
  if (contentType.includes("quicktime")) return ".mov";
  return undefined;
}

function outputPath(options: MediaOptions, extension: string): string {
  if (options.output) {
    const target = resolve(options.output);
    const existingExtension = extname(target);
    if (existingExtension && existingExtension.toLowerCase() !== extension) {
      throw new Error(`Output extension ${existingExtension} does not match generated ${extension} media.`);
    }
    return existingExtension ? target : `${target}${extension}`;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(homedir(), "Desktop", `cartethyia-${options.command}-${timestamp}${extension}`);
}

async function downloadAndSave(
  url: string,
  options: MediaOptions,
  mediaType: "image" | "video",
): Promise<{ readonly path: string; readonly bytes: number; readonly mimeType: string }> {
  const mediaUrl = new URL(url);
  if (mediaUrl.protocol !== "https:") throw new Error("Provider returned a media URL that is not HTTPS.");
  const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Media download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
  const extension = mediaType === "image" ? imageExtension(bytes) : videoExtension(bytes, mimeType);
  if (!extension) throw new Error(`Downloaded response is not a recognized ${mediaType} file.`);

  const path = outputPath(options, extension);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return { path, bytes: bytes.length, mimeType };
}

async function generateImage(options: MediaOptions, token: string): Promise<void> {
  if (!options.prompt?.trim()) throw new Error("image requires --prompt.");
  const model = options.model ?? DEFAULT_IMAGE_MODEL;
  const { payload } = await requestJson(`${options.baseUrl}/images/generations`, token, {
    method: "POST",
    body: JSON.stringify({ model, prompt: options.prompt, size: options.size, n: 1 }),
  });
  const data = dataRecord(payload);
  const entries = Array.isArray(data.data) ? data.data : [];
  const image = entries.find(isRecord);
  if (!image) throw new Error("CodeBuddy accepted the image request but returned no image item.");

  const base64 = typeof image.b64_json === "string" ? image.b64_json : undefined;
  const url = mediaUrl(image, ["url", "image_url"]);
  let saved: { readonly path: string; readonly bytes: number; readonly mimeType: string };
  if (base64) {
    const bytes = Buffer.from(base64, "base64");
    const extension = imageExtension(bytes);
    if (!extension) throw new Error("Provider returned base64 data that is not a recognized image.");
    const path = outputPath(options, extension);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    saved = { path, bytes: bytes.length, mimeType: typeof image.mime_type === "string" ? image.mime_type : "image/unknown" };
  } else if (url) {
    saved = await downloadAndSave(url, options, "image");
  } else {
    throw new Error("CodeBuddy image response contained neither a URL nor base64 image data.");
  }

  console.log(JSON.stringify({ media: "image", model, ...saved }));
}

function videoTask(payload: ProviderEnvelope): VideoTask {
  const data = isRecord(payload.data) ? payload.data : {};
  const content = isRecord(data.content) ? data.content : {};
  const url = mediaUrl(content, ["video_url", "url"]) ?? mediaUrl(data, ["video_url", "url"]);
  return {
    ...(typeof data.id === "string" ? { id: data.id } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

async function pollVideoTask(
  options: MediaOptions,
  token: string,
  taskId: string,
): Promise<VideoTask> {
  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  let latest: VideoTask = { id: taskId };
  while (Date.now() < deadline) {
    console.error(`Polling video task ${taskId}${latest.status ? ` (${latest.status})` : ""}...`);
    const { payload } = await requestJson(
      `${options.baseUrl}/videos/generations/${encodeURIComponent(taskId)}`,
      token,
      { method: "GET", headers: new Headers({ accept: "application/json" }) },
    );
    const current = videoTask(payload);
    latest = { ...current, id: current.id ?? taskId };
    if (latest.url) {
      return latest;
    }
    const status = latest.status?.toLowerCase();
    if (status && !["queued", "pending", "running", "in_progress", "processing", "generating"].includes(status)) {
      throw new Error(`Video task ${taskId} ended with status "${latest.status}" but returned no video URL.`);
    }
    if (Date.now() + VIDEO_POLL_INTERVAL_MS >= deadline) break;
    await Bun.sleep(VIDEO_POLL_INTERVAL_MS);
  }
  return latest;
}

async function finishVideo(
  options: MediaOptions,
  task: VideoTask,
  model: string,
  timedOut = false,
): Promise<void> {
  if (task.url) {
    const saved = await downloadAndSave(task.url, options, "video");
    console.log(JSON.stringify({ media: "video", model, status: task.status ?? "completed", ...saved }));
    return;
  }

  console.log(JSON.stringify({
    media: "video",
    model,
    taskId: task.id,
    status: task.status ?? "unknown",
    ...(timedOut ? { timedOut: true } : { pollCommand: `video-status --task-id ${task.id ?? "<task-id>"}` }),
  }));
}

async function generateVideo(options: MediaOptions, token: string): Promise<void> {
  if (!options.prompt?.trim()) throw new Error("video requires --prompt.");
  const model = options.model ?? DEFAULT_VIDEO_MODEL;
  const { payload } = await requestJson(`${options.baseUrl}/videos/generations`, token, {
    method: "POST",
    body: JSON.stringify({ model, prompt: options.prompt }),
  });
  const task = videoTask(payload);
  if (!task.id && !task.url) throw new Error("CodeBuddy accepted the video request but returned no task ID or video URL.");
  const result = options.waitForVideo && task.id ? await pollVideoTask(options, token, task.id) : task;
  await finishVideo(options, result, model, options.waitForVideo && Boolean(task.id) && !result.url);
}

async function checkVideo(options: MediaOptions, token: string): Promise<void> {
  if (!options.taskId) throw new Error("video-status requires --task-id.");
  const { payload } = await requestJson(
    `${options.baseUrl}/videos/generations/${encodeURIComponent(options.taskId)}`,
    token,
    { method: "GET", headers: new Headers({ accept: "application/json" }) },
  );
  await finishVideo(options, videoTask(payload), options.model ?? DEFAULT_VIDEO_MODEL);
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  if (options === "help") {
    console.log(usage());
    return;
  }
  const token = await accessTokenOf(options);
  switch (options.command) {
    case "image":
      await generateImage(options, token);
      return;
    case "video":
      await generateVideo(options, token);
      return;
    case "video-status":
      await checkVideo(options, token);
      return;
    default: {
      const exhaustive: never = options.command;
      throw new Error(`Unhandled media command: ${exhaustive}`);
    }
  }
}

await main().catch((error: unknown) => {
  console.error(`media: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
