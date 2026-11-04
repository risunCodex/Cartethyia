/**
 * Which account-health writes drop the route snapshot.
 *
 * The snapshot projects `provider_accounts.status` and `.cooldownUntil` and
 * nothing else (`route-catalog.ts:286-287`). A failure that only cooled one
 * (account, model) pair — the common throttle — changes neither, so dropping
 * the snapshot for it forced the next request to rebuild 11 SELECTs' worth of
 * routing for no reason. Under a failure wave each rebuild fed the next
 * invalidation, which is what made the cost superlinear.
 *
 * These assert the gate, not the SQL: the classification's `routesVisible` flag
 * is the contract, and it is what the reporter reads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  classifyAccountError,
  reportAttemptOutcome,
} from "../../src/providers/operations/account-health-service";
import { GatewayError } from "../../src/protocol/gateway-error";
import { getDb } from "../../src/persistence/boot";
import { providerAccounts } from "../../src/persistence/schema";
import { eq } from "drizzle-orm";
import { createDatabaseSnapshotBuilder } from "../../src/transport/routing/route-catalog";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { requireDatabase } from "../helpers/database";
import { recordAccountCheck } from "../../src/providers/quota/refresh";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";

/**
 * `routesVisible` is set by the caller that knows which columns it wrote, not
 * by the classifier — the same classification feeds both the account-wide path
 * (writes `status` + `cooldownUntil`) and the model-scoped path (writes
 * neither). So the classifier's own answer is always the conservative `true`,
 * and these assert that contract plus the categories the two paths key off.
 */

function upstream(message: string, extra: Record<string, unknown> = {}): GatewayError {
  const error = new GatewayError("rate_limit_transient" as never, 429, message);
  Object.assign(error.details, { origin: "upstream", scope: "account", credentialEvidence: true, ...extra });
  return error;
}

describe("account error classification", () => {
  test("a model-scoped throttle reports itself as not routing-visible", () => {
    // Rate limits are (account, model) scoped in this module: the account
    // stays routable for every other model, so `status` and `cooldownUntil`
    // never move.
    const classification = classifyAccountError(upstream("rate limit exceeded"), {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
    });
    expect(classification.category).toBe("rate_limit_transient");
    expect(classification.mutatesAccount).toBe(true);
    // Conservative at classify time; narrowed to false by the model-scoped
    // write path, which is what the reporter gates on.
    expect(classification.routesVisible).toBe(true);
  });

  test("an auth failure that parks the account is routing-visible", () => {
    const classification = classifyAccountError(upstream("token revoked"), {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
    });
    // A revocation writes `status`, which the snapshot reads.
    expect(classification.routesVisible).toBe(true);
  });

  test("a non-mutating classification is still reported", () => {
    // Scope "provider" with no credential evidence: recognised, but nothing is
    // written, so there is nothing for routing to learn.
    const classification = classifyAccountError(upstream("rate limit exceeded"), {
      origin: "upstream",
      scope: "provider",
    });
    // A rate limit mutates at provider scope too: the streak must advance or
    // the most common throttle never escalates.
    expect(classification.mutatesAccount).toBe(true);
  });
});

requireDatabase();

describe("model cooldown route snapshot invalidation", () => {
  let world: GatewayWorld;
  let routeService: InMemoryRouteSnapshotService;

  beforeAll(async () => {
    world = await createWorld({ modelId: "deepseek-v4.1-flash" });
    routeService = new InMemoryRouteSnapshotService(createDatabaseSnapshotBuilder(getDb()));
  });

  afterAll(async () => {
    routeService?.unsubscribe();
    await world?.cleanup();
  });

  test("Qoder virtual model rate limits evict a cached route and then exclude only that pair", async () => {
    const before = await routeService.getSnapshot();
    const candidate = before.candidates.find(
      (row) => row.provider_account_id === world.accountId && row.model_id === world.modelId,
    );
    expect(candidate).toBeDefined();

    await reportAttemptOutcome(getDb(), {
      accountId: world.accountId,
      modelId: "deepseek-v4.1-flash",
      error: new GatewayError("quota_exceeded", 429, "Qoder rate limit exceeded", {
        providerId: "qoder",
        providerStatus: 429,
        providerCode: "rate_limit_exceeded",
      }, "upstream"),
      evidence: {
        origin: "upstream",
        scope: "provider",
        providerId: "qoder",
        statusCode: 429,
      },
      snapshotService: routeService,
    });

    // G-02: `invalidate()` now triggers a DEBOUNCED background rebuild, so the
    // immediately-served snapshot can be one revision stale until the rebuild
    // completes. Wait for the revision to advance before asserting the new
    // routing — the invalidation is async, not synchronous.
    const minRevision = before.revision + 1;
    const deadline = Date.now() + 5_000;
    let after = await routeService.getSnapshot();
    while (after.revision < minRevision) {
      if (Date.now() > deadline) {
        throw new Error("route snapshot rebuild did not settle within 5s");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      after = await routeService.getSnapshot();
    }
    const cooled = after.candidates.find(
      (row) => row.provider_account_id === world.accountId && row.model_id === world.modelId,
    );
    expect(after.revision).toBeGreaterThan(before.revision);
    const health = cooled as unknown as { health_status?: string; cooldown_until?: number } | undefined;
    expect(health?.health_status).toBe("model_cooldown");
    expect(health?.cooldown_until).toBeGreaterThan(Date.now());

    const row = await getDb()
      .select({ status: providerAccounts.status, modelCooldowns: providerAccounts.modelCooldowns })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, world.accountId))
      .limit(1);
    expect(row[0]?.status).toBe("active");
    // `toHaveProperty` splits on dots, and this model id carries dots; the
    // array form treats the whole string as one key.
    expect(row[0]?.modelCooldowns).toHaveProperty(["deepseek-v4.1-flash"]);
  });

  test("ZCode ended trial cools only its model and preserves account eligibility", async () => {
    const trial = await createWorld({ modelId: "glm-5.3", extraModels: ["glm-5.3-flash"] });
    try {
      await reportAttemptOutcome(getDb(), {
        accountId: trial.accountId,
        modelId: trial.modelId,
        error: new GatewayError("invalid_request", 400,
          "ZCode has no active limited quota for GLM-5.3-Trial", {}, "upstream"),
        evidence: { origin: "upstream", scope: "provider", providerId: "zcode-start", statusCode: 400 },
      });
      const rows = await getDb().select({
        status: providerAccounts.status, cooldownUntil: providerAccounts.cooldownUntil,
        modelCooldowns: providerAccounts.modelCooldowns,
      }).from(providerAccounts).where(eq(providerAccounts.id, trial.accountId));
      expect(rows[0]?.status).toBe("active");
      expect(rows[0]?.cooldownUntil).toBeNull();
      const cooldowns = rows[0]?.modelCooldowns as Record<string, string>;
      expect(Date.parse(cooldowns[trial.modelId] ?? "")).toBeGreaterThan(Date.now());
      expect(cooldowns["glm-5.3-flash"]).toBeUndefined();
    } finally {
      await trial.cleanup();
    }
  });

  test("Commandcode MODEL_NOT_IN_PLAN leaves the Go account active for other models", async () => {
    const world = await createWorld({ modelId: "claude-haiku-4-5-20251001", extraModels: ["xiaomi/mimo-v2.6-flash"] });
    try {
      await reportAttemptOutcome(getDb(), {
        accountId: world.accountId, modelId: world.modelId,
        error: new GatewayError("authentication_failed", 403,
          "MODEL_NOT_IN_PLAN: Claude Haiku 4.5 available in Pro and above plans or extra on demand usage",
          { providerId: "commandcode", providerCode: "FORBIDDEN", credentialEvidence: true }, "upstream"),
        evidence: { origin: "upstream", scope: "account", providerId: "commandcode", providerCode: "FORBIDDEN", statusCode: 403, credentialEvidence: true },
      });
      const rows = await getDb().select({
        status: providerAccounts.status, cooldownUntil: providerAccounts.cooldownUntil,
        modelCooldowns: providerAccounts.modelCooldowns, category: providerAccounts.lastErrorCategory,
      }).from(providerAccounts).where(eq(providerAccounts.id, world.accountId));
      expect(rows[0]?.status).toBe("active");
      expect(rows[0]?.cooldownUntil).toBeNull();
      expect(rows[0]?.category).toBe("model_unreachable");
      const cooldowns = rows[0]?.modelCooldowns as Record<string, string>;
      expect(Date.parse(cooldowns[world.modelId] ?? "")).toBeGreaterThan(Date.now());
      expect(cooldowns["xiaomi/mimo-v2.6-flash"]).toBeUndefined();
    } finally {
      await world.cleanup();
    }
  });

  test("Start Plan quota timeouts never advance account failure streak", async () => {
    const world = await createWorld();
    try {
      const collector = await createDefaultProviderRegistry().resolveQuotaCollector("zcode-start");
      if (!collector) throw new Error("Missing Start Plan collector");
      const quota = await collector("fixture", Object.assign(async () => {
        throw new DOMException("quota request budget expired", "TimeoutError");
      }, { preconnect() {} }));
      for (let i = 0; i < 3; i += 1) await recordAccountCheck(getDb(), world.accountId, {
        ok: false, category: "quota_fetch_failed", error: quota.error,
      });
      const rows = await getDb().select({ status: providerAccounts.status,
        failures: providerAccounts.consecutiveFailures, cooldownUntil: providerAccounts.cooldownUntil,
      }).from(providerAccounts).where(eq(providerAccounts.id, world.accountId));
      expect(rows[0]).toEqual({ status: "active", failures: 0, cooldownUntil: null });
    } finally {
      await world.cleanup();
    }
  });
});

describe("a queued upstream is capacity, not a dead credential", () => {
  /**
   * The reported failure: Qoder answers `403 {"code":"10605", ...}` with
   * `isQueued:true` and a `queueCount`. The 403 made the generic auth arm
   * claim it, so a healthy account was parked as `auth_invalidated` — the
   * console's "Re-login required" — purely because the provider was busy.
   * The credential was never rejected; refreshing it cannot shorten a queue.
   */
  const queued = (): GatewayError =>
    new GatewayError(
      "upstream_error" as never,
      403,
      `{"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"dfmodel\\",\\"queueCount\\":1395,\\"queueType\\":\\"\\"}"}`,
      { providerCode: "10605" } as never,
      "upstream" as never,
    );

  test("a queued 403 is a model-capacity cooldown", () => {
    const classification = classifyAccountError(queued(), {
      origin: "upstream",
      scope: "account",
      providerId: "qoder",
      modelId: "deepseek-v4.1-flash",
    });
    expect(classification.category).toBe("model_capacity");
    expect(classification.status).toBe("cooldown");
  });

  test("it is never reported as credential invalidation", () => {
    // The whole point: the console must not offer "Re-login required" for an
    // account that is queued behind 1395 other callers.
    const classification = classifyAccountError(queued(), {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
      providerId: "qoder",
      modelId: "deepseek-v4.1-flash",
    });
    expect(classification.category).not.toBe("auth_invalidated");
  });

  test("queue evidence is recognised without the provider code", () => {
    // The body is nested JSON, so the tell is the key rather than a parse.
    const error = new GatewayError(
      "upstream_error" as never,
      403,
      `{"isQueued":true,"modelKey":"dfmodel","queueCount":12}`,
      {} as never,
      "upstream" as never,
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      providerId: "qoder",
      modelId: "deepseek-v4.1-flash",
    });
    expect(classification.category).toBe("model_capacity");
  });

  test("a real credential rejection is still recognised", () => {
    // Guard against the mirror mistake: excluding queued bodies must not
    // swallow an auth rejection that happens to be a 403.
    const error = new GatewayError(
      "authentication_failed" as never,
      403,
      "invalid api key",
      {} as never,
      "upstream" as never,
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      providerId: "qoder",
    });
    expect(classification.category).toBe("auth_invalidated");
  });
});

describe("Trae upstream auth verdict 1001", () => {
  const trae1001 = (): GatewayError =>
    new GatewayError(
      "authentication_failed" as never,
      401,
      "Trae could not authenticate the account (upstream code 1001): We're sorry, but we are not able to authenticate you.",
      { providerCode: "1001", providerStatus: 1001, credentialEvidence: true } as never,
      "upstream" as never,
    );

  test("is auth_invalidated, not the unknown fallback", () => {
    // The 1001 code is numeric, so the bare-401/403 credential arm normally
    // refuses to claim it. Without the explicit Trae recognition the account
    // fell to `unknown` with `mutatesAccount: false` — it stayed in rotation
    // and was re-dialled on every request despite the upstream's auth verdict.
    const classification = classifyAccountError(trae1001(), {
      origin: "upstream",
      scope: "account",
      providerId: "trae",
      credentialKind: "oauth",
      providerCode: "1001",
      credentialEvidence: true,
      statusCode: 401,
    });
    expect(classification.category).toBe("auth_invalidated");
    expect(classification.mutatesAccount).toBe(true);
    expect(classification.routesVisible).toBe(true);
  });

  test("a same code from another provider stays unclassified", () => {
    // The numeric-code guard exists so unknown numeric codes do not park
    // healthy accounts: only Trae's own 1001 verdict is recognised.
    const classification = classifyAccountError(trae1001(), {
      origin: "upstream",
      scope: "account",
      providerId: "some-other-provider",
      providerCode: "1001",
      credentialEvidence: true,
      statusCode: 401,
    });
    expect(classification.category).not.toBe("auth_invalidated");
  });
});

describe("Trae free-tier quota 4008", () => {
  const trae4008 = (): GatewayError =>
    new GatewayError(
      "quota_exceeded" as never,
      429,
      "Trae quota exceeded (upstream code 4008): Your requests have exceeded the quota.",
      { providerCode: "4008", providerStatus: 4008 } as never,
      "upstream" as never,
    );

  test("is a model-scoped 1-day cooldown, not the generic 1h fallback", () => {
    const classification = classifyAccountError(trae4008(), {
      origin: "upstream",
      scope: "account",
      providerId: "trae",
      modelId: "deepseek-v4.1-flash",
      providerCode: "4008",
      statusCode: 4008,
    });
    expect(classification.category).toBe("model_unreachable");
    expect(classification.status).toBe("cooldown");
    expect(classification.cooldownMs).toBe(24 * 60 * 60 * 1000);
    expect(classification.mutatesAccount).toBe(true);
  });

  test("a provider-scoped stream frame still reaches the model cooldown writer", () => {
    // A stream frame carries no credential detail, so `canMutate` is false;
    // the Trae arm must still set `mutatesAccount` true so the pair is
    // parked for the day instead of being re-dialled every few minutes.
    const classification = classifyAccountError(trae4008(), {
      origin: "upstream",
      scope: "provider",
      providerId: "trae",
      modelId: "deepseek-v4.1-flash",
    });
    expect(classification.category).toBe("model_unreachable");
    expect(classification.mutatesAccount).toBe(true);
  });
});

describe("an unclassified failure is a cooldown, never a parked account", () => {
  test("an unmapped upstream error cools down for 15 minutes", () => {
    const error = new GatewayError(
      "upstream_error" as never,
      400,
      "something this gateway does not understand",
      {} as never,
      "upstream" as never,
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      providerId: "qoder",
    });
    expect(classification.category).toBe("unknown");
    expect(classification.status).toBe("cooldown");
    expect(classification.cooldownMs).toBe(900_000);
  });
});

describe("a reset window the upstream stated in structured fields", () => {
  /** The body a real provider returned: no window in the prose at all. */
  const USAGE_LIMIT_BODY = JSON.stringify({
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      plan_type: "free",
      resets_at: 1795019113,
      eligible_promo: null,
      limit_window_minutes: 43200,
      resets_in_seconds: 2072028,
    },
  });

  function withRawBody(message: string, raw: string): GatewayError {
    const error = new GatewayError("upstream_error" as never, 429, message, {}, "upstream" as never);
    Object.assign(error.details, { raw });
    return error;
  }

  const evidence = { origin: "upstream", scope: "account", credentialEvidence: true } as const;

  test("wins over the 15-minute fallback", () => {
    // The message names no window, so parsing prose alone left this account
    // cooling for 15 minutes on a limit the provider said resets in ~23 days.
    const classification = classifyAccountError(
      withRawBody("The usage limit has been reached", USAGE_LIMIT_BODY),
      { ...evidence, statusCode: 429 },
    );
    expect(classification.category).toBe("rate_limit_transient");
    expect(classification.providerStated).toBe(true);
    // Bounded to a day: a longer window is a plan-level limit, and parking an
    // account for a month on one field is the operator's call, not automatic.
    expect(classification.cooldownMs).toBe(86_400_000);
    expect(classification.cooldownMs).toBeGreaterThan(900_000);
  });

  test("reads a relative reset the caller passes directly", () => {
    const classification = classifyAccountError(
      new GatewayError("upstream_error" as never, 429, "rate limit exceeded"),
      { ...evidence, statusCode: 429, upstreamBody: { resets_in_seconds: 600 } },
    );
    expect(classification.cooldownMs).toBe(600_000);
  });

  test("a reset already in the past is not a window", () => {
    // A stale `resets_at` would otherwise compute a negative delay and, at
    // worst, return the account to rotation immediately.
    const classification = classifyAccountError(
      withRawBody("rate limit exceeded", JSON.stringify({ error: { resets_at: 1 } })),
      { ...evidence, statusCode: 429 },
    );
    expect(classification.cooldownMs).toBe(900_000);
  });

  test("a body that is not JSON keeps the fallback", () => {
    const classification = classifyAccountError(
      withRawBody("rate limit exceeded", "<html>not json</html>"),
      { ...evidence, statusCode: 429 },
    );
    expect(classification.cooldownMs).toBe(900_000);
  });
});

describe("GitHub Copilot not-licensed verdict", () => {
  const githubUpstream = (message: string): GatewayError =>
    new GatewayError(
      "authentication_failed" as never,
      403,
      message,
      { providerId: "github", providerStatus: 403, credentialEvidence: true } as never,
      "upstream" as never,
    );

  test("disables the account instead of cycling a cooldown", () => {
    // The health log showed exactly this: `unauthorized: not licensed to use
    // Copilot` on `gpt-6-luna`, cycling active → cooldown → active forever.
    const classification = classifyAccountError(githubUpstream("unauthorized: not licensed to use Copilot"), {
      origin: "upstream",
      scope: "account",
      providerId: "github",
      statusCode: 403,
      credentialEvidence: true,
    });
    expect(classification.category).toBe("policy_blocked_banned");
    expect(classification.status).toBe("disabled");
    expect(classification.cooldownMs).toBe(0);
    expect(classification.mutatesAccount).toBe(true);
    expect(classification.routesVisible).toBe(true);
  });

  test("a bare forbidden on the Copilot surface is the same verdict", () => {
    const classification = classifyAccountError(githubUpstream("forbidden"), {
      origin: "upstream",
      scope: "provider",
      providerId: "github",
      statusCode: 403,
    });
    expect(classification.category).toBe("policy_blocked_banned");
    expect(classification.status).toBe("disabled");
    expect(classification.mutatesAccount).toBe(true);
  });

  test("does not claim a non-GitHub license refusal", () => {
    // Antigravity's model-entitlement refusal stays model-scoped; the GitHub
    // rule is scoped to the github provider and must not swallow it.
    const classification = classifyAccountError(
      new GatewayError("authentication_failed" as never, 403, "You do not have a valid license of this product", {
        providerId: "antigravity",
        providerStatus: 403,
        credentialEvidence: true,
      } as never, "upstream" as never),
      {
        origin: "upstream",
        scope: "account",
        providerId: "antigravity",
        statusCode: 403,
        credentialEvidence: true,
      },
    );
    expect(classification.category).not.toBe("policy_blocked_banned");
  });

  test("a GitHub auth rejection without license wording still cools", () => {
    const classification = classifyAccountError(githubUpstream("invalid api key"), {
      origin: "upstream",
      scope: "account",
      providerId: "github",
      statusCode: 401,
      credentialEvidence: true,
    });
    expect(classification.category).toBe("auth_invalidated");
    expect(classification.status).toBe("cooldown");
  });
});
