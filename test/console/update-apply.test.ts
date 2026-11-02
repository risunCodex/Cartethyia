/**
 * The detached update flow: the status file contract, the double-apply guard,
 * and the drain-before-exit sequencing.
 *
 * The apply route is the one destructive path in the console — it exits the
 * process — so what is pinned here is the sequencing around that exit: the
 * intent file is written before the spawn, a fresh `installing` status refuses
 * a second apply, and the shutdown coordinator's `begin("update")` completes
 * before `process.exit` runs. The spawn itself is injected, because a test that
 * really spawned `npm install -g` would be an integration test of npm.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTALLING_FRESH_MS,
  isFreshlyInstalling,
  readUpdateStatus,
  writeUpdateStatus,
  finishDetachedUpdate,
} from "../../src/console/updates/apply-update";
import { createUpdateRoutes } from "../../src/console/updates/routes";
import { ConsoleDomainError } from "../../src/console/shared/errors";

describe("update status file round-trip", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "update-status-"));
    dirs.push(dir);
    return dir;
  };

  test("write then read returns the identical status", () => {
    const dir = tmp();
    const status = { status: "installing" as const, targetTag: "1.2.3", startedAt: new Date().toISOString() };
    writeUpdateStatus(status, dir);
    expect(readUpdateStatus(dir)).toEqual(status);
  });

  test("a terminal status carries exitCode and stderrTail", () => {
    const dir = tmp();
    writeUpdateStatus(
      { status: "failed" as const, startedAt: new Date().toISOString(), exitCode: 1, stderrTail: "EBUSY" },
      dir,
    );
    const read = readUpdateStatus(dir);
    expect(read?.status).toBe("failed");
    expect(read?.exitCode).toBe(1);
    expect(read?.stderrTail).toBe("EBUSY");
  });

  test("an absent or corrupt file reads as null", () => {
    const dir = tmp();
    expect(readUpdateStatus(dir)).toBeNull();
    writeFileSync(join(dir, "update-status.json"), "{not json", "utf8");
    expect(readUpdateStatus(dir)).toBeNull();
  });
});

describe("isFreshlyInstalling — the double-apply guard predicate", () => {
  test("a fresh installing status is true", () => {
    const status = { status: "installing" as const, startedAt: new Date().toISOString() };
    expect(isFreshlyInstalling(status)).toBe(true);
  });

  test("an installing status older than the window is false", () => {
    const status = {
      status: "installing" as const,
      startedAt: new Date(Date.now() - INSTALLING_FRESH_MS - 1_000).toISOString(),
    };
    expect(isFreshlyInstalling(status)).toBe(false);
  });

  test("terminal statuses and a corrupt timestamp are never fresh", () => {
    expect(isFreshlyInstalling({ status: "success", startedAt: new Date().toISOString() })).toBe(false);
    expect(isFreshlyInstalling({ status: "failed", startedAt: new Date().toISOString(), exitCode: 1 })).toBe(false);
    expect(isFreshlyInstalling(null)).toBe(false);
    expect(isFreshlyInstalling({ status: "installing", startedAt: "not-a-date" })).toBe(false);
  });
});

describe("finishDetachedUpdate — the wrapper's terminal write", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("a failing install writes status failed with the exit code and stderr tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "update-finish-"));
    dirs.push(dir);
    const status = await finishDetachedUpdate(
      (onStderr) => {
        onStderr("npm ERR! EBUSY: resource busy");
        return Promise.resolve(1);
      },
      dir,
    );
    expect(status.status).toBe("failed");
    expect(status.exitCode).toBe(1);
    expect(status.stderrTail).toContain("EBUSY");
    expect(readUpdateStatus(dir)?.status).toBe("failed");
  });

  test("a successful install writes status success with exitCode 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "update-finish-"));
    dirs.push(dir);
    const status = await finishDetachedUpdate(() => Promise.resolve(0), dir);
    expect(status.status).toBe("success");
    expect(status.exitCode).toBe(0);
    expect(status.stderrTail).toBeUndefined();
  });

  test("a thrown install writes status failed with exitCode -1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "update-finish-"));
    dirs.push(dir);
    const status = await finishDetachedUpdate(
      () => Promise.reject(new Error("spawn ENOENT")),
      dir,
    );
    expect(status.status).toBe("failed");
    expect(status.exitCode).toBe(-1);
    expect(status.stderrTail).toContain("ENOENT");
  });
});

describe("/console/api/updates/apply", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "update-route-"));
    dirs.push(dir);
    return dir;
  };

  /** A signed-in tenant writer, as the console grants an owner. */
  const owner = { tenantId: "t-1", scopes: ["dashboard:write"] } as never;

  function build(options: {
    readonly begin?: () => Promise<void>;
    readonly status?: unknown;
  }): {
    readonly apply: () => Promise<unknown>;
    readonly begun: { current: string[] };
    readonly exits: { current: number[] };
    readonly configDir: string;
    readonly seededStartedAt?: string;
  } {
    const configDir = tmp();
    const seededStartedAt = options.status === undefined
      ? undefined
      : (options.status as { startedAt?: string }).startedAt;
    if (options.status !== undefined) {
      writeFileSync(
        join(configDir, "update-status.json"),
        JSON.stringify(options.status),
        "utf8",
      );
    }
    const begun = { current: [] as string[] };
    const exits = { current: [] as number[] };
    const routes = createUpdateRoutes({
      accessResolver: () => owner,
      observabilityStore: {} as never,
      fetchRelease: async () => null,
      configDir,
      spawnUpdate: () => ({ started: true }),
      shutdownCoordinator: {
        begin: async (reason) => {
          begun.current.push(reason);
          await options.begin?.();
        },
        totalShutdownBudgetMs: () => 1_000,
      },
    });
    // Invoke the route handler through the composed app so the scope check and
    // error shaping run exactly as deployed.
    const apply = async (): Promise<unknown> => {
      exits.current = [];
      // The real `process.exit` would kill the test runner: swap it out for the
      // duration of the call and observe the exit code instead.
      const originalExit = process.exit;
      const updateRoutes = routes as unknown as {
        handle: (request: Request) => Promise<Response>;
      };
      (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
        exits.current.push(code ?? 0);
        throw new Error("process.exit observed");
      }) as never;
      try {
        return await updateRoutes.handle(
          new Request("http://cartethyia.test/updates/apply", { method: "POST" }),
        );
      } finally {
        (process as { exit: (code?: number) => never }).exit = originalExit;
      }
    };
    return { apply, begun, exits, configDir, ...(seededStartedAt === undefined ? {} : { seededStartedAt }) };
  }

  test("writes the intent file, calls begin(update), and exits 0 after the drain", async () => {
    const route = build({});
    const response = (await route.apply()) as Response;
    expect(response.status).toBe(200);
    const status = readUpdateStatus(route.configDir);
    expect(status?.status).toBe("installing");
    // begin ran before the exit was observed — the drain is not skipped.
    expect(route.begun.current).toEqual(["update"]);
    expect(route.exits.current).toEqual([0]);
  });

  test("exits even when begin rejects — the safety timer is the backstop", async () => {
    const route = build({ begin: async () => { throw new Error("hung hook"); } });
    await route.apply();
    expect(route.exits.current).toEqual([0]);
  });

  test("a fresh installing status answers 409 and does not re-apply", async () => {
    const route = build({
      status: { status: "installing", startedAt: new Date().toISOString() },
    });
    const response = (await route.apply()) as Response;
    expect(response.status).toBe(409);
    expect(route.begun.current).toEqual([]);
    // The pre-existing intent file is untouched — no second spawn clobbered it.
    const raw = JSON.parse(readFileSync(join(route.configDir, "update-status.json"), "utf8")) as {
      startedAt: string;
    };
    expect(raw.startedAt).toBe(route.seededStartedAt ?? "");
  });

  test("a stale installing status is re-applied, not refused", async () => {
    const route = build({
      status: {
        status: "installing",
        startedAt: new Date(Date.now() - INSTALLING_FRESH_MS - 60_000).toISOString(),
      },
    });
    const response = (await route.apply()) as Response;
    expect(response.status).toBe(200);
    expect(route.begun.current).toEqual(["update"]);
  });

  test("a terminal status does not block a new apply", async () => {
    const route = build({
      status: { status: "failed" as const, startedAt: new Date().toISOString(), exitCode: 1 },
    });
    const response = (await route.apply()) as Response;
    expect(response.status).toBe(200);
    expect(readUpdateStatus(route.configDir)?.status).toBe("installing");
  });

  test("a composition without a coordinator answers 503 rather than exiting undrained", async () => {
    const configDir = tmp();
    const routes = createUpdateRoutes({
      accessResolver: () => owner,
      observabilityStore: {} as never,
      fetchRelease: async () => null,
      configDir,
      spawnUpdate: () => ({ started: true }),
    });
    const response = await (routes as unknown as {
      handle: (request: Request) => Promise<Response>;
    }).handle(
      new Request("http://cartethyia.test/updates/apply", { method: "POST" }),
    );
    expect(response.status).toBe(503);
    expect(readUpdateStatus(configDir)).toBeNull();
  });

  test("a failed spawn writes status failed and does not begin the drain", async () => {
    const configDir = tmp();
    const begun: string[] = [];
    const routes = createUpdateRoutes({
      accessResolver: () => owner,
      observabilityStore: {} as never,
      fetchRelease: async () => null,
      configDir,
      spawnUpdate: () => ({ started: false, error: "EACCES" }),
      shutdownCoordinator: {
        begin: async (reason) => {
          begun.push(reason);
        },
        totalShutdownBudgetMs: () => 1_000,
      },
    });
    const response = await (routes as unknown as {
      handle: (request: Request) => Promise<Response>;
    }).handle(
      new Request("http://cartethyia.test/updates/apply", { method: "POST" }),
    );
    expect(response.status).toBe(500);
    expect(begun).toEqual([]);
    expect(readUpdateStatus(configDir)?.status).toBe("failed");
  });
});

describe("GET /console/api/updates/status", () => {
  test("answers the status file contents without a session", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "update-status-route-"));
    const status = { status: "failed" as const, startedAt: new Date().toISOString(), exitCode: 14 };
    writeUpdateStatus(status, configDir);
    try {
      const routes = createUpdateRoutes({
        accessResolver: () => undefined,
        observabilityStore: {} as never,
        configDir,
      });
      const response = await (routes as unknown as {
        handle: (request: Request) => Promise<Response>;
      }).handle(new Request("http://cartethyia.test/updates/status"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(status);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("an untouched install answers a null-status shape, not an error", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "update-status-route-"));
    try {
      const routes = createUpdateRoutes({
        accessResolver: () => undefined,
        observabilityStore: {} as never,
        configDir,
      });
      const response = await (routes as unknown as {
        handle: (request: Request) => Promise<Response>;
      }).handle(new Request("http://cartethyia.test/updates/status"));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("idle");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// The error class import above is load-bearing for the 503 branch's shape; pin
// that the code/status pair is what the console contract promises.
describe("update_unavailable error shape", () => {
  test("carries status 503", () => {
    const error = new ConsoleDomainError("update_unavailable", 503, "no coordinator");
    expect(error.status).toBe(503);
    expect(error.code).toBe("update_unavailable");
  });
});
