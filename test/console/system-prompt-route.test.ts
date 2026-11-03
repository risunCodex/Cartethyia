/**
 * End-to-end contract for the system-prompt console route: deleting a preset
 * that scopes still reference must not fail the save. The backend neutralizes
 * dangling preset references to `off` instead of rejecting the body, so a
 * combo/alias that used the deleted preset stops injecting rather than
 * blocking the save.
 */
import { expect, test } from "bun:test";
import { createWorld } from "../helpers/fixtures";
import { createTestGateway } from "../helpers/gateway";
import { dbDescribe } from "../helpers/database";

dbDescribe("system-prompt route — dangling preset references", () => {
  test("PUT neutralizes a dangling combo preset reference to off", async () => {
    const world = await createWorld({
      apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] },
    });
    const gateway = await createTestGateway();
    try {
      await gateway.serveWorld(world);

      // A configuration that deletes the preset but leaves the combo pointing
      // at it. Previously this threw "combos references an unknown preset";
      // now the reference is neutralized to off and the save succeeds.
      const body = {
        global: null,
        presets: {},
        providers: {},
        models: {},
        combos: {
          "my-combo": { kind: "preset", presetId: "deleted-preset" },
        },
        aliases: {},
      };

      const put = await gateway.json("/console/api/system-prompt", body, {
        token: world.token,
        method: "PUT",
      });
      expect(put.status).toBe(200);

      const saved = await put.json();
      expect(saved.combos["my-combo"]).toEqual({ kind: "off" });
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });

  test("a valid preset reference is preserved", async () => {
    const world = await createWorld({
      apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] },
    });
    const gateway = await createTestGateway();
    try {
      await gateway.serveWorld(world);

      const body = {
        global: null,
        presets: {
          "keep-me": { id: "keep-me", name: "Keep", enabled: true, mode: "append", text: "hi" },
        },
        providers: {},
        models: {},
        combos: {
          "my-combo": { kind: "preset", presetId: "keep-me" },
        },
        aliases: {},
      };

      const put = await gateway.json("/console/api/system-prompt", body, {
        token: world.token,
        method: "PUT",
      });
      expect(put.status).toBe(200);

      const saved = await put.json();
      expect(saved.combos["my-combo"]).toEqual({ kind: "preset", presetId: "keep-me" });
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });
});
