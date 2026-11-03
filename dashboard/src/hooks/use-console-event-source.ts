import { useEffect, useRef } from "react";
import { useSseWhenVisible } from "./sse-visibility";

/**
 * Shared console SSE connection lifecycle.
 *
 * Every dashboard live stream hand-rolled the same mechanics: an authenticated
 * preflight, the tab-visibility gate, a fixed reconnect delay, and a
 * generation guard so a stale async connect can never touch a torn-down
 * component. This hook owns that loop once; feature hooks keep only their
 * frame parsing and state. Reconnect uses exponential backoff with jitter
 * (2s → 60s cap, reset on open) so a gateway outage cannot hammer it with a
 * fixed retry per tab per stream.
 */

/** First reconnect delay after a drop. */
export const SSE_RECONNECT_BASE_MS = 2_000;
/** Cap on the exponential backoff, so a long outage cannot hammer the gateway. */
export const SSE_RECONNECT_MAX_MS = 60_000;
/** Random jitter added to each delay so N tabs do not reconnect in lockstep. */
const SSE_RECONNECT_JITTER_MS = 400;

export interface UseConsoleEventSourceOptions {
  /** Full URL of the SSE endpoint (paths already carry the `/console/api` prefix when they need it). */
  readonly url: string;
  /**
   * Authenticated preflight. Runs before each (re)connect; throwing is
   * treated as a transport failure and retried with backoff. Optional.
   */
  readonly preflight?: () => Promise<unknown> | unknown;
  /** SSE event names to forward to `onEvent`. */
  readonly events?: readonly string[];
  /** Called for every forwarded frame with its event name and raw data. */
  readonly onEvent?: (event: string, data: string) => void;
  /** Called once the EventSource connection opens; resets the backoff. */
  readonly onOpen?: () => void;
  /** Called when the connection drops (transport error or server close). */
  readonly onClose?: () => void;
  /** Set false to keep the hook dormant (e.g. the non-SSE branch of a hook). */
  readonly enabled?: boolean;
}

export function useConsoleEventSource(options: UseConsoleEventSourceOptions): void {
  const visible = useSseWhenVisible();
  const { url, enabled = true } = options;
  // Keep the latest callbacks in a ref so the effect does not restart on every
  // render just because a consumer re-creates an inline handler.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Event-name sets are compared by content: inline array literals are recreated
  // per render, but the effect only needs to restart when the set changes.
  const eventsKey = options.events?.join(",") ?? "";

  useEffect(() => {
    if (!visible || !enabled) return;
    let active = true;
    let generation = 0;
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = SSE_RECONNECT_BASE_MS;

    const clearReconnect = (): void => {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    };

    const scheduleReconnect = (): void => {
      if (!active || reconnectTimer !== undefined) return;
      const jitter = Math.floor(Math.random() * SSE_RECONNECT_JITTER_MS);
      const wait = Math.min(backoffMs + jitter, SSE_RECONNECT_MAX_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, wait);
    };

    const connect = async (): Promise<void> => {
      if (!active) return;
      const currentGeneration = ++generation;
      try {
        await optionsRef.current.preflight?.();
      } catch {
        if (active && currentGeneration === generation) scheduleReconnect();
        return;
      }
      if (!active || currentGeneration !== generation) return;

      const nextSource = new EventSource(url);
      source = nextSource;

      nextSource.onopen = () => {
        if (!active || currentGeneration !== generation) return;
        backoffMs = SSE_RECONNECT_BASE_MS;
        optionsRef.current.onOpen?.();
      };

      nextSource.onerror = () => {
        if (!active || currentGeneration !== generation) return;
        nextSource.close();
        if (source === nextSource) source = undefined;
        optionsRef.current.onClose?.();
        scheduleReconnect();
      };

      for (const event of eventsKey ? eventsKey.split(",") : []) {
        nextSource.addEventListener(event, (listenerEvent) => {
          if (!active || currentGeneration !== generation) return;
          const message = listenerEvent as MessageEvent<string>;
          // A bare transport error is an `Event`, not a `MessageEvent`, so this
          // guard keeps server-named frames from being confused with it.
          if (typeof message.data !== "string") return;
          optionsRef.current.onEvent?.(event, message.data);
        });
      }
    };

    void connect();
    return () => {
      active = false;
      generation += 1;
      clearReconnect();
      source?.close();
    };
  }, [enabled, eventsKey, url, visible]);
}
