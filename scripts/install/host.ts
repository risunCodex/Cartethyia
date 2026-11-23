import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { statSync } from "node:fs";
import { pidAlive } from "../../src/shared/process";

export interface HostResult { code: number; stdout: string; stderr: string; }
export interface HostExecutor {
  run(args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; redact?: readonly string[] }): Promise<HostResult>;
  exists(path: string): Promise<boolean>;
  writeAtomic(path: string, content: string, mode?: number): Promise<void>;
  platform: NodeJS.Platform;
}
export const hostExecutor: HostExecutor = {
  platform: process.platform,
  async run(args, options = {}) {
    if (args.length === 0) throw new Error("Refusing to execute an empty command");
    const child = Bun.spawn([...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 120_000,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const redact = (text: string) => (options.redact ?? []).reduce((value, secret) => secret ? value.replaceAll(secret, "[redacted]") : value, text);
    if (code !== 0) throw new Error(`${args[0]} failed with exit code ${code}: ${redact(stderr || stdout).slice(-2_000)}`);
    return { code, stdout, stderr };
  },
  async exists(path) {
    try { statSync(path); return true; } catch { return false; }
  },
  async writeAtomic(path, content, mode = 0o600) {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, content, { mode, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  },
};
export function sudoExecutor(host: HostExecutor): HostExecutor {
  return {
    ...host,
    run: (args, options) => host.run(["sudo", "-n", "--", ...args], options),
    writeAtomic: async (path, content, mode = 0o600) => {
      const dir = await mkdtemp(join(tmpdir(), "carte-sudo-write-"));
      const temporary = join(dir, "content");
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
        const remote = `${path}.${process.pid}.tmp`;
        await host.run(["sudo", "-n", "--", "install", "-m", mode.toString(8), temporary, remote]);
        await host.run(["sudo", "-n", "--", "mv", remote, path]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
export async function acquireInstallLock(root: string): Promise<() => Promise<void>> {
  const path = join(root, ".install.lock");
  await mkdir(root, { recursive: true });
  const existing = await readFile(path, "utf8").catch(() => "");
  if (existing) {
    let pid = 0;
    try { pid = Number(JSON.parse(existing).pid); } catch { pid = 0; }
    if (pidAlive(pid)) throw new Error(`Another Cartethyia installation is running (PID ${pid})`);
    await rm(path, { force: true });
  }
  try {
    await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another installation acquired the lock; retry after it finishes");
    throw error;
  }
  return async () => { await rm(path, { force: true }); };
}
export function environment(env: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}
