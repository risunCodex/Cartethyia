/**
 * Qoder risk telemetry (p4 streak) and per-account dispatch spacing.
 *
 * The donor hub's issue #158 pinned the semantics: a sustained
 * `queueType=p4`/`RESOURCE_LIMIT` envelope across accounts, realms, and
 * models with healthy quota is an egress/machine risk pin, not a capacity
 * queue — and the upstream also scores request cadence (its PR #78 added a
 * per-account concurrency-1 + ≥400ms gate).
 */
import { describe, expect, test } from "bun:test";
import {
  _resetQoderRisk,
  noteQoderDispatchOk,
  noteQoderQueue,
  qoderAccountGate,
  qoderMinGapMs,
  qoderRiskSnapshot,
  warnCount,
} from "../../../src/providers/integrations/qoder/qoder-risk";

describe("qoder risk counters", () => {
  test("a p4 streak warns once at the threshold and resets on success", () => {
    _resetQoderRisk();
    expect(warnCount).toBe(0);
    for (let i = 0; i < 5; i += 1) noteQoderQueue("qoder", "p4");
    expect(warnCount).toBe(1); // one line at streak 5, not five
    expect(qoderRiskSnapshot("qoder").p4Streak).toBe(5);
    // A p3 capacity queue breaks the p4 streak.
    noteQoderQueue("qoder", "p3");
    expect(qoderRiskSnapshot("qoder").p4Streak).toBe(0);
    for (let i = 0; i < 5; i += 1) noteQoderQueue("qoder", "p4");
    expect(warnCount).toBe(2); // new streak escalates again
    noteQoderDispatchOk("qoder");
    expect(qoderRiskSnapshot("qoder").p4Streak).toBe(0);
  });

  test("queues without a stated type still count toward the total", () => {
    _resetQoderRisk();
    noteQoderQueue("qodercn", undefined);
    const snapshot = qoderRiskSnapshot("qodercn");
    expect(snapshot.queueTotal).toBe(1);
    expect(snapshot.p4Streak).toBe(0);
  });
});

describe("qoder per-account dispatch spacing", () => {
  test("the second immediate dispatch waits out the minimum gap", async () => {
    _resetQoderRisk();
    process.env["CARTETHYIA_QODER_MIN_GAP_MS"] = "120";
    await qoderAccountGate("qoder", "acct-1");
    const start = Date.now();
    await qoderAccountGate("qoder", "acct-1");
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    delete process.env["CARTETHYIA_QODER_MIN_GAP_MS"];
  });

  test("different accounts and providers gate independently", async () => {
    _resetQoderRisk();
    process.env["CARTETHYIA_QODER_MIN_GAP_MS"] = "150";
    const start = Date.now();
    await qoderAccountGate("qoder", "acct-1");
    await qoderAccountGate("qoder", "acct-2");
    await qoderAccountGate("qodercn", "acct-1");
    expect(Date.now() - start).toBeLessThan(120);
    delete process.env["CARTETHYIA_QODER_MIN_GAP_MS"];
  });

  test("the default gap is the hub's proven 400ms", () => {
    delete process.env["CARTETHYIA_QODER_MIN_GAP_MS"];
    expect(qoderMinGapMs()).toBe(400);
    process.env["CARTETHYIA_QODER_MIN_GAP_MS"] = "0";
    expect(qoderMinGapMs()).toBe(0);
    process.env["CARTETHYIA_QODER_MIN_GAP_MS"] = "bogus";
    // The config spec validates the integer range — a bad value refuses to boot.
    expect(() => qoderMinGapMs()).toThrow(/must be an integer/);
    delete process.env["CARTETHYIA_QODER_MIN_GAP_MS"];
  });
});
