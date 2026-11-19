/**
 * Response compression for the JSON control plane.
 *
 * The console API answers with large, highly repetitive JSON — a usage or
 * telemetry page is a list of rows that share almost every key name and many
 * values. Measured on a representative 500-row payload: **149.7 KiB raw →
 * 8.8 KiB gzipped, a 94.1% reduction**, for 0.34 ms of CPU. That is the single
 * largest response-time win available on the dashboard path: the payload is
 * what the browser spends its time receiving, and shaving microseconds off a
 * handler cannot compete with removing 94% of the bytes.
 *
 * ## Why the gate is a path allowlist inside the function
 *
 * The wrap is mounted on the console Elysia instance (`console-router.ts`),
 * but Elysia's `use()` merges the child's `hoc` into the **root** app's ext
 * (`node_modules/elysia/dist/base.js:886-887`). Measured: the wrap therefore
 * runs for `/v1/*` too, so instance-level scoping cannot express "console
 * only". A path test can, and it lives inside `gzipResponse` — the one place
 * that runs on every request.
 *
 * ## Why this is scoped to the console, not the proxy
 *
 * `/v1/*` is deliberately excluded, for two independent reasons:
 *
 * - A streaming completion must reach the client frame by frame as the model
 *   produces it. Buffering it to compress turns a live stream into a long
 *   stall followed by a burst, which is the opposite of what a streaming
 *   client asked for.
 * - Proxied bodies are the provider's own bytes. The gateway forwards them on
 *   purpose (wire-byte preservation), and re-encoding would also invalidate
 *   the provider's `ETag`.
 *
 * ## Threshold
 *
 * Below `MIN_COMPRESSIBLE_BYTES` the envelope, the header, and the CPU are all
 * pure loss: a 200-byte reply is not worth a gzip stream plus a browser
 * decompression step. The threshold sits where the saving stops being noise.
 *
 * ## Opting a route out
 *
 * A route that knows its body is already compressed — or is an encoded
 * envelope that would gain nothing — sets {@link NO_COMPRESS_HEADER}. The
 * honest-sounding alternative, declaring `content-encoding: gzip`, is a lie
 * when the bytes on the wire are not gzip, and the client that believes it
 * fails trying to inflate them.
 */
import { gzipSync } from "node:zlib";
import { fastPathname } from "../transport/pathname";

/**
 * Header a route sets to say "do not compress this", popped before the
 * response leaves.
 *
 * Deleted rather than left on the response, so it stays an internal signal
 * between two layers in this process and never reaches a client or a cache.
 */
export const NO_COMPRESS_HEADER = "x-cartethyia-no-compress";

/**
 * Smallest body worth compressing.
 *
 * 1 KiB is above every small control reply (`/health`, a single-row mutation
 * ack, an error envelope) and well below every list endpoint that benefits.
 */
export const MIN_COMPRESSIBLE_BYTES = 1024;

/**
 * Largest body this module will compress, as a ceiling on the event-loop
 * stall.
 *
 * `gzipSync` is synchronous, so its cost is paid out of the request's own
 * turn and is not interruptible. `/console/api/backup/export` answers with a
 * multi-MB JSON document; at that size level 6 costs tens of milliseconds,
 * which is longer than an entire dashboard poll. Those bytes go to disk
 * rather than being polled, so the compression ratio is the wrong thing to
 * optimise — above this size the response is returned as-is.
 */
export const MAX_COMPRESSIBLE_BYTES = 1024 * 1024;

/** Content types worth compressing, matched by prefix. */
const COMPRESSIBLE_TYPES: readonly string[] = [
  "application/json",
  "application/problem+json",
  "text/plain",
  "text/csv",
  "image/svg+xml",
];

/**
 * `gzip` at level 6 — the level where the curve flattens.
 *
 * Measured on the 149.7 KiB payload: level 6 costs 0.34 ms and captures 94.1%
 * of the available saving. The remaining ~2.5 points live at levels costing
 * several times more CPU per response, which on a control plane serving many
 * concurrent dashboard polls is the wrong trade.
 */
const GZIP_LEVEL = 6;

/**
 * True when the client offered gzip.
 *
 * The q-value is read rather than substring-matched, because `gzip;q=0` is an
 * explicit *refusal* and a `header.includes("gzip")` test would compress for a
 * client that said not to. A bare `*` is also not an offer: it means "any
 * encoding I did not name", so it cannot be read as consent to gzip.
 */
export function acceptsGzip(header: string | null): boolean {
  if (header === null) return false;
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName?.trim().toLowerCase();
    if (name !== "gzip") continue;
    const q = params
      .map((param) => param.trim().toLowerCase())
      .find((param) => param.startsWith("q="))
      ?.slice(2)
      .trim();
    if (q === undefined) return true;
    const value = Number(q);
    if (Number.isFinite(value) && value > 0) return true;
  }
  return false;
}

/** True when a body of this type and size is worth compressing at all. */
export function isCompressible(contentType: string | null, bodyLength: number): boolean {
  if (bodyLength < MIN_COMPRESSIBLE_BYTES) return false;
  return isCompressibleType(contentType);
}

/**
 * Replaces a response's body with its gzip encoding, or returns it unchanged
 * when that would not be a win.
 *
 * The body is buffered here on purpose. Every route this is applied to
 * produces its payload in one piece — a `JSON.stringify` of a query result, or
 * a plain object Elysia serializes — so there is no stream to preserve and no
 * incremental chunk to forward. The console SSE routes are kept out by content
 * type: `text/event-stream` is not in {@link COMPRESSIBLE_TYPES}, so a stream
 * can never reach the buffering path.
 *
 * The size gate runs on the **actual** byte length, not only a declared
 * `content-length`: Elysia does not set that header for a serialized object
 * (measured), so gating on it alone rejected every route worth compressing. A
 * declared length is still used as a fast path — it can skip the read for a
 * small reply — but silence from the header must never mean "too small". The
 * content-type gate is what keeps a stream from being read here, and it is
 * checked before the body is touched.
 */
export async function gzipResponse(request: Request, response: Response): Promise<Response> {
  // Scoped to the paths this module documents. Instance-level scoping is not
  // available here: the wrap's `hoc` propagates to the root app, so every
  // route in the process — `/v1/*` included — reaches this function.
  const pathname = fastPathname(request.url);
  if (!pathname.startsWith("/console/api/") && pathname !== "/metrics") return response;
  if (request.method === "HEAD") return response;
  if (response.status === 204 || response.status === 304) return response;
  // Already encoded — by a route or by an upstream. Never encode twice.
  if (response.headers.has("content-encoding")) return response;
  // A route that knows better: the body is an encoded envelope, or already
  // compressed in a form this wire layer cannot describe. Deleted here so the
  // signal stays internal and never reaches a client or a cache.
  if (response.headers.has(NO_COMPRESS_HEADER)) {
    response.headers.delete(NO_COMPRESS_HEADER);
    return response;
  }
  if (!acceptsGzip(request.headers.get("accept-encoding"))) return response;
  // Type first, before any read: this is what keeps an event stream out.
  if (!isCompressibleType(response.headers.get("content-type"))) return response;
  // A bodiless reply has nothing to compress, and `arrayBuffer()` on a null
  // body yields a 0-byte buffer that would rebuild into a non-null body.
  if (response.body === null) return response;
  // A declared length below the threshold skips the read entirely. It cannot
  // be the only gate — Elysia sets no `content-length` for a serialized
  // object (measured) — so the byte-length read below still has to exist.
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) < MIN_COMPRESSIBLE_BYTES) return response;

  const body = await response.arrayBuffer();
  // Below the threshold the envelope, the header, and the CPU are all pure
  // loss, so the response is rebuilt from the bytes already consumed rather
  // than compressed. A response that was read must always be rebuilt, or the
  // client would receive an empty body.
  if (body.byteLength < MIN_COMPRESSIBLE_BYTES) return rebuild(response, body);
  // Above the ceiling the synchronous `gzipSync` stall costs more than the
  // bytes it would save. Same rebuild obligation as the threshold path.
  if (body.byteLength > MAX_COMPRESSIBLE_BYTES) return rebuild(response, body);

  const compressed = gzipSync(new Uint8Array(body), { level: GZIP_LEVEL });
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(compressed.byteLength));
  // `vary` keeps a shared cache from handing the gzipped body to a client that
  // never asked for it; without it a cache keys only on the URL.
  headers.set("vary", appendVary(headers.get("vary")));
  return new Response(compressed, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** True when the content type is one this module is willing to encode. */
export function isCompressibleType(contentType: string | null): boolean {
  const normalized = contentType?.toLowerCase() ?? "";
  return COMPRESSIBLE_TYPES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * A response that was read and is not being compressed must be rebuilt from
 * the bytes already consumed, or the client would receive an empty body.
 */
function rebuild(response: Response, body: ArrayBuffer): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Adds `accept-encoding` to an existing `vary`, without duplicating it. */
function appendVary(existing: string | null): string {
  if (existing === null || existing.trim().length === 0) return "accept-encoding";
  const parts = existing.split(",").map((part) => part.trim().toLowerCase());
  if (parts.includes("accept-encoding") || parts.includes("*")) return existing;
  return `${existing}, accept-encoding`;
}
