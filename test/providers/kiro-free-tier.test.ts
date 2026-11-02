/**
 * Kiro free-tier roster — the KIRO FREE plan's model set.
 *
 * The console model list groups free-tier rows under the same "Free tier" pill
 * every other provider uses, driven solely by `freeTier === true` on the row
 * (see `dashboard/src/features/provider-detail/sections/Models.tsx`). This pins
 * which Kiro rows claim that tier so the pill never silently disappears or
 * spreads to a paid row: a Pro row marked free would bill the wrong plan, and
 * a free row unmarked would hide the pill.
 *
 * The free set is the plan's own: auto, claude-haiku-4.5, claude-sonnet-4.5,
 * glm-5 — with the windows published on the plan (1M/32k for auto, 200k/64k
 * for the other three).
 */
import { describe, expect, test } from "bun:test";
import { KIRO_MODELS } from "../../src/providers/integrations/kiro/kiro-catalog";

const KIRO_FREE_IDS = ["auto", "claude-haiku-4.5", "claude-sonnet-4.5", "glm-5"];

describe("Kiro free-tier roster", () => {
  test("the free set is exactly the four KIRO FREE models", () => {
    const free = KIRO_MODELS.filter((m) => m.freeTier === true).map((m) => m.modelId).sort();
    expect(free).toEqual([...KIRO_FREE_IDS].sort());
  });

  test("every free row claims the tier; no paid row does", () => {
    for (const row of KIRO_MODELS) {
      if (KIRO_FREE_IDS.includes(row.modelId)) {
        expect(row.freeTier).toBe(true);
      } else {
        expect(row.freeTier).toBeUndefined();
      }
    }
  });

  test("free rows carry the plan's published windows", () => {
    const byId = new Map(KIRO_MODELS.map((m) => [m.modelId, m]));
    const auto = byId.get("auto");
    expect(auto?.contextLimit).toBe(1_000_000);
    expect(auto?.outputLimit).toBe(32_000);
    for (const id of ["claude-haiku-4.5", "claude-sonnet-4.5", "glm-5"]) {
      const row = byId.get(id);
      expect(row?.contextLimit).toBe(200_000);
      expect(row?.outputLimit).toBe(64_000);
    }
  });
});
