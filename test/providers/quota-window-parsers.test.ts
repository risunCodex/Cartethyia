/**
 * Direct unit tests for the two quota window parsers (M-25).
 *
 * These pin the invariants both walkers must keep in sync through the shared
 * per-window field-resolution core:
 *  - skip rule: an entry with neither percent nor reset is dropped, never
 *    rendered as 0%;
 *  - percent fallback chain: used-percent, then remaining-percent inverted,
 *    then derived from absolute used/limit (parseQuotaWindows only);
 *  - label-dedup order: declarative windows first, `limits[]` later;
 *  - the 0-vs-null distinction: a genuine 0 percentage is kept, a missing one
 *    is null, never coerced.
 */
import { describe, expect, test } from "bun:test";
import { parseLimitWindows } from "../../src/providers/quota/quota-limit-windows";
import { parseQuotaWindows } from "../../src/providers/quota/quota-window-parser";

describe("parseLimitWindows", () => {
  test("reads a percent-only entry and emits it with the given label", () => {
    const windows = parseLimitWindows(
      { limits: [{ type: "weekly", percentUsed: 55, resetsAt: null }] },
      {
        kindPaths: ["type"],
        percentPaths: ["percentUsed"],
        resetPaths: ["resetsAt"],
        labelFor: (kind) => (kind === "weekly" ? "7 Day" : null),
        fallbackLabel: (kind) => kind,
      },
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.kind).toBe("weekly");
    expect(windows[0]?.label).toBe("7 Day");
    expect(windows[0]?.usedPercent).toBe(55);
    expect(windows[0]?.remainingPercent).toBe(45);
    expect(windows[0]?.resetsAt).toBeNull();
    expect(windows[0]?.accounting).toBe("independent");
  });

  test("emits a reset-only entry (emitWithoutPercent) with a null percent", () => {
    const windows = parseLimitWindows(
      { limits: [{ type: "weekly", resetsAt: "2026-12-01T00:00:00.000Z" }] },
      {
        kindPaths: ["type"],
        percentPaths: ["percentUsed"],
        resetPaths: ["resetsAt"],
        fallbackLabel: (kind) => kind,
      },
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.usedPercent).toBeNull();
    expect(windows[0]?.remainingPercent).toBeNull();
    expect(windows[0]?.resetsAt).toBe("2026-12-01T00:00:00.000Z");
  });

  test("drops an entry with neither percent nor reset — never renders 0%", () => {
    const windows = parseLimitWindows(
      { limits: [{ type: "weekly" }] },
      {
        kindPaths: ["type"],
        percentPaths: ["percentUsed"],
        resetPaths: ["resetsAt"],
        fallbackLabel: (kind) => kind,
      },
    );
    expect(windows).toEqual([]);
  });

  test("derives the absolute used value via deriveUsed (Cline shape)", () => {
    const windows = parseLimitWindows(
      { limits: [{ type: "weekly", percentUsed: 25, limit: 100 }] },
      {
        kindPaths: ["type"],
        percentPaths: ["percentUsed"],
        resetPaths: ["resetsAt"],
        limitPaths: ["limit"],
        deriveUsed: (_entry, usedPercent, limit) =>
          usedPercent !== null && limit !== null ? (limit * usedPercent) / 100 : null,
        fallbackLabel: (kind) => kind,
      },
    );
    expect(windows[0]?.used).toBe(25);
    expect(windows[0]?.limit).toBe(100);
    expect(windows[0]?.usedPercent).toBe(25);
  });

  test("keeps a genuine 0 percent distinct from null", () => {
    const windows = parseLimitWindows(
      { limits: [{ type: "weekly", percentUsed: 0, resetsAt: null }] },
      {
        kindPaths: ["type"],
        percentPaths: ["percentUsed"],
        resetPaths: ["resetsAt"],
        fallbackLabel: (kind) => kind,
      },
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.usedPercent).toBe(0);
  });
});

describe("parseQuotaWindows", () => {
  test("uses the used-percent path and derives from remaining percent when absent", () => {
    const result = parseQuotaWindows(
      { remaining_percent: 20 },
      [
        {
          kind: "weekly",
          label: "7 Day",
          usedPercentPaths: [["used_percent"]],
          remainingPercentPaths: [["remaining_percent"]],
        },
      ],
      { source: "test" },
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.usedPercent).toBe(80);
  });

  test("derives percent from absolute used/limit when no percentage is reported", () => {
    const result = parseQuotaWindows(
      { used: 30, limit: 120 },
      [
        {
          kind: "monthly",
          label: "30 Day",
          usedPaths: [["used"]],
          limitPaths: [["limit"]],
        },
      ],
      { source: "test" },
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.usedPercent).toBe(25);
    expect(result.windows[0]?.used).toBe(30);
    expect(result.windows[0]?.limit).toBe(120);
  });

  test("drops an entry with neither percent nor reset unless emitWithoutPercent", () => {
    const result = parseQuotaWindows(
      { limit: 120 },
      [{ kind: "weekly", label: "7 Day", limitPaths: [["limit"]] }],
      { source: "test" },
    );
    expect(result.windows).toEqual([]);
  });

  test("emitWithoutPercent emits a reset-only window with a null percent", () => {
    const result = parseQuotaWindows(
      { resets_at: "2026-12-01T00:00:00.000Z" },
      [
        {
          kind: "weekly",
          label: "7 Day",
          resetPaths: [["resets_at"]],
          emitWithoutPercent: true,
        },
      ],
      { source: "test" },
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.usedPercent).toBeNull();
    expect(result.windows[0]?.resetsAt).toBe("2026-12-01T00:00:00.000Z");
  });

  test("dedups by label with declarative windows winning over limits[]", () => {
    const result = parseQuotaWindows(
      {
        five_hour: { utilization: 10 },
        limits: [{ kind: "session", percent: 12, resets_at: null }],
      },
      [
        {
          kind: "session",
          label: "5 Hour",
          usedPercentPaths: [["five_hour", "utilization"]],
          resetPaths: [["five_hour", "resets_at"]],
          emitWithoutPercent: true,
        },
      ],
      {
        source: "claude",
        transform: (value) => value as Record<string, unknown>,
        extraWindows: (payload) =>
          parseLimitWindows(payload, {
            kindPaths: ["kind"],
            percentPaths: ["percent"],
            resetPaths: ["resets_at"],
            labelFor: (kind) => (kind === "session" ? "5 Hour" : null),
            fallbackLabel: (kind) => kind,
          }),
      },
    );
    // The declarative "5 Hour" wins; the limits[] duplicate is dropped.
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.label).toBe("5 Hour");
    expect(result.windows[0]?.usedPercent).toBe(10);
  });

  test("a payload with only limits[] still shows its windows", () => {
    const result = parseQuotaWindows(
      {
        limits: [{ kind: "weekly_all", percent: 40, resets_at: null }],
      },
      [],
      {
        source: "claude",
        transform: (value) => value as Record<string, unknown>,
        extraWindows: (payload) =>
          parseLimitWindows(payload, {
            kindPaths: ["kind"],
            percentPaths: ["percent"],
            resetPaths: ["resets_at"],
            labelFor: (kind) => (kind === "weekly_all" ? "7 Day" : null),
            fallbackLabel: (kind) => kind,
          }),
      },
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.label).toBe("7 Day");
    expect(result.windows[0]?.usedPercent).toBe(40);
  });

  test("keeps a genuine 0 percent distinct from null", () => {
    const result = parseQuotaWindows(
      { used_percent: 0 },
      [
        {
          kind: "weekly",
          label: "7 Day",
          usedPercentPaths: [["used_percent"]],
        },
      ],
      { source: "test" },
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.usedPercent).toBe(0);
  });

  test("applies the valueMultiplier to the resolved percent (Ollama shape)", () => {
    const result = parseQuotaWindows(
      { limits: { session: { usage: 0.3 } } },
      [
        {
          kind: "session",
          label: "Session (5h)",
          usedPercentPaths: [["limits", "session", "usage"]],
          valueMultiplier: 100,
        },
      ],
      { source: "ollama" },
    );
    expect(result.windows[0]?.usedPercent).toBe(30);
  });
});
