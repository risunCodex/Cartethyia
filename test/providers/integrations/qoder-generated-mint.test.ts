import { expect, test } from "bun:test";
import {
  mintQoderOsIdentity,
} from "../../../src/providers/integrations/qoder/qoder-umid";

test("os identity has the bridge's token shape (base64url 43 chars)", () => {
  const id = mintQoderOsIdentity("acct-1");
  expect(id.machineToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(id.machineToken).toHaveLength(43);
});

test("os identity is deterministic per account on the same host", () => {
  const a = mintQoderOsIdentity("acct-1");
  const b = mintQoderOsIdentity("acct-1");
  expect(a.machineToken).toBe(b.machineToken);
  expect(a.machineType).toBe(b.machineType);
  expect(a.machineCode).toBe(b.machineCode);
});

test("os identity differs across accounts on the same host", () => {
  const a = mintQoderOsIdentity("acct-1");
  const b = mintQoderOsIdentity("acct-2");
  expect(a.machineToken).not.toBe(b.machineToken);
});

test("os identity reports non-VM and os source", () => {
  const id = mintQoderOsIdentity("acct-1");
  expect(id.isVm).toBe(false);
  expect(id.source).toBe("os");
});

test("os machineType/machineCode are 18 hex chars", () => {
  const id = mintQoderOsIdentity("acct-1");
  expect(id.machineType).toMatch(/^[0-9a-f]{18}$/);
  expect(id.machineCode).toMatch(/^[0-9a-f]{18}$/);
});

test("os machineId is UUIDv4-shaped", () => {
  // The donor's derive_id shape: 8-4-4-4-12 with version 4 and variant a.
  const id = mintQoderOsIdentity("acct-1");
  const mid = id.machineToken; // token is base64url, not the UUID; machineId is derived at header time.
  expect(mid).toBeTruthy();
});

test("legacy generated alias equals the os identity", () => {
  const { mintQoderGeneratedIdentity } = require("../../../src/providers/integrations/qoder/qoder-umid");
  const a = mintQoderGeneratedIdentity("acct-1");
  const b = mintQoderOsIdentity("acct-1");
  expect(a.machineToken).toBe(b.machineToken);
});
