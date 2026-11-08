/**
 * Cooldown rule resolution + precedence (area 03, D15–D19).
 *
 * Presedensi yang dikunci: provider-stated > rule (provider, kategori, tier)
 * > konstanta lama > fallback env. Tests here exercise `resolveCooldownRule`
 * directly and the writer-side precedence through `recordAccountFailure` on a
 * real SQLite fixture.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "bun:sqlite";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { providerAccounts, providers } from "../../src/persistence/schema";
import { eq } from "drizzle-orm";
import { resolveCooldownRule } from "../../src/providers/operations/cooldown-rules";
import { recordAccountFailure } from "../../src/providers/operations/account-health-service";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe("resolveCooldownRule", () => {
  test("Trae model_unreachable free → 24h, paid/pro → 15m", () => {
    expect(
      resolveCooldownRule({ providerId: "trae", category: "model_unreachable", tier: "free" }),
    ).toBe(DAY);
    expect(
      resolveCooldownRule({ providerId: "trae", category: "model_unreachable", tier: "paid" }),
    ).toBe(15 * MINUTE);
    expect(
      resolveCooldownRule({ providerId: "trae", category: "model_unreachable", tier: "pro" }),
    ).toBe(15 * MINUTE);
  });

  test("Trae CN mirrors Trae", () => {
    expect(
      resolveCooldownRule({ providerId: "traecn", category: "model_unreachable", tier: "free" }),
    ).toBe(DAY);
  });

  test("unknown tier or category returns undefined (legacy behavior)", () => {
    expect(
      resolveCooldownRule({ providerId: "trae", category: "model_unreachable", tier: null }),
    ).toBeUndefined();
    expect(
      resolveCooldownRule({ providerId: "trae", category: "quota_exhausted", tier: "free" }),
    ).toBeUndefined();
  });

  test("unregistered providers return undefined", () => {
    expect(
      resolveCooldownRule({ providerId: "grok", category: "model_unreachable", tier: "free" }),
    ).toBeUndefined();
  });
});

// ---- Writer-side precedence on a real SQLite fixture ------------------------

let dir: string | undefined;
let sqlite: SqliteDatabase | undefined;
let db: CartethyiaDatabase | undefined;
let previousMode: string | undefined;

beforeEach(async () => {
  previousMode = process.env.CARTETHYIA_DB_MODE;
  process.env.CARTETHYIA_DB_MODE = "lite";
  dir = mkdtempSync(join(tmpdir(), "cartethyia-cooldown-rules-"));
  sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  db = buildSqliteHandle(sqlite).db;
  delete process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
  resetCooldownCacheForTests();
  await db.insert(providers).values({ id: "trae" });
});

afterEach(() => {
  sqlite?.close();
  if (dir !== undefined) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows holds the file briefly after close; the temp dir is disposable.
    }
  }
  sqlite = undefined;
  db = undefined;
  dir = undefined;
  if (previousMode === undefined) delete process.env.CARTETHYIA_DB_MODE;
  else process.env.CARTETHYIA_DB_MODE = previousMode;
  resetCooldownCacheForTests();
});

async function insertTraeAccount(plan: string | null): Promise<string> {
  const [row] = await db!
    .insert(providerAccounts)
    .values({
      providerId: "trae",
      label: `trae-${plan ?? "null"}`,
      credentialKind: "api_key",
      quotaPlan: plan,
    })
    .returning({ id: providerAccounts.id });
  return row!.id;
}

async function rowOf(accountId: string): Promise<{
  status?: string;
  modelCooldowns?: unknown;
  lastErrorCategory?: string | null;
}> {
  const [row] = await db!
    .select({
      status: providerAccounts.status,
      modelCooldowns: providerAccounts.modelCooldowns,
      lastErrorCategory: providerAccounts.lastErrorCategory,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  return row ?? {};
}

describe("recordAccountFailure tier-rule precedence", () => {
  test("Trae free quota verdict (model_unreachable) gets the 24h rule", async () => {
    const accountId = await insertTraeAccount("Free Plan Subscription");
    const classification = await recordAccountFailure(db!, accountId, new Error("Trae quota exceeded"), {
      origin: "upstream",
      scope: "account",
      providerId: "trae",
      modelId: "deepseek-v4.1-flash",
      providerCode: "4008",
      statusCode: 4008,
    });
    // Model-scoped: account status untouched, per-model deadline from the rule.
    const row = await rowOf(accountId);
    expect(row.status).toBe("active");
    const cooldowns = row.modelCooldowns as Record<string, string>;
    const deadline = Date.parse(cooldowns["deepseek-v4.1-flash"] ?? "");
    expect(deadline - Date.now()).toBeGreaterThan(DAY - 60_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(DAY);
    expect(classification?.ruleSource).toBe("provider-rule");
    // `lastErrorCategory` stays the classifier verdict.
    expect(row.lastErrorCategory).toBe("model_unreachable");
  });

  test("Trae paid quota verdict gets the 15m rule — not the 24h constant, not 1h escalation", async () => {
    const accountId = await insertTraeAccount("Pro");
    // Consecutive failure streak would otherwise escalate a fallback; the rule
    // duration must never escalate (D18) — and it is shorter than the old
    // 24h constant.
    const classification = await recordAccountFailure(db!, accountId, new Error("Trae quota exceeded"), {
      origin: "upstream",
      scope: "account",
      providerId: "trae",
      modelId: "deepseek-v4.1-flash",
      providerCode: "4008",
      statusCode: 4008,
    });
    const row = await rowOf(accountId);
    const cooldowns = row.modelCooldowns as Record<string, string>;
    const deadline = Date.parse(cooldowns["deepseek-v4.1-flash"] ?? "");
    expect(classification?.ruleSource).toBe("provider-rule");
    expect(deadline - Date.now()).toBeGreaterThan(14 * MINUTE);
    expect(deadline - Date.now()).toBeLessThanOrEqual(15 * MINUTE);
  });

  test("unknown plan keeps the legacy 24h constant (no rule applies)", async () => {
    const accountId = await insertTraeAccount(null);
    const classification = await recordAccountFailure(db!, accountId, new Error("Trae quota exceeded"), {
      origin: "upstream",
      scope: "account",
      providerId: "trae",
      modelId: "deepseek-v4.1-flash",
      providerCode: "4008",
      statusCode: 4008,
    });
    const row = await rowOf(accountId);
    const cooldowns = row.modelCooldowns as Record<string, string>;
    const deadline = Date.parse(cooldowns["deepseek-v4.1-flash"] ?? "");
    // Old TRAE_QUOTA_COOLDOWN_MS constant, unscaled (streak 0).
    expect(classification?.ruleSource).toBeUndefined();
    expect(deadline - Date.now()).toBeGreaterThan(DAY - 60_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(DAY);
  });

  test("a provider-stated window wins over the rule (D18)", async () => {
    const accountId = await insertTraeAccount("Free Plan Subscription");
    await recordAccountFailure(db!, accountId, new Error("Trae quota exceeded"), {
      origin: "upstream",
      scope: "account",
      providerId: "trae",
      modelId: "deepseek-v4.1-flash",
      providerCode: "4008",
      statusCode: 4008,
      retryAfterMs: 3 * 60 * 60 * 1000,
    });
    const row = await rowOf(accountId);
    const cooldowns = row.modelCooldowns as Record<string, string>;
    const deadline = Date.parse(cooldowns["deepseek-v4.1-flash"] ?? "");
    // Provider-stated 3h — not the 24h rule, not the 1h escalation cap.
    expect(deadline - Date.now()).toBeGreaterThan(2.9 * 60 * 60 * 1000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(3 * 60 * 60 * 1000);
  });

  test("Vertex/Antigravity 429 states a reset in the body — 24h provider-stated, not 15m fallback", async () => {
    const accountId = await insertTraeAccount(null);
    // Exact upstream body captured 2026-11-08 (Antigravity/Vertex Claude route):
    // the reset lives in `details[]` (ErrorInfo.metadata.quotaResetDelay /
    // quotaResetTimeStamp, RetryInfo.retryDelay) and in the prose message.
    const raw = JSON.stringify({
      error: {
        code: 429,
        message:
          "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 165h46m45s.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            domain: "cloudcode-pa.googleapis.com",
            metadata: {
              uiMessage: "true",
              model: "claude-sonnet-4-6",
              quotaResetDelay: "165h46m45.017558959s",
              quotaResetTimeStamp: "2026-11-15T12:12:39Z",
            },
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "596805.017558959s",
          },
        ],
      },
    });
    const classification = await recordAccountFailure(db!, accountId, new Error(raw), {
      origin: "upstream",
      scope: "provider",
      providerId: "antigravity",
      statusCode: 429,
      providerCode: "rate_limited",
      modelId: "claude-sonnet-4-6",
    });
    expect(classification?.providerStated).toBe(true);
    const row = await rowOf(accountId);
    const cooldowns = row.modelCooldowns as Record<string, string>;
    const deadline = Date.parse(cooldowns["claude-sonnet-4-6"] ?? "");
    // The provider-stated window is capped at the 24h maximum — far above the
    // 15-minute fallback that previously ignored the body entirely.
    expect(deadline - Date.now()).toBeGreaterThan(DAY - 60_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(DAY);
  });

  test("Vertex/Antigravity 429 without a stated reset stays the 15m fallback", async () => {
    const accountId = await insertTraeAccount(null);
    // Exact upstream body captured 2026-11-09 (Antigravity/Vertex Gemini route):
    // "Resource has been exhausted (e.g. check quota)." names no window.
    const raw = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    const classification = await recordAccountFailure(db!, accountId, new Error(raw), {
      origin: "upstream",
      scope: "provider",
      providerId: "antigravity",
      statusCode: 429,
      providerCode: "rate_limited",
      modelId: "gemini-3.8-flash",
    });
    expect(classification?.providerStated).toBe(false);
    const row = await rowOf(accountId);
    const cooldowns = row.modelCooldowns as Record<string, string>;
    const deadline = Date.parse(cooldowns["gemini-3.8-flash"] ?? "");
    expect(deadline - Date.now()).toBeGreaterThan(14 * MINUTE);
    expect(deadline - Date.now()).toBeLessThanOrEqual(15 * MINUTE);
  });
});
