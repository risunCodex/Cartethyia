/**
 * Claude's collector has no module-local quota cache (M-24): the shared
 * two-tier quota cache owns dedup, so a sweep within the old 5-minute local
 * TTL cannot serve a pre-debit balance over `debitCachedQuota`'s spent value.
 *
 * Two proofs:
 *  - `fetchClaudeQuota` performs an upstream read on every call — a second
 *    call for the same credential hits the fetcher again instead of a local
 *    tier (the 429 cooldown is the only local short-circuit left);
 *  - the full sweep sequence — seed via `refreshAccountQuota`, debit, refresh
 *    again — keeps the debited balance: the second refresh re-reads upstream
 *    (which has caught up with the spend the debit represented) instead of
 *    serving a stale pre-debit value from a local cache.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providerAccounts, providers } from "../../src/persistence/schema";
import { fetchClaudeQuota } from "../../src/providers/integrations/claude/claude-quota";
import {
  clearQuotaCacheForTests,
  debitCachedQuota,
  getCachedQuotaEntry,
} from "../../src/providers/quota/cache";
import {
  refreshAccountQuota,
  type QuotaRefreshDeps,
  type QuotaRefreshTarget,
} from "../../src/providers/quota/refresh";
import type { FetchLike, ProviderQuotaResult } from "../../src/providers/quota/quota-contracts";
import type { ProviderRegistry } from "../../src/providers/provider-registry";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchClaudeQuota performs an upstream read on every call", () => {
  test("two calls for the same credential both hit the fetcher", async () => {
    let count = 0;
    const fetcher = (async () => {
      count += 1;
      return jsonResponse({
        five_hour: { utilization: 75 },
        limits: [],
      });
    }) as unknown as FetchLike;
    const first = await fetchClaudeQuota("token-alpha", fetcher);
    const second = await fetchClaudeQuota("token-alpha", fetcher);
    expect(count).toBe(2);
    expect(first.source).toBe("claude");
    expect(second.windows[0]?.usedPercent).toBe(75);
  });

  test("the 429 cooldown still short-circuits repeated attempts without an upstream call", async () => {
    let count = 0;
    const fetcher = (async () => {
      count += 1;
      return jsonResponse({ error: "rate_limit_exceeded" }, 429);
    }) as unknown as FetchLike;
    await expect(fetchClaudeQuota("token-beta", fetcher)).rejects.toThrow(/rejected/i);
    await expect(fetchClaudeQuota("token-beta", fetcher)).rejects.toThrow(/cooled down/i);
    expect(count).toBe(1);
  });
});

describe("refreshAccountQuota -> debit -> refresh again keeps the debited balance", () => {
  test("a second refresh re-reads upstream instead of serving a stale local tier", async () => {
    clearQuotaCacheForTests();
    const dir = mkdtempSync(join(tmpdir(), "carte-claude-quota-"));
    const sqlite = createSqliteDatabase(join(dir, "q.sqlite"));
    try {
      await applySqliteMigrations(sqlite);
      const { db } = buildSqliteHandle(sqlite);
      await db.insert(providers).values({ id: "claude" });
      const accountId = "acc-claude-debit";
      await db.insert(providerAccounts).values({
        id: accountId,
        providerId: "claude",
        label: "claude-debit",
        credentialKind: "oauth",
        status: "active",
      });

      // The collector emits one pooled window. The provider's usage data starts
      // at balance 75; after the test debits 40 (the spend the requests
      // produced, which the provider's own counter has also caught up with), a
      // second upstream read reports 35.
      const pooledResult = (remaining: number): ProviderQuotaResult => ({
        source: "claude",
        plan: null,
        windows: [
          {
            kind: "credits",
            label: "Credits",
            accounting: "pooled",
            usedPercent: 100 - remaining,
            remainingPercent: remaining,
            resetsAt: null,
            used: 100 - remaining,
            limit: 100,
            remaining,
          },
        ],
        error: null,
      });
      let upstreamRemaining = 75;
      const registry = {
        resolveQuotaCollector: async () => async () => pooledResult(upstreamRemaining),
      } as unknown as ProviderRegistry;
      const deps: QuotaRefreshDeps = {
        db,
        redis: undefined,
        providerRegistry: registry,
        resolveCredential: async () => "token-oauth",
      };
      const target: QuotaRefreshTarget = {
        accountId,
        providerId: "claude",
        tenantId: null,
        credentialKind: "oauth",
      };
      const fetcher = (async () => jsonResponse({})) as unknown as FetchLike;

      const seed = await refreshAccountQuota(deps, target, fetcher);
      expect(seed.failure).toBeNull();
      const seeded = await getCachedQuotaEntry("global", accountId, undefined);
      expect(seeded?.quota.windows[0]?.remaining).toBe(75);

      await debitCachedQuota("global", accountId, 40, undefined);
      const afterDebit = await getCachedQuotaEntry("global", accountId, undefined);
      expect(afterDebit?.quota.windows[0]?.remaining).toBe(35);

      // Upstream has now caught up with the spend; the second refresh must see
      // it. With the old module-local cache this refresh returned the stale 75
      // without an upstream read and the sweep wrote it back over the debit.
      upstreamRemaining = 35;
      const refreshed = await refreshAccountQuota(deps, target, fetcher);
      expect(refreshed.failure).toBeNull();
      const afterRefresh = await getCachedQuotaEntry("global", accountId, undefined);
      expect(afterRefresh?.quota.windows[0]?.remaining).toBe(35);
    } finally {
      try {
        sqlite.close();
      } catch {
        /* closed */
      }
      clearQuotaCacheForTests();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows may hold the file briefly; the temp dir is disposable. */
      }
    }
  });
});
