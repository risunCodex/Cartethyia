import type { LabImage } from "./protocol";

export type LabMediaIntent = "image" | "video";

export interface LabVideo {
  readonly name: string;
  readonly src: string;
}

export interface GeneratedMedia {
  readonly images?: readonly LabImage[];
  readonly videos?: readonly LabVideo[];
}

/** Reports when an explicit media request still needs its selected native worker. */
export function shouldFallbackToMediaWorker(
  intent: LabMediaIntent | undefined,
  calls: readonly { readonly name: string }[],
): boolean {
  return intent !== undefined && !calls.some((call) => call.name === `generate_${intent}`);
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm"]);
const MAX_BASE64_LENGTH = 20_000_000;

/** Question/explanation/discussion cues — these never describe a media request. */
const DISCUSSION_INDICATORS =
  /\b(how|what|why|when|which|who|where|explain|describe|tell me|cara|bagaimana|jelaskan|perbedaan|kenapa|apakah|mengapa|apa itu|diskusikan|belajar|panduan|tutorial)\b/i;

/** Technical context tokens between the action and the media noun indicate a
 *  software/UI discussion, not a request to produce media. */
const TECH_CONTEXT =
  /\b(program|code|function|api|script|pipeline|library|module|component|database|server|client|button|page|window|file|data|upload|process|analyze|convert|show|display|embed|render|automate|framework|system|interface|service|loop|array|variable|object|method|class|query|input|output|text-to-image|image-to-text|generation)\b/i;

/** Abstract targets that make a verb like draw/paint figurative rather than a request. */
const ABSTRACT_TARGETS = /\b(conclusion|conclusions|attention|parallel|analogy|comparison|distinction|similarity|difference|lesson|moral|insight|meaning|point|boundary)\b/i;

/** Detects an explicit image or video creation request without affecting ordinary chat. */
export function detectMediaIntent(prompt: string): LabMediaIntent | undefined {
  const normalized = prompt.toLocaleLowerCase().trim();
  if (normalized.length === 0) return undefined;
  // A question or explanation mentions media without requesting it — the
  // planner should answer it, not fire a generation tool.
  if (DISCUSSION_INDICATORS.test(normalized)) return undefined;

  const action = "(?:generate|create|make|draw|design|produce|animate|buat(?:kan)?|bikin|hasilkan)";
  const findRequest = (mediaWord: string, intent: LabMediaIntent): LabMediaIntent | undefined => {
    const match = new RegExp(`\\b(${action})\\b[\\s\\S]{0,60}\\b(${mediaWord})\\b`).exec(normalized);
    if (match === null) return undefined;
    // The text between the action verb and the media noun must read as one
    // direct request: a sentence boundary or a technical-context token means
    // the media word belongs to a discussion, not to the request.
    const between = normalized.slice(match.index + match[1]!.length, match.index + match[0]!.length - match[2]!.length);
    if (/[.!?;"\n]/.test(between)) return undefined;
    if (TECH_CONTEXT.test(between)) return undefined;
    return intent;
  };

  const video = findRequest("video|clip|movie|film|animation", "video");
  if (video !== undefined) return video;

  const image = findRequest(
    "image|picture|illustration|drawing|photo|photograph|gambar|ilustrasi|lukisan|foto|potret|logo|icon|wallpaper|poster|avatar|graphic",
    "image",
  );
  if (image !== undefined) return image;

  // Single verbs that directly request a drawing/painting. Only trust them on
  // short prompts: a long sentence using them is more likely figurative or a
  // discussion, and discussion indicators were already rejected above.
  if (normalized.length <= 120 && /\b(draw|sketch|paint|ilustrasikan|gambarkan)\b/.test(normalized)) {
    if (ABSTRACT_TARGETS.test(normalized)) return undefined;
    return "image";
  }
  return undefined;
}

/** Picks a preferred configured image worker, falling back to the first enabled model. */
export function preferredImageWorker(models: readonly string[]): string | undefined {
  const preferred = ["gemini-3-pro-image-preview", "gemini-3.1-flash-image", "gemini-3.1-flash-image-preview"];
  for (const model of preferred) {
    const match = models.find((candidate) => candidate.endsWith(`/${model}`) || candidate === model);
    if (match !== undefined) return match;
  }
  return models[0];
}

/** Parses a completed native image-generation response into safe browser sources. */
export function parseImageGenerationResponse(payload: unknown): readonly LabImage[] {
  const rows = responseRows(payload, "image");
  const images = rows.map((row, index) => {
    const mimeType = stringField(row, "mime_type") ?? stringField(row, "mimeType") ?? "image/png";
    const encoded = stringField(row, "b64_json");
    if (encoded !== undefined) {
      if (!IMAGE_MIME_TYPES.has(mimeType)) throw new Error(`The image-generation route returned unsupported media type "${mimeType}".`);
      return { name: `generated-${index + 1}.${fileExtension(mimeType)}`, dataUrl: `data:${mimeType};base64,${validateBase64(encoded)}` };
    }
    const url = stringField(row, "url");
    if (url !== undefined) {
      return { name: `generated-${index + 1}`, dataUrl: secureMediaUrl(url, "image") };
    }
    throw new Error("The image-generation route returned a malformed image result.");
  });
  if (images.length === 0) throw new Error("The image-generation route returned no image data.");
  return images;
}

/** Parses a completed native video-generation response into safe browser sources. */
export function parseVideoGenerationResponse(payload: unknown): readonly LabVideo[] {
  const rows = responseRows(payload, "video");
  const videos = rows.map((row, index) => {
    const url = stringField(row, "url") ?? stringField(row, "video_url");
    const mimeType = stringField(row, "mime_type") ?? stringField(row, "mimeType");
    if (url !== undefined) {
      return { name: `generated-${index + 1}.mp4`, src: secureMediaUrl(url, "video") };
    }
    const encoded = stringField(row, "b64_json");
    if (encoded !== undefined) {
      if (mimeType === undefined || !VIDEO_MIME_TYPES.has(mimeType)) {
        throw new Error(`The video-generation route returned unsupported media type "${mimeType ?? "unknown"}".`);
      }
      return { name: `generated-${index + 1}.${fileExtension(mimeType)}`, src: `data:${mimeType};base64,${validateBase64(encoded)}` };
    }
    throw new Error("The video-generation route returned a malformed video result.");
  });
  if (videos.length === 0) throw new Error("The video-generation route returned no video data.");
  return videos;
}

function responseRows(payload: unknown, kind: string): readonly Record<string, unknown>[] {
  const record = asRecord(payload);
  if (record === undefined) throw new Error(`The ${kind}-generation route returned a malformed response.`);
  const data = record.data;
  if (!Array.isArray(data)) {
    if (record.task_id !== undefined || isPending(record.status)) {
      throw new Error(`The ${kind}-generation route returned an asynchronous task without completed media.`);
    }
    throw new Error(`The ${kind}-generation route returned no media data.`);
  }
  if (
    (data.length === 0 && (record.task_id !== undefined || isPending(record.status))) ||
    data.some((item) => {
      const row = asRecord(item);
      return row !== undefined && isPending(row.status);
    })
  ) {
    throw new Error(`The ${kind}-generation route returned an asynchronous task without completed media.`);
  }
  return data.map((item) => {
    const row = asRecord(item);
    if (row === undefined) throw new Error(`The ${kind}-generation route returned a malformed media result.`);
    return row;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPending(value: unknown): boolean {
  return typeof value === "string" && ["queued", "pending", "processing", "running", "in_progress"].includes(value.toLowerCase());
}

function validateBase64(value: string): string {
  const unpadded = value.replace(/=+$/, "");
  const padding = value.length - unpadded.length;
  if (
    value.length === 0 ||
    value.length > MAX_BASE64_LENGTH ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    unpadded.length % 4 === 1 ||
    (padding > 0 && value.length % 4 !== 0)
  ) {
    throw new Error("The media-generation route returned invalid or oversized base64 data.");
  }
  return `${unpadded}${"=".repeat((4 - unpadded.length % 4) % 4)}`;
}

function secureMediaUrl(value: string, kind: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The ${kind}-generation route returned an invalid media URL.`);
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new Error(`The ${kind}-generation route must return a secure HTTPS media URL.`);
  }
  return url.toString();
}

function fileExtension(mimeType: string): string {
  return mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
}
