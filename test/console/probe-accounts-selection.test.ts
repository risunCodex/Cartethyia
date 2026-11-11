/**
 * probeAllAccounts respects the request's `accountIds` selection.
 *
 * The Grok "Test 407" button probes every account by default; when the
 * operator selects accounts, only those must be probed — not every active
 * account. The filter lives in `ProviderProbingService.probeAllAccounts`;
 * these tests drive it with a stub `probeModel` that records which account ids
 * it was asked to probe, so no upstream network is touched.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderProbingService } from "../../src/providers/discovery/probing-service";
import type { ProbeModelRequest, ProbeModelResult } from "../../src/providers/discovery/discovery-types";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type { ProviderRegistry } from "../../src/providers/provider-registry";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providerAccounts, providers, tenants } from "../../src/persistence/schema";

const PROVIDER_ID = "grok";

class RecordingProbingService extends ProviderProbingService {
  probedAccountIds: string[] = [];

  override async probeModel(_tenantId: string, _providerId: string, request: ProbeModelRequest): Promise<ProbeModelResult> {
    if (request.accountId !== undefined) this.probedAccountIds.push(request.accountId);
    return {
      ok: true,
      latencyMs: 10,
      ...(request.accountId !== undefined ? { accountId: request.accountId } : {}),
    };
  }
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may briefly hold the temp file; it is disposable.
  }
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-probe-select-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  const db = buildSqliteHandle(sqlite).db;
  await db.insert(providers).values({ id: PROVIDER_ID, enabled: true });
  const [tenant] = await db.insert(tenants).values({ name: "probe-select-tenant", status: "active" }).returning({ id: tenants.id });
  const inserted = await db
    .insert(providerAccounts)
    .values([
      { providerId: PROVIDER_ID, tenantId: tenant!.id, label: "acct-a", credentialKind: "oauth" },
      { providerId: PROVIDER_ID, tenantId: tenant!.id, label: "acct-b", credentialKind: "oauth" },
      { providerId: PROVIDER_ID, tenantId: tenant!.id, label: "acct-c", credentialKind: "oauth" },
    ])
    .returning({ id: providerAccounts.id });
  const ids = inserted.map((row) => row.id);

  const base = createDefaultProviderRegistry();
  const registry = {
    resolve: (providerId: string) => base.resolve(providerId),
    registrations: () => base.registrations(),
  } as unknown as ProviderRegistry;

  const service = new RecordingProbingService({
    db,
    telemetryBuffer: undefined,
    defaultEndpoints: { chat: "/chat/completions", responses: "/responses", messages: "/v1/messages", gemini: "/api/llm/g/v1/generate" },
    bundledModelCatalog: new Map(),
    outboundFetchFor: async () => ({ fetch: globalThis.fetch }),
    snapshotInvalidator: { invalidate: () => {} },
    providerRegistry: registry,
  });

  return { db, service, ids, tenantId: tenant!.id, cleanup: () => { try { sqlite.close(); } catch { /* closed */ } removeDir(dir); } };
}

const REQUEST: ProbeModelRequest = {
  modelId: "grok-4.6",
  prompt: "Type the number 407.",
  stream: true,
  serviceKind: "llm",
};

describe("probeAllAccounts selection", () => {
  test("without accountIds, every account is probed", async () => {
    const fx = await fixture();
    try {
      const result = await fx.service.probeAllAccounts(fx.tenantId, PROVIDER_ID, REQUEST);
      expect(result.results).toHaveLength(3);
      expect(fx.service.probedAccountIds.sort()).toEqual([...fx.ids].sort());
    } finally {
      fx.cleanup();
    }
  });

  test("with accountIds, only the selected accounts are probed", async () => {
    const fx = await fixture();
    try {
      const selected = [fx.ids[0]!, fx.ids[2]!];
      const result = await fx.service.probeAllAccounts(fx.tenantId, PROVIDER_ID, {
        ...REQUEST,
        accountIds: selected,
      });
      expect(result.results).toHaveLength(2);
      expect(fx.service.probedAccountIds.sort()).toEqual([...selected].sort());
    } finally {
      fx.cleanup();
    }
  });

  test("with an empty accountIds array, nothing is probed", async () => {
    const fx = await fixture();
    try {
      const result = await fx.service.probeAllAccounts(fx.tenantId, PROVIDER_ID, {
        ...REQUEST,
        accountIds: [],
      });
      expect(result.results).toHaveLength(0);
      expect(fx.service.probedAccountIds).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("unknown account ids are ignored without error", async () => {
    const fx = await fixture();
    try {
      const result = await fx.service.probeAllAccounts(fx.tenantId, PROVIDER_ID, {
        ...REQUEST,
        accountIds: [fx.ids[1]!, "does-not-exist"],
      });
      expect(result.results).toHaveLength(1);
      expect(fx.service.probedAccountIds).toEqual([fx.ids[1]!]);
    } finally {
      fx.cleanup();
    }
  });
});
