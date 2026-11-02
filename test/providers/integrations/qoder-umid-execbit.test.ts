import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePosixExecutable } from "../../../src/providers/integrations/qoder/qoder-umid";

/**
 * The umidpack bridge binaries are committed without the exec bit (git mode
 * 100644), so `ensurePosixExecutable` must set it before the ELF/Mach-O is
 * spawned on Linux/macOS. Mode bits are only meaningful on POSIX; on Windows
 * the bridge path goes through WSL, which performs its own chmod on the staged
 * copy, so the exec-bit assertions are skipped there.
 */
const posix = process.platform === "win32" ? test.skip : test;

posix("ensurePosixExecutable sets the exec bit on a non-executable file", () => {
  const dir = mkdtempSync(join(tmpdir(), "qoder-umid-exec-"));
  const file = join(dir, "runtime-info");
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  expect(statSync(file).mode & 0o111).toBe(0);
  ensurePosixExecutable(file);
  expect(statSync(file).mode & 0o111).not.toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

posix("ensurePosixExecutable is idempotent and keeps an existing exec bit", () => {
  const dir = mkdtempSync(join(tmpdir(), "qoder-umid-exec-"));
  const file = join(dir, "runtime-info");
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  ensurePosixExecutable(file);
  ensurePosixExecutable(file);
  expect(statSync(file).mode & 0o111).not.toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("ensurePosixExecutable tolerates a missing file", () => {
  const missing = join(tmpdir(), "no-such-umid-bridge-runtime-info");
  expect(() => ensurePosixExecutable(missing)).not.toThrow();
});

test("ensurePosixExecutable tolerates an unreadable path", () => {
  const dir = mkdtempSync(join(tmpdir(), "qoder-umid-exec-"));
  const file = join(dir, "runtime-info");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o000);
  expect(() => ensurePosixExecutable(file)).not.toThrow();
  rmSync(dir, { recursive: true, force: true });
});
