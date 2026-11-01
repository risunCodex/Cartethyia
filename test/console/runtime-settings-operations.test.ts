/**
 * The operational settings: cooldown override, upstream timeout, detail window.
 *
 * These are the knobs that used to be deployment-only env vars. Two properties
 * matter more than the values themselves:
 *
 * - **A dangerous default stays off.** `forceDisableCooldown` must survive a
 *   round trip as `false` when nothing was ever written — a stored preference
 *   bag that omits it is not consent to route around cooldowns.
 * - **A number outside the request path's range is clamped, not stored raw.**
 *   These override values are read while dispatching, so an out-of-range one
 *   would be a live footgun; clamping keeps them inside the range the
 *   deployment env var itself accepts.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { getDb } from "../../src/persistence/boot";
import { consoleSettings } from "../../src/persistence/schema";
import { DrizzleRuntimeSettingsStore } from "../../src/console/settings/store";
import { createRuntimeSettingsOperations } from "../../src/console/settings/contracts";
import { resolvePayloadCapture } from "../../src/observability/payload-capture";
import { dbDescribe, requireDatabase } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

requireDatabase();

dbDescribe("operational runtime settings", () => {
  let world: GatewayWorld;
  let store: DrizzleRuntimeSettingsStore;

  beforeAll(async () => {
    world = await createWorld();
    store = new DrizzleRuntimeSettingsStore(getDb(), "redis");
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  /** Writes a raw preferences bag, exactly as the dashboard's PATCH leaves it. */
  async function writeBag(preferences: Record<string, unknown>): Promise<void> {
    await getDb()
      .insert(consoleSettings)
      .values({ tenantId: world.tenantId, preferences, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: { preferences, updatedAt: new Date() },
      });
  }

  test("an unset cooldown override stays off", async () => {
    // The dangerous direction: absent must never read as enabled.
    await writeBag({});
    const settings = await store.get(world.tenantId);
    expect(settings.forceDisableCooldown).toBe(false);
  });

  test("a cooldown override round-trips", async () => {
    await writeBag({ forceDisableCooldown: true });
    expect((await store.get(world.tenantId)).forceDisableCooldown).toBe(true);
    await writeBag({ forceDisableCooldown: false });
    expect((await store.get(world.tenantId)).forceDisableCooldown).toBe(false);
  });

  test("an absent numeric override reads as null, not zero", async () => {
    // `null` means "use the deployment default"; zero would be a real (and
    // unusable) value. Conflating them would silently disable a timeout.
    await writeBag({});
    const settings = await store.get(world.tenantId);
    expect(settings.upstreamTimeoutSeconds).toBeNull();
    expect(settings.telemetryWindowMinutes).toBeNull();
  });

  test("an out-of-range timeout is clamped to the env var's own bounds", async () => {
    await writeBag({ upstreamTimeoutSeconds: 999_999 });
    expect((await store.get(world.tenantId)).upstreamTimeoutSeconds).toBe(600);
    await writeBag({ upstreamTimeoutSeconds: 3 });
    expect((await store.get(world.tenantId)).upstreamTimeoutSeconds).toBe(5);
  });

  test("a negative or non-numeric override reads as null", async () => {
    // Neither is a value the request path can honour, and neither should be
    // stored as one: they mean "no override".
    await writeBag({ upstreamTimeoutSeconds: -5 });
    expect((await store.get(world.tenantId)).upstreamTimeoutSeconds).toBeNull();
    await writeBag({ telemetryWindowMinutes: "not a number" });
    expect((await store.get(world.tenantId)).telemetryWindowMinutes).toBeNull();
  });

  test("a request detail window override round-trips", async () => {
    await writeBag({ telemetryWindowMinutes: 14 });
    expect((await store.get(world.tenantId)).telemetryWindowMinutes).toBe(14);
    const capture = await resolvePayloadCapture(getDb(), world.tenantId);
    expect(capture.ok).toBe(true);
    if (capture.ok) expect(capture.retentionMs).toBe(14 * 60_000);
  });

  test("an attachment ceiling round-trips", async () => {
    await writeBag({ imageClampMaxBytes: 25 * 1024 * 1024 });
    expect((await store.get(world.tenantId)).imageClampMaxBytes).toBe(25 * 1024 * 1024);
  });

  test("an attachment ceiling is clamped to what the clamp can honour", async () => {
    // 64 KB floor, 100 MB ceiling: outside that the value would either admit
    // nothing usable or promise more than any upstream takes.
    await writeBag({ imageClampMaxBytes: 1 });
    expect((await store.get(world.tenantId)).imageClampMaxBytes).toBe(64 * 1024);
    await writeBag({ imageClampMaxBytes: 500 * 1024 * 1024 });
    expect((await store.get(world.tenantId)).imageClampMaxBytes).toBe(100 * 1024 * 1024);
  });

  test("vision handoff models default to empty", async () => {
    await writeBag({});
    expect((await store.get(world.tenantId)).visionHandoffModels).toEqual([]);
  });

  test("vision handoff models round-trip in order", async () => {
    await writeBag({
      visionHandoffModels: [
        "provider-a/vision-1",
        "provider-b/vision-2",
        "provider-a/vision-1",
        "",
        "  provider-c/vision-3  ",
      ],
    });
    // Trims, de-duplicates, and drops empties while preserving order.
    expect((await store.get(world.tenantId)).visionHandoffModels).toEqual([
      "provider-a/vision-1",
      "provider-b/vision-2",
      "provider-c/vision-3",
    ]);
  });

  test("vision handoff models normalize non-array values to empty", async () => {
    await writeBag({ visionHandoffModels: "provider-a/vision-1" as unknown as string[] });
    expect((await store.get(world.tenantId)).visionHandoffModels).toEqual([]);
  });
});

/**
 * Saving a preference must invalidate the route snapshot.
 *
 * Two preferences are read on the request path: `forceDisableCooldown` decides
 * candidate eligibility when the snapshot is built, and
 * `tenantConcurrencyLimit` decides admission. The snapshot is cached until
 * something invalidates it, so a save that does not invalidate leaves `/v1/*`
 * dispatching the pre-save revision until some unrelated console write happens
 * to clear it — the toggle looks broken while the row is already correct.
 */
dbDescribe("runtime settings invalidate the route snapshot", () => {
  let world: GatewayWorld;
  let invalidations: number;

  beforeAll(async () => {
    world = await createWorld();
    invalidations = 0;
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  /** A tenant-scoped access decision, as the route layer supplies it. */
  const access = () =>
    ({
      id: "key",
      tenantId: world.tenantId,
      tenant_id: world.tenantId,
      scopes: ["dashboard:read", "dashboard:write"],
    }) as never;

  function operations(): ReturnType<typeof createRuntimeSettingsOperations> {
    invalidations = 0;
    return createRuntimeSettingsOperations({
      store: new DrizzleRuntimeSettingsStore(getDb(), "redis"),
      accessResolver: () => undefined,
      snapshotInvalidator: {
        invalidate: () => {
          invalidations += 1;
          return Promise.resolve(1);
        },
      },
    });
  }

  test("a save invalidates so the next request reads it", async () => {
    await operations().update(access(), { forceDisableCooldown: true });
    expect(invalidations).toBe(1);
    await operations().update(access(), { tenantConcurrencyLimit: 4 });
    expect(invalidations).toBe(1);
  });

  test("a rejected save does not invalidate", async () => {
    // Nothing was written, so there is nothing to rebuild for.
    await expect(
      operations().update(access(), { tenantConcurrencyLimit: 0 }),
    ).rejects.toThrow();
    expect(invalidations).toBe(0);
  });

  test("a save still returns when the invalidator fails", async () => {
    // The row is already committed; a failed rebuild must not fail the save,
    // or the operator sees an error for a setting that was stored.
    const ops = createRuntimeSettingsOperations({
      store: new DrizzleRuntimeSettingsStore(getDb(), "redis"),
      accessResolver: () => undefined,
      snapshotInvalidator: {
        invalidate: () => Promise.reject(new Error("snapshot service down")),
      },
    });
    const updated = await ops.update(access(), { forceDisableCooldown: false });
    expect(updated.forceDisableCooldown).toBe(false);
  });
});
