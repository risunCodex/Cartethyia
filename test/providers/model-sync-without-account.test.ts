/**
 * Model sync must not require a stored account.
 *
 * It used to: `modelDiscoveryRequiresCredential` defaulted to true, so a
 * provider with no usable account answered a local 409 — "Model sync needs a
 * usable account first" — before any request left the gateway. Most providers
 * publish their model list without auth, so that gate blocked the case it was
 * meant to protect and told the operator to add an account they did not need.
 *
 * The gate is gone. A usable account is used when there is one; the fetch is
 * attempted either way, and an upstream that does require auth answers 401
 * itself — naming the real problem instead of a missing prerequisite.
 *
 * These drive `syncModels` with no account at all and assert the resolver is
 * reached. A stub resolver that returns `null` makes syncModels fail with the
 * upstream-shaped 502, which is only reachable *after* the gate that used to
 * throw 409 — so the error itself is the evidence.
 *
 * Area 05 adds the read-only discovery / verified-commit pair on the same
 * seam: `discoverModels` must not write a single row, and a commit whose id is
 * not in the fresh roster must be rejected before anything is persisted.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { ProviderProbingService } from "../../src/providers/discovery/probing-service";
import { createProviderCatalogRoutes } from "../../src/console/providers/catalog/routes";
import { consoleErrorHandler } from "../../src/console/shared/errors";
import type { AccessDecision } from "../../src/security/access-control";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type { ProviderRegistry } from "../../src/providers/provider-registry";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import type { ModelDefinition } from "../../src/providers/provider-model-definition";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { models, providers, tenants } from "../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";

const PROVIDER_ID = "groq";

/** Enough of a drizzle query builder to answer every read with "nothing". */
function emptyDb(): CartethyiaDatabase {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) {
    chain[method] = () => chain;
  }
  // A thenable that resolves to no rows, so every `await db.select()...` is [].
  chain.then = (resolve: (value: unknown) => unknown) => resolve([]);
  const db = {
    select: () => chain,
    query: async () => ({ rows: [] }),
    execute: async () => ({ rows: [] }),
  };
  return db as unknown as CartethyiaDatabase;
}

function serviceWithResolver(
  resolver: () => Promise<readonly ModelDefinition[] | null>,
  db: CartethyiaDatabase = emptyDb(),
): ProviderProbingService {
  const base = createDefaultProviderRegistry();
  const registry = {
    resolveModelDiscovery: async (providerId: string) =>
      providerId === PROVIDER_ID ? resolver : base.resolveModelDiscovery(providerId),
    resolve: (providerId: string) => base.resolve(providerId),
    registrations: () => base.registrations(),
  } as unknown as ProviderRegistry;

  return new ProviderProbingService({
    db,
    telemetryBuffer: undefined,
    defaultEndpoints: { chat: "/chat/completions", responses: "/responses", messages: "/v1/messages", gemini: "/api/llm/g/v1/generate" },
    bundledModelCatalog: new Map(),
    outboundFetchFor: async () => ({ fetch: globalThis.fetch }),
    snapshotInvalidator: { invalidate: () => {} },
    providerRegistry: registry,
  });
}

const ROSTER: readonly ModelDefinition[] = [
  {
    modelId: "listed-model",
    wireFamily: "chat",
    endpointPath: "/v1/chat/completions",
    contextLimit: 128_000,
    outputLimit: 8_192,
    modalities: { input: ["text"], output: ["text"] },
    reasoning: false,
    toolCall: true,
    cost: { input: null, output: null },
  },
];

describe("model sync without a stored account", () => {
  test("reaches the discovery resolver instead of failing on a missing account", async () => {
    let called = false;
    const service = serviceWithResolver(async () => {
      called = true;
      return null;
    });

    const error = await service
      .syncModels("tenant-1", PROVIDER_ID)
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as { code?: string; status?: number; message?: string });

    // The resolver ran. A gate would have thrown before it was reached.
    expect(called).toBe(true);
    expect(error).toBeDefined();
  });

  test("reports an upstream failure, not a missing-account precondition", async () => {
    const service = serviceWithResolver(async () => null);
    const error = await service
      .syncModels("tenant-1", PROVIDER_ID)
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as { code?: string; status?: number; message?: string });

    expect(error?.message).not.toMatch(/needs a usable/i);
    expect(error?.message).toMatch(/discovery failed/i);
  });

  test("no registration may still declare the removed credential flag", () => {
    // The flag was deleted from the registry contract. A row that kept it would
    // be silently ignored, leaving the next reader to wonder why it does
    // nothing.
    for (const row of createDefaultProviderRegistry().registrations()) {
      expect(Object.keys(row as object)).not.toContain("modelDiscoveryRequiresCredential");
    }
  });
});

describe("read-only discovery and verified commit (area 05)", () => {
  function removeDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold the temp file; it is disposable.
    }
  }

  async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "carte-discover-commit-"));
    const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    await db.insert(providers).values({ id: PROVIDER_ID, enabled: true });
    // The store has its own probing service; give it the same injected
    // resolver so commit's server-side re-fetch sees exactly this roster.
    const registry = {
      resolveModelDiscovery: async (providerId: string) =>
        providerId === PROVIDER_ID ? async () => ROSTER : undefined,
      hasModelDiscovery: () => true,
    } as unknown as ProviderRegistry;
    const [tenant] = await db.insert(tenants).values({ name: "discover-tenant", status: "active" }).returning({ id: tenants.id });
    const access: AccessDecision = {
      id: "operator",
      tenantId: tenant!.id,
      scopes: ["models:read", "models:write"],
      admissionIdentity: "operator",
    };
    const service = serviceWithResolver(async () => ROSTER, db);
    const store = new DrizzleProviderCatalogStore(db, {
      telemetryBuffer: { enqueue() {} } as never,
      bundledModelCatalog: { modelsByProvider: new Map() },
      providerRegistry: registry,
      outboundFetchFor: async () => ({ fetch: globalThis.fetch }),
      snapshotInvalidator: { invalidate() {} },
    });
    const app = new Elysia();
    app.error(consoleErrorHandler("Provider catalog operation failed"));
    app.use(createProviderCatalogRoutes({
      store,
      accessResolver: () => access,
      providerRegistry: registry,
      snapshotInvalidator: { invalidate: async () => 1 },
    }));
    return {
      db,
      service,
      store,
      app,
      cleanup: () => {
        try { sqlite.close(); } catch { /* closed */ }
        removeDir(dir);
      },
    };
  }

  test("discoverModels fetches without persisting, and the console projects candidates", async () => {
    const fx = await fixture();
    try {
      const before = await fx.db.select().from(models);
      const discovery = await fx.service.discoverModels("tenant-1", PROVIDER_ID);
      expect(discovery.supported).toBe(true);
      expect(discovery.models.map((m) => m.modelId)).toEqual(["listed-model"]);
      const candidates = await fx.store.listDiscoveryCandidates("tenant-1", PROVIDER_ID);
      expect(candidates.candidates[0]?.alreadyRegistered).toBe(false);
      expect(await fx.db.select().from(models)).toHaveLength(before.length);
    } finally {
      fx.cleanup();
    }
  });

  test("registered models are excluded from discovery candidates", async () => {
    const fx = await fixture();
    try {
      await fx.db.insert(models).values({
        providerId: PROVIDER_ID,
        modelId: "listed-model",
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        contextLimit: 128_000,
        outputLimit: 8_192,
        modalities: { input: ["text"], output: ["text"] },
        reasoning: false,
        toolCall: true,
        enabled: true,
      });
      const candidates = await fx.store.listDiscoveryCandidates("tenant-1", PROVIDER_ID);
      expect(candidates.supported).toBe(true);
      expect(candidates.candidates).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("the commit route answers 400 for an id outside the fresh roster and writes nothing", async () => {
    const fx = await fixture();
    try {
      const response = await fx.app.handle(
        new Request(`http://localhost/providers/${PROVIDER_ID}/models/discover/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelIds: ["forged-model"] }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code?: string; error?: string };
      expect(body.code).toBe("invalid_request");
      expect(body.error).toMatch(/no longer in the provider's listing/i);
      expect(await fx.db.select().from(models)).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("a verified commit persists source=manual with the fetched metadata", async () => {
    const fx = await fixture();
    try {
      const result = await fx.store.commitDiscoveredModels("tenant-1", PROVIDER_ID, ["listed-model"]);
      expect(result.committed).toEqual(["listed-model"]);
      const rows = await fx.db.select().from(models).where(eq(models.modelId, "listed-model"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("manual");
      expect(rows[0]?.contextLimit).toBe(128_000);
      expect(rows[0]?.outputLimit).toBe(8_192);
      expect(rows[0]?.warningMetadata).toBeNull();
    } finally {
      fx.cleanup();
    }
  });
});
