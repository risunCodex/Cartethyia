// Single-read ingress body policy: route table, size/media enforcement, depth cap.
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import { assertBoundedJsonDepth } from "../../protocol/codecs";
import type { ProxyRequestStateStore } from "../request/state";
import { fastPathname } from "../pathname";
import { NATIVE_SERVICE_PATHS, RESPONSES_COMPACT_PATH, TOKEN_COUNT_PATH } from "../contracts";
import { bodyTooLargeError } from "./guard-errors";

/** Whether this request is a gateway (`/v1/*`) request. */
export function isProxyRequest(request: Request): boolean {
  return fastPathname(request.url).startsWith("/v1/");
}

/**
 * Canonical JSON proxy routes that read a body through the ingress pipeline.
 *
 * This list must mirror the routes `app.ts` actually mounts. It drives
 * body-read policy — a JSON route rejects a missing or non-JSON content-type
 * with 415, while an unrouted path is not read at all — so an entry with no
 * handler behind it describes a route the gateway does not serve. Three such
 * entries (`/v1/embeddings`, `/v1/audio/transcriptions`, `/v1/audio/speech`)
 * were listed for a while with nothing mounted — they advertised a surface
 * that 404d — and the route-table test pinned them absent so re-adding one was
 * a deliberate act. They are mounted now, as passthrough surfaces.
 *
 * The native service routes (`NATIVE_SERVICE_PATHS` — System One, web search,
 * image and video generation) are included: they read a JSON body through the
 * same policy, but their bodies are opaque and are excluded from the canonical
 * parse stage (see `request-context.ts`).
 */
const PROXY_JSON_ROUTES = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/completions",
  RESPONSES_COMPACT_PATH,
  "/v1/messages",
  // Reads a JSON body through the ingress policy but skips the canonical chat
  // stage — see `isOpaqueBodyRoute`. Listed here because this table must mirror
  // what `app.ts` mounts: without the entry the body would not be read at all.
  TOKEN_COUNT_PATH,
  "/v1/images/generations",
  ...NATIVE_SERVICE_PATHS,
] as const;

/** Whether `path` is one of the canonical JSON proxy routes. */
function isJsonProxyRoute(path: string): boolean {
  return (PROXY_JSON_ROUTES as readonly string[]).includes(path);
}

/**
 * Whether `path` is a provider-dispatching route. Discovery/surface routes
 * such as `/v1/models` are authenticated gateway routes but never dispatch, so
 * they must not be reported as proxy request lifecycle events or enqueue
 * telemetry rows.
 */
export function isProxyDispatchRoute(path: string | undefined): path is string {
  return path !== undefined && isJsonProxyRoute(path);
}

export function isJsonProxyRoutePath(path: string): boolean {
  return isJsonProxyRoute(path);
}

interface IngressPolicyOptions {
  readonly maxBodyBytes?: number;
}

/** Reads a proxy body exactly once and enforces its encoded size and media type. */
export async function readIngressBody(
  request: Request,
  options: IngressPolicyOptions = {},
): Promise<unknown> {
  if (!isProxyRequest(request)) return undefined;
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const p = fastPathname(request.url);
  const isJsonRoute = isJsonProxyRoute(p);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType) {
    if (isJsonRoute) throw new GatewayError("unsupported_media_type", 415, "This endpoint reads JSON, so the request needs a content-type: application/json header (request {requestId}). We speak JSON here — send JSON 💬");
    return undefined;
  }
  if (contentType !== "application/json") {
    if (isJsonRoute) throw new GatewayError("unsupported_media_type", 415, `This endpoint reads JSON and cannot parse '${contentType}' (request {requestId}). Send content-type: application/json. We speak JSON here — send JSON 💬`);
    return undefined;
  }
  const maxBytes = options.maxBodyBytes ?? 1_048_576;
  const declared = request.headers.get("content-length");
  const parsed = declared === null ? undefined : Number(declared);
  if (declared !== null && (!/^\d+$/.test(declared) || parsed === undefined || parsed > maxBytes))
    throw bodyTooLargeError(maxBytes);

  const reader = request.body?.getReader();
  if (!reader) throw new GatewayError("invalid_request", 400, "The request body could not be read (request {requestId}). Resend it with a JSON body. Check the shape of what you sent — then resend 🪞");
  // Collect raw chunks then decode once. String `+=` on each chunk reallocates
  // the accumulating UTF-16 string (O(n²) for large Claude Code prompts);
  // Buffer.concat + one TextDecoder pass is linear and allocation-stable.
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw bodyTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    // The oversize branch above cancels the reader, and `cancel()` releases
    // the lock itself — releasing again throws ERR_INVALID_STATE, which would
    // replace the intended 413 with an opaque runtime error.
    try {
      if (request.body?.locked) reader.releaseLock();
    } catch {
      // Already released by cancel().
    }
  }
  try {
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const body = JSON.parse(text) as unknown;
    assertBoundedJsonDepth(body);
    return body;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("invalid_request", 400, "The request body is not valid JSON (request {requestId}). Check for a trailing comma or an unclosed brace. Check the shape of what you sent — then resend 🪞");
  }
}

export function createIngressPolicyMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly maxBodyBytes?: number;
}): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const state = deps.stateStore.get(request);
      if (!state) return;
      state.ingressBody = await readIngressBody(
        request,
        ...(deps.maxBodyBytes === undefined ? [] : [{ maxBodyBytes: deps.maxBodyBytes }]),
      );
    })
    .as("plugin");
}
