/**
 * Qoder-specific SSE decoding.
 *
 * The generic `decodeSseEvents` splits on newlines and treats a bare line
 * (no `data:` prefix) with no open event as malformed. Qoder's IDE surface
 * embeds literal newline bytes inside JSON string values (e.g. `raw_usage`
 * keys like `"data_policy_preferre\n\nnd_count"`), which fragments one logical
 * `data:` event into many physical lines — including blank lines that are not
 * event boundaries. The generic decoder can throw `Malformed SSE line` on the
 * trailing fragments of those giant events.
 *
 * This decoder is tolerant by construction: it accumulates one event's payload
 * across `data:` lines, bare continuations, and blank lines until the payload
 * is a complete JSON value or the `[DONE]` sentinel. It never throws on a
 * bare fragment — payload completeness is the only way an event ends.
 */

export interface QoderSseEvent {
  readonly event: string | null;
  readonly data: string;
}

const DEFAULT_MAX_EVENT_BYTES = 8 * 1024 * 1024;

/** True when the accumulated text is a complete JSON value (or non-JSON text). */
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
      if (depth < 0) return true;
    }
  }
  return depth <= 0;
}

/**
 * Decodes Qoder SSE into complete events.
 */
export async function* decodeQoderSseEvents(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
): AsyncIterable<QoderSseEvent> {
  if (body === null) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let current: string | null = null; // accumulated payload of the open event
  let eventBytes = 0;

  /** Returns the open payload when complete, else null (clearing it). */
  const takeComplete = (): string | null => {
    if (current === null) return null;
    const trimmed = current.trim();
    if (trimmed.length === 0) {
      current = null;
      eventBytes = 0;
      return null;
    }
    if (trimmed === "[DONE]" || isCompleteJsonValue(trimmed)) {
      const data = current;
      current = null;
      eventBytes = 0;
      return data;
    }
    return null;
  };

  const appendPayload = (text: string): void => {
    if (current === null) return;
    current += text;
    eventBytes += text.length;
    if (eventBytes > maxEventBytes) throw new Error("SSE event exceeds size bound");
  };

  /** Emit a complete open payload, if any. Returns `true` when the stream ends. */
  function* emitComplete(): Generator<QoderSseEvent, boolean, void> {
    const data = takeComplete();
    if (data === null) return false;
    if (data.trim() === "[DONE]") return true;
    yield { event: null, data };
    return false;
  }

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      lineBuffer += decoder.decode(value, { stream: true });

      for (;;) {
        const nl = lineBuffer.indexOf("\n");
        if (nl < 0) break;
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        const trimmed = line.trim();

        // Comments, event names, and other fields carry no payload.
        if (trimmed.startsWith(":") || trimmed.startsWith("event:")) continue;

        if (trimmed.startsWith("data:")) {
          // A fresh `data:` — flush a complete open event first, then start a
          // new payload with the slice after the prefix.
          if (yield* emitComplete()) return;
          current = line.slice(5).trimStart();
          eventBytes = current.length;
          if (eventBytes > maxEventBytes) throw new Error("SSE event exceeds size bound");
          continue;
        }

        // Other known fields (id:, retry:, vendor extensions) carry no payload.
        if (/^[a-zA-Z0-9_-]+:/.test(trimmed)) continue;

        if (trimmed.length === 0) {
          // Blank line: an event boundary only when the open payload is
          // complete; otherwise it is a literal newline inside the JSON string.
          if (yield* emitComplete()) return;
          if (current !== null) appendPayload("\n");
          continue;
        }

        // Bare line: continuation of the open payload (Qoder fragments JSON
        // across physical lines with literal newlines inside strings).
        if (current !== null) {
          appendPayload("\n" + line);
          if (yield* emitComplete()) return;
          continue;
        }
        // Bare line with no open payload: ignore (tolerant by design).
      }
    }

    yield* emitComplete();
  } finally {
    reader.releaseLock();
  }
}
