import type { CartethyiaDatabase } from "../persistence/db-handle";
import { DrizzleTelemetryStore } from "../persistence/stores/telemetry-store";
import { PayloadBacklogFullError, prunePayloadFrames, writePayloadFrame } from "./payload-store";
import { resolveTelemetryPayloadMaxBytes } from "../config/telemetry";
import { metrics } from "./metrics";
import { preferencesReaderFor } from "../persistence/tenant-preferences";
import type {
  TelemetryPayloadDepth,
  TelemetryPayloadMode,
} from "../console/settings/contracts";
type CaptureScope = "tenant" | "debug_session" | "operator_flag";

/**
 * How long a captured payload frame lives when the deployment has not chosen.
 *
 * An hour, not fifteen minutes: a frame is the only record of what a request
 * actually sent and received, and the window is when an operator can still go
 * back and read it. Fifteen minutes is shorter than the time between noticing
 * a bad response and opening the drawer, so the frame was already gone by the
 * time someone looked for it. The cost is disk, which the Data Management
 * panel reports and a tenant can reclaim on demand.
 *
 * Exported so surfaces that report on disk usage quote the same window the
 * capture path enforces, rather than a second copy of the default that would
 * drift the first time this one changes.
 */
export function payloadRetentionMs(): number {
  const raw = Number(process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS ?? DEFAULT_PAYLOAD_RETENTION_MS);
  if (!Number.isFinite(raw) || raw < 1_000 || raw > MAX_PAYLOAD_RETENTION_MS) return DEFAULT_PAYLOAD_RETENTION_MS;
  return Math.floor(raw);
}

/**
 * The fallback window, exported so a test can assert the default without
 * pinning the number.
 *
 * A literal in a test is a veto on changing policy: the assertion fails the
 * moment the default moves, so the number stops being a choice and becomes
 * whatever the test happened to be written against.
 */
export const DEFAULT_PAYLOAD_RETENTION_MS = 60 * 60_000;

/** Upper bound for a deployment-level retention override, not a tenant setting. */
export const MAX_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Truncates a string to at most `maxBytes` UTF-8 bytes without splitting a
 * code point.
 *
 * The budget contract everywhere in this module is **bytes**, not UTF-16 code
 * units: `.length` on a CJK-heavy body counts one per character while the same
 * text costs three bytes on the wire and on disk, so a "1 MiB" cap kept ~3 MiB
 * of CJK content and dropped 3× more Latin content than the operator asked
 * for. Slicing at a raw byte boundary can split a multi-byte sequence; this
 * helper backs up to the last complete sequence so the truncated text stays
 * valid.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= maxBytes) return value;
  const sliced = Buffer.from(value, "utf8").subarray(0, maxBytes);
  // Walk back from the cut (at most 3 bytes: the longest UTF-8 sequence is 4
  // bytes) to the lead byte of the sequence the cut landed inside, then drop
  // that whole sequence. A cut that lands between sequences stays put.
  for (let back = 0; back < 4 && sliced.length - back > 0; back += 1) {
    const byte = sliced[sliced.length - back - 1]!;
    if ((byte & 0xc0) !== 0x80) {
      // This is a lead byte (or ASCII): the sequence it starts has n bytes.
      const sequenceLength =
        byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      // The cut is `back` bytes into this sequence. If the sequence does not
      // fully fit within the slice, drop the whole sequence.
      if (back + 1 < sequenceLength) {
        return sliced.subarray(0, sliced.length - back - 1).toString("utf8");
      }
      return sliced.toString("utf8");
    }
    // Continuation byte: the lead byte is further back.
  }
  // Degenerate slice of only continuation bytes: nothing complete to keep.
  return "";
}

/**
 * Settings-gated payload capture. Request-event metadata is always retained;
 * tenants opt into drawer capture through Settings → Privacy: `metadata`
 * keeps only the Proxy→Provider request line, `full` keeps redacted bodies
 * at the tenant's chosen depth. Their lifetime is the tenant's Request detail
 * window, or the deployment default when unset. Fail-closed on error.
 */
export async function resolvePayloadCapture(
  db: CartethyiaDatabase,
  tenantId: string | null,
): Promise<
  | {
      readonly ok: true;
      readonly mode: TelemetryPayloadMode;
      readonly depth: TelemetryPayloadDepth;
      readonly retentionMs: number;
    }
  | { readonly ok: false }
> {
  if (!tenantId) return { ok: false };
  try {
    const prefs = await preferencesReaderFor(db).readPreferences(tenantId);
    const mode = prefs?.telemetryPayloads;
    const depth = prefs?.telemetryPayloadDepth;
    const minutes = prefs?.telemetryWindowMinutes;
    const retentionMs =
      typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
        ? Math.min(MAX_PAYLOAD_RETENTION_MS, Math.floor(minutes * 60_000))
        : payloadRetentionMs();
    return {
      ok: true,
      mode: mode === "full" || mode === "metadata" || mode === "none" ? mode : "none",
      depth:
        depth === "minimum" || depth === "moderate" || depth === "maximum"
          ? depth
          : depth === "medium"
            ? "minimum"
            : depth === "high"
              ? "moderate"
              : depth === "full"
                ? "maximum"
                : "minimum",
      retentionMs,
    };
  } catch {
    // A preference read that fails must not invent capture. Off keeps nothing.
    // Reported as its own state rather than silently as `none`: an operator
    // whose capture is off by choice and one whose preference read is failing
    // need different fixes, and both would otherwise look like "not configured".
    return { ok: false };
  }
}

/**
 * Whether the tenant's capture mode keeps bodies (`full`). Both the
 * provider-response tee and the ingress-body release key off this: `none` and
 * `metadata` store no client request body, so the parsed ingress body can be
 * dropped once the canonical request exists instead of being held until
 * finalize — which, for a streaming response, is the whole stream.
 */
export async function payloadCaptureKeepsBodies(
  db: CartethyiaDatabase,
  tenantId: string | null,
): Promise<boolean> {
  const resolved = await resolvePayloadCapture(db, tenantId);
  return resolved.ok && resolved.mode === "full";
}

/**
 * Why one request's drawer payloads are empty.
 *
 * Every reason the drawer can read empty is named here, because from the
 * client the four panels look identical in all of them: an operator who turned
 * capture off and an operator whose capture is broken both see four blank
 * panels. Recording the reason is what makes remote diagnosis possible without
 * access to the server's logs.
 */
export type PayloadCaptureState =
  /** Bodies were captured for this request. */
  | "captured"
  /** Only the Proxy→Provider request line was kept (mode `metadata`). */
  | "captured_metadata"
  /** The tenant has capture switched off; request metadata is still retained. */
  | "skipped_mode_none"
  /** The request had no tenant, so no capture preference could be read. */
  | "skipped_no_tenant"
  /** The attempt was not the terminal one; the terminal attempt captures. */
  | "skipped_not_terminal"
  /** The preference read failed, and capture fails closed. */
  | "skipped_preference_read_failed"
  /** The storage write failed after the decision to capture. */
  | "failed_write"
  /** The payload writer's backlog was at its bound, so the frame was dropped. */
  | "failed_backlog";

export interface PayloadCaptureInput {
  tenantId: string;
  requestBody: unknown;
  responseBody: unknown;
  clientResponseBody?: unknown;
  providerRequestBody?: unknown;
  providerResponseBody?: unknown;
  /**
   * Combined body cap override for this capture (Settings → capture depth).
   * Defaults to the configured capture limit.
   */
  maxBytes?: number;
  /**
   * Retention for this capture; normally the deployment default. Bounded by
   * {@link MAX_PAYLOAD_RETENTION_MS} either way.
   */
  retentionMs?: number;
  scope: CaptureScope;
  /** Links the row to `telemetry_events.request_id`. */
  requestId?: string;
  // optional opt-in flags — exactly one must be true for `scope`, see `isCaptureAllowed`
  tenantOptIn?: boolean;
  debugSessionOptIn?: boolean;
  operatorFlagOptIn?: boolean;
}

interface PayloadSignals {
  readonly toolCalls: number;
  readonly images: number;
  readonly attachments: number;
}

interface StoredPayload {
  id: string;
  /**
   * JSON text of the five body surfaces, in drawer order, built while the
   * record was measured. Present only on a record that has not been persisted
   * yet; the frame writer consumes it so the bodies are not serialized twice.
   */
  _serialized?: readonly string[];
  request_id: string | null;
  captured_at: Date;
  expires_at: Date;
  request_body: unknown;
  response_body: unknown;
  client_response_body: unknown;
  provider_request_body: unknown;
  provider_response_body: unknown;
  /**
   * Bitmask of the stages whose body was kept: 1 request, 2 provider request,
   * 4 provider response, 8 client response. Written to its own column so the
   * Usage list can show which panels have content without inflating a frame
   * per row.
   */
  stages: number;
  signals: PayloadSignals;
}

/**
 * How long a captured payload frame lives.
 *
 * Exported so surfaces that report on disk usage quote the same window the
 * capture path enforces, rather than a second copy of the default that would
 * drift the first time this one changes.
 */
function isCaptureAllowed(input: PayloadCaptureInput): boolean {
  // Exactly one opt-in must be set, and it must be the one `scope` names:
  // two flags at once would silently widen capture beyond the declared scope.
  const optIns = [input.tenantOptIn, input.debugSessionOptIn, input.operatorFlagOptIn];
  if (optIns.filter(Boolean).length !== 1) return false;
  if (input.scope === "tenant") return input.tenantOptIn === true;
  if (input.scope === "debug_session") return input.debugSessionOptIn === true;
  if (input.scope === "operator_flag") return input.operatorFlagOptIn === true;
  return false;
}

function payloadSignals(values: readonly unknown[]): PayloadSignals {
  let toolCalls = 0;
  let images = 0;
  let attachments = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const type = typeof record["type"] === "string" ? record["type"].toLowerCase() : "";
    if (type === "tool_call" || type === "tool_use" || type === "function_call") toolCalls += 1;
    if (type === "image" || type === "input_image" || type === "output_image") images += 1;
    if (type === "file" || type === "document" || type === "attachment") attachments += 1;
    for (const [key, child] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === "tool_calls" || normalizedKey === "toolcalls") {
        if (Array.isArray(child)) toolCalls += child.length;
      } else if (normalizedKey === "attachments" || normalizedKey === "files") {
        if (Array.isArray(child)) attachments += child.length;
      } else if (
        (normalizedKey === "image_url" ||
          normalizedKey === "input_image" ||
          normalizedKey === "output_image") &&
        !type.includes("image")
      ) {
        images += 1;
      }
      visit(child, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return { toolCalls, images, attachments };
}

/**
 * Shapes a captured payload without persisting it — a pure helper reused by
 * `TelemetryPayloadCapture.capture` and exercised directly in tests. Bodies
 * are accounted in *drawer order*, and the combined total is bounded by
 * `maxBytes` (post-redaction, defaulting to the configured capture limit): a
 * body that no longer fits is replaced with a truncation marker — no object
 * store exists, so an oversized body is never referenced, only accounted.
 * Payloads remain redacted and bounded during their retention window.
 *
 * Drawer order is the allocation order, and that is deliberate: the cap is a
 * single shared budget, so whatever is accounted first is what survives a
 * large request. `response_body` is the legacy alias of the client response
 * and names no panel of its own, so it is accounted **last** — accounting it
 * earlier lets a large client request plus its own duplicate consume the whole
 * budget before the Provider Request and Provider Response panels are reached,
 * and those two then read empty for a request that did reach an upstream.
 */
export function buildPayloadRecord(
  input: PayloadCaptureInput,
  now = new Date(),
  maxBytes = resolveTelemetryPayloadMaxBytes(),
  retentionMs = payloadRetentionMs(),
): Omit<StoredPayload, "id"> {
  const expiresAt = new Date(now.getTime() + retentionMs);
  // Each body is serialized once, in drawer order, and only while the running
  // total still fits the cap. Serializing every body up front to measure them
  // and then serializing the whole record again to store it holds two copies of
  // every body at once — measured at 23 MB of heap for 8 MB of bodies. A body
  // that would cross the cap is never touched: its text is not built and its
  // object is not walked for signals.
  const surfaces: ReadonlyArray<readonly [keyof StoredPayload, unknown]> = [
    ["request_body", input.requestBody],
    ["provider_request_body", input.providerRequestBody],
    ["provider_response_body", input.providerResponseBody],
    ["client_response_body", input.clientResponseBody],
    ["response_body", input.responseBody],
  ];
  const stored: Partial<Record<keyof StoredPayload, unknown>> = {};
  const serialized: string[] = [];
  const kept: unknown[] = [];
  let accounted = 0;
  const truncatedKeys = new Set<keyof StoredPayload>();
  // A fully-dropped body's own byte size, for the marker the drawer renders.
  const truncatedOriginalBytes = new Map<keyof StoredPayload, number>();
  /**
   * Whether a surface kept a *body* — not whether it is merely non-null.
   *
   * A surface that lost its body to the cap carries a truncation marker, and
   * a marker is not content: the drawer renders it in place of a body, but the
   * Usage list ticks a stage to say "this panel has something to open".
   */
  const keptStage = (value: unknown, key: keyof StoredPayload): boolean =>
    value != null && !truncatedKeys.has(key);
  for (const [key, body] of surfaces) {
    if (body === undefined || body === null) {
      stored[key] = null;
      serialized.push("null");
      continue;
    }
    const text = JSON.stringify(body);
    // Accounted in UTF-8 bytes: the cap is a storage budget, and the bytes a
    // body costs on disk are its UTF-8 size. Code-unit accounting under-counts
    // multi-byte content ~3x (CJK) and over-allocates Latin content.
    const textBytes = Buffer.byteLength(text, "utf8");
    if (accounted + textBytes > maxBytes) {
      // Same drop-then-marker rule as before — only the accounting basis is
      // now bytes. A partial head would be raw JSON text where the drawer
      // renders a structured panel, so the body is kept whole or marked.
      truncatedKeys.add(key);
      truncatedOriginalBytes.set(key, textBytes);
      stored[key] = null;
      serialized.push("null");
      continue;
    }
    accounted += textBytes;
    stored[key] = body;
    serialized.push(text);
    kept.push(body);
  }
  // Only a surface that *had* a body and lost it to the cap is marked.
  // Stamping the marker onto every null surface would also mark surfaces that
  // never carried anything — a request that never reached an upstream then
  // reports "truncated" for a provider panel that was never captured, and the
  // stage bitmask counts a marker as captured content.
  const marker = (originalBytes: number): unknown => ({
    _truncated: true,
    _original_bytes: originalBytes,
    _hint: "Truncated by the capture cap — raise Settings → Telemetry payloads → Capture depth to keep more.",
  });
  for (const key of truncatedKeys) stored[key] = marker(truncatedOriginalBytes.get(key) ?? 0);
  return {
    request_id: input.requestId ?? null,
    captured_at: now,
    expires_at: expiresAt,
    request_body: stored.request_body ?? null,
    response_body: stored.response_body ?? null,
    client_response_body: stored.client_response_body ?? null,
    provider_request_body: stored.provider_request_body ?? null,
    provider_response_body: stored.provider_response_body ?? null,
    // Presence, not size: a stage counts as captured when a body was kept for
    // it. `response_body` is the legacy alias of the client response, so it
    // folds into that stage — it never names a panel of its own.
    // A truncation marker is deliberately not presence: the drawer renders it
    // in place of a body, but the Usage list ticks stages to say "this panel
    // has content", and a panel whose body was dropped has none.
    stages:
      (keptStage(stored.request_body, "request_body") ? 1 : 0) |
      (keptStage(stored.provider_request_body, "provider_request_body") ? 2 : 0) |
      (keptStage(stored.provider_response_body, "provider_response_body") ? 4 : 0) |
      (keptStage(stored.client_response_body, "client_response_body") ||
      keptStage(stored.response_body, "response_body")
        ? 8
        : 0),
    signals: payloadSignals(kept),
    _serialized: serialized,
  };
}

/**
 * Postgres-backed redacted request/response payload capture. Payloads live for
 * the tenant's chosen retention — an hour by default (see
 * {@link payloadRetentionMs} / `DEFAULT_PAYLOAD_RETENTION_MS`) — and are pruned
 * by the sweep.

 */
export class TelemetryPayloadCapture {
  private readonly store: DrizzleTelemetryStore;

  constructor(
    db: CartethyiaDatabase,
    /**
     * Reads the tenant's chosen retention for captures that arrive without one.
     *
     * Injected rather than imported so the capture path does not depend on the
     * console's settings module, and so a test can pin a retention without
     * touching the database. Absent means every capture uses the deployment
     * default, which is what a probe or a debug session wants anyway.
     */
    private readonly retentionFor?: (tenantId: string) => Promise<number> | number,
  ) {
    this.store = new DrizzleTelemetryStore(db);
  }

  async capture(input: PayloadCaptureInput): Promise<{
    id: string;
    expiresAt: Date;
    /** Terminal capture state for the request row (`failed_backlog` on a dropped frame). */
    payloadCaptureState?: PayloadCaptureState;
  }> {
    if (!isCaptureAllowed(input)) {
      throw Object.assign(new Error("payload capture not opted in"), {
        code: "capture_not_opted_in",
      });
    }
    // A caller that knows the answer passes it; otherwise the tenant's own
    // preference is resolved, and failing that the deployment default. The
    // early-rejection path has no preference to hand and lands here, which is
    // why the default must be the deployment one rather than the shortest.
    const retentionMs = await resolveRetention(input, this.retentionFor);
    const record = buildPayloadRecord(
      input,
      new Date(),
      input.maxBytes ?? resolveTelemetryPayloadMaxBytes(),
      retentionMs,
    );
    let reference;
    try {
      reference = await writePayloadFrame(record, record.expires_at, record._serialized
        ? {
            requestId: record.request_id,
            capturedAt: record.captured_at.toISOString(),
            signals: record.signals,
            bodies: record._serialized,
          }
        : undefined);
    } catch (error) {
      if (error instanceof PayloadBacklogFullError) {
        // The writer's backlog is at its bound: the frame is dropped here,
        // counted, and surfaced on the request as its own terminal state —
        // distinct from a storage failure, because "the disk is slow" and
        // "capture burst past the backlog bound" need different fixes. No
        // `telemetry_payloads` row is inserted: a row without a frame would
        // read as a corrupt reference.
        metrics.cartethyia_payload_backlog_dropped_total.inc(1);
        return {
          id: "",
          expiresAt: record.expires_at,
          payloadCaptureState: "failed_backlog",
        };
      }
      throw error;
    }
    // Typed columns only — bodies live in the frame file. The schema has no
    // jsonb body column, so a body cannot be written to Postgres here.
    return this.store.insertPayload({
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      capturedAt: record.captured_at,
      expiresAt: record.expires_at,
      storage: reference.storage,
      file: reference.file,
      offset: reference.offset,
      length: reference.length,
      checksum: reference.checksum,
      version: reference.version,
      // Presence travels with the row so the Usage list can read it without
      // inflating the frame. Built by `buildPayloadRecord`, which always sets
      // it; the guard keeps the insert honest if a caller supplies a record
      // from before the field existed.
      ...(Number.isInteger(record.stages) ? { stages: record.stages } : {}),
    });
  }

  async cleanupExpired(batchSize = 5000, now = new Date()): Promise<{ deleted: number }> {
    let deleted = 0;
    for (let run = 0; run < 40; run += 1) {
      const batch = await this.store.deleteExpiredPayloads(batchSize, now);
      deleted += batch;
      if (batch < batchSize) break;
    }
    // A file last written before *the longest retention a tenant can choose*
    // closed cannot still hold a live frame — whatever its tenant picked, that
    // frame has expired. Using the deployment default here instead was correct
    // only while every frame shared one window: with a tenant allowed to keep
    // frames for a week, a 15-minute bound would delete files still holding
    // frames their rows address, and the drawer would silently read empty.
    deleted += await prunePayloadFrames(now, payloadPruneBound(now));
    return { deleted };
  }
}

/**
 * The cutoff before which a frame file can be deleted wholesale.
 *
 * Every frame expires at most {@link MAX_PAYLOAD_RETENTION_MS} after it is
 * written, so a file last touched before that instant cannot still hold a live
 * frame — and that is the only thing that makes a damaged, unparsable file
 * reclaimable at all. Exported so the bound is pinned without a database: the
 * alternative is a test that deletes a live frame and notices nothing.
 */
export function payloadPruneBound(now: Date): Date {
  return new Date(now.getTime() - MAX_PAYLOAD_RETENTION_MS);
}

/**
 * How long one capture's frame should live.
 *
 * Order of authority: the caller's own value, then the tenant's preference,
 * then the deployment default. A failure resolving the tenant's preference
 * falls back rather than throwing — an unknown retention must not turn into a
 * lost capture, and the deployment default is always a valid answer.
 */
export async function resolveRetention(
  input: PayloadCaptureInput,
  retentionFor?: (tenantId: string) => Promise<number> | number,
): Promise<number> {
  if (typeof input.retentionMs === "number" && Number.isFinite(input.retentionMs)) {
    return Math.min(Math.max(1_000, Math.floor(input.retentionMs)), MAX_PAYLOAD_RETENTION_MS);
  }
  if (retentionFor) {
    try {
      const value = await retentionFor(input.tenantId);
      if (Number.isFinite(value)) {
        return Math.min(Math.max(1_000, Math.floor(value)), MAX_PAYLOAD_RETENTION_MS);
      }
    } catch {
      // Falls through to the deployment default below.
    }
  }
  return payloadRetentionMs();
}
