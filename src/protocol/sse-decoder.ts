import { GatewayError } from "./gateway-error";

/**
 * Single shared SSE event decoder for all provider wire families.
 *
 * Replaces three hand-rolled line loops that each buffered unboundedly and
 * disagreed on the SSE spec: `factory.ts` `sseLines` (dropped `event:`
 * semantics, no bounds, no abort wiring), `claude/adapter.ts`
 * `parseClaudeSseStream` (correct join but unbounded + reader never
 * cancelled), and `codex/adapter.ts` (`await res.text()` + `split("\n")`,
 * defeating incremental decoding entirely).
 *
 * Semantics, per RFC 8895 / the WHATWG SSE fragment all three upstreams
 * actually emit:
 * - `event: <name>` sets the pending event name (preserved on the yielded
 *   event so Claude's `error`-event detection keeps working).
 * - `data: <text>` appends a data line; multiple lines join with `\n`.
 * - A blank line dispatches the pending event (only when it carries data —
 *   bare `event:` blocks with no `data:` yield nothing, matching the old
 *   Claude `flush()` early return).
 * - `:` comments (keepalives), `id:`, and `retry:` lines are ignored.
 * - Anything else is a malformed stream and throws 502 — the old factory
 *   silently skipped garbage lines while Claude threw; strict wins because
 *   a corrupt stream must never decode as valid deltas.
 */

export interface SseEvent {
  /** Value of the preceding `event:` line, or null for data-only events. */
  readonly event: string | null;
  /** Joined `data:` lines (without the `data:` prefixes). */
  readonly data: string;
}

interface SseDecodeOptions {
  /**
   * Max UTF-16 length of a single line; default equals `maxEventBytes`.
   *
   * A `data:` line's content is always accumulated into `eventBytes`, so the
   * per-event cap is the real defense against unbounded memory growth. The
   * per-line cap only exists to bound the pre-newline buffer when a stream
   * has no line breaks at all; keeping it at the event cap avoids rejecting
   * legitimate providers (Responses `response.created` packs the full tool
   * schema — including every tool description — into a single JSON line).
   */
  readonly maxLineBytes?: number;
  /** Max accumulated `data:` length per event; default 4 MiB. */
  readonly maxEventBytes?: number;
  /** Aborting stops the stream promptly and cancels the reader. */
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_MAX_EVENT_BYTES = 4 * 1024 * 1024;

/**
 * True when the accumulated data is a complete JSON value.
 *
 * Uses a bracket-depth scan that skips string contents (including escapes), so
 * an inline `\n` or `\n\n` inside a string does not count as a structural
 * terminator. A non-JSON payload (`[DONE]`, plain text) has depth 0 and reads
 * as complete, so blank-line boundaries stay working for ordinary streams.
 */
function isCompleteJsonValue(data: string): boolean {
  if (data.length === 0) return true;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth < 0) return true; // trailing close: not a partial JSON prefix
    }
  }
  return depth <= 0;
}

// A corrupt SSE stream is an upstream protocol failure, not a client mistake:
// labelling it `invalid_request` told the client its request was wrong and
// invited a retry of the identical request against a broken upstream. The
// `upstream` origin keeps the public envelope from prefixing it
// a gateway-branded message, which blamed the gateway for the provider's bytes.
// The message quotes the offending line (bounded) so the client and operator
// see the actual bytes the upstream sent rather than a generic sentence.
const MAX_SSE_SNIPPET = 160;
function snippet(line: string): string {
  const collapsed = line.replace(/[\r\n]+/g, " ").trim();
  if (collapsed.length === 0) return "<empty line>";
  return collapsed.length > MAX_SSE_SNIPPET
    ? `${collapsed.slice(0, MAX_SSE_SNIPPET)}…`
    : collapsed;
}
function oversized(what: string, line?: string): GatewayError {
  const quote = line === undefined ? "" : `: ${snippet(line)}`;
  return new GatewayError("platform_unavailable", 502, `SSE ${what} exceeds size bound${quote} (request {requestId}). The upstream sent more than we can hold — retry 🌙`, {}, "upstream");
}

export async function* decodeSseEvents(
  body: ReadableStream<Uint8Array> | null,
  opts: SseDecodeOptions = {},
): AsyncIterable<SseEvent> {
  if (body === null) throw new GatewayError("platform_unavailable", 502, "SSE response has no body (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
  const maxEventBytes = opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxLineBytes = opts.maxLineBytes ?? maxEventBytes;
  const signal = opts.signal;
  if (signal?.aborted) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // Byte accumulation: `buffer += decode()` per chunk reallocated the whole
  // prefix (O(n^2)) and `slice(newline+1)` memmove'd per line. Chunks collect
  // raw and decode once per complete line instead.
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let eventName: string | null = null;
  let dataLines: string[] = [];
  let eventBytes = 0;

  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  /** True when any pending byte is a newline. */
  function hasPendingNewline(): boolean {
    for (const chunk of pending) {
      if (chunk.indexOf(10) >= 0) return true;
    }
    return false;
  }

  /** Removes and decodes the first complete line, or undefined when partial. */
  function takeLine(): string | undefined {
    let scanned = 0;
    let chunkIndex = -1;
    let newlineAt = -1;
    for (let index = 0; index < pending.length; index += 1) {
      const chunk = pending[index]!;
      const found = chunk.indexOf(10);
      if (found >= 0) {
        chunkIndex = index;
        newlineAt = found;
        break;
      }
      scanned += chunk.byteLength;
    }
    if (chunkIndex < 0) return undefined;
    const head = pending.splice(0, chunkIndex + 1);
    const lineBytes = new Uint8Array(scanned + newlineAt);
    let offset = 0;
    for (let index = 0; index < head.length - 1; index += 1) {
      const chunk = head[index]!;
      lineBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const last = head[head.length - 1]!;
    lineBytes.set(last.subarray(0, newlineAt), offset);
    offset += newlineAt;
    pendingBytes -= offset + 1;
    const rest = last.subarray(newlineAt + 1);
    if (rest.byteLength > 0) pending.unshift(rest);
    const line = decoder.decode(lineBytes).replace(/\r$/, "");
    if (line.length > maxLineBytes) throw oversized("line", line);
    return line;
  }
  function* dispatchEvent(): Iterable<SseEvent> {
    if (dataLines.length === 0) {
      eventName = null;
      return;
    }
    const data = dataLines.join("\n");
    const name = eventName;
    dataLines = [];
    eventName = null;
    eventBytes = 0;
    yield { event: name, data };
  }

  function* emitLine(line: string): Iterable<SseEvent> {
    if (line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      const name = line.slice(6).trim();
      eventName = name.length > 0 ? name : null;
      return;
    }
    if (line.startsWith("data:")) {
      const piece = line.slice(5).trimStart();
      dataLines.push(piece);
      eventBytes += piece.length;
      if (eventBytes > maxEventBytes) throw oversized("event", line);
      return;
    }
    if (line.startsWith("id:") || line.startsWith("retry:")) return;
    if (line.trim() === "") {
      // A blank line is an SSE event boundary — but only when the payload
      // accumulated so far is already a complete value. Some upstreams
      // (Qoder IDE /model/v1) emit JSON that contains literal blank lines
      // inside a string (`raw_usage` carries keys like
      // `"data_policy_preferre\n\nnd_count"`). Treating that blank line as a
      // boundary splits the JSON, leaves a dangling continuation, and throws
      // "Malformed SSE line". When the open data is not yet a complete JSON
      // value, append the blank line as a continuation instead.
      if (dataLines.length > 0 && !isCompleteJsonValue(dataLines.join("\n"))) {
        dataLines.push("");
        return;
      }
      yield* dispatchEvent();
      return;
    }
    // Benign vendor extensions (e.g. `x-foo:`, `:comment` handled above) must
    // not 502 the request: only `event:`/`data:` carry payload, the rest is
    // heartbeat/metadata. Unknown colon-prefixed fields are ignored.
    if (/^[a-zA-Z0-9_-]+:/.test(line)) return;
    // Some vendors (Qoder IDE /model/v1) emit a single `data:` event whose JSON
    // payload contains literal newlines, so the event arrives as several lines:
    // the first has the `data:` prefix, the rest are bare continuations. Treat
    // a bare line as a continuation of the open `data:` event rather than a
    // malformed stream. A bare line with no open data is still an error.
    if (dataLines.length > 0) {
      dataLines.push(line);
      eventBytes += line.length;
      if (eventBytes > maxEventBytes) throw oversized("event", line);
      return;
    }
    throw new GatewayError("platform_unavailable", 502, `Malformed SSE line: ${snippet(line)} (request {requestId}). The upstream sent something we can't read — retry 🌙`, {}, "upstream");
  }

  try {
    while (true) {
      if (signal?.aborted) return;
      const chunk = await reader.read();
      if (chunk.value && chunk.value.byteLength > 0) {
        pending.push(chunk.value);
        pendingBytes += chunk.value.byteLength;
        if (!hasPendingNewline() && pendingBytes > maxLineBytes) {
          const partial = decoder.decode(new Uint8Array(pendingBytes)).slice(0, MAX_SSE_SNIPPET);
          throw oversized("line", partial);
        }
      }
      let line = takeLine();
      while (line !== undefined) {
        yield* emitLine(line);
        line = takeLine();
      }
      if (chunk.done) break;
    }
    if (pendingBytes > 0) {
      if (pendingBytes > maxLineBytes) {
        const partial = decoder.decode(new Uint8Array(pendingBytes)).slice(0, MAX_SSE_SNIPPET);
        throw oversized("line", partial);
      }
      const total = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const chunk of pending.splice(0, pending.length)) {
        total.set(chunk, offset);
        offset += chunk.byteLength;
      }
      pendingBytes = 0;
      yield* emitLine(decoder.decode(total));
    }
    yield* dispatchEvent();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // `onAbort` cancels the reader, and `cancel()` releases the lock itself —
    // an unconditional `releaseLock()` then throws ERR_INVALID_STATE, which
    // would replace whatever actually ended the stream (a 499 abort, a
    // provider error, a normal close). Release only while this reader still
    // holds the lock; a read can also still be pending, which throws too.
    try {
      if (body.locked) reader.releaseLock();
    } catch {
      // Already released by cancel(), or a pending read owns the lock.
    }
  }
}
