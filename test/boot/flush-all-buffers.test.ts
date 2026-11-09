/**
 * The shared flush sequence drains every buffered writer in the canonical
 * order. Both wired call sites — the console's manual flush route and the
 * shutdown coordinator's `flushTelemetry` hook — call this helper, so the
 * order and writer set are pinned here: a fourth writer added to one path but
 * not the other would fail this test instead of silently diverging.
 */
import { describe, expect, test } from "bun:test";
import { flushAllBuffers } from "../../src/boot/flush";

describe("flushAllBuffers", () => {
  test("flushes telemetry, usage, then health events, in order", async () => {
    const order: string[] = [];
    const deps = {
      telemetryBuffer: {
        flush: async () => {
          order.push("telemetry");
        },
      },
      usageFlush: {
        flush: async () => {
          order.push("usage");
        },
      },
      healthEventFlush: {
        flush: async () => {
          order.push("health");
        },
      },
    };

    await flushAllBuffers(deps);

    expect(order).toEqual(["telemetry", "usage", "health"]);
  });

  test("propagates a failing writer", async () => {
    await expect(
      flushAllBuffers({
        telemetryBuffer: { flush: async () => {} },
        usageFlush: {
          flush: async () => {
            throw new Error("usage flush failed");
          },
        },
        healthEventFlush: { flush: async () => {} },
      }),
    ).rejects.toThrow("usage flush failed");
  });
});
