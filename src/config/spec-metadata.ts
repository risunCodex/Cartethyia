/**
 * Shared metadata for config docs and tests.
 *
 * `CONFIG_SPEC` declares the gateway's spec-driven variables. These constants
 * name the deliberate asymmetries around it so `.env.example`, the generated
 * reference, and the drift tests all project the same exception lists.
 */

/** Keys in `CONFIG_SPEC` that are intentionally absent from `.env.example`. */
export const SPEC_ONLY_ENV_EXAMPLE_KEYS: Readonly<Record<string, true>> = {
  // Setup wizard writes this directly; a sample would mislead copy/paste.
  CARTETHYIA_API_KEY: true,
  // Opt-in diagnostics; sampling them would nudge operators to enable them.
  CARTETHYIA_FORCED_GC: true,
  CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS: true,
  // Advanced knobs documented in the generated configuration reference.
  CARTETHYIA_DISABLED_TASKS: true,
  // Install-identity directory; only operators who need a stable identity
  // across restarts touch it, and the reference covers it.
  CARTETHYIA_INSTALL_ID_DIR: true,
  CARTETHYIA_OAUTH_CALLBACK_PORT: true,
  // Provider-specific overrides. Readers live in `src/config/providers.ts`;
  // the majority of installs do not need them in the starter sample.
  CARTETHYIA_KIMI_OAUTH_HOST: true,
  CARTETHYIA_KIMI_QUOTA_BASE_URL: true,
  CARTETHYIA_GITHUB_ENTERPRISE_DOMAIN: true,
  CARTETHYIA_OPENCODE_UNAVAILABLE_FREE: true,
  // Telemetry retention is deployment-level and documented in the reference.
  CARTETHYIA_TELEMETRY_RETENTION_DAYS: true,
  CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES: true,
};

/** Keys in `.env.example` that `CONFIG_SPEC` does not declare. */
export const ENV_EXAMPLE_ONLY_KEYS: Readonly<Record<string, true>> = {
  // Read outside `src/config/` by their owning modules.
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
  // Test-runner-only knob, not read by the gateway runtime.
  CARTETHYIA_TEST_JOBS: true,
};

/**
 * Operator-visible variables that are intentionally outside `CONFIG_SPEC` and
 * therefore omitted from the generated configuration reference.
 */
export const CONFIG_REFERENCE_EXTERNAL_VARIABLES = [
  "CARTETHYIA_DB_MODE",
  "DATABASE_URL",
  "REDIS_URL",
  "NODE_ENV",
  "LOG_LEVEL",
  "DATABASE_POOL_MAX",
  "DATABASE_POOL_IDLE_FLOOR",
  "CARTETHYIA_DATA_DIR",
  "CARTETHYIA_TELEMETRY_PAYLOAD_DIR",
  "CARTETHYIA_CONFIG_DIR",
  "DASHBOARD_PORT",
  "VITE_BACKEND_URL",
  "CARTETHYIA_TEST_DATABASE_URL",
  "CARTETHYIA_TEST_JOBS",
  "CARTETHYIA_REDIS_URL",
] as const;
