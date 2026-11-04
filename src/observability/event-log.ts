import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveTelemetryRetentionDays } from "../config/telemetry";
import { resolveDataDir } from "../persistence/db-mode";
import { hourStamp } from "../shared/time";

/**
 * Per-request telemetry lives in hourly JSONL files, not in Postgres. The
 * database keeps only the durable aggregate; the files are the single source
 * for recent requests and readers must go through this module, not a
 * `telemetry_events` table.
 */
/**
 * Where raw hourly event files live.
 *
 * Resolved from the configured data directory, never relative to the working
 * directory: the gateway can be started from anywhere, and a relative path
 * makes the written history depend on where the operator happened to be —
 * start it from another folder and every past request reads as zero, because
 * the files were written somewhere else entirely.
 */
export const TELEMETRY_EVENT_DIR = join(resolveDataDir(), "telemetry-events");

export interface TelemetryEventRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly tenantId?: string;
  readonly requestId: string;
  readonly sourceSurface: string | null;
  readonly requestedModel: string | null;
  /** The model the upstream named in its own response; null when it named none. */
  readonly reportedModel: string | null;
  readonly requestedEffort: string | null;
  readonly providerId: string | null;
  readonly accountId: string | null;
  readonly networkPoolId: string | null;
  readonly endpoint: string | null;
  readonly apiKeyId: string | null;
  readonly userAgent: string | null;
  readonly clientIp: string | null;
  readonly latencyMs: number | null;
  readonly ttfbMs: number | null;
  readonly stream: boolean | null;
  readonly status: string | null;
  readonly httpStatus: number | null;
  readonly errorOrigin: string | null;
  readonly errorCategory: string | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly creditUsed: number | null;
  readonly resolveMs: number | null;
  readonly tokensPerSec: number | null;
  readonly firstContentDeltaAtMs: number | null;
  readonly lastEventAtMs: number | null;
  /** Why the drawer payloads are empty, or `captured`; absent when unrecorded. */
  readonly payloadCaptureState?: string | null;
  /**
   * True for a completed request whose output was far smaller than the model's
   * ceiling and which ended with an ordinary `stop` (a "degenerate stop").
   * NULL/unset for everything else.
   */
  readonly degenerateStop?: boolean;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0 && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalize(raw: Record<string, unknown>): TelemetryEventRecord | undefined {
  const tenantId = asString(raw["tenantId"]);
  const requestId = asString(raw["requestId"]);
  const createdAt = asString(raw["createdAt"]);
  // No time means the row cannot be ordered or aged out. Inventing one made
  // every undated row reappear as "just now" on each read.
  if (!tenantId || !requestId || !createdAt) return undefined;
  return {
    id: asString(raw["id"]) ?? requestId,
    createdAt,
    tenantId,
    requestId,
    sourceSurface: asString(raw["sourceSurface"]),
    requestedModel: asString(raw["requestedModel"]),
    reportedModel: asString(raw["reportedModel"]),
    requestedEffort: asString(raw["requestedEffort"]),
    providerId: asString(raw["providerId"]),
    accountId: asString(raw["accountId"]),
    networkPoolId: asString(raw["networkPoolId"]),
    endpoint: asString(raw["endpoint"]),
    apiKeyId: asString(raw["apiKeyId"]),
    userAgent: asString(raw["userAgent"]),
    clientIp: asString(raw["clientIp"]),
    latencyMs: asNumber(raw["latencyMs"]),
    ttfbMs: asNumber(raw["ttfbMs"]),
    stream: typeof raw["stream"] === "boolean" ? raw["stream"] : null,
    status: asString(raw["status"]),
    httpStatus: asNumber(raw["httpStatus"]),
    errorOrigin: asString(raw["errorOrigin"]),
    errorCategory: asString(raw["errorCategory"]),
    inputTokens: asNumber(raw["inputTokens"]),
    cachedInputTokens: asNumber(raw["cachedInputTokens"]),
    outputTokens: asNumber(raw["outputTokens"]),
    reasoningTokens: asNumber(raw["reasoningTokens"]),
    estimatedCostUsd: asNumber(raw["estimatedCostUsd"]),
    creditUsed: asNumber(raw["creditUsed"]),
    resolveMs: asNumber(raw["resolveMs"]),
    tokensPerSec: asNumber(raw["tokensPerSec"]),
    firstContentDeltaAtMs: asNumber(raw["firstContentDeltaAtMs"]),
    lastEventAtMs: asNumber(raw["lastEventAtMs"]),
    ...(raw["degenerateStop"] === true ? { degenerateStop: true } : {}),
  };
}

/**
 * The comparable hour of an event file's name.
 *
 * A name is either `2026-10-22T05-15.jsonl` (an older window file) or
 * `2026-10-22.events.jsonl` (a day file). Both sort against `hourStamp`: only
 * the leading date and hour are taken, so the day file's `.events` suffix cannot
 * make it compare as later or earlier than the window files beside it.
 */
function eventFileHour(file: string): string {
  const stamp = file.endsWith(".events.jsonl") ? `${file.slice(0, 10)}T00` : file.slice(0, 13);
  return stamp;
}

/** Chunk size for the streaming scan: one line can be long, a file cannot. */
const READ_CHUNK_BYTES = 256 * 1024;

/**
 * The newest matching events in one file, read backwards from the end.
 *
 * Reads fixed blocks from the tail until the page is full, so a day file of any
 * size costs one block per page rather than a full parse. A partial line at the
 * very end is dropped: the writer may still be appending to it.
 */
async function* readEventFileTail(
  file: string,
  tenantId: string | undefined,
  want: number,
  since: number | undefined,
  until: number | undefined,
): AsyncGenerator<TelemetryEventRecord> {
  if (want <= 0) return;
  const handle = await open(join(TELEMETRY_EVENT_DIR, file), "r").catch(() => undefined);
  if (handle === undefined) return;
  try {
    const size = (await handle.stat().catch(() => undefined))?.size ?? 0;
    if (size === 0) return;
    const BLOCK = 64 * 1024;
    let end = size;
    let carry = "";
    const found: TelemetryEventRecord[] = [];
    while (end > 0 && found.length < want) {
      const start = Math.max(0, end - BLOCK);
      const length = end - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const text = buffer.toString("utf8") + carry;
      const lines = text.split("\n");
      carry = lines.shift() ?? "";
      // Newest first: the block was read from the end, so its lines run
      // backwards through the file.
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? "";
        if (line.length === 0) continue;
        if (tenantId !== undefined && !line.includes(tenantId)) continue;
        let parsed: TelemetryEventRecord | undefined;
        try {
          const value: unknown = JSON.parse(line);
          if (typeof value === "object" && value !== null) {
            parsed = value as TelemetryEventRecord;
          }
        } catch {
          continue;
        }
        if (parsed === undefined) continue;
        if (parsed.tenantId !== tenantId) continue;
        const at = Date.parse(parsed.createdAt);
        if (Number.isFinite(at)) {
          if (since !== undefined && at < since) continue;
          if (until !== undefined && at > until) continue;
        }
        found.push(parsed);
        if (found.length >= want) break;
      }
      end = start;
    }
    for (const event of found) yield event;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function* readEventFiles(
  files: readonly string[],
  allow?: (line: string) => boolean,
): AsyncGenerator<TelemetryEventRecord> {
  for (const file of files) {
    const handle = await open(join(TELEMETRY_EVENT_DIR, file), "r").catch(() => undefined);
    if (handle === undefined) continue;
    // Chunked, because `readFile` + `split` held the whole file as a string plus
    // an array of one string per line — several times the file's size, per
    // concurrent read, on the same process that serves every request. Peak
    // memory is now one chunk and one line.
    const decoder = new TextDecoder();
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let carry = "";
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES);
        if (bytesRead === 0) break;
        const text = carry + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        const lines = text.split(String.fromCharCode(10));
        // The tail is a partial line unless the chunk ended exactly on a newline.
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          // A line that cannot match is skipped before `JSON.parse`. The log is
          // shared by every tenant, so most of its bytes belong to someone else —
          // parsing them was the entire cost of a console read.
          if (allow !== undefined && !allow(line)) continue;
          try {
            const event = normalize(JSON.parse(line) as Record<string, unknown>);
            if (event) yield event;
          } catch {
            // A torn tail from a crash is skipped, not fatal. The next line stands alone.
          }
        }
      }
      if (carry.length > 0) {
        const line = carry + decoder.decode();
        if (allow === undefined || allow(line)) {
          try {
            const event = normalize(JSON.parse(line) as Record<string, unknown>);
            if (event) yield event;
          } catch {
            // A torn tail from a crash is skipped, not fatal.
          }
        }
      }
    } finally {
      await handle.close();
    }
  }
}

/** Reads every retained event, newest first. A missing directory is an empty log. */
export async function readTelemetryEvents(): Promise<TelemetryEventRecord[]> {
  const files = await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]);
  const events: TelemetryEventRecord[] = [];
  for await (const event of readEventFiles(files.filter((file) => file.endsWith(".jsonl")))) events.push(event);
  events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return events;
}

interface EventQuery {
  readonly tenantId?: string;
  readonly since?: Date;
  /**
   * Exclusive upper bound on `createdAt`, used to push a pagination cursor into
   * the query instead of filtering after the whole window was parsed. Without
   * it a cursor page drops `limit` — the reader cannot know where the page
   * ends — so only the first page of a list is bounded.
   */
  readonly until?: Date;
  readonly apiKeyIds?: readonly string[];
  readonly accountIds?: readonly string[];
  readonly requestId?: string;
  /**
   * Distinct from {@link requestId}: `id` defaults to the request id when a row
   * does not carry one of its own (`event-log.ts:68`), so a row can match by
   * either. A lookup by `id` short-circuits like `requestId` does, which is the
   * whole point — without it a single-event detail read parses the retention
   * window and then scans it in JS.
   */
  readonly id?: string;
  readonly httpStatus?: number;
  readonly limit?: number;
}

function matches(event: TelemetryEventRecord, query: EventQuery, since: number | undefined, until: number | undefined, keys: ReadonlySet<string> | undefined, accounts: ReadonlySet<string> | undefined): boolean {
  if (query.tenantId !== undefined && event.tenantId !== query.tenantId) return false;
  const at = new Date(event.createdAt).getTime();
  if (since !== undefined && at < since) return false;
  if (until !== undefined && at > until) return false;
  if (keys && (event.apiKeyId === null || !keys.has(event.apiKeyId))) return false;
  if (accounts && (event.accountId === null || !accounts.has(event.accountId))) return false;
  if (query.requestId !== undefined && event.requestId !== query.requestId) return false;
  if (query.id !== undefined && event.id !== query.id) return false;
  if (query.httpStatus !== undefined && event.httpStatus !== query.httpStatus) return false;
  return true;
}

/** The events matching a query, already newest first. */
export async function queryTelemetryEvents(query: EventQuery): Promise<TelemetryEventRecord[]> {
  // Hourly request files only. A `.compacted.jsonl` also ends in `.jsonl`, and
  // letting one through meant every summary row was parsed as if it were a
  // request — a row with no `tenantId`/`createdAt` that then failed `matches`,
  // but only after paying for the parse.
  //
  // The lower bound is the retention window, not just `since`: a caller that
  // asks for all time still must not scan files that have already been aged
  // out, and one that passes no `since` at all must not read every file ever
  // written. Retention removes whole raw files; no summary is substituted.
  const retentionFloor = hourStamp(
    new Date(Date.now() - resolveTelemetryRetentionDays() * 24 * 60 * 60_000),
  );
  const sinceFloor =
    query.since === undefined ? retentionFloor : hourStamp(query.since);
  const floor = sinceFloor > retentionFloor ? sinceFloor : retentionFloor;
  const files = (await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]))
    .filter(
      (file) =>
        file.endsWith(".jsonl") &&
        !file.endsWith(".compacted.jsonl") &&
        eventFileHour(file) >= floor,
    )
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const since = query.since?.getTime();
  const until = query.until?.getTime();
  const keys = query.apiKeyIds ? new Set(query.apiKeyIds) : undefined;
  const accounts = query.accountIds ? new Set(query.accountIds) : undefined;
  const events: TelemetryEventRecord[] = [];
  // The tenant and request ids are plain substrings of the stored line, so they
  // are checked on the raw text: a UUID appearing anywhere in the row is that
  // field, and a false negative is not possible while a false positive costs
  // only the parse it would have paid anyway.
  const allow =
    query.tenantId === undefined && query.requestId === undefined && query.id === undefined
      ? undefined
      : (line: string): boolean =>
          (query.tenantId === undefined || line.includes(query.tenantId)) &&
          (query.requestId === undefined || line.includes(query.requestId)) &&
          (query.id === undefined || line.includes(query.id));
  // A single-row lookup: stop at the first (newest) match instead of parsing
  // the whole retention window.
  const oneRow = query.requestId !== undefined || query.id !== undefined;
  // With one file per hour, a plain page of the newest rows does not need to
  // parse the whole retention window to return fifty lines. When nothing filters on
  // content — no status, no key, no account — the newest rows are the last
  // lines, so they are read backwards from the end and the scan stops once the
  // page is full.
  const tailOnly =
    query.limit !== undefined &&
    !oneRow &&
    query.httpStatus === undefined &&
    query.apiKeyIds === undefined &&
    query.accountIds === undefined;
  if (tailOnly) {
    const newest: TelemetryEventRecord[] = [];
    for (const file of files) {
      for await (const event of readEventFileTail(file, query.tenantId, query.limit - newest.length, since, until)) {
        newest.push(event);
      }
      if (newest.length >= query.limit) break;
    }
    return newest.slice(0, query.limit);
  }
  for (const file of files) {
    const matched: TelemetryEventRecord[] = [];
    for await (const event of readEventFiles([file], allow)) {
      if (!matches(event, query, since, until, keys, accounts)) continue;
      matched.push(event);
      if (oneRow) return matched;
    }
    matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    events.push(...matched);
    if (query.limit !== undefined && events.length >= query.limit) return events.slice(0, query.limit);
  }
  return events;
}

interface EventTotals {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  truncated: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  estimatedCost: number;
  unpriced: number;
  latencySum: number;
  latencyCount: number;
  tokensPerSecSum: number;
  tokensPerSecCount: number;
}

export function emptyTotals(): EventTotals {
  return { requests: 0, succeeded: 0, failed: 0, cancelled: 0, truncated: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, estimatedCost: 0, unpriced: 0, latencySum: 0, latencyCount: 0, tokensPerSecSum: 0, tokensPerSecCount: 0 };
}

/**

/** Folds one event into a totals bucket. `failed` counts any non-completed terminal status. */
export function accumulate(totals: EventTotals, event: TelemetryEventRecord): void {
  totals.requests += 1;
  if (event.status === "completed") totals.succeeded += 1;
  else if (event.status === "cancelled") totals.cancelled += 1;
  else if (event.status === "truncated") totals.truncated += 1;
  else if (event.status !== null) totals.failed += 1;
  totals.inputTokens += event.inputTokens ?? 0;
  totals.cachedTokens += event.cachedInputTokens ?? 0;
  totals.outputTokens += event.outputTokens ?? 0;
  if (event.estimatedCostUsd !== null) totals.estimatedCost += event.estimatedCostUsd;
  else if (event.status === "completed") totals.unpriced += 1;
  if (event.latencyMs !== null) { totals.latencySum += event.latencyMs; totals.latencyCount += 1; }
  if (event.tokensPerSec !== null) { totals.tokensPerSecSum += event.tokensPerSec; totals.tokensPerSecCount += 1; }
}

