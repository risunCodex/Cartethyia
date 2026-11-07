import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  qoderMachineHeaders,
  type QoderNativeIdentity,
} from "../../../src/providers/integrations/qoder/qoder-umid";
import {
  readMachineIdentityCache,
  readMachineIdentityCacheEvenExpired,
  sampleIdentityWithVote,
  writeMachineIdentityCache,
} from "../../../src/providers/integrations/qoder/qoder-identity-cache";

const nativeIdentity: QoderNativeIdentity = {
  machineToken: "P1gA" + "a".repeat(84),
  machineType: "a".repeat(18),
  machineCode: "b".repeat(18),
  isVm: false,
  source: "runtime-info",
};

const generatedIdentity: QoderNativeIdentity = {
  machineToken: "P1gA" + "c".repeat(84),
  machineType: "c".repeat(18),
  machineCode: "d".repeat(18),
  isVm: false,
  source: "generated",
};

test("qoderMachineHeaders sends full machine set for native identity", () => {
  const headers = qoderMachineHeaders(nativeIdentity, "machine-uuid");
  expect(headers["cosy-machineid"]).toBe("machine-uuid");
  expect(headers["cosy-machinetoken"]).toBe(nativeIdentity.machineToken);
  expect(headers["cosy-machinetype"]).toBe(nativeIdentity.machineType);
  expect(headers["cosy-machinecode"]).toBe(nativeIdentity.machineCode);
  expect(headers["cosy-machineos"]).toBeTruthy();
  expect(headers["cosy-machinehostname"]).toBeTruthy();
});

test("qoderMachineHeaders omits token/type/code for generated identity (donor issue #10)", () => {
  const headers = qoderMachineHeaders(generatedIdentity, "machine-uuid");
  expect(headers["cosy-machineid"]).toBe("machine-uuid");
  expect(headers["cosy-machinetoken"]).toBeUndefined();
  expect(headers["cosy-machinetype"]).toBeUndefined();
  expect(headers["cosy-machinecode"]).toBeUndefined();
  expect(headers["cosy-machineos"]).toBeTruthy();
  expect(headers["cosy-machinehostname"]).toBeTruthy();
});

test("qoderMachineHeaders falls back to machineToken as machine id when none supplied", () => {
  const headers = qoderMachineHeaders(nativeIdentity);
  expect(headers["cosy-machineid"]).toBe(nativeIdentity.machineToken);
});

test("sampleIdentityWithVote takes the majority when all samples agree", () => {
  const sample = () => ({
    identity: { ...nativeIdentity },
    seed: "seed-1",
  });
  const result = sampleIdentityWithVote(sample, "acct-1");
  expect(result).not.toBeNull();
  expect(result!.identity.machineToken).toBe(nativeIdentity.machineToken);
  expect(result!.seed).toBe("seed-1");
});

test("sampleIdentityWithVote resolves disagreement by extending and taking majority", () => {
  let calls = 0;
  const sample = () => {
    calls += 1;
    // First two calls disagree, the rest agree on the minority token.
    if (calls <= 2) return { identity: { ...generatedIdentity }, seed: "seed-gen" };
    return { identity: { ...nativeIdentity }, seed: "seed-native" };
  };
  const result = sampleIdentityWithVote(sample, "acct-1");
  expect(calls).toBeGreaterThanOrEqual(3);
  expect(result).not.toBeNull();
  // Majority is native (3 votes vs 2 generated), so native wins.
  expect(result!.identity.machineToken).toBe(nativeIdentity.machineToken);
});

test("sampleIdentityWithVote returns null when every sample fails", () => {
  const sample = () => null;
  expect(sampleIdentityWithVote(sample, "acct-1")).toBeNull();
});

describe("machine identity disk cache", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const entry = {
    machineToken: nativeIdentity.machineToken,
    machineType: nativeIdentity.machineType,
    machineCode: nativeIdentity.machineCode,
    isVm: false,
    source: "runtime-info" as const,
    environment: "3",
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-identity-cache-"));
    env = { CARTETHYIA_DATA_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("write then read returns the same entry", () => {
    writeMachineIdentityCache("intl", entry, env);
    const cached = readMachineIdentityCache("intl", env);
    expect(cached).not.toBeNull();
    expect(cached!.machineToken).toBe(nativeIdentity.machineToken);
    expect(cached!.environment).toBe("3");
  });

  test("missing realm returns null", () => {
    expect(readMachineIdentityCache("cn", env)).toBeNull();
  });

  test("expired entry is not returned by readMachineIdentityCache but is by EvenExpired", async () => {
    writeMachineIdentityCache("intl", entry, env);
    // Manually age the entry past the TTL (30 min).
    const path = join(dir, "machine_identity.json");
    const doc = JSON.parse(await Bun.file(path).text());
    doc.realm["intl"].cachedAt = Date.now() - 31 * 60 * 1000;
    await Bun.write(path, JSON.stringify(doc));

    expect(readMachineIdentityCache("intl", env)).toBeNull();
    const expired = readMachineIdentityCacheEvenExpired("intl", env);
    expect(expired).not.toBeNull();
    expect(expired!.machineToken).toBe(nativeIdentity.machineToken);
  });
});
