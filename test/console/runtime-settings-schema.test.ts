/**
 * The update schema must accept every field the request type allows.
 *
 * This is the guard that was missing. `runtimeUpdateBody` is what the route
 * parses a PATCH against, and a key the schema does not name is dropped before
 * the store sees it — so a field can be fully implemented, typed, validated in
 * the store, and still do nothing at all. The four operational overrides were
 * exactly that: the request carried them, the 200 came back, the toast fired,
 * and the stored value never moved.
 *
 * Asserted against the request type's own keys rather than a hand-written list,
 * because a second list is the thing that drifts.
 */
import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { runtimeUpdateBody } from "../../src/console/settings/contracts";
import type { UpdateRuntimeSettingsRequest } from "../../src/console/settings/contracts";

const SCHEMA_KEYS = Object.keys(runtimeUpdateBody.properties ?? {});

// Every key the type declares, checked without a value: TypeScript types are
// erased at runtime, so this list is the one place the two are joined by hand.
// Adding a field to the type and forgetting the schema is the failure this
// catches, and it cannot be caught by the compiler.
const REQUEST_KEYS: readonly (keyof UpdateRuntimeSettingsRequest)[] = [
  "tenantConcurrencyLimit",
  "thinkingNormalizationEnabled",
  "responsesReasoningSummary",
  "telemetryPayloads",
  "telemetryPayloadDepth",
  "privacyMode",
  "rtkPruneEnabled",
  "rtkPruneLevel",
  "ponyTailEnabled",
  "ponyTailLevel",
  "forceDisableCooldown",
  "invokeDisabled",
  "concurrencyTolerance",
  "upstreamTimeoutSeconds",
  "telemetryWindowMinutes",
  "imageClampMaxBytes",
  "visionHandoffModels",
];

describe("runtimeUpdateBody", () => {
  test("accepts every field the request type declares", () => {
    for (const key of REQUEST_KEYS) {
      expect(SCHEMA_KEYS).toContain(key);
    }
  });

  test("names nothing the request type does not have", () => {
    // The other direction: a stale schema key is dead weight that misleadingly
    // suggests a field can be patched.
    for (const key of SCHEMA_KEYS) {
      expect(REQUEST_KEYS as readonly string[]).toContain(key);
    }
  });

  test("the operational overrides are present by name", () => {
    // Called out separately: these are the four that were silently dropped, and
    // a generic assertion above would not make that history legible.
    for (const key of [
      "forceDisableCooldown",
      "upstreamTimeoutSeconds",
      "telemetryWindowMinutes",
      "imageClampMaxBytes",
    ]) {
      expect(SCHEMA_KEYS).toContain(key);
    }
  });

  test("null is accepted for the numeric overrides", () => {
    // "Deployment default" is sent as null. Rejecting it would make clearing an
    // override impossible, which is a different bug with the same symptom.
    const nullable = [
      "upstreamTimeoutSeconds",
      "telemetryWindowMinutes",
      "imageClampMaxBytes",
    ];
    for (const key of nullable) {
      expect(Value.Check(runtimeUpdateBody, { [key]: null })).toBe(true);
      const value = key === "imageClampMaxBytes" ? 64 * 1024 : 60;
      expect(Value.Check(runtimeUpdateBody, { [key]: value })).toBe(true);
      expect(Value.Check(runtimeUpdateBody, { [key]: "60" })).toBe(false);
    }
  });

  test("the vision handoff array accepts an ordered list and rejects non-arrays", () => {
    expect(
      Value.Check(runtimeUpdateBody, {
        visionHandoffModels: ["provider-a/vision-1", "provider-b/vision-2"],
      }),
    ).toBe(true);
    expect(Value.Check(runtimeUpdateBody, { visionHandoffModels: [] })).toBe(true);
    expect(Value.Check(runtimeUpdateBody, { visionHandoffModels: "provider-a/vision-1" })).toBe(false);
    expect(Value.Check(runtimeUpdateBody, { visionHandoffModels: [1, 2] })).toBe(false);
  });

  test("the separate payload retention override is no longer accepted", () => {
    expect(SCHEMA_KEYS).not.toContain("telemetryPayloadRetentionMinutes");
  });
});
