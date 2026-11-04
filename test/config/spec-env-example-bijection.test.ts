/**
 * `.env.example` and `CONFIG_SPEC` must agree.
 *
 * The spec is the canonical declaration of every variable `src/config/`
 * reads; `.env.example` is what an operator copies to `.env` as their
 * starting point. When the two drift, the operator ends up either (a) with a
 * knob the code does not honor (`.env.example` ahead of spec), (b) without a
 * knob the code uses (`.env.example` behind spec), or (c) with a value that
 * is strictly worse than the shipped default (same key, different numbers).
 *
 * Case (c) is the one this file was written for: 2.5.10 shipped with
 * `UPSTREAM_TIMEOUT_MS=75000` and `ACCOUNT_UNCLASSIFIED_COOLDOWN_MS=900000`
 * in the spec and 120000/60000 in the sample — an operator who copied
 * `.env.example` ended up with a configuration the maintainers had explicitly
 * documented as inferior. A tsc pass could not see it; a bijection test can.
 *
 * The two allowlists below name what is deliberately asymmetric:
 * - `SPEC_ONLY_KEYS`: declared in the spec but intentionally not sampled in
 *   `.env.example`. These are either keys the operator should discover through
 *   the reference doc (`CARTETHYIA_FORCED_GC`, `CARTETHYIA_DISABLED_TASKS`) or
 *   keys the setup wizard writes directly (`CARTETHYIA_API_KEY`).
 * - `ENV_EXAMPLE_ONLY_KEYS`: not in `CONFIG_SPEC` because they are read
 *   outside `src/config/` (logger level, Postgres pool tuning, dashboard
 *   build) or are consumed by scripts/tests rather than the gateway.
 *
 * Any new drift fails here. The allowlist is the deliberate exception list;
 * widening it is the review surface.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_SPEC, type ConfigEntry } from "../../src/config/spec";

/** Keys in CONFIG_SPEC that are deliberately absent from `.env.example`. */
const SPEC_ONLY_KEYS: Readonly<Record<string, true>> = {
  // Setup wizard writes this directly; sample would mislead a copy-paste.
  CARTETHYIA_API_KEY: true,
  // Opt-in diagnostics; sampling would nudge operators to enable them.
  CARTETHYIA_FORCED_GC: true,
  CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS: true,
  // Advanced knobs documented in `documentation/reference/configuration.md`.
  CARTETHYIA_DISABLED_TASKS: true,
  // Install-identity directory; only hosters who need a stable identity across
  // restarts touch it, and the reference doc covers it.
  CARTETHYIA_INSTALL_ID_DIR: true,

  CARTETHYIA_OAUTH_CALLBACK_PORT: true,
  // Provider-specific overrides. Readers live in `src/config/providers.ts`;
  // every operator who needs one goes through the reference doc, and sampling
  // them in `.env.example` would advertise flags the vast majority of
  // installs do not care about.
  CARTETHYIA_KIMI_OAUTH_HOST: true,
  CARTETHYIA_KIMI_QUOTA_BASE_URL: true,
  CARTETHYIA_GITHUB_ENTERPRISE_DOMAIN: true,
  CARTETHYIA_OPENCODE_UNAVAILABLE_FREE: true,
  // Telemetry retention baseline. Tenants override from the Settings panel;
  // the deployment-level knob stays in CONFIG_SPEC but is doc-only.
  CARTETHYIA_TELEMETRY_RETENTION_DAYS: true,
  CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES: true,
};

/** Keys in `.env.example` that `CONFIG_SPEC` does not declare. */
const ENV_EXAMPLE_ONLY_KEYS: Readonly<Record<string, true>> = {
  // Read outside src/config/ by their domain modules.
  CARTETHYIA_DB_MODE: true,
  NODE_ENV: true,
  LOG_LEVEL: true,
  DATABASE_URL: true,
  DATABASE_POOL_MAX: true,
  DATABASE_POOL_IDLE_FLOOR: true,
  REDIS_URL: true,
  CARTETHYIA_DATA_DIR: true,
  CARTETHYIA_TELEMETRY_PAYLOAD_DIR: true,
  CARTETHYIA_CONFIG_DIR: true,
  DASHBOARD_PORT: true,
  VITE_BACKEND_URL: true,
  // Read by scripts/test/run.ts (test-only runner knob), not src/config.
  CARTETHYIA_TEST_JOBS: true,
};

const envExamplePath = resolve(process.cwd(), ".env.example");
const envExampleText = readFileSync(envExamplePath, "utf8");

/** Parse `KEY=value` lines in `.env.example`, honoring the commented samples. */
function parseEnvExample(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lineRegex = /^\s*#?\s*([A-Z][A-Z0-9_]*)=([^\s#]*)/;
  for (const raw of text.split(/\r?\n/)) {
    const match = lineRegex.exec(raw);
    if (match === null) continue;
    const [, key, value] = match;
    if (key === undefined) continue;
    entries.set(key, value ?? "");
  }
  return entries;
}

const envExampleEntries = parseEnvExample(envExampleText);
const envExampleKeys = new Set(envExampleEntries.keys());
const specKeys = new Set(Object.keys(CONFIG_SPEC));

test("every spec key is sampled in .env.example (modulo allowlist)", () => {
  const missing = [...specKeys].filter(
    (key) => !envExampleKeys.has(key) && SPEC_ONLY_KEYS[key] !== true,
  );
  expect(missing).toEqual([]);
});

test("every .env.example key is declared in the spec (modulo allowlist)", () => {
  const extra = [...envExampleKeys].filter(
    (key) => !specKeys.has(key) && ENV_EXAMPLE_ONLY_KEYS[key] !== true,
  );
  expect(extra).toEqual([]);
});

test("the allowlists only name keys that actually exist on their side", () => {
  // A spec-only allowlist entry that is also in .env.example (or vice versa)
  // means the key moved and the allowlist went stale. Catch here, not later.
  const stale_spec_only = Object.keys(SPEC_ONLY_KEYS).filter(
    (key) => !specKeys.has(key) || envExampleKeys.has(key),
  );
  const stale_env_only = Object.keys(ENV_EXAMPLE_ONLY_KEYS).filter(
    (key) => !envExampleKeys.has(key) || specKeys.has(key),
  );
  expect(stale_spec_only).toEqual([]);
  expect(stale_env_only).toEqual([]);
});

test("shared keys with a spec default agree with the .env.example sample", () => {
  const drifts: Array<{ key: string; spec: unknown; env: string }> = [];
  for (const key of specKeys) {
    if (!envExampleKeys.has(key)) continue;
    const entry = CONFIG_SPEC[key as keyof typeof CONFIG_SPEC] as ConfigEntry;
    const sampled = envExampleEntries.get(key);
    if (sampled === undefined || sampled === "") continue;
    switch (entry.kind) {
      case "int": {
        const parsed = Number(sampled);
        if (Number.isFinite(parsed) && parsed !== entry.default) {
          drifts.push({ key, spec: entry.default, env: sampled });
        }
        break;
      }
      case "text": {
        if (sampled !== entry.default) {
          drifts.push({ key, spec: entry.default, env: sampled });
        }
        break;
      }
      // optional-int, optional-text, required, flag, list: no fixed default
      // to compare, or an operator-supplied value is expected rather than a
      // literal match. The symmetric-diff tests above still cover presence.
      default:
        break;
    }
  }
  expect(drifts).toEqual([]);
});
