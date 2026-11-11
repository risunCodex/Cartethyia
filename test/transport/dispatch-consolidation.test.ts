/**
 * Consolidation units for the transport dispatch findings:
 *
 * - M-08: `flagPoolOnEgressFailure` — the one verdict→flag dispatch the
 *   attempt loop and the streaming finalizer share. Both call sites classify
 *   with `classifyEgressFailure` and must retire the same pool the same way;
 *   this pins that a cooldown verdict writes the cooldown flag/row and a
 *   blocked verdict writes the block flag/row, with the same gating both
 *   sites previously applied by hand.
 * - M-12: `buildDispatchNetworkBindings` — the one builder for the three
 *   outbound bindings both dispatch paths share. Pins the identical key set
 *   and function identity (attachment = the raw factory fetch, HTTP/2 = the
 *   raw factory bidi, outboundFetch = the capture-wrapped fetch), and the
 *   eager/lazy capture-read gating: when no network binding exists, the
 *   DB-backed capture-preference read is skipped entirely.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { flagPoolOnEgressFailure } from "../../src/network/pool/health";
import { classifyEgressFailure } from "../../src/network/verdict";
import {
  buildDispatchNetworkBindings,
  type DispatchNetworkBindings,
} from "../../src/transport/dispatch/upstream";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import type { ValidatedNetworkBindingFactory } from "../../src/network/egress/factory";
import type { ProviderExchangeCapture } from "../../src/transport/dispatch/attempt-finalize";
import type { CapturePreferenceState } from "../../src/transport/dispatch/capture-policy";

// ─── M-08: flagPoolOnEgressFailure ─────────────────────────────────────────

/** One row the durable recorder is expected to insert into `health_events`. */
interface AuditRow {
  readonly entityKind: string;
  readonly networkPoolId: string;
  readonly toStatus: string;
  readonly reason: string;
  readonly errorCategory: string;
}

/** One call made on the pool selector. */
interface SelectorCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** The subset of the selector the flag helpers actually use. */
interface FlagSelector {
  flagProviderBlocked(poolId: string, providerId: string, reason: string): Promise<unknown>;
  flagProviderCooldown(
    poolId: string,
    providerId: string,
    retryAfterMs: number,
    reason: string,
  ): Promise<unknown>;
}

/** The subset of the database the flag helpers actually use. */
interface AuditSink {
  insert(table: unknown): { values(row: AuditRow): Promise<void> };
}

interface FlagHarness {
  readonly selector: FlagSelector;
  readonly rows: AuditRow[];
  readonly calls: SelectorCall[];
  readonly db: AuditSink;
  /** Resolves once `count` audit rows have been written. */
  readonly settled: (count: number) => Promise<void>;
}

/** Builds the two collaborators and a way to await them. */
function flagHarness(): FlagHarness {
  const rows: AuditRow[] = [];
  const calls: SelectorCall[] = [];
  let notify: (() => void) | undefined;
  const selector: FlagSelector = {
    flagProviderBlocked: async (poolId, providerId, reason) => {
      calls.push({ method: "flagProviderBlocked", args: [poolId, providerId, reason] });
      // Inert marker entry: the mirror write is swallowed by its own catch.
      return { until: Date.now() + 60_000, reason, blocked: true };
    },
    flagProviderCooldown: async (poolId, providerId, retryAfterMs, reason) => {
      calls.push({ method: "flagProviderCooldown", args: [poolId, providerId, retryAfterMs, reason] });
      return { until: Date.now() + retryAfterMs, reason };
    },
  };
  const db: AuditSink = {
    insert: () => ({
      values: async (row: AuditRow): Promise<void> => {
        rows.push(row);
        notify?.();
      },
    }),
  };
  const settled = (count: number): Promise<void> =>
    rows.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          notify = () => {
            if (rows.length >= count) resolve();
          };
        });
  return { selector, rows, calls, db, settled };
}

/** Coalescing state is module-global and keyed by (pool, provider). */
let flagSequence = 0;
function flagPoolId(): string {
  flagSequence += 1;
  return `pool-flag-${flagSequence}-${crypto.randomUUID()}`;
}

/** A provider-scoped 429: the cooldown verdict. */
function rateLimitedUpstream(): GatewayError {
  return new GatewayError(
    "accounts_rate_limited",
    429,
    "Too many requests",
    { providerId: "opencode", rateLimitScope: "provider" },
    "upstream",
  );
}

/** A free-tier 403: the blocked verdict. */
function freeTierRefusal(): GatewayError {
  return new GatewayError(
    "authentication_failed",
    403,
    "FreeTierError: free tier can only be used from an allowed region",
    { providerId: "opencode", rateLimitScope: "provider", providerCode: "FreeTierError", raw: "FreeTierError" },
    "upstream",
  );
}

describe("flagPoolOnEgressFailure", () => {
  test("a cooldown verdict writes the cooldown flag and a rate_limit_transient row", async () => {
    const h = flagHarness();
    const pool = flagPoolId();
    const error = rateLimitedUpstream();
    flagPoolOnEgressFailure(h.selector as never, h.db as never, pool, "opencode", error, classifyEgressFailure(error, "opencode"));
    await h.settled(1);
    expect(h.calls[0]?.method).toBe("flagProviderCooldown");
    expect(h.rows[0]?.errorCategory).toBe("rate_limit_transient");
    expect(h.rows[0]?.networkPoolId).toBe(pool);
  });

  test("a blocked verdict writes the block flag and an egress_blocked row", async () => {
    const h = flagHarness();
    const pool = flagPoolId();
    const error = freeTierRefusal();
    flagPoolOnEgressFailure(h.selector as never, h.db as never, pool, "opencode", error, classifyEgressFailure(error, "opencode"));
    await h.settled(1);
    expect(h.calls[0]?.method).toBe("flagProviderBlocked");
    expect(h.rows[0]?.errorCategory).toBe("egress_blocked");
    expect(h.rows[0]?.networkPoolId).toBe(pool);
  });

  test("a none verdict writes nothing — the two call sites' '!cancelled' gate", async () => {
    const h = flagHarness();
    flagPoolOnEgressFailure(
      h.selector as never,
      h.db as never,
      flagPoolId(),
      "opencode",
      rateLimitedUpstream(),
      { kind: "none" },
    );
    // Give any (wrong) fire-and-forget write a beat to land.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls).toHaveLength(0);
    expect(h.rows).toHaveLength(0);
  });

  test("no pool id or no selector means no write", async () => {
    const h = flagHarness();
    const error = rateLimitedUpstream();
    const verdict = classifyEgressFailure(error, "opencode");
    flagPoolOnEgressFailure(h.selector as never, h.db as never, undefined, "opencode", error, verdict);
    flagPoolOnEgressFailure(undefined, h.db as never, flagPoolId(), "opencode", error, verdict);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls).toHaveLength(0);
    expect(h.rows).toHaveLength(0);
  });

  test("a non-GatewayError never writes even with a non-none verdict", async () => {
    const h = flagHarness();
    flagPoolOnEgressFailure(h.selector as never, h.db as never, flagPoolId(), "opencode", new Error("boom"), {
      kind: "blocked",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls).toHaveLength(0);
    expect(h.rows).toHaveLength(0);
  });
});

// ─── M-12: buildDispatchNetworkBindings ────────────────────────────────────

/** A db that fails loudly if ever touched — used to prove no preference read. */
function hpDb(): CartethyiaDatabase {
  return {
    select: () => {
      throw new Error("db.select must not be called");
    },
  } as unknown as CartethyiaDatabase;
}

/** A preference-read db returning a full/moderate tenant. */
function preferenceDb(): { db: CartethyiaDatabase; reads: () => number } {
  let reads = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            reads += 1;
            return Promise.resolve([
              {
                preferences: {
                  telemetryPayloads: "full",
                  telemetryPayloadDepth: "moderate",
                  telemetryWindowMinutes: 60,
                },
              },
            ]);
          },
        }),
      }),
    }),
  } as unknown as CartethyiaDatabase;
  return { db, reads: () => reads };
}

/**
 * A factory returning stable per-input closures so function identity can be
 * asserted: the attachment fetch must be exactly `factory.fetch(...)` and the
 * HTTP/2 dialer exactly `factory.http2Bidi(...)`.
 */
type FakeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FakeBidi = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  options?: unknown,
) => Promise<unknown>;

function bindingFactory(): {
  factory: ValidatedNetworkBindingFactory;
  fetches: { poolId: string | undefined; tenantId: string | undefined }[];
  bidiCalls: { poolId: string | undefined; tenantId: string | undefined }[];
} {
  const fetches: { poolId: string | undefined; tenantId: string | undefined }[] = [];
  const bidiCalls: { poolId: string | undefined; tenantId: string | undefined }[] = [];
  // Memoized per (pool, tenant) pair, like the real factory's per-agent cache
  // and its stable direct egress, so identity across equal inputs is assertable.
  const fetchCache = new Map<string, FakeFetch>();
  const fetch = (poolId?: string, tenantId?: string): FakeFetch => {
    fetches.push({ poolId, tenantId });
    const key = `${poolId ?? ""}|${tenantId ?? ""}`;
    const cached = fetchCache.get(key);
    if (cached !== undefined) return cached;
    const fn: FakeFetch = async (_input, init) => {
      return new Response(`ok ${init?.method ?? "GET"}`, {
        headers: { "content-type": "application/json" },
      });
    };
    fetchCache.set(key, fn);
    return fn;
  };
  const bidiCache = new Map<string, FakeBidi>();
  const http2Bidi = (poolId?: string, tenantId?: string): FakeBidi => {
    bidiCalls.push({ poolId, tenantId });
    const key = `${poolId ?? ""}|${tenantId ?? ""}`;
    const cached = bidiCache.get(key);
    if (cached !== undefined) return cached;
    const fn: FakeBidi = async () => {
      throw new Error("bidi not exercised in this unit");
    };
    bidiCache.set(key, fn);
    return fn;
  };
  const fetchWithTls = (profile: string, poolId?: string, tenantId?: string): FakeFetch => {
    // Simple pass-through: profile dials reuse the fetch builder.
    void profile;
    return fetch(poolId, tenantId);
  };
  return { factory: { fetch, http2Bidi, fetchWithTls } as unknown as ValidatedNetworkBindingFactory, fetches, bidiCalls };
}

function captureSink(): ProviderExchangeCapture {
  return { request: null, response: Promise.resolve(null) };
}

function captureState(): CapturePreferenceState {
  return {};
}

describe("buildDispatchNetworkBindings", () => {
  test("returns the identical three keys with the same function objects both call sites built", async () => {
    const { factory, fetches, bidiCalls } = bindingFactory();
    const { db } = preferenceDb();
    const providerCapture = captureSink();
    // The raw closures the helper must hand back verbatim — captured first so
    // identity can be asserted without re-invoking the factory.
    const attachmentReference = factory.fetch("pool-a", "tenant-1");
    const http2Reference = factory.http2Bidi("pool-a", "tenant-1");
    const bindings = await buildDispatchNetworkBindings({
      deps: { networkBindingFactory: factory, db },
      networkPoolId: "pool-a",
      tenantId: "tenant-1",
      providerCapture,
      state: captureState(),
    }) as DispatchNetworkBindings;
    expect(Object.keys(bindings).sort()).toEqual([
      "outboundAttachmentFetch",
      "outboundFetch",
      "outboundHttp2",
      "outboundProfileFetch",
    ]);
    // The attachment and HTTP/2 bindings are the raw factory closures — the
    // same objects the two call sites handed the dispatch context before.
    expect(bindings.outboundAttachmentFetch).toBe(attachmentReference);
    expect(bindings.outboundHttp2).toBe(http2Reference);
    expect(typeof bindings.outboundFetch).toBe("function");
    // Reference call + the helper's wrapped-fetch and attachment-fetch calls.
    expect(fetches).toHaveLength(3);
    expect(bidiCalls).toHaveLength(2);
    for (const call of fetches) {
      expect(call).toEqual({ poolId: "pool-a", tenantId: "tenant-1" });
    }
    for (const call of bidiCalls) {
      expect(call).toEqual({ poolId: "pool-a", tenantId: "tenant-1" });
    }
  });

  test("the wrapped outboundFetch tees the capture sink and forwards to the inner fetch", async () => {
    const { factory } = bindingFactory();
    const { db } = preferenceDb();
    const providerCapture = captureSink();
    const bindings = await buildDispatchNetworkBindings({
      deps: { networkBindingFactory: factory, db },
      networkPoolId: "pool-a",
      tenantId: "tenant-1",
      providerCapture,
      state: captureState(),
    });
    const response = await bindings.outboundFetch!("https://upstream.test/v1/chat/completions", {
      method: "POST",
      body: '{"model":"m"}',
    });
    expect(response.status).toBe(200);
    expect(providerCapture.request).toMatchObject({ method: "POST", body: { model: "m" } });
  });

  test("equal inputs produce identical binding objects across invocations", async () => {
    const { factory } = bindingFactory();
    const { db } = preferenceDb();
    const first = await buildDispatchNetworkBindings({
      deps: { networkBindingFactory: factory, db },
      networkPoolId: "pool-a",
      tenantId: "tenant-1",
      providerCapture: captureSink(),
      state: captureState(),
    });
    const second = await buildDispatchNetworkBindings({
      deps: { networkBindingFactory: factory, db },
      networkPoolId: "pool-a",
      tenantId: "tenant-1",
      providerCapture: captureSink(),
      state: captureState(),
    });
    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());
    // The attachment and HTTP/2 closures are the same factory outputs, so for
    // equal inputs they are identical objects; the wrapped fetch is a fresh
    // closure per call but must behave identically.
    expect(second.outboundAttachmentFetch).toBe(first.outboundAttachmentFetch);
    expect(second.outboundHttp2).toBe(first.outboundHttp2);
    const sinkA = captureSink();
    const sinkB = captureSink();
    await (first.outboundFetch as NonNullable<DispatchNetworkBindings["outboundFetch"]>)(
      "https://upstream.test/v1/chat/completions",
      { method: "POST", body: '{"model":"m"}' },
    );
    await (second.outboundFetch as NonNullable<DispatchNetworkBindings["outboundFetch"]>)(
      "https://upstream.test/v1/chat/completions",
      { method: "POST", body: '{"model":"m"}' },
    );
    expect(sinkA.request).toEqual(sinkB.request);
  });

  test("no network binding factory skips the DB-backed capture-preference read entirely", async () => {
    const db = hpDb();
    const bindings = await buildDispatchNetworkBindings({
      deps: { networkBindingFactory: undefined, db },
      networkPoolId: "pool-a",
      tenantId: "tenant-1",
      providerCapture: captureSink(),
      state: captureState(),
    });
    expect(bindings).toEqual({});
    expect(Object.keys(bindings)).toHaveLength(0);
  });

  test("a network binding factory performs the capture-preference reads (memoized on state)", async () => {
    const { factory } = bindingFactory();
    const { db, reads } = preferenceDb();
    const state = captureState();
    await buildDispatchNetworkBindings({
      deps: { networkBindingFactory: factory, db },
      networkPoolId: "pool-a",
      tenantId: "tenant-1",
      providerCapture: captureSink(),
      state,
    });
    // One preference read serves both the body gate and the depth resolution.
    expect(reads()).toBe(1);
    expect(state.payloadCapturePreference).toMatchObject({ ok: true, mode: "full", depth: "moderate" });
  });
});
