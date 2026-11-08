/**
 * The single entry point for every test invocation.
 *
 * A bare `bun test` is not enough for this suite, and the reasons are worth
 * stating so the flags are not "helpfully" removed later:
 *
 * - The local `.env` is shared with the test subprocesses. Database suites
 *   only run when `CARTETHYIA_TEST_DATABASE_URL` points to a disposable
 *   database; when present, the runner routes `DATABASE_URL` there and selects
 *   Full mode so tests cannot accidentally write to the runtime database.
 * - Config, HOME, platform-specific config paths, and telemetry are redirected
 *   to one temporary sandbox per invocation and removed on exit. Tests cannot
 *   inherit the operator's writable state merely by forgetting an override.
 * - **`--timeout` is a hang detector, not a budget.** 15 s is far longer than
 *   any legitimate test in this suite; it exists so a deadlocked test fails
 *   with a name instead of stalling CI. A test that needs to wait is written
 *   against `helpers/clock.ts` instead of sleeping.
 * - **`--parallel` is default, capped.** Files are isolated per worker, so the database
 *   suites must scope their rows — which `helpers/fixtures.ts` does by
 *   construction. Serializing the run instead would hide a leak that the
 *   parallel run catches. Worker count is capped at 4 (or
 *   `CARTETHYIA_TEST_JOBS`) so the suite does not pin every core.
 *
 * `--scope` picks explicit path sets: `backend` (backend-only trees under
 * `test/`), `dashboard` (`dashboard/test/`), `scripts` (`test/cli/`),
 * `integration` (`test/integration/`), or `all`.
 * `--watch` re-runs on change. Anything else is forwarded to
 * `bun test`, so `bun run test -- --test-name-pattern admission` works.
 *
 * The scope is passed as an explicit PATH rather than as the working directory,
 * because running `bun test` from the repo root discovers `dashboard/test/`
 * too — `dashboard` is not excluded from root discovery, so the "backend" scope
 * was silently running the dashboard suites a second time. The paths below are
 * the single definition of what each scope covers.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { generateCartethyiaEncryptionKey, readEnvFile } from "../cli/env";
import { PACKAGE_ROOT } from "../../src/config/package-paths";

const PROJECT_ROOT = PACKAGE_ROOT;
const DASHBOARD_ROOT = join(PROJECT_ROOT, "dashboard");
const BACKEND_TESTS = join(PROJECT_ROOT, "test");
const INTEGRATION_TESTS = join(BACKEND_TESTS, "integration");
const DASHBOARD_TESTS = join(DASHBOARD_ROOT, "test");
const SCRIPTS_TESTS = join(PROJECT_ROOT, "test", "cli");
const DEFAULT_BACKEND_TESTS = readdirSync(BACKEND_TESTS)
  .filter((name) => name !== "cli" && name !== "integration")
  .map((name) => join(BACKEND_TESTS, name));
const sandboxRoot = mkdtempSync(join(tmpdir(), "cartethyia-test-run-"));

const rawArgs = process.argv.slice(2);


const scopeIndex = rawArgs.indexOf("--scope");
const scope = scopeIndex >= 0 ? rawArgs[scopeIndex + 1] : "all";
if (!["all", "backend", "dashboard", "scripts", "integration"].includes(scope ?? "")) {
  console.error(`[test] unknown --scope "${scope}"; expected backend, dashboard, scripts, integration, or all`);
  throw new Error(`Unknown test scope: ${scope}`);
}

const passthrough = rawArgs.filter((_arg, index) => {
  // Drop the `--scope <value>` pair; everything else is forwarded to `bun test`.
  if (scopeIndex < 0) return true;
  return index !== scopeIndex && index !== scopeIndex + 1;
});
const watch = passthrough.includes("--watch");
const testArgs = passthrough.filter((arg) => arg !== "--watch");

const sharedEnv = {
  ...(await readEnvFile(join(PROJECT_ROOT, ".env"))),
  ...process.env,
};

/**
 * Trusts the loopback TLS fixture without touching a production path.
 *
 * `test/network/outbound-http2.test.ts` stands up a real self-signed HTTP/2
 * server, and the binding it exercises pins `rejectUnauthorized: true` — which
 * is correct and must not be weakened to accommodate a fixture. The supported
 * way to trust a private CA is `NODE_EXTRA_CA_CERTS`, and it is read when the
 * TLS root store is first built, so it has to be set on the subprocess rather
 * than inside the test file (by then the store is already built).
 *
 * Two traps make this a merge and not an assignment:
 *
 * - Node replaces the extra-CA list rather than appending, so pointing the
 *   variable at the fixture alone would silently untrust whatever the machine
 *   already relied on — this workstation, for instance, carries a corporate
 *   MITM root there.
 * - A `ca` option on the socket would mean editing the production dial to
 *   accept a per-caller override, which is the weakening this avoids.
 *
 * PEM bundles concatenate, so the existing file's contents are prefixed with
 * the fixture and written to one temp file per run.
 */
function mergedExtraCaCerts(): Record<string, string> {
  const fixture = join(PROJECT_ROOT, "test", "fixtures", "localhost-cert.pem");
  if (!existsSync(fixture)) return {};
  const existing = sharedEnv.NODE_EXTRA_CA_CERTS?.trim();
  const parts = [readFileSync(fixture, "utf8")];
  if (existing && existsSync(existing)) parts.push(readFileSync(existing, "utf8"));
  const bundle = join(sandboxRoot, "extra-ca.pem");
  writeFileSync(bundle, parts.join("\n"));
  return { NODE_EXTRA_CA_CERTS: bundle };
}

const testDatabaseUrl = sharedEnv.CARTETHYIA_TEST_DATABASE_URL?.trim();
if (testDatabaseUrl) {
  const runtimeDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (runtimeDatabaseUrl && testDatabaseUrl === runtimeDatabaseUrl) {
    console.error("[test] CARTETHYIA_TEST_DATABASE_URL must differ from the runtime DATABASE_URL");
    process.exit(1);
  }
  sharedEnv.CARTETHYIA_DB_MODE = "full";
  sharedEnv.DATABASE_URL = testDatabaseUrl;
} else if (scope === "all" || scope === "backend" || scope === "integration") {
  console.error(
    "[test] set CARTETHYIA_TEST_DATABASE_URL in the local .env or shell before running backend tests; " +
      "the development DATABASE_URL is never used as a test fallback",
  );
  process.exit(1);
}

// Tests exercise code that writes user-owned configuration and telemetry. Set
// every filesystem root before spawning Bun so even a forgotten per-file
// sandbox cannot overwrite or clean the operator's real data.
Object.assign(sharedEnv, {
  APPDATA: join(sandboxRoot, "config", "roaming"),
  LOCALAPPDATA: join(sandboxRoot, "config", "local"),
  XDG_CONFIG_HOME: join(sandboxRoot, "config", "xdg"),
  CARTETHYIA_CONFIG_DIR: join(sandboxRoot, "config"),
  CARTETHYIA_DATA_DIR: join(sandboxRoot, "data"),
  CARTETHYIA_TELEMETRY_PAYLOAD_DIR: join(sandboxRoot, "data", "telemetry-payloads"),
  HOME: join(sandboxRoot, "home"),
  USERPROFILE: join(sandboxRoot, "home"),
});

// A generated throwaway key when the environment carries none. `.env` is
// gitignored, so CI has no `CARTETHYIA_ENCRYPTION_KEY` at all, and every test
// that seals a credential then died with "CARTETHYIA_ENCRYPTION_KEY is
// required" — a missing fixture, not a defect. One key per run, and it never
// touches the operator's real one: an explicit variable still wins.
if (!sharedEnv.CARTETHYIA_ENCRYPTION_KEY?.trim()) {
  sharedEnv.CARTETHYIA_ENCRYPTION_KEY = generateCartethyiaEncryptionKey();
}

/**
 * One `bun test` invocation.
 *
 * `paths` are the explicit test roots for the scope. They are what keeps the
 * scopes disjoint; see the header comment. `cwd` still matters because each tree
 * has its own `tsconfig.json` and dependency resolution (the dashboard has its
 * own `package.json`).
 *
 * Parallelism is capped so the suite does not pin every core (Bun 1.4+ uses
 * all CPUs by default). We use at most `TEST_MAX_JOBS` (4) regardless of the
 * machine, and `CARTETHYIA_TEST_JOBS` overrides it. The runner stays responsive
 * while tests run.
 */
const TEST_MAX_JOBS = 4;
const testJobs = (() => {
  const raw = process.env.CARTETHYIA_TEST_JOBS?.trim();
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  return Math.min(availableParallelism(), TEST_MAX_JOBS);
})();

function runTests(cwd: string, label: string, paths: readonly string[]): Promise<number> {
  const proc = Bun.spawn(
    [
      "bun",
      "test",
      ...(watch ? ["--watch"] : []),
      "--timeout",
      "15000",
      `--parallel=${testJobs}`,
      ...paths,
      ...testArgs,
    ],
    {
      cwd,
      env: { ...sharedEnv, ...mergedExtraCaCerts() },
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  return proc.exited.then((code) => {
    if (code !== 0) console.error(`[test] ${label} failed with exit code ${code}`);
    return code;
  });
}

let exitCode = 0;
try {
  if (scope === "all" || scope === "backend") {
    exitCode = await runTests(PROJECT_ROOT, "backend", DEFAULT_BACKEND_TESTS);
  }
  if (exitCode === 0 && (scope === "all" || scope === "dashboard")) {
    exitCode = await runTests(DASHBOARD_ROOT, "dashboard", [DASHBOARD_TESTS]);
  }
  // Backend already includes test/cli; the standalone scripts scope exists so
  // CLI work can be run without the rest of the backend suite.
  if (exitCode === 0 && scope === "scripts") {
    exitCode = await runTests(PROJECT_ROOT, "scripts", [SCRIPTS_TESTS]);
  }
  if (exitCode === 0 && scope === "integration") {
    exitCode = await runTests(PROJECT_ROOT, "integration", [INTEGRATION_TESTS]);
  }
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
process.exitCode = exitCode;
