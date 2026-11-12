/**
 * Buddy device-binding portability: the qimei36 binding must survive
 * export → import. The binding is normally derived from the INTERNAL account
 * id, which changes on re-import — so export materializes the raw binding into
 * the exported auth state. These tests pin the derivation contract and the
 * materialization behavior.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  materializeBuddyDeviceBinding,
  resolveBuddyDeviceBinding,
} from "../../src/providers/integrations/buddy/headers";

const accountId = "b12d000f-fa65-438b-976b-cf12b0282db0";
const derived = createHash("sha256")
  .update(`wb2a:qimei36:${accountId}`)
  .digest("hex")
  .slice(0, 32);

describe("resolveBuddyDeviceBinding", () => {
  test("explicit auth_state qimei36 wins", () => {
    const binding = resolveBuddyDeviceBinding({
      credential: {
        account_id: accountId,
        auth_state: { qimei36: "explicit-binding" },
      },
    } as never);
    expect(binding).toBe("explicit-binding");
  });

  test("derives a stable 32-hex binding from the account id", () => {
    const binding = resolveBuddyDeviceBinding({
      credential: { account_id: accountId },
    } as never);
    expect(binding).toBe(derived);
    expect(binding).toMatch(/^[0-9a-f]{32}$/);
  });

  test("returns undefined without an account id", () => {
    expect(resolveBuddyDeviceBinding({ credential: {} } as never)).toBeUndefined();
  });
});

describe("materializeBuddyDeviceBinding", () => {
  test("returns undefined when an explicit binding already exists", () => {
    const out = materializeBuddyDeviceBinding(accountId, { qimei36: "explicit" });
    expect(out).toBeUndefined();
  });

  test("materializes the derived binding into the auth state", () => {
    const out = materializeBuddyDeviceBinding(accountId, { userId: "u1" });
    expect(out).toEqual({ userId: "u1", qimei36: derived });
  });

  test("materializes into an empty auth state", () => {
    const out = materializeBuddyDeviceBinding(accountId, undefined);
    expect(out).toEqual({ qimei36: derived });
  });

  test("returns undefined for an empty account id", () => {
    expect(materializeBuddyDeviceBinding("", {})).toBeUndefined();
  });
});
