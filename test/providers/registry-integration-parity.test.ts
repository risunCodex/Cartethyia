/**
 * The provider registry declares a lazy loader for every capability it
 * exposes. This test runs each loader and asserts the imported file resolves,
 * the named export exists, and the exported value is the shape the registry
 * promises. It also asserts there is no orphan integration file — a module
 * under `src/providers/integrations/` that no registry entry imports.
 *
 * The reason this file was written is operational: in 2.5.8 and 2.5.9 we
 * shipped `cline` and `kiro` entries whose loaders referenced the right file
 * but the wrong named export. The adapter loaded; the model-discovery loader
 * threw at first request with a `TypeError: undefined is not a function` that
 * reached the operator as a 500 the dashboard could not explain. A tsc pass
 * does not catch this because the registry's loader returns `unknown` cast
 * through the `oauthCapability` / `quotaCapability` helpers; only a real
 * `await` sees the missing export. This test does the awaits.
 *
 * Orphan detection is the other half: every file under `integrations/` is
 * either imported by a registry entry (directly or transitively) or has a
 * documented reason to exist on its own (shared helpers, catalogs the entry
 * reads lazily). The ORPHAN_ALLOWLIST below names each deliberate exception.
 */
import { expect, test } from "bun:test";
import { readdirSync, statSync, type Stats } from "node:fs";
import { join, sep } from "node:path";
import { PROVIDER_CAPABILITIES } from "../../src/providers/default-registry";
import type { ProviderModuleCapabilities } from "../../src/providers/provider-registry";

const INTEGRATION_ROOT = join("src", "providers", "integrations");

/**
 * Files under `integrations/` that no registry entry imports directly.
 *
 * Each entry is deliberate: either a shared helper imported by sibling files
 * in the same integration, or a catalog data file loaded by the integration's
 * own code rather than the registry. A new orphan fails here and the reviewer
 * must either wire it into the registry or add a tuple with a reason.
 */
const ORPHAN_ALLOWLIST: Readonly<Record<string, string>> = {
  // Codegen stamp written by the model-roster regenerator; not source.
  "src/providers/integrations/.codegen-stamp": "codegen marker",
  // Gateway-executed web-tool engine for the Buddy family. Pure engine with
  // no adapter consumer yet: the streaming re-drive loop that consumes it is
  // the next integration step, so it is not reachable from a registry
  // entrypoint today.
  "src/providers/integrations/buddy/buddy-server-tools.ts":
    "server-tools engine; adapter stream loop wiring pending",
};

/** Walk a directory, yielding every regular file path. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      return out;
    }
    for (const name of entries) {
      const full = join(current, name);
      let kind: Stats;
      try {
        kind = statSync(full);
      } catch {
        continue;
      }
      if (kind.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

function forwardSlash(path: string): string {
  return path.split(sep).join("/");
}

test("every provider's declared loaders resolve and return the promised shape", async () => {
  const failures: Array<{ provider: string; capability: string; error: string }> = [];
  for (const [providerId, raw] of Object.entries(PROVIDER_CAPABILITIES)) {
    const capabilities = raw as ProviderModuleCapabilities;
    try {
      const adapter = await capabilities.loadAdapter();
      if (adapter === undefined || adapter === null) {
        failures.push({ provider: providerId, capability: "loadAdapter", error: "returned undefined/null" });
      }
    } catch (error) {
      failures.push({ provider: providerId, capability: "loadAdapter", error: String(error) });
    }
    if (capabilities.loadModels !== undefined) {
      try {
        const models = await capabilities.loadModels();
        if (!Array.isArray(models)) {
          failures.push({ provider: providerId, capability: "loadModels", error: `not an array: ${typeof models}` });
        }
      } catch (error) {
        failures.push({ provider: providerId, capability: "loadModels", error: String(error) });
      }
    }
    if (capabilities.loadAuthentication !== undefined) {
      try {
        const auth = await capabilities.loadAuthentication();
        if (auth === undefined || auth === null) {
          failures.push({ provider: providerId, capability: "loadAuthentication", error: "returned undefined/null" });
        }
      } catch (error) {
        failures.push({ provider: providerId, capability: "loadAuthentication", error: String(error) });
      }
    }
    if (capabilities.loadQuotaCollector !== undefined) {
      try {
        const quota = await capabilities.loadQuotaCollector();
        if (typeof quota !== "function") {
          failures.push({ provider: providerId, capability: "loadQuotaCollector", error: `not a function: ${typeof quota}` });
        }
      } catch (error) {
        failures.push({ provider: providerId, capability: "loadQuotaCollector", error: String(error) });
      }
    }
    if (capabilities.loadModelDiscovery !== undefined) {
      try {
        const discovery = await capabilities.loadModelDiscovery();
        if (typeof discovery !== "function") {
          failures.push({ provider: providerId, capability: "loadModelDiscovery", error: `not a function: ${typeof discovery}` });
        }
      } catch (error) {
        failures.push({ provider: providerId, capability: "loadModelDiscovery", error: String(error) });
      }
    }
  }
  expect(failures).toEqual([]);
});

test("no file under integrations/ is orphaned from the registry's import graph", async () => {
  const files = walkFiles(INTEGRATION_ROOT).filter(
    (file) => file.endsWith(".ts") || file.endsWith(".tsx"),
  );
  // Reachability from the full gateway surface, not just the registry:
  // several integration files (buddy quota/activity/telemetry) are consumed
  // by `src/console/` and `src/workers/` rather than by a registry loader.
  // Those are legitimate; the drift this guards is a file nobody imports.
  //
  // We seed from the gateway entrypoints and walk every static and dynamic
  // import specifier under `src/`, then flag any integration file that was
  // not visited.
  const seen = new Set<string>();
  const queue: string[] = [
    join("src", "providers", "default-registry.ts"),
    join("src", "main.ts"),
    join("src", "console", "quota", "account-quota-tenant.ts"),
    join("src", "workers", "buddy-growth-tasks.ts"),
    join("src", "workers", "daily-checkin.ts"),
  ];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    if (seen.has(current)) continue;
    seen.add(current);
    let text: string;
    try {
      text = await Bun.file(current).text();
    } catch {
      continue;
    }
    // Match static `from "..."`, static `import "..."`, and
    // `await import("...")` / `import("...")` specifiers.
    const specifierPattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g;
    for (const match of text.matchAll(specifierPattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (!specifier.startsWith(".") && !specifier.startsWith("src/")) continue;
      const dir = current.split(sep).slice(0, -1).join(sep);
      const base = specifier.startsWith(".") ? join(dir, specifier) : specifier;
      for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        try {
          if (statSync(candidate).isFile()) {
            queue.push(candidate);
            break;
          }
        } catch {
          // not this candidate; try next
        }
      }
    }
  }
  const reachable = new Set<string>();
  for (const path of seen) reachable.add(forwardSlash(path));
  const orphans: string[] = [];
  for (const file of files) {
    const rel = forwardSlash(file);
    if (reachable.has(rel)) continue;
    if (ORPHAN_ALLOWLIST[rel] !== undefined) continue;
    orphans.push(rel);
  }
  expect(orphans).toEqual([]);
});
