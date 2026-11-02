/**
 * InferHub management-API client.
 *
 * Called only from route handlers — there is no scheduler, no poller, and no
 * background loop anywhere in this design. A page that nobody opens issues no
 * requests.
 *
 * Two constraints the API imposes:
 * - The documented budget is 30 req/min per account for Management + MCP. All
 *   calls share one bucket capped at 20/min to leave headroom, and the public
 *   endpoints are assumed to share it because the docs do not prove otherwise.
 * - Every value here is untrusted remote data. A response is parsed defensively
 *   and a failure returns `undefined` — never a half-parsed object that a route
 *   would render as if it were good.
 */
import { createValidatedFetch, type ValidatedFetch } from "../../network/outbound-fetch";

export const INFERHUB_API_BASE = "https://inferhub.dev/api";

/** Leave headroom under the documented 30/min Management budget. */
const RATE_LIMIT_PER_MINUTE = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Bounded: one retry, and only when the server asked us to wait. */
const MAX_ATTEMPTS = 2;

/** One shared bucket for every management call this process makes. */
interface Bucket {
  windowStart: number;
  used: number;
}
const bucket: Bucket = { windowStart: Date.now(), used: 0 };

function takeToken(now: number): boolean {
  if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bucket.windowStart = now;
    bucket.used = 0;
  }
  if (bucket.used >= RATE_LIMIT_PER_MINUTE) return false;
  bucket.used += 1;
  return true;
}

/** Test seam: lets a test drive the bucket without waiting a minute. */
export function __resetRateLimit(now: number = Date.now()): void {
  bucket.windowStart = now;
  bucket.used = 0;
}

export interface InferhubClientOptions {
  /** `config_read` key; required for `/catalog`, ignored by the public endpoints. */
  readonly configKey?: string | undefined;
  readonly fetchFn?: ValidatedFetch | typeof fetch;
  readonly now?: () => number;
}

/**
 * One management GET.
 *
 * Returns `undefined` for any non-2xx, timeout, rate-limit exhaustion, or parse
 * failure. A caller that gets `undefined` keeps its last good snapshot, so a
 * transient upstream problem never blanks an operator's view.
 */
async function get(
  path: string,
  options: InferhubClientOptions,
): Promise<unknown> {
  const now = options.now?.() ?? Date.now();
  if (!takeToken(now)) return undefined;

  const fetchFn = (options.fetchFn ?? createValidatedFetch()) as ValidatedFetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.configKey !== undefined && options.configKey.length > 0)
    headers.authorization = `Bearer ${options.configKey}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchFn(`${INFERHUB_API_BASE}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 429) {
        // Honor `Retry-After` rather than retrying immediately, but only once:
        // the bounded loop is the guard against a retry storm.
        const retryAfter = Number(response.headers.get("retry-after"));
        if (attempt < MAX_ATTEMPTS && Number.isFinite(retryAfter) && retryAfter > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter * 1000, 5_000)));
          continue;
        }
        return undefined;
      }
      if (!response.ok) return undefined;
      return await response.json();
    } catch {
      // Timeout, network error, or a body that is not JSON: treat as no data.
      return undefined;
    }
  }
  return undefined;
}

/** `GET /api/market` — public. Money is numeric. */
export function fetchMarket(options: InferhubClientOptions = {}): Promise<unknown> {
  return get("/market", options);
}

/** `GET /api/status` — public. Availability and per-model health. */
export function fetchStatus(options: InferhubClientOptions = {}): Promise<unknown> {
  return get("/status", options);
}

/** `GET /api/catalog` — needs `config_read`. Money is a decimal string. */
export function fetchCatalog(options: InferhubClientOptions = {}): Promise<unknown> {
  return get("/catalog", options);
}

/** `GET /api/pricing/config` — public platform fee configuration. */
export function fetchPricingConfig(options: InferhubClientOptions = {}): Promise<unknown> {
  return get("/pricing/config", options);
}

export function objectArray(payload: unknown, key: string): readonly Record<string, unknown>[] {
  const value =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)[key]
      : payload;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object",
  );
}
