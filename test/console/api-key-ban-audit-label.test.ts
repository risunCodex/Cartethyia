/**
 * The ban endpoint's audit label is derived server-side.
 *
 * The audit trail used to store a `reasonLabel` the client sent alongside the
 * machine `reason` — a free-text field an operator's browser authored. The
 * label is fully derivable from `reason` via `API_KEY_BAN_REASONS`, so a client
 * that could write it could skew the human-readable audit record while the
 * machine value told the truth. Now the server derives the label itself and
 * client-sent `reasonLabel` bodies are dropped (the field is not even in the
 * body schema), and a custom reason simply carries no label.
 */
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import * as fullSchema from "../../src/persistence/schema";
import { DrizzleApiKeyStore } from "../../src/persistence/stores/api-key-store";
import { createApiKeyOperations } from "../../src/console/api-keys/routes";
import { API_KEY_BAN_REASONS } from "../../src/console/api-keys/ban-constants";
import { createRunId, dbDescribe, requireDatabase, withRollback } from "../helpers/database";
import { createApiKey, createTenant } from "../helpers/fixtures";

requireDatabase();

const RUN_ID = createRunId("api-key-ban-label");

/** Tenant-scoped write access, as the console grants a signed-in owner. */
function owner(tenantId: string) {
  return {
    tenantId,
    scopes: ["dashboard:read", "dashboard:write"],
  } as never;
}

interface RecordedAudit {
  readonly action: string;
  readonly detail?: Record<string, unknown>;
}

dbDescribe("ban audit reasonLabel", () => {
  test("a listed reason records the canonical label derived from it", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const key = await createApiKey(client, { tenantId: tenant.tenantId });
      const db = drizzle(client as never, { schema: fullSchema });
      const audit: { entries: RecordedAudit[] } = { entries: [] };
      const operations = createApiKeyOperations({
        store: new DrizzleApiKeyStore(db as never),
        accessResolver: () => owner(tenant.tenantId),
        admissionService: { purgeKey: async () => undefined },
        auditSink: {
          record: async (entry: RecordedAudit) => {
            audit.entries.push(entry);
          },
        } as never,
      });
      const reason = API_KEY_BAN_REASONS[1]!; // traffic_suspicious
      await operations.banKey(owner(tenant.tenantId), key.id, {
        reason: reason.value,
        minutes: 60,
      });
      const banned = audit.entries.find((entry) => entry.action === "api_key.banned");
      expect(banned?.detail?.reason).toBe(reason.value);
      expect(banned?.detail?.reasonLabel).toBe(reason.label);
    });
  });

  test("a custom reason records no reasonLabel at all", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const key = await createApiKey(client, { tenantId: tenant.tenantId });
      const db = drizzle(client as never, { schema: fullSchema });
      const audit: { entries: RecordedAudit[] } = { entries: [] };
      const operations = createApiKeyOperations({
        store: new DrizzleApiKeyStore(db as never),
        accessResolver: () => owner(tenant.tenantId),
        admissionService: { purgeKey: async () => undefined },
        auditSink: {
          record: async (entry: RecordedAudit) => {
            audit.entries.push(entry);
          },
        } as never,
      });
      await operations.banKey(owner(tenant.tenantId), key.id, {
        reason: "operator typed this by hand",
        minutes: 60,
      });
      const banned = audit.entries.find((entry) => entry.action === "api_key.banned");
      expect(banned?.detail?.reason).toBe("operator typed this by hand");
      expect("reasonLabel" in (banned?.detail ?? {})).toBe(false);
    });
  });

  // The wire no longer accepts a client-sent `reasonLabel`, so the only label
  // that can be recorded is the canonical one derived from `reason` (pinned by
  // the first test above).
});
