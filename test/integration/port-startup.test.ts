import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePackagePath } from "../../src/config/package-paths";
import { probeListenPort, blockedPortMessage, startupFailureMessage } from "../../scripts/cli/port";
import { gatewayExecutable, startGateway } from "../../scripts/cli/gateway";
import { install } from "../../scripts/install/install";
import { parseInstallArgs } from "../../scripts/install/plan";
import type { HostExecutor } from "../../scripts/install/host";

let blocker: Server | null = null;
const blockerSockets = new Set<Socket>();
let configDir: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "carte-port-startup-"));
  previousConfigDir = process.env.CARTETHYIA_CONFIG_DIR;
  process.env.CARTETHYIA_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (blocker) {
    for (const socket of blockerSockets) socket.destroy();
    blockerSockets.clear();
    await new Promise<void>((resolve) => blocker!.close(() => resolve()));
  }
  blocker = null;
  if (previousConfigDir === undefined) delete process.env.CARTETHYIA_CONFIG_DIR;
  else process.env.CARTETHYIA_CONFIG_DIR = previousConfigDir;
  await rm(configDir, { recursive: true, force: true });
});

async function occupy(): Promise<number> {
  blocker = createServer();
  blocker.on("connection", (socket) => {
    blockerSockets.add(socket);
    socket.on("close", () => blockerSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    blocker!.once("error", reject);
    blocker!.listen({ port: 0, host: "0.0.0.0", exclusive: true }, () => resolve());
  });
  const address = blocker.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

test("bind preflight rejects a custom port with no HTTP health response", async () => {
  const port = await occupy();
  const probe = await probeListenPort(port);
  expect(probe).toEqual({ status: "blocked", code: "EADDRINUSE" });
});

test("carte refuses a non-HTTP port blocker before spawning a gateway", async () => {
  const port = await occupy();
  await expect(startGateway(port, "test-token")).rejects.toThrow(
    new RegExp(`port ${port} is already in use[\\s\\S]*change PORT[\\s\\S]*${configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  expect(blockedPortMessage(port)).toContain("No process was stopped");
});

test("a TypeScript gateway override launches through Bun with the real package root", async () => {
  const executable = await gatewayExecutable("src/main.ts");
  expect(executable[0]).toBe(process.execPath);
  expect(executable[1]).toBe("run");
  expect(executable[2]).toBe(resolvePackagePath("src", "main.ts"));
  expect(Bun.file(executable[2]!).exists()).resolves.toBe(true);
});

test("installer rejects a blocked custom port before host mutation or install lock", async () => {
  const root = join(configDir, "install");
  const calls: string[][] = [];
  const host: HostExecutor = {
    platform: "linux",
    run: async (args) => { calls.push([...args]); return { code: 0, stdout: "", stderr: "" }; },
    exists: async (path) => { try { statSync(path); return true; } catch { return false; } },
    writeAtomic: async () => undefined,
  };
  const port = 18081;
  const request = parseInstallArgs([
    "--non-interactive", "--local", "--lite", "--port", String(port), "--root", root,
  ]);
  await expect(install(request, host, {
    probePort: async () => ({ status: "blocked", code: "EADDRINUSE" }),
    ownedGateway: async () => false,
  })).rejects.toThrow(/custom port[\s\S]*already in use[\s\S]*change PORT/);
  expect(calls).toEqual([]);
  expect(await Bun.file(join(root, ".install.lock")).exists()).toBe(false);
});

test("installer allows a healthy owned gateway on rerun", async () => {
  const root = join(configDir, "install");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "true" } }));
  const calls: string[][] = [];
  const host: HostExecutor = {
    platform: "linux",
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "sh") return { code: 0, stdout: "0\n", stderr: "" };
      if (args[0] === "apt-get") return { code: 0, stdout: "apt\n", stderr: "" };
      if (args[0] === "git") return { code: 0, stdout: "", stderr: "" };
      throw new Error("command failed");
    },
    exists: async (path) => { try { statSync(path); return true; } catch { return false; } },
    writeAtomic: async () => undefined,
  };
  const request = parseInstallArgs([
    "--non-interactive", "--local", "--lite", "--port", "18082", "--root", root,
  ]);
  await expect(install(request, host, {
    probePort: async () => ({ status: "blocked", code: "EADDRINUSE" }),
    ownedGateway: async () => true,
  })).rejects.toThrow("command failed");
  expect(calls).toContainEqual(["bun", "install", "--linker", "isolated", "--frozen-lockfile"]);
});

test("an early gateway crash includes its own actionable log detail", async () => {
  const log = join(configDir, "gateway.log");
  await writeFile(log, "boot\nError: CARTETHYIA_DB_MODE is required; choose lite or full.\n");
  const message = startupFailureMessage(18083, 1, log);
  expect(message).toContain("port 18083");
  expect(message).toContain("CARTETHYIA_DB_MODE is required");
  expect(message).toContain("cartethyia doctor");
  expect(message).toContain(log);
});

test("startup log formatting keeps the cause inside a long bundled error line", async () => {
  const log = join(configDir, "gateway.log");
  await writeFile(log, `${"x".repeat(600)}Error: EADDRINUSE: address already in use 0.0.0.0:18084`);
  const message = startupFailureMessage(18084, 1, log);
  expect(message).toContain("EADDRINUSE");
  expect(message).toContain("already in use");
  expect(message.length).toBeLessThan(3_000);
});

test("bun run honors a saved custom port and exits with actionable blocked-port guidance", async () => {
  const port = await occupy();
  await writeFile(join(configDir, ".env"),
    `CARTETHYIA_DB_MODE=lite\nCARTETHYIA_ENCRYPTION_KEY=${"a".repeat(64)}\nPORT=${port}\nCARTETHYIA_DATA_DIR=${join(configDir, "data")}\n`);
  const env = { ...process.env };
  delete env.PORT;
  const child = Bun.spawn([process.execPath, "run", "scripts/cli/main.ts", "menu"], {
    cwd: resolve(import.meta.dir, "..", ".."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(stderr).toContain(`port ${port} is already in use`);
  expect(stderr).toContain(`change PORT in ${join(configDir, ".env")}`);
  expect(stderr).toContain("CARTETHYIA_PUBLIC_ORIGIN");
});
