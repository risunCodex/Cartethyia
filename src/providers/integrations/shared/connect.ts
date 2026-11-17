// Connect streaming-protocol framing (https://connectrpc.com/docs/protocol).
//
// A Connect frame is a 5-byte envelope: 1 flag byte + 4-byte big-endian payload
// length + payload. Flag bit 0 marks a gzip-compressed payload, bit 1 marks an
// end-of-stream trailer. This module owns the envelope arithmetic, the frame
// encode/decode, the incremental decoder, and the end-of-stream trailer parse.
// When to compress a body (the size threshold) is a per-surface policy and
// stays at the call sites; `encodeFrame` compresses exactly when asked.

import { gzipSync } from "node:zlib";

export const CONNECT_COMPRESSED_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;

/** Cap on one frame payload, guarding against a hostile length prefix. */
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

export class ConnectFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectFrameError";
  }
}

export interface ConnectFrame {
  readonly flags: number;
  readonly payload: Uint8Array;
  readonly compressed: boolean;
}

/** Encodes one payload into a Connect frame, gzip-compressing when `compress` is set. */
export function encodeFrame(payload: Uint8Array, compress: boolean): Buffer {
  const body = compress ? gzipSync(payload) : Buffer.from(payload);
  const flags = compress ? CONNECT_COMPRESSED_FLAG : 0;
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/** Decodes one frame from a buffer containing exactly one frame. */
export function decodeFrame(buf: Buffer): ConnectFrame {
  if (buf.length < 5) {
    throw new ConnectFrameError(`frame shorter than 5-byte header (${buf.length})`);
  }
  const flags = buf[0]!;
  const length = buf.readUInt32BE(1);
  if (length > MAX_CONNECT_FRAME_PAYLOAD) {
    throw new ConnectFrameError(`frame payload ${length} exceeds ${MAX_CONNECT_FRAME_PAYLOAD} cap`);
  }
  const payload = buf.subarray(5, 5 + length);
  return {
    flags,
    payload,
    compressed: (flags & CONNECT_COMPRESSED_FLAG) !== 0,
  };
}

/**
 * Incremental frame reader over a byte stream. Consumes as many complete
 * frames as the input holds; a trailing partial frame is buffered until more
 * bytes arrive. Reassembly rides on {@link FrameBuffer} — appending into
 * spare capacity keeps a frame that spans many reads O(n), where prepending
 * the unconsumed tail to every chunk (`Buffer.concat([pending, chunk])`)
 * copies the entire partial frame each time.
 */
export class ConnectFrameDecoder {
  #frameBuffer = new FrameBuffer();

  push(chunk: Uint8Array): ConnectFrame[] {
    this.#frameBuffer.append(chunk);
    const frames: ConnectFrame[] = [];
    for (;;) {
      const view = this.#frameBuffer.view();
      if (view.length < 5) break;
      const length = view.readUInt32BE(1);
      if (length > MAX_CONNECT_FRAME_PAYLOAD) {
        throw new ConnectFrameError(`frame payload ${length} exceeds ${MAX_CONNECT_FRAME_PAYLOAD} cap`);
      }
      if (view.length < 5 + length) break;
      frames.push(decodeFrame(view.subarray(0, 5 + length)));
      this.#frameBuffer.consume(5 + length);
    }
    return frames;
  }

  /** True when a partial frame is buffered (stream ended mid-frame). */
  get hasPartial(): boolean {
    return this.#frameBuffer.view().length > 0;
  }
}

/** Parses the Connect end-of-stream trailer JSON: `{error:{code,message}}`. */
export interface ConnectTrailer {
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly details?: unknown;
}

export function parseTrailer(payload: Uint8Array): ConnectTrailer {
  const text = new TextDecoder().decode(payload).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as ConnectTrailer;
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Strips a Connect streaming envelope from a unary body when present.
 *
 * Unary Connect responses are normally raw protobuf, but some endpoints
 * answer with the 5-byte framed form (1 flag byte + 4-byte big-endian
 * length). The envelope is unambiguous when the length prefix describes
 * exactly the remainder, so raw payloads pass through untouched.
 */
export function stripConnectEnvelope(body: Uint8Array): Uint8Array {
  if (body.byteLength < 5) return body;
  const flags = body[0] ?? 0;
  const length =
    ((body[1] ?? 0) << 24) | ((body[2] ?? 0) << 16) | ((body[3] ?? 0) << 8) | (body[4] ?? 0);
  if (flags !== CONNECT_COMPRESSED_FLAG && flags !== CONNECT_END_STREAM_FLAG && flags !== 0) {
    return body;
  }
  if (length !== body.byteLength - 5) return body;
  return body.subarray(5);
}

/** Initial allocation for a frame buffer that has not received a chunk yet. */
const FRAME_BUFFER_MIN_BYTES = 4096;
/** Ceiling on the spare capacity kept above the live length when growing. */
const FRAME_BUFFER_SPARE_BYTES = 1024 * 1024;

/**
 * Growable byte buffer for reassembling Connect frames across stream reads.
 *
 * Appending into spare capacity costs one copy per byte, where prepending the
 * unconsumed tail to every read (`Buffer.concat([pending, chunk])`) copies the
 * entire partial frame on every chunk. A frame that spans many reads (the
 * payload cap allows up to 16 MiB) therefore costs O(n²) copying and peaks at
 * twice the frame size. `consume` only advances an offset, so dropping parsed
 * bytes moves nothing.
 *
 * The view returned by {@link view} is a subarray of the backing store and
 * stays valid until the next {@link append}, which may relocate the bytes.
 */
export class FrameBuffer {
  private buffer: Buffer = Buffer.alloc(0);
  private start = 0;
  private end = 0;

  /** The bytes received but not yet consumed. */
  view(): Buffer {
    return this.buffer.subarray(this.start, this.end);
  }

  /** Drops the first `count` bytes of the view without copying the rest. */
  consume(count: number): void {
    if (count <= 0) return;
    this.start = Math.min(this.start + count, this.end);
  }

  /** Appends `chunk`, growing the backing store when its tail is too small. */
  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const needed = this.end - this.start + chunk.byteLength;
    if (this.buffer.length - this.start < needed) this.grow(needed);
    this.buffer.set(chunk, this.end);
    this.end += chunk.byteLength;
  }

  private grow(needed: number): void {
    // Double while the frame is small so a chunk-per-read stream does not
    // reallocate every read, but hold the spare to a fixed ceiling once it is
    // large: doubling a multi-megabyte frame would allocate twice the frame
    // size, which is the peak this class exists to avoid.
    const capacity = Math.max(
      needed,
      Math.min(this.buffer.length * 2, needed + FRAME_BUFFER_SPARE_BYTES),
      FRAME_BUFFER_MIN_BYTES,
    );
    // Only [start, end) is ever exposed, so the uninitialised tail cannot leak.
    const next = Buffer.allocUnsafe(capacity);
    this.buffer.copy(next, 0, this.start, this.end);
    this.buffer = next;
    this.end -= this.start;
    this.start = 0;
  }
}
