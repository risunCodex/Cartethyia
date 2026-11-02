import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Absolute root containing package assets. A compiled Bun executable has a
 * virtual `import.meta.dir`, so deployments can point this at the shipped
 * assets directory explicitly.
 */
function resolvePackageRoot(
  moduleDir: string,
  configuredRoot: string | undefined,
): string {
  const root = configuredRoot?.trim();
  return root ? resolve(root) : resolve(moduleDir, "..", "..");
}

export const PACKAGE_ROOT = resolvePackageRoot(
  import.meta.dir,
  process.env.CARTETHYIA_PACKAGE_ROOT,
);

/** Resolve an asset shipped with the package. */
export function resolvePackagePath(...segments: string[]): string {
  return resolve(PACKAGE_ROOT, ...segments);
}

/** Outfile `bun build --compile` writes when no `--outfile` is given. */
export const DEFAULT_BINARY_OUTFILE = "dist/cartethyia";

/**
 * The artifact path `bun build --compile` actually writes for `outfile`.
 *
 * Bun appends `.exe` when it compiles for Windows, so the extensionless
 * `dist/cartethyia` handed to it never exists on that platform. This is the one
 * place that knows where the compiled binary lands; `scripts/build/` resolves
 * its target from here instead of re-deriving the name, because a launcher that
 * probed the requested path reported "run bun run build first" immediately
 * after a successful build.
 *
 * It sits in `src/config/` rather than `scripts/build/` because the launcher
 * ships in the npm package and `scripts/build/` does not: a shipped module that
 * imported the build script crashed every installed copy of `carte` with
 * `Cannot find module '../build/compile'`.
 */
export function compiledBinaryPath(outfile: string = DEFAULT_BINARY_OUTFILE): string {
  return process.platform === "win32" && !outfile.toLowerCase().endsWith(".exe")
    ? `${outfile}.exe`
    : outfile;
}

/** User-writable directory for the npm-installed CLI's configuration. */
export function resolveUserConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const appData = env.APPDATA?.trim();
    return appData ? resolve(appData, "Cartethyia") : resolve(homedir(), ".cartethyia");
  }
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Cartethyia");
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  return xdgConfigHome
    ? resolve(xdgConfigHome, "Cartethyia")
    : resolve(homedir(), ".config", "Cartethyia");
}
