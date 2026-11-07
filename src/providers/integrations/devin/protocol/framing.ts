/**
 * Devin (Codeium Cascade) Connect framing.
 *
 * Connect protocol over HTTP/1.1: a request body is a single frame
 * `[flags 1 byte][length 4 bytes BE][payload]`; the response is a stream of
 * the same frames. Flags: 0x01 = payload gzip-compressed, 0x02 = end-of-
 * stream (trailer JSON). Ported from oh-my-pi / opencode-devin-provider
 * (MIT) and adapted to Cartethyia.
 */

import { randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const CONNECT_COMPRESSED_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;

/** Cap on one frame payload, guarding against a hostile length prefix. */
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

/** Request bodies at or above this size are gzip-compressed. */
export const MIN_COMPRESSED_BODY_BYTES = 1024;

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

/** Encodes one payload into a Connect frame, compressing when `compress` is set. */
export function encodeFrame(payload: Uint8Array, compress: boolean): Buffer {
  const useCompression = compress && payload.byteLength >= MIN_COMPRESSED_BODY_BYTES;
  const body = useCompression ? gzipSync(payload) : Buffer.from(payload);
  const flags = useCompression ? CONNECT_COMPRESSED_FLAG : 0;
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

/** Decompresses a frame payload if its compressed flag is set. */
export function deframe(payload: Uint8Array, compressed: boolean): Buffer {
  return compressed ? gunzipSync(payload) : Buffer.from(payload);
}

/**
 * Incremental frame reader over a byte stream. Consumes as many complete
 * frames as the input holds; a trailing partial frame is buffered until more
 * bytes arrive.
 */
export class ConnectFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): ConnectFrame[] {
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    const frames: ConnectFrame[] = [];
    for (;;) {
      if (this.#buffer.length < 5) break;
      const length = this.#buffer.readUInt32BE(1);
      if (length > MAX_CONNECT_FRAME_PAYLOAD) {
        throw new ConnectFrameError(`frame payload ${length} exceeds ${MAX_CONNECT_FRAME_PAYLOAD} cap`);
      }
      if (this.#buffer.length < 5 + length) break;
      frames.push(decodeFrame(this.#buffer.subarray(0, 5 + length)));
      this.#buffer = this.#buffer.subarray(5 + length);
    }
    return frames;
  }

  /** True when a partial frame is buffered (stream ended mid-frame). */
  get hasPartial(): boolean {
    return this.#buffer.length > 0;
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

/** Deterministic random UUID for execution ids (avoids importing node crypto in browser-safe paths). */
export function newExecutionId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
