/**
 * Minimal SSE stream helper for console live endpoints. The gateway
 * already speaks SSE to inference clients; frames are the same wire shape
 * (named `event:`, JSON `data:`) pointed at the dashboard instead, built by
 * the shared `buildSseEventFrame` core so the two layers cannot drift.
 */

interface SseSender {
  send(event: string, data: unknown): void;
}

/** Register endpoint-specific SSE subscriptions; return their teardown callback. */
type SseSetup = (sender: SseSender) => () => void;

import { TEXT_ENCODER, buildSseEventFrame as formatSseFrame } from "../../protocol/sse-frame";

export { formatSseFrame };

/**
 * Heartbeat cadence. The listener idles at 60s, so a comment frame every 25s
 * keeps SSE connections alive through proxies and idle-timeout sweeps.
 */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Hard cap on one stream's lifetime. A tab that is abandoned but never
 * unloads (a backgrounded browser window, a parked laptop) would otherwise
 * hold its subscription and timers forever; the client reconnects on close,
 * so this only forces a refresh. 45 minutes is far longer than any live view
 * needs in one stretch.
 */
const SSE_MAX_LIFETIME_MS = 45 * 60_000;

/**
 * Idle timeout: if no *data* frame is sent for this long, the stream sends a
 * terminal `close` event and closes. Heartbeats deliberately do not count —
 * they are there to keep proxies alive, not to prove someone is reading, so
 * they must not defeat the abandoned-tab cutoff.
 */
const SSE_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Watchdog cadence; the two cutoffs above are checked on this tick. */
const SSE_WATCHDOG_MS = 30_000;

/** Frame sent when the server cuts the stream (idle or max lifetime). */
function closeFrame(reason: string): Uint8Array {
  return TEXT_ENCODER.encode(formatSseFrame("close", JSON.stringify({ reason })));
}

/**
 * Console SSE response stream with uniform JSON event encoding, heartbeat,
 * idle/max-lifetime cutoff, and abort/cancel cleanup. The setup callback runs
 * synchronously at stream start so the initial snapshot is enqueued before the
 * first read.
 *
 * The encoder is the module-level shared `TextEncoder` from the frame module:
 * allocating one per stream (let alone per send) is unnecessary garbage for a
 * hot path that encodes a frame every few hundred milliseconds per connection.
 */
export function createConsoleSseStream(
  signal: AbortSignal,
  setup: SseSetup,
): ReadableStream<Uint8Array> {
  let cleanupSubscription: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let close: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const startedAt = Date.now();
      let lastDataAt = startedAt;
      const sender: SseSender = {
        send(event, data) {
          if (closed) return;
          try {
            lastDataAt = Date.now();
            controller.enqueue(TEXT_ENCODER.encode(formatSseFrame(event, JSON.stringify(data))));
          } catch {
            close?.();
          }
        },
      };

      const terminate = (reason: string): void => {
        if (closed) return;
        try {
          controller.enqueue(closeFrame(reason));
        } catch {
          // Fall through to close regardless.
        }
        close?.();
      };

      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(watchdog);
        cleanupSubscription?.();
        try {
          controller.close();
        } catch {
          // Stream may already be closed by the runtime.
        }
      };

      if (signal.aborted) {
        close();
        return;
      }
      cleanupSubscription = setup(sender);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(TEXT_ENCODER.encode(": ping\n\n"));
        } catch {
          close?.();
        }
      }, SSE_HEARTBEAT_MS);

      watchdog = setInterval(() => {
        if (closed) return;
        const now = Date.now();
        if (now - lastDataAt > SSE_IDLE_TIMEOUT_MS) {
          terminate("idle");
        } else if (now - startedAt > SSE_MAX_LIFETIME_MS) {
          terminate("max_lifetime");
        }
      }, SSE_WATCHDOG_MS);

      signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      close?.();
    },
  });
}

/** Standard response wrapper for console SSE endpoints. */
export function consoleSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
