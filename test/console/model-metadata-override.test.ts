/**
 * Model metadata overrides: the fallback ceilings and the passthrough rule.
 *
 * These are the two decisions that would otherwise be invisible: that an unknown
 * limit is `null` rather than a number, and that passthrough grants every
 * capability rather than adding to a list.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import {
  FALLBACK_CONTEXT_LIMIT,
  FALLBACK_OUTPUT_LIMIT,
  applyModelMetadataOverride,
  resolveManualModelMetadata,
} from "../../src/providers/provider-model-definition";
import { QODER_PROVIDER_WARNINGS } from "../../src/providers/integrations/qoder/qoder-virtual";
import { QODER_CN_MODELS, QODER_INTL_MODELS, qoderVirtualModels, qoderCatalogModel } from "../../src/providers/integrations/qoder/qoder-catalog";
import { seedBundledModels } from "../../src/providers/operations/provider-catalog-seeder";
import { mapModelRow, withImageModality } from "../../src/console/providers/catalog/store";
import { createProviderCatalogRoutes } from "../../src/console/providers/catalog/routes";
import { consoleErrorHandler } from "../../src/console/shared/errors";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { models, providers, tenants } from "../../src/persistence/schema";
import type { AccessDecision } from "../../src/security/access-control";
import type { ModelWarning } from "../../src/console/providers/catalog/contracts";

describe("fallback ceilings", () => {
  test("are large enough to never be the binding constraint", () => {
    // A ceiling that is too low truncates a working request; one that is too
    // high only means the upstream refuses on its own terms. So the fallback
    // must sit above every current frontier model.
    expect(FALLBACK_CONTEXT_LIMIT).toBeGreaterThanOrEqual(200_000);
    expect(FALLBACK_OUTPUT_LIMIT).toBeGreaterThanOrEqual(32_000);
  });

  test("are the documented 512k / 131k", () => {
    expect(FALLBACK_CONTEXT_LIMIT).toBe(512_000);
    expect(FALLBACK_OUTPUT_LIMIT).toBe(131_072);
  });
});

describe("applyModelMetadataOverride", () => {
  const base = resolveManualModelMetadata("factory", "a-model-nobody-knows");

  test("an absent override is a no-op", () => {
    expect(applyModelMetadataOverride(base, undefined)).toEqual(base);
  });

  test("absent fields leave the stored value alone", () => {
    // An edit that only sets the context ceiling must not reset the flags.
    const next = applyModelMetadataOverride(base, { contextLimit: 200_000 });
    expect(next.contextLimit).toBe(200_000);
    expect(next.outputLimit).toBe(base.outputLimit);
    expect(next.toolCall).toBe(base.toolCall);
  });

  test("null means unknown, not zero", () => {
    const next = applyModelMetadataOverride(base, { contextLimit: null });
    expect(next.contextLimit).toBeNull();
  });

  test("passthrough grants every capability", () => {
    const next = applyModelMetadataOverride(base, { passthrough: true });
    expect(next.reasoning).toBe(true);
    expect(next.toolCall).toBe(true);
    expect(next.modalities.input).toContain("image");
  });

  test("passthrough cannot be partly revoked by a per-flag false", () => {
    // The point of passthrough is that the operator does not know which
    // capabilities the model has, so an explicit false beside it is either
    // stale or a mistake. Passthrough wins.
    const next = applyModelMetadataOverride(base, {
      passthrough: true,
      image: false,
      toolCall: false,
    });
    expect(next.toolCall).toBe(true);
    expect(next.modalities.input).toContain("image");
  });

  test("a per-flag false is honored when passthrough is off", () => {
    const next = applyModelMetadataOverride(base, { image: false });
    expect(next.modalities.input).not.toContain("image");
  });
});

describe("withImageModality", () => {
  test("adds image to a text-only blob", () => {
    const next = JSON.parse(withImageModality(JSON.stringify({ input: ["text"] }), true)) as {
      input: string[];
    };
    expect(next.input).toContain("image");
    expect(next.input).toContain("text");
  });

  test("removes image without dropping text", () => {
    const next = JSON.parse(
      withImageModality(JSON.stringify({ input: ["text", "image", "pdf"] }), false),
    ) as { input: string[] };
    expect(next.input).not.toContain("image");
    expect(next.input).toContain("text");
    expect(next.input).toContain("pdf");
  });

  test("an unparseable blob is replaced rather than left to corrupt preflight", () => {
    const next = JSON.parse(withImageModality("not json{", true)) as { input: string[] };
    expect(next.input).toContain("image");
  });

  test("a null blob is treated as absent, not as an error", () => {
    const next = JSON.parse(withImageModality(null, true)) as { input: string[] };
    expect(next.input).toContain("image");
  });

  test("never produces an empty input list", () => {
    // An empty modality list makes capability preflight treat the route as
    // unable to accept anything.
    const next = JSON.parse(withImageModality(JSON.stringify({ input: ["image"] }), false)) as {
      input: string[];
    };
    expect(next.input.length).toBeGreaterThan(0);
  });
});

/**
 * The unsized row, as the console reads it.
 *
 * A model the catalog cannot size was projected with `null` limits, so its card
 * read `n/a ctx · n/a out` while the route was perfectly routable — a working
 * model that looked unusable. The ceiling is now substituted at the read, which
 * keeps the stored `null` honest (upstream really did say nothing) while the
 * console shows a number and flags it as a guess.
 *
 * Driven through `mapModelRow` rather than a store, because the decision is
 * purely a function of one row.
 */
describe("unsized model rows", () => {
  /** A persisted `models` row; only the fields the projection reads matter. */
  function row(overrides: Partial<Record<string, unknown>>) {
    return {
      modelId: "a-model-nobody-knows",
      providerId: "factory",
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      serviceKind: "llm",
      enabled: true,
      contextLimit: null,
      outputLimit: null,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      cost: null,
      source: "manual",
      sourceUpdatedAt: null,
      ...overrides,
    } as unknown as Parameters<typeof mapModelRow>[0];
  }

  test("an unfiled row is shown with the fallback, marked estimated", () => {
    const entry = mapModelRow(row({}), false);
    expect(entry.contextLimit).toBe(FALLBACK_CONTEXT_LIMIT);
    expect(entry.outputLimit).toBe(FALLBACK_OUTPUT_LIMIT);
    expect(entry.limitsEstimated).toBe(true);
  });

  test("a row with its own limit keeps it and carries no marker", () => {
    // The substitution must not overwrite a number upstream actually stated.
    const entry = mapModelRow(row({ contextLimit: 200_000, outputLimit: 8_192 }), false);
    expect(entry.contextLimit).toBe(200_000);
    expect(entry.outputLimit).toBe(8_192);
    expect(entry.limitsEstimated).toBeUndefined();
  });

  test("a row the base catalog can size keeps null rather than inventing a number", () => {
    // The catalog knows this id, so nothing was "unfiled" — the row's own
    // `null` is a gap in the listing, not a model nobody has heard of, and the
    // card should say so instead of showing a confident fallback.
    const entry = mapModelRow(row({ modelId: "deepseek-chat", providerId: "deepseek" }), false);
    expect(entry.contextLimit).toBeNull();
    expect(entry.limitsEstimated).toBeUndefined();
  });

  test("the substitution is display-only: the row itself is untouched", () => {
    const stored = row({});
    mapModelRow(stored, false);
    expect(stored.contextLimit).toBeNull();
  });
});

/** Area 06: warning metadata is display-only and editable only off builtin. */
describe("warning metadata", () => {
  const warning: ModelWarning = {
    kind: "cache_reliability",
    message: "Cache reliability may be degraded.",
    severity: "warn",
  };
  /** A persisted row carrying only the columns `mapModelRow` reads. */
  function warningRow(overrides: Partial<Record<string, unknown>>) {
    return {
      modelId: "warning-model",
      providerId: "qoder",
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      serviceKind: "llm",
      enabled: true,
      contextLimit: 200_000,
      outputLimit: 8_192,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      cost: null,
      source: "manual",
      sourceUpdatedAt: null,
      ...overrides,
    } as unknown as Parameters<typeof mapModelRow>[0];
  }

  test("mapModelRow projects a decoded jsonb object and a SQLite JSON string alike", () => {
    const fromObject = mapModelRow(warningRow({ warningMetadata: { warnings: [warning] } }), false);
    expect(fromObject.warnings).toEqual([warning]);
    const fromString = mapModelRow(warningRow({ warningMetadata: JSON.stringify({ warnings: [warning] }) }), false);
    expect(fromString.warnings).toEqual([warning]);
  });

  test("a null, malformed, or empty blob projects no warnings", () => {
    expect(mapModelRow(warningRow({ warningMetadata: null }), false).warnings).toBeUndefined();
    expect(mapModelRow(warningRow({ warningMetadata: "not json" }), false).warnings).toBeUndefined();
    expect(mapModelRow(warningRow({ warningMetadata: { warnings: [] } }), false).warnings).toBeUndefined();
  });

  test("qoder carries exactly three provider-level 'may' warnings on every row kind", () => {
    expect(QODER_PROVIDER_WARNINGS.map((w) => w.kind)).toEqual([
      "fallback_model",
      "cache_reliability",
      "model_refusal",
    ]);
    for (const w of QODER_PROVIDER_WARNINGS) {
      expect(w.message).toMatch(/\bmay\b/);
      expect(w.severity).toBe("warn");
    }
    const all = [
      ...QODER_CN_MODELS,
      ...QODER_INTL_MODELS,
      ...qoderVirtualModels(QODER_CN_MODELS, "qodercn"),
      qoderCatalogModel(
        { key: "new-slot", displayName: "New", isVl: false, isReasoning: false, maxInputTokens: 1000, enable: true, isFree: false },
        "qoder",
      ),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const definition of all) expect(definition.warnings).toEqual(QODER_PROVIDER_WARNINGS);
  });

  function removeDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // disposable temp dir
    }
  }

  async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "carte-warning-metadata-"));
    const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const [tenant] = await db.insert(tenants).values({ name: "warnings", status: "active" }).returning({ id: tenants.id });
    const tenantId = tenant!.id;
    await db.insert(providers).values({ id: "qoder", enabled: true });
    await db.insert(models).values([
      {
        providerId: "qoder",
        modelId: "manual-model",
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        source: "manual",
      },
      {
        providerId: "qoder",
        modelId: "builtin-model",
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        source: "builtin",
      },
    ]);
    const store = new DrizzleProviderCatalogStore(db, {
      telemetryBuffer: { enqueue() {} } as never,
      bundledModelCatalog: { modelsByProvider: new Map() },
      providerRegistry: new ProviderRegistry(),
      outboundFetchFor: () => fetch as never,
      snapshotInvalidator: { invalidate() {} },
    });
    const access: AccessDecision = {
      id: "operator",
      tenantId,
      scopes: ["models:write"],
      admissionIdentity: "operator",
    };
    const app = new Elysia();
    app.error(consoleErrorHandler("Provider catalog operation failed"));
    app.use(createProviderCatalogRoutes({
      store,
      accessResolver: () => access,
      providerRegistry: new ProviderRegistry(),
      snapshotInvalidator: { invalidate: async () => 1 },
    }));
    const patch = (modelId: string, metadata: unknown) => app.handle(
      new Request("http://localhost/providers/qoder/models", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId, route: "/v1/chat/completions", enabled: true, metadata }),
      }),
    );
    return {
      db,
      app,
      patch,
      cleanup: () => {
        try { sqlite.close(); } catch { /* closed */ }
        removeDir(dir);
      },
    };
  }

  test("seeder writes definition warnings into the builtin upsert", async () => {
    const fx = await fixture();
    try {
      await seedBundledModels(fx.db, new Map([[
        "qoder",
        [{
          modelId: "seeded-model",
          wireFamily: "chat",
          endpointPath: "/v1/chat/completions",
          contextLimit: 1000,
          outputLimit: 1000,
          modalities: { input: ["text"], output: ["text"] },
          reasoning: false,
          toolCall: true,
          cost: { input: null, output: null },
          warnings: QODER_PROVIDER_WARNINGS,
        }],
      ]]));
      const [seeded] = await fx.db.select().from(models).where(eq(models.modelId, "seeded-model"));
      expect(seeded).toBeDefined();
      // The column is `text` on SQLite; the Drizzle builder may return either
      // the stored string or a decoded object depending on the mapper path.
      const parsed = typeof seeded?.warningMetadata === "string"
        ? JSON.parse(seeded.warningMetadata) as unknown
        : seeded?.warningMetadata;
      const warnings = (parsed as { warnings?: ModelWarning[] } | null)?.warnings
        ?? (parsed as ModelWarning[] | null);
      expect(warnings).toEqual([...QODER_PROVIDER_WARNINGS]);
    } finally {
      fx.cleanup();
    }
  });

  test("a non-builtin row can set and clear warnings; projection follows", async () => {
    const fx = await fixture();
    try {
      const set = await fx.patch("manual-model", { warnings: [warning] });
      expect(set.status).toBe(200);
      const [stored] = await fx.db.select().from(models).where(eq(models.modelId, "manual-model"));
      const parsed = typeof stored?.warningMetadata === "string"
        ? JSON.parse(stored.warningMetadata) as unknown
        : stored?.warningMetadata;
      const storedWarnings = (parsed as { warnings?: ModelWarning[] } | null)?.warnings
        ?? (parsed as ModelWarning[] | null);
      expect(storedWarnings).toEqual([warning]);
      const projected = mapModelRow(stored!, false);
      expect(projected.warnings).toEqual([warning]);

      const clear = await fx.patch("manual-model", { warnings: null });
      expect(clear.status).toBe(200);
      const [cleared] = await fx.db.select().from(models).where(eq(models.modelId, "manual-model"));
      expect(cleared?.warningMetadata).toBeNull();
      expect(mapModelRow(cleared!, false).warnings).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("builtin warnings are immutable and invalid payloads answer 400", async () => {
    const fx = await fixture();
    try {
      const builtin = await fx.patch("builtin-model", { warnings: [warning] });
      expect(builtin.status).toBe(403);
      expect((await builtin.json()).code).toBe("builtin_model_immutable");

      const cases: unknown[] = [
        { warnings: [{ kind: "", message: "x" }] },
        { warnings: [{ kind: "x".repeat(65), message: "x" }] },
        { warnings: [{ kind: "x", message: "" }] },
        { warnings: [{ kind: "x", message: "y".repeat(501) }] },
      ];
      for (const metadata of cases) {
        const response = await fx.patch("manual-model", metadata);
        expect(response.status).toBe(400);
        expect((await response.json()).code).toBe("invalid_request");
      }
      // A non-array field is a schema failure (422) before the domain validator.
      const wrongShape = await fx.patch("manual-model", { warnings: "not-an-array" });
      expect(wrongShape.status).toBe(422);
    } finally {
      fx.cleanup();
    }
  });
});
