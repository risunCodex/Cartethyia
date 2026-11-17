/**
 * Qoder native-identity store + device allocation.
 *
 * The invariant under test: one account owns one device identity (machine
 * token), two accounts never share a device, and allocation mints a fresh
 * seed so each account is a distinct device. The DB-level partial unique
 * index is exercised as the backstop.
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
} from "../../../src/persistence/db-sqlite";
import { providerAccounts, providers, type NativeIdentityRecord } from "../../../src/persistence/schema";
import {
  allocateQoderNativeIdentity,
  DrizzleQoderNativeIdentityStore,
} from "../../../src/providers/integrations/qoder/qoder-native-identity-store";
import type { QoderNativeIdentity } from "../../../src/providers/integrations/qoder/qoder-umid";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-qoder-nativeid-"));
  const sqlite = createSqliteDatabase(join(dir, "t.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  const env = { CARTETHYIA_DATA_DIR: dir };
  await db.insert(providers).values({ id: "qoder" });
  const account = async (label: string, providerId = "qoder") => {
    const [row] = await db
      .insert(providerAccounts)
      .values({
        providerId,
        label,
        credentialKind: "api_key",
        credentialFingerprint: randomUUID(),
      })
      .returning({ id: providerAccounts.id });
    if (!row) throw new Error("account insert returned no row");
    return row.id as string;
  };
  return {
    db,
    account,
    env,
    cleanup: () => {
      try { sqlite.close(); } catch { /* already closed */ }
      removeDir(dir);
    },
  };
}

/** A deterministic fake minter: stable token per call (same seed → same
 * token). An optional `collideWith` makes the first call emit an occupied
 * token so collision-retry tests can exercise the loop. `source` defaults to
 * "os": the per-account mint whose tokens the unique index keeps exclusive.
 * Pass "runtime-info" for the machine-scoped bridge semantics (tokens are
 * legitimately shared by every account on one host). */
function fakeMinter(collideWith?: string, source: QoderNativeIdentity["source"] = "os") {
  let n = 0;
  return {
    mint: (_accountId?: string): { identity: QoderNativeIdentity; seed: string } => {
      n += 1;
      const token = n === 1 && collideWith !== undefined ? collideWith : `tok-${n}`;
      return {
        identity: {
          machineToken: token,
          machineType: `type-${n}`,
          machineCode: `code-${n}`,
          isVm: false,
          source,
        },
        seed: `{"seed":${n}}`,
      };
    },
    count: () => n,
  };
}

const RECORD = (token: string, type = "x86_64_linux", code = "c"): NativeIdentityRecord => ({
  machineToken: token,
  machineType: type,
  machineCode: code,
});

describe("DrizzleQoderNativeIdentityStore", () => {
  test("get returns undefined until bound, then the record", async () => {
    const f = await fixture();
    try {
      const id = await f.account("a");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      expect(await store.get("qoder", id)).toBeUndefined();
      await store.bind("qoder", id, RECORD("tok-1"));
      expect(await store.get("qoder", id)).toEqual(RECORD("tok-1"));
    } finally {
      f.cleanup();
    }
  });

  test("occupied excludes the account's own token but includes other accounts'", async () => {
    const f = await fixture();
    try {
      const a = await f.account("a");
      const b = await f.account("b");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      await store.bind("qoder", a, RECORD("tok-a"));
      await store.bind("qoder", b, RECORD("tok-b"));

      expect(await store.occupied(a)).toEqual(new Set(["tok-b"]));
      expect(await store.occupied(b)).toEqual(new Set(["tok-a"]));
      const c = await f.account("c");
      expect(await store.occupied(c)).toEqual(new Set(["tok-a", "tok-b"]));
    } finally {
      f.cleanup();
    }
  });

  test("the partial unique index rejects two accounts sharing a derived token", async () => {
    const f = await fixture();
    try {
      const a = await f.account("a");
      const b = await f.account("b");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      await store.bind("qoder", a, { ...RECORD("tok-0"), source: "os" });
      await expect(store.bind("qoder", b, { ...RECORD("tok-0"), source: "os" })).rejects.toThrow();
    } finally {
      f.cleanup();
    }
  });

  test("machine-scoped runtime-info tokens may repeat across accounts (migration 0049)", async () => {
    const f = await fixture();
    try {
      const a = await f.account("a");
      const b = await f.account("b");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      await store.bind("qoder", a, { ...RECORD("tok-0"), source: "runtime-info" });
      // The bridge output is byte-identical for every account on one host —
      // the second binding is the same machine, not a spoof collision.
      await store.bind("qoder", b, { ...RECORD("tok-0"), source: "runtime-info" });
      expect((await store.get("qoder", b))?.machineToken).toBe("tok-0");
    } finally {
      f.cleanup();
    }
  });
});

describe("allocateQoderNativeIdentity", () => {
  test("mints and binds a fresh device", async () => {
    const f = await fixture();
    try {
      const id = await f.account("a");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      const minter = fakeMinter();
      const record = await allocateQoderNativeIdentity(store, "qoder", id, { mint: minter.mint, env: f.env, realm: "intl" });
      expect(record?.machineToken).toBe("tok-1");
      expect(record?.seed).toBe('{"seed":1}');
      if (record === null) throw new Error("expected a bound record");
      expect(await store.get("qoder", id)).toEqual(record);
    } finally {
      f.cleanup();
    }
  });

  test("a runtime-info cache entry is shared by every account on the host", async () => {
    const f = await fixture();
    try {
      const a = await f.account("a");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      const native = fakeMinter(undefined, "runtime-info");
      const first = await allocateQoderNativeIdentity(store, "qoder", a, { mint: native.mint, env: f.env, realm: "intl" });
      expect(first?.machineToken).toBe("tok-1");
      // The bridge token is machine-scoped: account b's allocation hits the
      // disk cache and binds the SAME token instead of minting another.
      const b = await f.account("b");
      const second = await allocateQoderNativeIdentity(store, "qoder", b, { mint: native.mint, env: f.env, realm: "intl" });
      expect(second?.machineToken).toBe("tok-1");
    } finally {
      f.cleanup();
    }
  });

  test("skips occupied tokens and avoidToken", async () => {
    const f = await fixture();
    try {
      const a = await f.account("a");
      const b = await f.account("b");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      await store.bind("qoder", a, RECORD("tok-1"));
      await store.bind("qoder", b, RECORD("tok-2"));

      const c = await f.account("c");
      const minter = fakeMinter();
      const record = await allocateQoderNativeIdentity(store, "qoder", c, {
        mint: minter.mint,
        avoidToken: "tok-3",
        env: f.env,
        realm: "intl",
      });
      // tok-1/tok-2 are occupied; tok-3 avoided → first free is tok-4.
      expect(record?.machineToken).toBe("tok-4");
    } finally {
      f.cleanup();
    }
  });

  test("returns null when the minter always fails", async () => {
    const f = await fixture();
    try {
      const id = await f.account("a");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      const record = await allocateQoderNativeIdentity(store, "qoder", id, {
        mint: () => null,
        env: f.env,
        realm: "intl",
      });
      expect(record).toBeNull();
      if (record !== null) throw new Error("expected no bound record");
      expect(await store.get("qoder", id)).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  test("collision retries until a free token is minted", async () => {
    const f = await fixture();
    try {
      const a = await f.account("a");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      await store.bind("qoder", a, RECORD("tok-1"));

      const id = await f.account("b");
      // minter returns tok-1 (occupied) then tok-2 (free). "os" source: the
      // uniqueness semantics the collision loop exists for.
      let calls = 0;
      const mint = () => {
        calls += 1;
        return {
          identity: {
            machineToken: calls === 1 ? "tok-1" : "tok-2",
            machineType: "t",
            machineCode: "c",
            isVm: false,
            source: "os" as const,
          },
          seed: `{"seed":${calls}}`,
        };
      };
      const record = await allocateQoderNativeIdentity(store, "qoder", id, { mint, env: f.env, realm: "intl" });
      // The first mint yields tok-1 (occupied) → re-mint; the second call
      // yields tok-2 (free), which is bound.
      expect(calls).toBe(2);
      expect(record?.machineToken).toBe("tok-2");
    } finally {
      f.cleanup();
    }
  });

  test("concurrent allocations never share a device (in-process lock)", async () => {
    const f = await fixture();
    try {
      const a = await f.account("a");
      const b = await f.account("b");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      const minter = fakeMinter();
      const [ra, rb] = await Promise.all([
        allocateQoderNativeIdentity(store, "qoder", a, { mint: minter.mint, env: f.env, realm: "intl" }),
        allocateQoderNativeIdentity(store, "qoder", b, { mint: minter.mint, env: f.env, realm: "intl" }),
      ]);
      expect(ra?.machineToken).toBe("tok-1");
      // The in-process lock serializes the two allocations. The first binds
      // tok-1 and writes it to the disk cache; the second sees the cached
      // token as occupied and mints fresh (tok-2).
      expect(rb?.machineToken).toBe("tok-2");
      expect(ra?.machineToken).not.toBe(rb?.machineToken);
    } finally {
      f.cleanup();
    }
  });

  test("the occupied pool is global across realms (qoder vs qodercn)", async () => {
    const f = await fixture();
    try {
      await f.db.insert(providers).values({ id: "qodercn" });
      const a = await f.account("a");
      const b = await f.account("b", "qodercn");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      await store.bind("qoder", a, RECORD("tok-1"));

      const minter = fakeMinter();
      const record = await allocateQoderNativeIdentity(store, "qodercn", b, { mint: minter.mint, env: f.env, realm: "cn" });
      // tok-1 is occupied, so the fresh mint binds the next free token.
      expect(record?.machineToken).toBe("tok-2");
      expect(record?.machineToken).not.toBe("tok-1");
    } finally {
      f.cleanup();
    }
  });
});
