/**
 * Empty-stream replay + pre-start failover.
 *
 * When a provider returns HTTP 200 but the response body decodes to zero
 * meaningful events, the request is replayed byte-identical (same headers,
 * same body) up to `maxEmptyReplays` times with exponential backoff. If all
 * replays on one endpoint fail, the helper advances to the next endpoint in
 * the caller-supplied ordered list.
 *
 * The helper is transport-layer: it owns fetch, watchdog, backoff, and
 * endpoint rotation. The caller owns SSE decoding via the `DrainStream`
 * callback and supplies materialized headers + serialized body so replays
 * are byte-identical.
 *
 * Design: the replay count, backoff, and the ordered endpoint list are the
 * caller's contract; this helper owns fetch, watchdog, and rotation so a
 * provider that answers 200 with no events is retried on the next endpoint
 * rather than surfacing an empty body to the client.
 */
import { GatewayError } from "../../protocol/gateway-error";
import {
  fallbackRetryDelayMs,
  MIN_RETRY_BUDGET_MS,
  sleep as abortableSleep,
} from "../failure-policy";

// ─── Public types ──────────────────────────────────────────────────────────

/** What the caller's drain observed. Counts only dispatched data events:
 *  comments/keepalives, `[DONE]`, and whitespace-only data are excluded. */
export interface StreamTally {
  readonly dataEvents: number;
  readonly meaningful: boolean;
  readonly thoughtOnly: boolean;
}

/** Drain one response body to a tally. Provider-supplied; uses decodeSseEvents. */
export type DrainStream = (response: Response, signal: AbortSignal) => Promise<StreamTally>;

/** Bound fetch for one endpoint. Receives materialized headers + serialized body. */
export type EmptyStreamFetch = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

/**
 * Retry-delay policy.
 *
 * Delays come from `fallbackRetryDelayMs` (capped exponential with full
 * jitter), whose base and cap are operator-tunable. There is deliberately no
 * per-caller base: the local formula this replaced was uncapped and
 * unjittered, so a provider returning 200-with-no-events could drive an
 * unbounded wait, and concurrent clients could resynchronize their retries.
 */
interface EmptyStreamPolicy {
  readonly maxEmptyReplays?: number;
  readonly firstEventTimeoutMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface EmptyStreamResult {
  readonly response: Response;
  readonly tally: StreamTally;
  readonly endpoint: string;
  readonly replaysUsed: number;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_REPLAYS = 2;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 200_000; // 200s, matches CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS default


// ─── Helpers ───────────────────────────────────────────────────────────────

/** Pure predicate: zero data events, or data events with nothing meaningful. */
export function isEmptyStream(tally: StreamTally): boolean {
  return tally.dataEvents === 0 || (!tally.meaningful && !tally.thoughtOnly);
}



// ─── Main function ─────────────────────────────────────────────────────────

/**
 * Replays the byte-identical request while responses drain empty,
 * failing over across ordered endpoints pre-start.
 *
 * Throws GatewayError (platform_unavailable, 502, upstream) on exhaustion,
 * GatewayError (deadline_exceeded, 504, upstream) when a first event never
 * arrives within the window, and GatewayError (transport_closed, 499) on
 * client abort.
 */
export async function fetchWithEmptyStreamRecovery(
  endpoints: readonly string[],
  request: { headers: Record<string, string>; body: string },
  deps: {
    fetch: EmptyStreamFetch;
    drain: DrainStream;
    signal: AbortSignal;
    deadlineMs: number;
    policy?: EmptyStreamPolicy;
  },
): Promise<EmptyStreamResult> {
  const maxReplays = deps.policy?.maxEmptyReplays ?? DEFAULT_MAX_REPLAYS;
  const firstEventTimeout = deps.policy?.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  const sleep = deps.policy?.sleep ?? abortableSleep;

  if (endpoints.length === 0) {
    throw new GatewayError("platform_unavailable", 502, "No endpoints available (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
  }

  for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex++) {
    const endpoint = endpoints[endpointIndex]!;
    const replaysAllowed = maxReplays;

    for (let replay = 0; replay <= replaysAllowed; replay++) {
      // Check abort before each fetch
      if (deps.signal.aborted) {
        throw new GatewayError("transport_closed", 499, "The request was aborted (request {requestId}). Send it again whenever ready 🙃");
      }

      // Check deadline floor
      const now = Date.now();
      const remaining = deps.deadlineMs - now;
      if (remaining < MIN_RETRY_BUDGET_MS) {
        throw new GatewayError(
          "platform_unavailable",
          502,
          "Deadline exhausted before empty-stream replay (request {requestId}). Some things just take longer 🐢",
          {},
          "upstream",
        );
      }

      const fetchTimeout = Math.min(firstEventTimeout, remaining);

      let response: Response;
      try {
        response = await fetchWithTimeout(deps.fetch, endpoint, request, deps.signal, fetchTimeout);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        break; // advance to next endpoint
      }

      // Drain the response
      let tally: StreamTally;
      try {
        tally = await deps.drain(response, deps.signal);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        break; // advance to next endpoint
      }

      // Check if empty
      if (!isEmptyStream(tally)) {
        // Success — return the response and tally
        return {
          response,
          tally,
          endpoint,
          replaysUsed: replay,
        };
      }

      // Empty — replay if we haven't exhausted this endpoint's budget
      if (replay < replaysAllowed) {
        const delay = fallbackRetryDelayMs(replay);
        await sleep(delay, deps.signal);
      }
    }
  }

  // All endpoints exhausted
  throw new GatewayError(
    "platform_unavailable",
    502,
    "All endpoints returned empty streams (request {requestId}). The upstream came back empty-handed — retry 🌙",
    {},
    "upstream",
  );
}

// ─── Internal helpers ──────────────────────────────────────────────────────

async function fetchWithTimeout(
  fetch: EmptyStreamFetch,
  url: string,
  request: { headers: Record<string, string>; body: string },
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  // Race the fetch against a first-event timeout. The timer and the abort
  // listener are both cleaned up once the race settles, so a successful fetch
  // leaves neither behind.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    // A client cancellation is the caller's signal; the fetch already races the
    // same abort signal, so rejecting here only surfaces the 499 envelope.
    timeoutPromiseReject(
      new GatewayError("transport_closed", 499, "The request was aborted (request {requestId}). Send it again whenever ready 🙃"),
    );
  };
  let timeoutPromiseReject!: (reason: unknown) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutPromiseReject = reject;
    timer = setTimeout(() => {
      // A first-event timeout is the gateway waiting on a silent upstream (e.g.
      // a provider that holds the request in a queue), not the client leaving.
      // It must surface as a deadline failure, never as a `transport_closed`
      // 499 — that code is reserved for genuine client cancellations and would
      // otherwise hide a real upstream wait behind "cancelled by client".
      reject(new GatewayError("deadline_exceeded", 504, "First event timeout (request {requestId}). Some things just take longer 🐢", {}, "upstream"));
    }, timeoutMs);
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      fetch(url, { headers: request.headers, body: request.body, signal }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
