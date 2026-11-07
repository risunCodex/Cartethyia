/**
 * `mapPlanToTier` — plan string → tier, per provider (area 03 / D14–D15).
 *
 * The mapping is deliberately conservative, mirroring `plan-gate.ts`: a tier
 * is only claimed when the plan string proves it, and anything unrecognized
 * resolves to `null` (unknown ⇒ legacy cooldown behavior).
 */
import { describe, expect, test } from "bun:test";
import { mapPlanToTier } from "../../src/providers/operations/account-tier";

describe("mapPlanToTier", () => {
  test("a null or empty plan is unknown", () => {
    expect(mapPlanToTier("trae", null)).toBeNull();
    expect(mapPlanToTier("trae", "")).toBeNull();
    expect(mapPlanToTier("trae", "   ")).toBeNull();
  });

  test("a free marker wins regardless of provider", () => {
    expect(mapPlanToTier("trae", "Free Plan Subscription")).toBe("free");
    expect(mapPlanToTier("traecn", "Free Plan Subscription")).toBe("free");
    expect(mapPlanToTier("cb", "personal_free_user")).toBe("free");
    expect(mapPlanToTier("cbcn", "personal_free_user_lite")).toBe("free");
    expect(mapPlanToTier("qoder", "free")).toBe("free");
    expect(mapPlanToTier("cursor", "FREE")).toBe("free");
  });

  test("Trae paid plans map to paid", () => {
    expect(mapPlanToTier("trae", "Pro")).toBe("paid");
    expect(mapPlanToTier("trae", "Premium")).toBe("paid");
    expect(mapPlanToTier("traecn", "Pro")).toBe("paid");
  });

  test("buddy-family paid plans map to paid; enterprise/team map to pro", () => {
    expect(mapPlanToTier("cb", "Professional")).toBe("paid");
    expect(mapPlanToTier("cbcn", "Team")).toBe("pro");
  });

  test("Cursor non-free membership maps to paid", () => {
    expect(mapPlanToTier("cursor", "Pro")).toBe("paid");
    expect(mapPlanToTier("cursor", "Ultra")).toBe("paid");
    expect(mapPlanToTier("cursor", "Hobby")).toBe("paid");
  });

  test("Qoder non-personal_standard / org maps to pro; personal_standard stays unknown", () => {
    expect(mapPlanToTier("qoder", "team")).toBe("pro");
    expect(mapPlanToTier("qoder", "enterprise")).toBe("pro");
    expect(mapPlanToTier("qodercn", "org_admin")).toBe("pro");
    expect(mapPlanToTier("qoder", "personal_pro")).toBe("pro");
    // `personal_standard` is the default personal type — not proven pro, and
    // not free, so it stays unknown.
    expect(mapPlanToTier("qoder", "personal_standard")).toBeNull();
  });

  test("unknown providers and plans stay unknown", () => {
    expect(mapPlanToTier("openai", "Pro")).toBeNull();
    expect(mapPlanToTier("grok", "SuperGrok")).toBeNull();
    expect(mapPlanToTier("kimi", "Kimi")).toBeNull();
    expect(mapPlanToTier("trae", "MysteryPlan")).toBe("paid"); // Trae non-free = paid by construction
  });

  test("provider ids are case-insensitive", () => {
    expect(mapPlanToTier("TRAE", "Pro")).toBe("paid");
    expect(mapPlanToTier("Cursor", "Pro")).toBe("paid");
    expect(mapPlanToTier("QODER", "team")).toBe("pro");
  });
});
