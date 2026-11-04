import { describe, expect, test } from "bun:test";
import { filterCandidateQuotaWindows, EligibilityEvaluator } from "../../src/transport/routing/router";
import type { ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

describe("filterCandidateQuotaWindows", () => {
  const windows: ProviderQuotaWindow[] = [
    {
      kind: "weekly:Gemini",
      label: "Gemini (Weekly)",
      accounting: "independent",
      usedPercent: 4,
      remainingPercent: 96,
      resetsAt: "2026-11-08T04:07:34.000Z",
    },
    {
      kind: "session:Gemini",
      label: "Gemini (5 Hour)",
      accounting: "independent",
      usedPercent: 4,
      remainingPercent: 96,
      resetsAt: "2026-11-02T04:08:14.000Z",
    },
    {
      kind: "google:model",
      label: "Gemini (Flash / Pro)",
      accounting: "independent",
      usedPercent: 4,
      remainingPercent: 96,
      resetsAt: "2026-11-02T04:08:14.000Z",
    },
    {
      kind: "weekly:Claude & GPT",
      label: "Claude & GPT (Weekly)",
      accounting: "independent",
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: "2026-11-03T09:13:02.000Z",
    },
    {
      kind: "session:Claude & GPT",
      label: "Claude & GPT (5 Hour)",
      accounting: "independent",
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: "2026-11-02T05:05:08.000Z",
    },
    {
      kind: "claude:model",
      label: "Claude (Sonnet / Opus)",
      accounting: "independent",
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: "2026-11-03T09:13:02.000Z",
    },
  ];

  test("isolates Gemini windows when candidate is a Gemini model under Antigravity", () => {
    const candidate = {
      provider_id: "antigravity",
      model_id: "gemini-3.8-flash",
    };
    const filtered = filterCandidateQuotaWindows(windows, candidate);
    expect(filtered.map((w) => w.kind)).toEqual([
      "weekly:Gemini",
      "session:Gemini",
      "google:model",
    ]);
  });

  test("isolates Claude windows when candidate is a Claude model under Antigravity", () => {
    const candidate = {
      provider_id: "antigravity",
      model_id: "claude-sonnet-4-6",
    };
    const filtered = filterCandidateQuotaWindows(windows, candidate);
    expect(filtered.map((w) => w.kind)).toEqual([
      "weekly:Claude & GPT",
      "session:Claude & GPT",
      "claude:model",
    ]);
  });

  test("EligibilityEvaluator marks Gemini eligible when only Claude windows are exhausted", () => {
    const evaluator = new EligibilityEvaluator();
    const geminiCandidate = {
      provider_id: "antigravity",
      model_id: "gemini-3.8-flash",
      wire_family: "chat",
      endpoint: "/v1internal:generateContent",
      capability_profile: {},
      quota_windows: filterCandidateQuotaWindows(windows, {
        provider_id: "antigravity",
        model_id: "gemini-3.8-flash",
      }),
    } as unknown as RouteCandidate;

    const geminiDecision = evaluator.evaluate(geminiCandidate);
    expect(geminiDecision.eligible).toBe(true);
    expect(geminiDecision.reason).toBe("healthy");

    // Exhausted quota is deliberately NOT an eligibility exclusion anymore: the
    // account is still routed and the upstream is the one that answers. Quota
    // only affects ordering (creditPriority), never eligibility.
    const claudeCandidate = {
      provider_id: "antigravity",
      model_id: "claude-sonnet-4-6",
      wire_family: "chat",
      endpoint: "/v1internal:generateContent",
      capability_profile: {},
      quota_windows: filterCandidateQuotaWindows(windows, {
        provider_id: "antigravity",
        model_id: "claude-sonnet-4-6",
      }),
    } as unknown as RouteCandidate;

    const claudeDecision = evaluator.evaluate(claudeCandidate);
    expect(claudeDecision.eligible).toBe(true);
    expect(claudeDecision.reason).toBe("healthy");
  });
});
