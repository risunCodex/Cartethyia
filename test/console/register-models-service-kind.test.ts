/**
 * `POST /providers/:providerId/models` supports `serviceKind` so native services
 * such as `embedding` can be registered through the console API without manual
 * database edits, and routes them to their native endpoint path immediately.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { models, providers, tenants } from "../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import { createProviderCatalogRoutes } from "../../src/console/providers/catalog/routes";
import { consoleErrorHandler } from "../../src/console/shared/errors";
import { AuditRecorder } from "../../src/console/auth/audit-recorder";
import { DEFAULT_ENDPOINT_BY_WIRE_FAMILY } from "../../src/console/providers/catalog/catalog-projections";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import type { AccessDecision } from "../../src/security/access-control";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the file briefly; the temp dir is disposable.
  }
}

async function setupFixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-register-service-kind-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  const handle = buildSqliteHandle(sqlite);
  const db = handle.db;
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "service-kind-tenant", status: "active" })
    .returning({ id: tenants.id });
  const tenantId = tenant!.id;
  await db.insert(providers).values({
    id: "custom-embed",
    tenantId,
    baseUrl: "https://embed.example.com",
    enabled: true,
  });
  let invalidations = 0;
  const store = new DrizzleProviderCatalogStore(db, {
    telemetryBuffer: { enqueue() {} } as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: new ProviderRegistry(),
    outboundFetchFor: () => fetch as never,
    snapshotInvalidator: {
      invalidate() {
        invalidations += 1;
      },
    },
  });
  const access: AccessDecision = {
    id: "operator",
    tenantId,
    scopes: ["models:write", "models:read"],
    admissionIdentity: "operator",
  };
  const app = new Elysia();
  app.error(consoleErrorHandler("Provider catalog operation failed"));
  app.use(
    createProviderCatalogRoutes({
      store,
      accessResolver: () => access,
      auditSink: new AuditRecorder(db),
      providerRegistry: new ProviderRegistry(),
      snapshotInvalidator: {
        invalidate: async () => {
          invalidations += 1;
          return invalidations;
        },
      },
    }),
  );
  return {
    db,
    app,
    invalidations: () => invalidations,
    cleanup: () => {
      try {
        sqlite.close();
      } catch {
        // closed
      }
      removeDir(dir);
    },
  };
}

describe("POST /providers/:providerId/models with serviceKind", () => {
  test("registers embedding models with service_kind='embedding', endpoint='/v1/embeddings', and invalidates route snapshot", async () => {
    const fx = await setupFixture();
    try {
      const response = await fx.app.handle(
        new Request("http://localhost/providers/custom-embed/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelIds: ["text-embedding-3-small"],
            serviceKind: "embedding",
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ registered: 1 });
      expect(fx.invalidations()).toBeGreaterThanOrEqual(1);

      const rows = await fx.db
        .select()
        .from(models)
        .where(and(eq(models.providerId, "custom-embed"), eq(models.modelId, "text-embedding-3-small")));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.serviceKind).toBe("embedding");
      expect(rows[0]!.endpointPath).toBe("/v1/embeddings");
    } finally {
      fx.cleanup();
    }
  });

  test("defaults serviceKind to llm and endpointPath to wire default when omitted", async () => {
    const fx = await setupFixture();
    try {
      const response = await fx.app.handle(
        new Request("http://localhost/providers/custom-embed/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelIds: ["gpt-4o-mini"],
            wireFamily: "chat",
          }),
        }),
      );
      expect(response.status).toBe(200);
      const rows = await fx.db
        .select()
        .from(models)
        .where(and(eq(models.providerId, "custom-embed"), eq(models.modelId, "gpt-4o-mini")));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.serviceKind).toBe("llm");
      expect(rows[0]!.endpointPath).toBe(DEFAULT_ENDPOINT_BY_WIRE_FAMILY.chat);
    } finally {
      fx.cleanup();
    }
  });

  test("rejects an unknown serviceKind with 422 invalid_request", async () => {
    const fx = await setupFixture();
    try {
      const response = await fx.app.handle(
        new Request("http://localhost/providers/custom-embed/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelIds: ["text-embedding-3-small"],
            serviceKind: "not-a-service",
          }),
        }),
      );
      expect(response.status).toBe(422);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("invalid_request");
    } finally {
      fx.cleanup();
    }
  });
});
