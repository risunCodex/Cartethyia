/**
 * The shutdown coordinator's constructor defaults must equal what production
 * `bootstrap()` actually passes — otherwise reading the class gives a wrong
 * answer for drain timing, and `totalShutdownBudgetMs()` (which drives the
 * process force-exit guard in main.ts) inherits whichever copy was used.
 */
import { describe, expect, test } from "bun:test";
import { ShutdownCoordinator } from "../../src/boot/lifecycle";

describe("ShutdownCoordinator defaults", () => {
  test("constructor defaults match the production bootstrap() drain budgets", () => {
    const coordinator = new ShutdownCoordinator();
    // drainWindowMs 20_000 + drainTimeoutMs 8_000 + flushTimeoutMs 1_000
    // + the 5_000 margin in totalShutdownBudgetMs().
    expect(coordinator.totalShutdownBudgetMs()).toBe(34_000);
  });

  test("explicit opts override the defaults", () => {
    const coordinator = new ShutdownCoordinator(
      {},
      { drainWindowMs: 0, drainTimeoutMs: 1_000, flushTimeoutMs: 500 },
    );
    expect(coordinator.totalShutdownBudgetMs()).toBe(0 + 1_000 + 500 + 5_000);
  });
});
