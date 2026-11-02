// Connect streaming-protocol framing (https://connectrpc.com/docs/protocol).
//
// A Connect frame is a 5-byte envelope: 1 flag byte + 4-byte big-endian payload
// length + payload. Flag bit 0 marks a gzip-compressed payload, bit 1 marks an
// end-of-stream trailer. Compression and trailer semantics stay at the call
// sites; this module owns only the envelope arithmetic.

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
