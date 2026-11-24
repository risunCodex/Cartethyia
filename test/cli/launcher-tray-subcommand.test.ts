/**
 * The `carte` launcher decides whether it is starting a tray or running a
 * command. `carte tray` starts one; `carte tray hide` asks the running one for
 * something and must come back with its answer, not detach and wait 60 seconds
 * for a startup signal that will never arrive.
 *
 * The launcher runs under Node and spawns `bun` from `CARTETHYIA_BUN`, so a
 * shell script stands in for Bun and records the argv it was handed.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CARTE = join(import.meta.dir, "../../scripts/cli/bin/carte.cjs");

let dir: string;
let fakeBun: string;
let argvFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "carte-launcher-test-"));
  argvFile = join(dir, "argv.txt");
  fakeBun = join(dir, "bun");
  // Stands in for the CLI: records its argv, and writes a startup signal when
  // the test wants the launcher to see one.
  writeFileSync(
    fakeBun,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${argvFile}"`,
      'if [ -n "$CARTETHYIA_FAKE_SIGNAL" ]; then',
      '  printf \'%s\' "$CARTETHYIA_FAKE_SIGNAL" > "$CARTETHYIA_TRAY_STARTUP_SIGNAL"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runCarte(
  args: readonly string[],
  signal?: unknown,
): Promise<{ code: number | null; output: string }> {
  const proc = Bun.spawn(["node", CARTE, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      CARTETHYIA_BUN: fakeBun,
      CARTETHYIA_FAKE_ARGV: argvFile,
      ...(signal === undefined ? {} : { CARTETHYIA_FAKE_SIGNAL: JSON.stringify(signal) }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, output: stdout + stderr };
}

function recordedArgv(): string[] {
  return readFileSync(argvFile, "utf8").trim().split("\n");
}

test("carte tray status runs the CLI in the foreground instead of waiting for a tray", async () => {
  const { code, output } = await runCarte(["tray", "status"]);

  expect(output).not.toContain("Loading Cartethyia");
  expect(code).toBe(0);
  expect(recordedArgv().slice(-2)).toEqual(["tray", "status"]);
});

test("every tray subcommand reaches the CLI as a plain foreground command", async () => {
  for (const subcommand of ["hide", "show", "toggle", "status"]) {
    const { output } = await runCarte(["tray", subcommand]);
    expect(output).not.toContain("Loading Cartethyia");
    expect(recordedArgv().slice(-2)).toEqual(["tray", subcommand]);
  }
});

test("carte --tray still starts a tray and waits for readiness", async () => {
  const { output } = await runCarte(["--tray"], { status: "ready", url: "http://127.0.0.1:12800/console" });

  expect(output).toContain("Loading Cartethyia");
  expect(output).toContain("ready at http://127.0.0.1:12800/console");
});

test("carte --tray reports a hidden start with the way back", async () => {
  // The tray is detached with no stdio, so the launcher's own line is the only
  // place the operator can be told the icon they cannot see is deliberate.
  const { output } = await runCarte(["--tray"], {
    status: "ready",
    url: "http://127.0.0.1:12800/console",
    note: "The tray icon is hidden; restore it with carte tray show.",
  });

  expect(output).toContain("ready at http://127.0.0.1:12800/console");
  expect(output).toContain("carte tray show");
});

test("carte --tray with a tray already running reports success, not a failed start", async () => {
  // The CLI showed the existing tray's icon and had nothing to start, so it
  // exits 0 without a URL. The launcher used to call that "exited before
  // readiness" and exit 1 for a command that had done exactly what was asked.
  const { code, output } = await runCarte(["--tray"], { status: "already-running" });

  expect(output).toContain("already running");
  expect(output).not.toContain("failed to start");
  expect(code).toBe(0);
});

test("bare carte still defaults to the arrow-key menu", async () => {
  await runCarte([]);

  expect(recordedArgv().at(-1)).toBe("menu");
});
