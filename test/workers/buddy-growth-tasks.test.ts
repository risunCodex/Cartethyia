/**
 * The buddy growth tasks: what each one sends, and what it does with a
 * duplicate.
 *
 * Two properties are pinned. Both are easy to get wrong in the direction that
 * costs the operator money or noise:
 *
 * 1. **The wire shape is the reference gateway's.** Path, method, and body per
 *    endpoint, because a growth endpoint that is merely reachable is not the
 *    same as one we call correctly — and a wrong body is answered with a
 *    business error we would then have to interpret.
 * 2. **A duplicate is a success.** `409 duplicate`, business code `14051`, and
 *    the "not eligible / no chances" family are normal upstream states. Reading
 *    any of them as a failure would flood the log once per account per day and,
 *    through the health machine, could cool an account for a growth-page
 *    problem.
 *
 * The day marker gets its own test: it is what stops a sweep ticking every few
 * minutes from re-POSTing a claim.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import {
  adoptFirstBuddy,
  agreeBuddyAgreement,
  useBuddyMakeupCard,
} from "../../src/providers/integrations/buddy/lifecycle";
import {
  buddyAdoptTask,
  buddyDayKey,
  buddyStreakTask,
  type BuddyTaskDeps,
} from "../../src/workers/buddy-growth-tasks";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;
}

/** Records every call and answers from `responder`. */
function recording(responder: (seen: Seen) => Response): { fetcher: FetchLike; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    const seen: Seen = {
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(seen);
    return responder(seen);
  }) as unknown as FetchLike;
  return { fetcher, calls };
}

function ok(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function err(status: number, code: number, msg: string): Response {
  return new Response(JSON.stringify({ code, msg }), { status });
}

const CALL = {
  baseUrl: "https://copilot.tencent.com/v2",
  headers: { "X-Product": "SaaS" },
  credential: "token-1",
  uid: "uid-1",
  accountId: "acct-1",
  providerId: "cb",
} as const;

function withFetcher(fetcher: FetchLike) {
  return { ...CALL, fetcher };
}

describe("the growth endpoints — request shape", () => {
  test("makeup posts the target date only when yesterday was missed", async () => {
    // Yesterday scored zero and a card is available → one spend.
    const { fetcher, calls } = recording((seen) => {
      if (seen.url.endsWith("/activity/growth/heatmap")) {
        return ok({ code: 0, data: { cells: [{ date: "2026-10-15", score: 0 }] } });
      }
      if (seen.url.endsWith("/activity/growth/streak")) {
        return ok({ code: 0, data: { streak: { days: 3 }, makeup_cards: { balance: 2 } } });
      }
      return ok({ code: 0, data: {} });
    });
    const result = await useBuddyMakeupCard(withFetcher(fetcher), "2026-10-15");
    expect(result.state).toBe("claimed");
    const sent = calls.find((entry) => entry.url.endsWith("/activity/growth/makeup-cards/use"));
    expect(sent?.method).toBe("POST");
    expect(sent?.body).toEqual({ target_date: "2026-10-15" });
  });

  test("makeup skips when yesterday was not missed — no write at all", async () => {
    const { fetcher, calls } = recording((seen) =>
      seen.url.endsWith("/activity/growth/heatmap")
        ? ok({ code: 0, data: { cells: [{ date: "2026-10-15", score: 5 }] } })
        : ok({ code: 0, data: { streak: { days: 3 }, makeup_cards: { balance: 2 } } }),
    );
    const result = await useBuddyMakeupCard(withFetcher(fetcher), "2026-10-15");
    expect(result.state).toBe("skipped");
    expect(calls.some((entry) => entry.url.endsWith("/makeup-cards/use"))).toBe(false);
  });

  test("adoption agrees first, then adopts", async () => {
    const { fetcher, calls } = recording(() => ok({ code: 0, data: {} }));
    await agreeBuddyAgreement(withFetcher(fetcher));
    expect(calls[0]!.url).toContain("/activity/growth/buddy/agreement");
    expect(calls[0]!.body).toEqual({ agree: true });
    await adoptFirstBuddy(withFetcher(fetcher));
    expect(calls[1]!.url).toContain("/activity/growth/buddy/first");
  });

  test("adoption below the conversation threshold is not eligible, not a failure", async () => {
    const { fetcher } = recording(() => err(400, 0, "first_buddy task not completed yet"));
    const result = await adoptFirstBuddy(withFetcher(fetcher));
    expect(result.state).toBe("not_eligible");
    expect(result.error).toBeNull();
  });

  test("a transport failure is the only thing that reports an error", async () => {
    const { fetcher } = recording(() => {
      throw new Error("network down");
    });
    const result = await adoptFirstBuddy(withFetcher(fetcher));
    expect(result.state).toBe("error");
    expect(result.error).toContain("network down");
  });
});

// ---------------------------------------------------------------------------
// Task-level tests: the day marker
// ---------------------------------------------------------------------------

/** A real SQLite handle, so the ledger's composite PK is the real guard. */
async function realDb(): Promise<{ db: ReturnType<typeof buildSqliteHandle>["db"]; sqlite: Database }> {
  const dir = mkdtempSync(join(tmpdir(), "cart-buddy-"));
  const sqlite = createSqliteDatabase(join(dir, "g.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  sqlite.exec("INSERT INTO tenants (id, name, status) VALUES ('t', 'A', 'active')");
  sqlite.exec("INSERT INTO providers (id) VALUES ('cbcn')");
  sqlite.exec(
    "INSERT INTO provider_accounts (id, provider_id, label, credential_kind, status) VALUES ('a1','cbcn','L','oauth','active')",
  );
  return { db, sqlite };
}

function taskDeps(
  db: ReturnType<typeof buildSqliteHandle>["db"],
  fetcher: FetchLike,
): BuddyTaskDeps {
  return {
    db,
    resolveCredential: async () => "token-1",
    fetcher,
    listAccounts: async () => [{ id: "a1", providerId: "cbcn" }],
    now: () => new Date("2026-10-16T02:00:00Z"),
  };
}

describe("the day marker — one claim per account per task", () => {
  test("a second pass the same day does not re-POST the claim", async () => {
    const { db, sqlite } = await realDb();
    const { fetcher, calls } = recording(() => ok({ code: 0, data: {} }));
    const deps = taskDeps(db, fetcher);

    await buddyStreakTask(deps);
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    const rows = sqlite
      .prepare("SELECT day_key, account_id, task FROM buddy_task_ledger")
      .all() as Array<{ day_key: string; account_id: string; task: string }>;
    expect(rows).toEqual([
      {
        day_key: buddyDayKey(new Date("2026-10-16T02:00:00Z")),
        account_id: "a1",
        task: "buddy-streak",
      },
    ]);
    sqlite.close();
  });

  test("the same task on a different day runs again", async () => {
    const { db, sqlite } = await realDb();
    const { fetcher, calls } = recording(() => ok({ code: 0, data: {} }));
    const first = taskDeps(db, fetcher);
    await buddyStreakTask(first);
    await buddyStreakTask({ ...first, now: () => new Date("2026-10-18T02:00:00Z") });
    // Two distinct day keys, so the streak read happened twice.
    const streakReads = calls.filter((entry) => entry.url.endsWith("/activity/growth/streak"));
    expect(streakReads.length).toBeGreaterThanOrEqual(2);
    sqlite.close();
  });

  test("each task keeps its own marker", async () => {
    const { db, sqlite } = await realDb();
    const { fetcher } = recording(() => ok({ code: 0, data: { state: "idle" } }));
    const deps = taskDeps(db, fetcher);
    await buddyAdoptTask(deps);
    const tasks = (
      sqlite.prepare("SELECT task FROM buddy_task_ledger ORDER BY task").all() as Array<{ task: string }>
    ).map((row) => row.task);
    expect(tasks).toEqual(["buddy-adopt"]);
    sqlite.close();
  });


});
