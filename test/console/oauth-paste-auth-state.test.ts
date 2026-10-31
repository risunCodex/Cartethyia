/**
 * An OAuth paste that carries an `authState` bag must persist it whole.
 *
 * The paste importer used to cherry-pick `profileArn/authMethod/region/userId`
 * from the wrapper and silently dropped every other key — so a re-import of an
 * exported Qoder account lost `machineId` and answered 401 "missing its user
 * identity" at dispatch, buddy accounts lost their `qimei36` device binding,
 * cursor lost its login `method`, coreweave lost its project. The bag travels
 * wholesale now; these tests pin that, plus the alias picks older export shapes
 * rely on and the stale metadata that must NOT survive a re-import.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providers, tenants } from "../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import { ProviderRegistry } from "../../src/providers/provider-registry";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

/** One temp SQLite database with a tenant; the store is exercised directly. */
async function withStore(
  run: (ctx: { readonly store: DrizzleProviderCatalogStore; readonly tenantId: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-paste-authstate-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    // Accounts hang off a provider row (`opencode` is a bundled id).
    await db.insert(providers).values({ id: "opencode" });
    const store = new DrizzleProviderCatalogStore(db, {
      telemetryBuffer: { enqueue() {} } as never,
      bundledModelCatalog: { modelsByProvider: new Map() },
      providerRegistry: new ProviderRegistry(),
      outboundFetchFor: () => fetch,
      snapshotInvalidator: { invalidate() {} },
    });
    await run({ store, tenantId });
  } finally {
    sqlite.close();
    removeDir(dir);
  }
}

async function pastedAuthStateOf(
  store: DrizzleProviderCatalogStore,
  tenantId: string,
  secret: string,
): Promise<Record<string, unknown>> {
  const account = await store.createAccount(tenantId, "opencode", {
    credentialKind: "oauth",
    credentialMode: "auto",
    secret,
  });
  const states = await store.listAccountAuthStates(tenantId, "opencode", [account.id]);
  const state = states[account.id];
  expect(state).toBeDefined();
  return state as Record<string, unknown>;
}

describe("oauth paste auth-state persistence", () => {
  test("an import of an exported Qoder row restores userId and machineId", async () => {
    await withStore(async ({ store, tenantId }) => {
      const state = await pastedAuthStateOf(
        store,
        tenantId,
        JSON.stringify({
          id: randomUUID(),
          providerId: "qoder",
          credentialKind: "oauth",
          accessToken: "at-1",
          refreshToken: "rt-1",
          authState: { userId: "upstream-user", machineId: "upstream-machine" },
        }),
      );
      expect(state["userId"]).toBe("upstream-user");
      expect(state["machineId"]).toBe("upstream-machine");
      // Recomputed for these tokens, not carried from the wrapper.
      expect(state["credentialMode"]).toBe("auto");
      expect(state["staticToken"]).toBeUndefined();
    });
  });

  test("provider-specific keys travel wholesale without a picker", async () => {
    await withStore(async ({ store, tenantId }) => {
      const state = await pastedAuthStateOf(
        store,
        tenantId,
        JSON.stringify({
          accessToken: "at-1",
          refreshToken: "rt-1",
          authState: {
            userId: "upstream-user",
            credentialMode: "jwt",
            tokenExpiresAt: "2020-01-01T00:00:00.000Z",
            jwtIssuer: "https://old",
            qimei36: "legacy-binding",
            method: "login",
            coreweaveProject: "proj-1",
          },
        }),
      );
      expect(state["qimei36"]).toBe("legacy-binding");
      expect(state["method"]).toBe("login");
      expect(state["coreweaveProject"]).toBe("proj-1");
      // Stale token metadata from the export is recomputed, never carried.
      expect(state["credentialMode"]).toBe("auto");
      expect(state["tokenExpiresAt"]).toBeUndefined();
      expect(state["jwtIssuer"]).toBeUndefined();
    });
  });

  test("a stringified authState (SQLite-string export) still travels", async () => {
    await withStore(async ({ store, tenantId }) => {
      const state = await pastedAuthStateOf(
        store,
        tenantId,
        JSON.stringify({
          accessToken: "at-1",
          refreshToken: "rt-1",
          authState: JSON.stringify({ userId: "upstream-user", machineId: "upstream-machine" }),
        }),
      );
      expect(state["userId"]).toBe("upstream-user");
      expect(state["machineId"]).toBe("upstream-machine");
    });
  });

  test("older flat export shapes keep their aliases", async () => {
    await withStore(async ({ store, tenantId }) => {
      const state = await pastedAuthStateOf(
        store,
        tenantId,
        JSON.stringify({
          accessToken: "at-1",
          refreshToken: "rt-1",
          machine_id: "flat-machine",
          user_id: "flat-user",
          region: "sg",
        }),
      );
      expect(state["machineId"]).toBe("flat-machine");
      expect(state["userId"]).toBe("flat-user");
      expect(state["region"]).toBe("sg");
    });
  });
});
