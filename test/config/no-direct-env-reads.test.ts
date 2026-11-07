/**
 * Direct `process.env.CARTETHYIA_*` reads need an allowlist entry.
 *
 * The policy — stated at the top of `src/config/spec.ts` — is that
 * `CONFIG_SPEC` is the canonical declaration for every environment variable
 * `src/config/` reads, and that module-specific reads that affect a single
 * subsystem may still live next to their consumer. In practice that leaves
 * two legitimate shapes of direct read:
 *
 * 1. Spec readers: `spec.ts` reads `process.env.<KEY>` through its own
 *    helpers. The file that defines the spec is excluded by construction.
 * 2. Module-local knobs: one subsystem's operator override that no other
 *    file touches. These bypass the spec deliberately — adding them to the
 *    spec would advertise a flag that is meaningless for the rest of the
 *    gateway.
 *
 * What this test guards is the drift between those shapes and the easier
 * third: a feature grows an env knob, reads it from wherever, forgets to
 * document it, and the operator learns about it from a stack trace. The
 * ALLOW list below names each (file, variable) tuple that is deliberately
 * module-local, with a one-line reason. Any new direct read fails here; the
 * reviewer must either declare it in `CONFIG_SPEC` or add an entry here and
 * explain why.
 *
 * Scripts (install, setup, CLI boot) are excluded — they run on the operator
 * side of the boundary, before the gateway starts, and the spec's audience is
 * "code the gateway runs," not "the installer." Those paths are listed in
 * SCRIPT_PREFIXES below for the same reason.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

const SPEC_FILE: string = join("src", "config", "spec.ts");

/** Script trees that run outside the gateway process. */
const SCRIPT_PREFIXES: readonly string[] = [
  `scripts${sep}cli${sep}`,
  `scripts${sep}install${sep}`,
  `scripts${sep}build${sep}`,
  `scripts${sep}test${sep}`,
  `scripts${sep}tools${sep}`,
];

/**
 * Deliberate module-local env reads inside the gateway.
 *
 * Shape: `relative/path/with/forward/slashes.ts` -> { VAR_NAME: reason }.
 * The path is normalized to forward slashes before lookup, so the key is
 * platform-independent. A new direct read fails this test unless its tuple
 * is added here; the reason field makes the review deliberate.
 */
const ALLOW_LIST: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "src/config/package-paths.ts": {
    // Bootstrap: resolved before the spec is loaded, used to find the
    // installed root of the package from which other paths derive.
    CARTETHYIA_PACKAGE_ROOT: "boot-time path resolution, pre-spec",
  },
  "src/config/providers.ts": {
    // Opt-in operator override; declared in CONFIG_SPEC as a list kind, but
    // parsed with per-value semantics (`none` sentinel, empty→undefined)
    // that the generic list reader does not expose.
    CARTETHYIA_OPENCODE_UNAVAILABLE_FREE: "custom list semantics beyond generic reader",
  },
  "src/config/runtime.ts": {
    // One-shot sentinel the install script sets to mark a source run; not an
    // operator-tunable knob, so it is not sampled in `.env.example` either.
    CARTETHYIA_SOURCE_RUN: "install-script sentinel, not an operator knob",
    // Read raw for PRESENCE, not value: with a process count above one, an
    // absent index must fail rather than default to 0 — the spec's int reader
    // cannot distinguish "absent" from "explicitly 0". The value itself is
    // still read through the spec.
    CARTETHYIA_PROCESS_INDEX: "presence check; absent must error, not default to 0",
  },
  "src/observability/payload-capture.ts": {
    // Telemetry subsystem knob; the retention value is also in `.env.example`
    // and read directly here because the capture module is otherwise pure.
    CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS: "telemetry subsystem local override",
  },
  "src/observability/payload-store.ts": {
    // Same telemetry subsystem; keeping both reads next to the storage layer
    // avoids leaking telemetry paths into the generic config surface.
    CARTETHYIA_TELEMETRY_PAYLOAD_DIR: "telemetry storage path override",
    CARTETHYIA_TELEMETRY_PAYLOAD_FILE_MAX_BYTES: "telemetry file-size override",
  },
  "src/providers/integrations/buddy/buddy-identity.ts": {
    // Buddy device-token file path, injected by the deployment image, not an
    // operator-facing knob — kept in the integration so it is reviewed with
    // the rest of the buddy credential surface.
    CARTETHYIA_DEVICE_TOKEN_FILE: "buddy device-token file path, deployment-level injection",
  },
  "src/providers/integrations/qoder/qoder-umid.ts": {
    // Deployment-level bridge override: force/disable the mini-ELF UMID
    // bundle on Linux (containers auto-detect). Read directly in the bridge
    // because it decides which binary to spawn at mint time.
    CARTETHYIA_QODER_UMID_MINI: "UMID bridge mode override (1=mini, 0=native, absent=auto)",
  },
  "src/providers/integrations/cursor/cursor.ts": {
    // Cursor heartbeat tuning; subsystem-specific, only meaningful if the
    // operator is debugging the cursor transport.
    CARTETHYIA_CURSOR_HEARTBEAT_MS: "cursor transport heartbeat override",
  },
  "src/console/cli-tools/cartethyia-websearch-plugin.ts": {
    // OpenCode websearch plugin generation: operator overrides for the
    // generated plugin's gateway URL/key/backend. Only read at plugin-write
    // time (CLI-tools apply), not by gateway request paths — they live next to
    // the plugin generator so the generated file stays self-contained.
    CARTETHYIA_SEARCH_URL: "opencode websearch plugin gateway URL override",
    CARTETHYIA_SEARCH_API_KEY: "opencode websearch plugin API key override",
    CARTETHYIA_SEARCH_BACKEND: "opencode websearch plugin backend override (exa/parallel)",
  },
};

/** Walk a directory, yielding every .ts/.tsx file path relative to repo root. */
function walkTs(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(current, name);
      let kind: Stats;
      try {
        kind = statSync(full);
      } catch {
        continue;
      }
      if (kind.isDirectory()) {
        if (name === "node_modules" || name === ".codegen-stamp") continue;
        stack.push(full);
      } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Normalize a path's separators to `/` for allowlist lookup. */
function forwardSlash(path: string): string {
  return path.split(sep).join("/");
}

const ENV_READ_PATTERN = /process\.env(?:\.|\[["'])(CARTETHYIA_[A-Z0-9_]+)/g;

function isScriptPath(rel: string): boolean {
  for (const prefix of SCRIPT_PREFIXES) {
    if (rel.startsWith(prefix)) return true;
  }
  return false;
}

interface Finding {
  readonly file: string;
  readonly variable: string;
  readonly line: number;
}

function collectDirectReads(): Finding[] {
  const findings: Finding[] = [];
  for (const file of walkTs("src")) {
    const rel = relative(".", file);
    if (rel === SPEC_FILE) continue;
    const text = readFileSync(file, "utf8");
    ENV_READ_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(ENV_READ_PATTERN)) {
      const variable = match[1];
      if (variable === undefined) continue;
      const offset = match.index ?? 0;
      const line = text.slice(0, offset).split(/\r?\n/).length;
      findings.push({ file: forwardSlash(rel), variable, line });
    }
  }
  return findings;
}

test("every direct process.env.CARTETHYIA_* read in src/ is allowlisted", () => {
  const findings = collectDirectReads();
  const unexpected: Finding[] = [];
  for (const finding of findings) {
    if (isScriptPath(finding.file)) continue;
    const perFile = ALLOW_LIST[finding.file];
    if (perFile?.[finding.variable] === undefined) {
      unexpected.push(finding);
    }
  }
  expect(unexpected).toEqual([]);
});

test("the allowlist does not name a (file, variable) tuple that no longer exists", () => {
  const findings = collectDirectReads();
  const live = new Set<string>();
  for (const finding of findings) {
    live.add(`${finding.file}::${finding.variable}`);
  }
  const stale: string[] = [];
  for (const [file, perFile] of Object.entries(ALLOW_LIST)) {
    for (const variable of Object.keys(perFile)) {
      if (!live.has(`${file}::${variable}`)) {
        stale.push(`${file}::${variable}`);
      }
    }
  }
  expect(stale).toEqual([]);
});
