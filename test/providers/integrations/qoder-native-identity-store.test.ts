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
    cleanup: () => {
      try { sqlite.close(); } catch { /* already closed */ }
      removeDir(dir);
    },
  };
}

/** A deterministic fake minter: each mint yields a fresh token sequence. */
function fakeMinter() {
  let n = 0;
  return {
    mint: (_accountId: string): { identity: QoderNativeIdentity; seed: string } => {
      n += 1;
      return {
        identity: {
          machineToken: `tok-${n}`,
          machineType: `type-${n}`,
          machineCode: `code-${n}`,
          isVm: false,
          source: "runtime-info",
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

  test("the partial unique index rejects two accounts sharing a token", async () => {
    const f = await fixture();
    try {
      const a = await f.account("a");
      const b = await f.account("b");
      const store = new DrizzleQoderNativeIdentityStore(f.db);
      await store.bind("qoder", a, RECORD("tok-0"));
      await expect(store.bind("qoder", b, RECORD("tok-0"))).rejects.toThrow();
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
      const record = await allocateQoderNativeIdentity(store, "qoder", id, { mint: minter.mint });
      expect(record?.machineToken).toBe("tok-1");
      expect(record?.seed).toBe('{"seed":1}');
      if (record === null) throw new Error("expected a bound record");
      expect(await store.get("qoder", id)).toEqual(record);
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
      // minter returns tok-1 (occupied) then tok-2 (free).
      let calls = 0;
      const mint = () => {
        calls += 1;
        return {
          identity: {
            machineToken: calls === 1 ? "tok-1" : "tok-2",
            machineType: "t",
            machineCode: "c",
            isVm: false,
            source: "runtime-info" as const,
          },
          seed: `{"seed":${calls}}`,
        };
      };
      const record = await allocateQoderNativeIdentity(store, "qoder", id, { mint });
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
        allocateQoderNativeIdentity(store, "qoder", a, { mint: minter.mint }),
        allocateQoderNativeIdentity(store, "qoder", b, { mint: minter.mint }),
      ]);
      expect(ra?.machineToken).toBe("tok-1");
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
      const record = await allocateQoderNativeIdentity(store, "qodercn", b, { mint: minter.mint });
      expect(record?.machineToken).toBe("tok-2");
      expect(record?.machineToken).not.toBe("tok-1");
    } finally {
      f.cleanup();
    }
  });
});
