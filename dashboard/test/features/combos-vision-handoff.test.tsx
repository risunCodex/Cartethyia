/**
 * Vision-handoff section keeps its model list in sync with the runtime
 * settings query even when that query resolves *after* mount (cold cache).
 * The list is not an initializer: the query can land later, and freezing the
 * list on the first render kept a just-saved model invisible until a hard
 * refresh.
 */
import { expect, test } from "bun:test";
import { createElement } from "react";
import { VisionHandoffSection } from "../../src/features/routing/CombosPage";
import { createTestQueryClient, mount } from "../helpers/render";
import { registerDom } from "../helpers/dom";
import { queryKeys } from "../../src/data/query-keys";
import type { RuntimeSettingsResponse } from "../../../src/console/settings/contracts";

registerDom();

function settings(handoff: readonly string[]): RuntimeSettingsResponse {
  return {
    redisBackendActual: "memory",
    tenantConcurrencyLimit: null,
    thinkingNormalizationEnabled: false,
    responsesReasoningSummary: "detailed",
    telemetryPayloads: "metadata",
    telemetryPayloadDepth: "minimum",
    privacyMode: "masked",
    rtkPruneEnabled: false,
    rtkPruneLevel: "full",
    ponyTailEnabled: false,
    ponyTailLevel: "full",
    forceDisableCooldown: false,
    invokeDisabled: false,
    concurrencyTolerance: null,
    upstreamTimeoutSeconds: null,
    telemetryWindowMinutes: null,
    imageClampMaxBytes: null,
    visionHandoffModels: handoff,
    updatedAt: "2026-11-02T00:00:00.000Z",
    defaults: {
      upstreamTimeoutSeconds: 120,
      telemetryWindowMinutes: 60,
      imageClampMaxBytes: 10 * 1024 * 1024,
      telemetryRetentionDays: 7,
    },
  };
}

test("shows saved handoff models when the settings query resolves after mount", async () => {
  const client = createTestQueryClient();
  // Cold cache: the first render sees empty settings.
  client.setQueryData(queryKeys.settings.runtime, settings([]));
  const { container, act, flush, unmount } = await mount(
    createElement(VisionHandoffSection),
    { queryClient: client },
  );
  try {
    expect(container.textContent).toContain("No vision handoff models");

    // The settings query resolves later with the saved list.
    await act(async () => {
      client.setQueryData(queryKeys.settings.runtime, settings(["cb/hy3"]));
    });
    await flush();

    expect(container.textContent).not.toContain("No vision handoff models");
    expect(container.textContent).toContain("cb/hy3");
  } finally {
    unmount();
  }
});
