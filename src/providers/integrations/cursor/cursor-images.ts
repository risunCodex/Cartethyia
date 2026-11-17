// Image-input handling for the Cursor adapter: MIME sniffing, size caps,
// canonical image-part resolution (inline data URLs and validated HTTPS
// fetches), and image extraction from tool results.
//
// The policy is pure Cartethyia: a caller-supplied media type is a claim, so
// the MIME type is verified by sniffing the payload's magic bytes before it
// is compared against the declared type, and remote images are fetched only
// over HTTPS through the validated attachment egress with redirects refused.
import { GatewayError } from "../../../protocol/gateway-error";
import { resolveImageSource, splitDataUrl } from "../../../protocol/codecs";
import { IMAGE_CLAMP_MAX_BYTES } from "../../../protocol/image-clamp";
import type { ContentPart } from "../../../protocol/canonical-model";
import type { ProviderDispatchContext } from "../../provider-contracts";

/** Image MIME types Cursor accepts in `selected_images`. */
const ALLOWED_IMAGE_MIME_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
  "image/gif": true,
};

/** Largest image payload accepted, matching the shared pre-send clamp. */
const MAX_IMAGE_BYTES = IMAGE_CLAMP_MAX_BYTES;

/** One validated image ready for the Run wire (bytes + sniffed media type). */
export interface CursorImageInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

/** Identifies an allowed image payload from its magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function base64ToBytes(data: string): Uint8Array | undefined {
  try {
    const binary = atob(data);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Validates one decoded image payload.
 *
 * The MIME type is verified by sniffing and only then compared against the
 * declared type: a caller-supplied `content-type` or data-URL media type is a
 * claim, and sending bytes the upstream will reject — or bytes that are not an
 * image at all — fails the whole request rather than being dropped silently.
 */
function finishImage(bytes: Uint8Array): CursorImageInput {
  const sniffed = sniffImageMime(bytes);
  const mimeType = sniffed;
  if (mimeType === undefined || ALLOWED_IMAGE_MIME_TYPES[mimeType] !== true) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor accepts PNG, JPEG, WebP and GIF image input only (request {requestId}). Check the shape of what you sent — then resend 🪞",
    );
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new GatewayError(
      "invalid_request",
      400,
      `Cursor image input exceeds the ${MAX_IMAGE_BYTES}-byte limit (request {requestId}). We love long reads, but not that long 📚`,
    );
  }
  return { data: bytes, mimeType };
}

/**
 * Resolves one canonical image part into validated Cursor image bytes.
 *
 * Inline `data:` URLs are decoded and sniffed; HTTPS URLs are fetched through
 * the validated attachment egress with redirects refused (a public URL must
 * not be able to redirect the fetch at a private address). Everything else is
 * a rejected request, not a silently dropped attachment.
 */
export async function resolveCursorImageInput(
  part: Extract<ContentPart, { kind: "image" }>,
  context: ProviderDispatchContext,
): Promise<CursorImageInput> {
  const source = resolveImageSource(part.payload);
  const url = source?.url;
  if (url === undefined) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor image input requires inline image data or an HTTPS image URL",
    );
  }
  const dataUrl = splitDataUrl(url);
  if (dataUrl !== undefined) {
    const bytes = base64ToBytes(dataUrl.data);
    if (bytes === undefined) {
      throw new GatewayError("invalid_request", 400, "Cursor image attachment is not valid base64 (request {requestId}). Check the shape of what you sent — then resend 🪞");
    }
    return finishImage(bytes);
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor image URLs must be HTTPS; private and non-TLS sources are not fetched (request {requestId}). Check the shape of what you sent — then resend 🪞",
    );
  }
  const fetcher = context.outbound_attachment_fetch;
  if (fetcher === undefined) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor has no validated egress to fetch this image URL (request {requestId}). All roads blocked — time to find a new route 🗺️",
    );
  }
  // Redirects are not followed: reject the response rather than letting a
  // public URL redirect the attachment fetch to a private address.
  const response = await fetcher(url, {
    method: "GET",
    redirect: "manual",
    signal: context.abort_signal,
  });
  if (!response.ok) {
    throw new GatewayError(
      "invalid_request",
      400,
      `Cursor could not fetch this image URL (${response.status})`,
    );
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_IMAGE_BYTES) {
    throw new GatewayError(
      "invalid_request",
      400,
      `Cursor image input exceeds the ${MAX_IMAGE_BYTES}-byte limit (request {requestId}). We love long reads, but not that long 📚`,
    );
  }
  return finishImage(body);
}

/** One image-bearing block of a tool result, ready for `McpToolResultContentItem`. */
export interface ResultImage {
  readonly data: Uint8Array;
  readonly mimeType: string;
}
