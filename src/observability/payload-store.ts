import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import { hourStamp } from "../shared/time";

export interface PayloadFileReference {
  readonly storage: "jsonl-file";
  readonly file: string;
  readonly offset: number;
  readonly length: number;
  readonly checksum: string;
  readonly version: 1;
}

interface PayloadFrame {
  readonly version: 1;
  readonly id: string;
  readonly expiresAt: string;
  readonly payload: unknown;
}

function isPayloadFileReference(value: unknown): value is PayloadFileReference {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["storage"] === "jsonl-file" &&
    typeof record["file"] === "string" &&
    typeof record["offset"] === "number" &&
    typeof record["length"] === "number" &&
    typeof record["checksum"] === "string" &&
    record["version"] === 1
  );
}

/**
 * Builds a frame reference from a `telemetry_payloads` row's typed columns.
 * Returns undefined when any column is out of contract so callers treat a
 * corrupt index row as "no payload" rather than path-traversing or reading
 * the wrong bytes.
 */
export function payloadReferenceFromRow(row: {
  readonly storage: string;
  readonly file: string;
  readonly offset: number;
  readonly length: number;
  readonly checksum: string;
  readonly version: number;
}): PayloadFileReference | undefined {
  const candidate = {
    storage: row.storage,
    file: row.file,
    offset: row.offset,
    length: row.length,
    checksum: row.checksum,
    version: row.version,
  };
  return isPayloadFileReference(candidate) ? candidate : undefined;
}

/** Extension for frame files. */
const FRAME_FILE_SUFFIX = ".jsonl";

function isFrameFileName(name: string): boolean {
  return name.endsWith(FRAME_FILE_SUFFIX);
}

const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_DIRECTORY = "./data/telemetry-payloads";

/**
 * Backlog bounds for the payload writer: per-process, in front of the
 * append-only file writes.
 *
 * The writer used to be an unbounded promise chain: every capture appended
 * another link, so a slow disk (or a burst of large captures) accumulated
 * every waiting frame's bytes in memory with no ceiling — the exact
 * unbounded-growth failure this phase exists to remove. Items are counted
 * before queueing in their exact serialized frame bytes (the same buffers
 * that will be written), so 64 MiB of backlog means 64 MiB of real memory,
 * not an estimate.
 */
export const MAX_PAYLOAD_BACKLOG_ITEMS = 32;
export const MAX_PAYLOAD_BACKLOG_BYTES = 64 * 1024 * 1024;

/** Raised when the payload writer's backlog is at its bound. */
export class PayloadBacklogFullError extends Error {
  constructor(
    readonly boundedBy: "items" | "bytes",
  ) {
    super(`telemetry payload writer backlog full (${boundedBy})`);
    this.name = "PayloadBacklogFullError";
  }
}

interface BacklogEntry {
  readonly estimatedBytes: number;
  run: () => Promise<void>;
}

let backlog: BacklogEntry[] = [];
let backlogBytes = 0;
let draining = false;

/** Test/diagnostic seam: current backlog occupancy. */
export function payloadWriterBacklog(): { readonly items: number; readonly bytes: number } {
  return { items: backlog.length, bytes: backlogBytes };
}

/**
 * Runs the backlog to completion. One drain at a time: entries execute in
 * FIFO order, which preserves the append-only file semantics the previous
 * promise chain provided.
 */
function drainBacklog(): void {
  if (draining) return;
  draining = true;
  const step = (): void => {
    const entry = backlog.shift();
    if (entry === undefined) {
      draining = false;
      return;
    }
    backlogBytes -= entry.estimatedBytes;
    entry
      .run()
      .catch(() => undefined)
      .finally(() => step());
  };
  step();
}

/**
 * Single source of truth for the telemetry payload directory: the
 * `CARTETHYIA_TELEMETRY_PAYLOAD_DIR` override when set, otherwise the
 * default `./data/telemetry-payloads`. Every writer and reader must resolve
 * the directory through this function so the two can never drift.
 */
export function payloadDirectory(): string {
  return process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR?.trim() || DEFAULT_DIRECTORY;
}

function maxFileBytes(): number {
  const raw = Number(process.env.CARTETHYIA_TELEMETRY_PAYLOAD_FILE_MAX_BYTES ?? DEFAULT_MAX_FILE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_FILE_BYTES;
}

/**
 * Frame checksum.
 *
 * A byte-loop FNV-1a ran on the event loop — O(frame bytes) of pure JS per
 * capture, on buffers up to the frame cap. `crypto.createHash` is the runtime's
 * native path. The digest is hex-SHA-256 truncated to 16 hex chars: still far
 * stronger than FNV-32 for corruption detection, and short enough that the
 * `telemetry_payloads` column shape is unchanged.
 *
 * **Format note:** the frame `version` stays 1 because the checksum is a
 * stored reference field, not part of the frame bytes on disk — the reader
 * never re-verified the old FNV value against the file, and the new value is
 * written and read by the same deployed version. References written by the
 * FNV build (8 hex chars) and the new build (16 hex chars) coexist: the
 * checksum column is opaque identity, not a validated format.
 */
function checksum(value: Buffer | readonly Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of Array.isArray(value) ? value : [value]) hash.update(part);
  return hash.digest("hex").slice(0, 16);
}

function fileName(now = new Date()): string {
  return `${hourStamp(now)}-${process.pid}${FRAME_FILE_SUFFIX}`;
}

/**
 * Gzipped frame body.
 *
 * The pieces stay separate until the worker, because nothing before the
 * compression reads them assembled and joining them earlier is a copy of the
 * whole frame. The single join happens inside the compression step, and the
 * compressed buffer is what gets written, checksummed, and bounded — so the
 * cap and the reference both describe bytes on disk, not bytes of JSON.
 */
async function compressFrame(parts: readonly Buffer[]): Promise<Buffer> {
  const joined = Buffer.concat(parts);
  return compressAsync(joined);
}

/**
 * The compression worker: one per process, started lazily on the first
 * capture, at most {@link MAX_ACTIVE_COMPRESSION_JOBS} jobs in flight.
 *
 * `gzipSync` ran on the event loop: compressing a frame is O(frame bytes) of
 * native CPU, and a burst of large captures (a batch of retries finishing
 * together) stalled every request sharing the thread — a 1 MiB frame at
 * ~100 MB/s of gzip is ~10 ms of loop stall per capture, times the burst.
 * The worker turns that into background CPU; the semaphore keeps at most two
 * compressions running at once so a burst cannot pile unbounded memory into
 * the worker (each queued job holds its input buffer).
 *
 * Fallback: if the worker cannot start or dies, compression falls back to
 * synchronous gzip on the event loop — capture still works, which is what the
 * at-least-once frame contract requires; only the stall protection is lost.
 */
const MAX_ACTIVE_COMPRESSION_JOBS = 2;
let compressionWorker: Worker | undefined;
let workerBroken = false;
let activeCompressionJobs = 0;
const compressionQueue: (() => void)[] = [];

interface CompressionJob {
  readonly id: number;
  readonly input: Buffer;
  readonly resolve: (output: Buffer) => void;
  readonly reject: (error: Error) => void;
}
let nextJobId = 1;
const pendingJobs = new Map<number, CompressionJob>();

function ensureCompressionWorker(): Worker | undefined {
  if (workerBroken) return undefined;
  if (compressionWorker) return compressionWorker;
  try {
    // Inline worker via Blob URL: no separate source file to ship, no path
    // resolution to break in compiled/AOT builds. The worker body is the
    // minimal gzip service: postMessage({id, input}) -> {id, output} or {id, error}.
    const source = `
      const { gzipSync } = require("node:zlib");
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", (job) => {
        try {
          const output = gzipSync(Buffer.from(job.input));
          parentPort.postMessage({ id: job.id, output });
        } catch (error) {
          parentPort.postMessage({ id: job.id, error: String(error) });
        }
      });
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    compressionWorker = new Worker(url, { name: "payload-gzip" });
    compressionWorker.unref();
    compressionWorker.on("message", (message: { id: number; output?: Buffer; error?: string }) => {
      const job = pendingJobs.get(message.id);
      if (!job) return;
      pendingJobs.delete(message.id);
      releaseCompressionSlot();
      if (message.error !== undefined) job.reject(new Error(message.error));
      else job.resolve(message.output ?? Buffer.alloc(0));
    });
    compressionWorker.on("error", () => {
      // Worker died: fail every pending job and fall back to sync forever.
      workerBroken = true;
      compressionWorker = undefined;
      for (const job of pendingJobs.values()) {
        job.reject(new Error("payload compression worker failed"));
      }
      pendingJobs.clear();
    });
    return compressionWorker;
  } catch {
    workerBroken = true;
    return undefined;
  }
}

function releaseCompressionSlot(): void {
  activeCompressionJobs -= 1;
  const next = compressionQueue.shift();
  if (next) next();
}

async function compressAsync(input: Buffer): Promise<Buffer> {
  const worker = ensureCompressionWorker();
  if (!worker) return gzipSync(input);
  // Semaphore: wait for a free slot before queueing the job.
  if (activeCompressionJobs >= MAX_ACTIVE_COMPRESSION_JOBS) {
    await new Promise<void>((resolve) => compressionQueue.push(resolve));
  }
  activeCompressionJobs += 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const job: CompressionJob = {
        id: nextJobId++,
        input,
        resolve: (output) => resolve(output),
        reject: (error) => reject(error),
      };
      pendingJobs.set(job.id, job);
      worker.postMessage({ id: job.id, input }, [input.buffer.slice(
        input.byteOffset,
        input.byteOffset + input.byteLength,
      ) as ArrayBuffer]);
    });
  } catch {
    // A failed job still holds its slot until the worker's reply arrives or
    // the worker is declared broken; the sync fallback keeps the write alive.
    return gzipSync(input);
  } finally {
    // The slot is released by the worker's message handler, not here — but a
    // worker that never replies (broken before reply) leaks the slot. The
    // error path above declared the worker broken and drained the queue, so
    // a stale slot only outlives one job.
  }
}

async function appendFrame(frame: PayloadFrame, parts?: readonly Buffer[]): Promise<PayloadFileReference> {
  const directory = payloadDirectory();
  await mkdir(directory, { recursive: true });
  // Encoded as a line here rather than at the write, so the cap, the checksum,
  // and the reference all describe the same bytes that land on disk — the
  // prebuilt-parts path and the plain one cannot disagree about the shape.
  // Single copy: the prebuilt parts (or the one serialized buffer) go to the
  // compressor as-is; the join happens exactly once inside compressFrame.
  // The previous shape concatenated here and again inside compressFrame — two
  // full-frame copies before any bytes reached the worker.
  const compressed = await compressFrame(
    parts === undefined ? [Buffer.from(JSON.stringify(frame), "utf8")] : parts,
  );
  if (compressed.byteLength > MAX_FRAME_BYTES) throw new Error("telemetry payload frame exceeds limit");
  const encoded = toLine(compressed);
  const file = fileName();
  const path = join(directory, file);
  const currentSize = await stat(path).then((value) => value.size).catch(() => 0);
  const offset = currentSize;
  if (offset + encoded.byteLength > maxFileBytes()) {
    const rotated = `${Date.now()}-${randomUUID()}${FRAME_FILE_SUFFIX}`;
    return appendFrameToPath(join(directory, rotated), encoded, basename(rotated));
  }
  return appendFrameToPath(path, encoded, file, offset);
}

/**
 * One frame as a stored line: base64 of the gzipped JSON, newline-terminated.
 *
 * A newline is the frame delimiter, so the file is a text file of base64 lines
 * and a frame's extent is found by reading to the next `\n` — a binary length
 * header would make every frame opaque, unreadable without first decoding a
 * big-endian length and then gunzipping exactly that many bytes.
 *
 * base64 rather than raw gzip bytes because gzip contains newlines, which
 * would make the delimiter ambiguous.
 */
function toLine(compressed: Buffer): Buffer {
  return Buffer.from(`${compressed.toString("base64")}\n`, "utf8");
}

async function appendFrameToPath(
  path: string,
  encoded: Buffer,
  knownFile = basename(path),
  knownOffset?: number,
): Promise<PayloadFileReference> {
  const offset = knownOffset ?? await stat(path).then((value) => value.size).catch(() => 0);
  const handle = await open(path, "a");
  try {
    await handle.write(encoded);
  } finally {
    await handle.close();
  }
  return {
    storage: "jsonl-file",
    file: knownFile,
    offset,
    length: encoded.byteLength,
    checksum: checksum(encoded),
    version: 1,
  };
}

/**
 * The frame's body keys, in the same order `buildPayloadRecord` serializes
 * them.
 *
 * The record hands the writer one string per body already serialized, so the
 * two orders must agree or every body lands under the wrong key. The order is
 * drawer order with the legacy `response_body` alias last, for the same reason
 * the record accounts it last: it names no panel of its own and must not
 * spend the shared byte budget ahead of the provider stages.
 *
 * There are five, not four. `buildPayloadRecord` builds one string per surface
 * and `response_body` is the fifth — dropping it here wrote the frame with the
 * first four bodies and silently discarded the last, so a capture whose client
 * response was in the legacy slot came back with that panel empty.
 */
const FRAME_BODY_KEYS = [
  "request_body",
  "provider_request_body",
  "provider_response_body",
  "client_response_body",
  "response_body",
] as const;

/**
 * The pieces of a frame whose bodies were already serialized while measured.
 *
 * Returned as separate buffers rather than one assembled buffer: the file
 * write accepts a list, and assembling them first is a copy of the whole frame
 * that nothing reads back.
 */
function prebuiltFrameParts(
  id: string,
  expiresAt: string,
  capturedAt: string,
  requestId: string | null,
  signals: unknown,
  bodies: readonly string[],
): Buffer[] {
  const parts = [
    Buffer.from(
      `{"version":1,"id":${JSON.stringify(id)},"expiresAt":${JSON.stringify(expiresAt)},` +
        `"payload":{"request_id":${JSON.stringify(requestId)},"captured_at":${JSON.stringify(capturedAt)},` +
        `"expires_at":${JSON.stringify(expiresAt)}`,
      "utf8",
    ),
  ];
  for (let index = 0; index < FRAME_BODY_KEYS.length; index += 1) {
    parts.push(Buffer.from(`,"${FRAME_BODY_KEYS[index]}":${bodies[index] ?? "null"}`, "utf8"));
  }
  parts.push(Buffer.from(`,"signals":${JSON.stringify(signals)}}}`, "utf8"));
  return parts;
}

export function writePayloadFrame(
  payload: unknown,
  expiresAt: Date,
  prebuilt?: { readonly requestId: string | null; readonly capturedAt: string; readonly signals: unknown; readonly bodies: readonly string[] },
): Promise<PayloadFileReference> {
  const id = randomUUID();
  const expires = expiresAt.toISOString();
  const parts = prebuilt
    ? prebuiltFrameParts(id, expires, prebuilt.capturedAt, prebuilt.requestId, prebuilt.signals, prebuilt.bodies)
    : undefined;
  const frame: PayloadFrame = { version: 1, id, expiresAt: expires, payload };
  // Accounted in exact serialized frame bytes: the prebuilt parts are the
  // buffers that will be written; the non-prebuilt path serializes here once
  // (the same buffer the append would build anyway). Counting before queueing
  // is what makes the byte bound real rather than an estimate.
  const estimatedBytes = parts
    ? parts.reduce((total, part) => total + part.byteLength, 0)
    : Buffer.byteLength(JSON.stringify(frame), "utf8");
  if (backlog.length >= MAX_PAYLOAD_BACKLOG_ITEMS) {
    throw new PayloadBacklogFullError("items");
  }
  if (backlogBytes + estimatedBytes > MAX_PAYLOAD_BACKLOG_BYTES) {
    throw new PayloadBacklogFullError("bytes");
  }
  const task = new Promise<PayloadFileReference>((resolve, reject) => {
    // The entry settles the caller's promise itself: the drain loop's own
    // `.catch(() => undefined)` is only there so one failed write cannot
    // stop the rest of the backlog from running. Bytes are charged here, on
    // queue, and discharged when the entry starts running — the window
    // between is exactly the memory the bound exists to cap.
    backlogBytes += estimatedBytes;
    backlog.push({
      estimatedBytes,
      run: async () => {
        try {
          resolve(await appendFrame(frame, parts));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  });
  drainBacklog();
  return task;
}

export async function readPayloadFrame(reference: PayloadFileReference): Promise<unknown | undefined> {
  // Basename-constrain the reference: a hostile/restored row carrying
  // `../../x` must not escape the payload directory (path traversal).
  const safeFile = basename(reference.file);
  if (safeFile !== reference.file || safeFile.length === 0) return undefined;
  const path = join(payloadDirectory(), safeFile);
  // Read exactly the frame. Reading the whole file copied every earlier frame
  // in the same hour into memory just to return one of them.
  const handle = await open(path, "r");
  let data: Buffer;
  try {
    const stat = await handle.stat();
    if (reference.offset < 0 || reference.offset + reference.length > stat.size) return undefined;
    data = Buffer.alloc(reference.length);
    await handle.read(data, 0, reference.length, reference.offset);
  } finally {
    await handle.close();
  }
  const frame = data;
  const json = frameJsonFromSlice(frame);
  if (json === undefined) return undefined;
  const parsed = JSON.parse(json.toString("utf8")) as PayloadFrame;
  return parsed.version === 1 ? parsed.payload : undefined;
}

/** Decompressed frame body, or undefined when the bytes are not gzip. */
function gunzipFrame(stored: Buffer): Buffer | undefined {
  try {
    return gunzipSync(stored);
  } catch {
    return undefined;
  }
}

/**
 * The JSON of one frame read out of a file.
 *
 * A frame is a base64 line — base64 because gzip contains newlines, which would
 * make the newline delimiter ambiguous. The bytes are gunzipped only if they
 * are gzip; `gunzipFrame` returning `undefined` is what marks a slice as not a
 * frame.
 */
function frameJsonFromSlice(
  slice: Buffer,
): Buffer | undefined {
  // Frames are a base64 line. The trailing newline is not part of the payload.
  const text = slice.toString("utf8").trim();
  if (text.length === 0) return undefined;
  const gzipped = Buffer.from(text, "base64");
  return gunzipFrame(gzipped);
}

/**
 * What a whole file's parseable frames say about reclaiming it.
 *
 * `live` — at least one frame is still inside its retention window.
 * `none` — every frame was read and every one has expired.
 * `unknown` — parsing stopped on a torn tail or a corrupt frame, so the rest
 *   of the file is unreadable and cannot be assumed empty of live frames.
 */
type FrameLiveness = "live" | "none" | "unknown";

function frameLiveness(data: Buffer, before: Date): FrameLiveness {
  let offset = 0;
  while (offset < data.byteLength) {
    const newline = data.indexOf(0x0a, offset);
    if (newline <= 0) return "unknown";
    const end = newline + 1;
    const slice = data.subarray(offset, end);
    const json = frameJsonFromSlice(slice);
    if (json === undefined) return "unknown";
    let frame: PayloadFrame;
    try {
      frame = JSON.parse(json.toString("utf8")) as PayloadFrame;
    } catch {
      return "unknown";
    }
    if (new Date(frame.expiresAt).getTime() >= before.getTime()) return "live";
    offset = end;
  }
  // Bytes left over that are too short to hold a frame are an unreadable tail.
  return offset === data.byteLength ? "none" : "unknown";
}

/**
 * Reclaims frame files that no longer hold a live payload.
 *
 * Frames are append-only and this pass never rewrites a file. That is a
 * correctness requirement, not an optimization: a `telemetry_payloads` row
 * addresses its body by file + offset + length, so compacting a file in place
 * would shift every later frame and leave live rows pointing at the wrong
 * bytes — the drawer then reads `undefined` and the payload silently vanishes
 * while its row is still current. A file is dropped whole, and only once
 * nothing in it is still live.
 *
 * `unparseableWrittenBefore` bounds the damaged-file case. A region that
 * cannot be parsed cannot prove it holds no live frame, so such a file is kept
 * until its last write is older than that instant — every frame it could hold
 * was written before then and has therefore expired. A caller that cannot
 * supply that bound leaves the default, which keeps damaged files rather than
 * risk dropping a frame a row still addresses.
 *
 * One damaged file must not abort the pass. If a single corrupt frame threw
 * straight out of the loop, every other expired file would stay on disk
 * forever and the volume would only grow — and because a container restart is
 * the usual way a half-written tail appears, the failure would look
 * Docker-specific.
 */
export async function prunePayloadFrames(
  before: Date,
  unparseableWrittenBefore: Date = new Date(0),
): Promise<number> {
  const directory = payloadDirectory();
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !isFrameFileName(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      if (await fileReclaimable(path, before, unparseableWrittenBefore)) {
        await unlink(path);
        deleted += 1;
      }
    } catch {
      // Stat, read, or unlink failed on this one file. Leave it for the next
      // pass rather than abandoning every remaining file's reclaim.
    }
  }
  return deleted;
}

/**
 * True when the file can be deleted without losing a frame a row still
 * addresses. A readable file is reclaimable once every frame has expired; a
 * damaged one only once `unparseableWrittenBefore` rules out a live frame in
 * the part that could not be parsed.
 */
async function fileReclaimable(
  path: string,
  before: Date,
  unparseableWrittenBefore: Date,
): Promise<boolean> {
  const data = await readFile(path);
  // Nothing written yet, so nothing to lose. A real frame is far longer than
  // any header this format could carry.
  if (data.byteLength === 0) return true;
  const liveness = frameLiveness(data, before);
  if (liveness === "live") return false;
  if (liveness === "none") return true;
  const written = await stat(path).then((value) => value.mtimeMs);
  return written <= unparseableWrittenBefore.getTime();
}
