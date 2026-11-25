/**
 * The console's tray control: `GET /tray/status` and `POST /tray/visibility`.
 *
 * This is the same file channel the CLI uses (`tray-request.json` /
 * `tray-state.json` under `CARTETHYIA_CONFIG_DIR`), so the tests play the tray's
 * part: write the request the route is waiting for, then answer with a state
 * record quoting its nonce. Nothing here touches the operator's real config
 * directory, and nothing spawns a tray or a gateway.
 *
 * The gates are pinned one at a time — `platform:admin`, loopback peer, and the
 * nonce confirmation — because each covers a failure the other two do not.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia, type AnyElysia } from "elysia";
import { createTrayRoutes, type TrayRoutesConfig } from "../../src/console/tray/routes";
import { consumeTrayRequest, clearTrayState, writeTrayState } from "../../src/console/tray/control";
import { createAccessDecision, type AccessScope } from "../../src/security/access-control";

let configDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "carte-console-tray-test-"));
  originalConfigDir = process.env.CARTETHYIA_CONFIG_DIR;
  process.env.CARTETHYIA_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CARTETHYIA_CONFIG_DIR;
  else process.env.CARTETHYIA_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

const requestPath = (): string => join(configDir, "tray-request.json");

function decision(scopes: readonly AccessScope[]) {
  return createAccessDecision({
    id: `tray-test-${Math.random().toString(16).slice(2)}`,
    tenantId: null,
    scopes,
  });
}

const ADMIN = decision(["platform:admin"]);
const TENANT = decision(["dashboard:read", "dashboard:write"]);

function app(options: {
  readonly access?: ReturnType<typeof decision> | undefined;
  readonly peer?: string | null;
  readonly changeOptions?: TrayRoutesConfig["changeOptions"];
} = {}): AnyElysia {
  const config: TrayRoutesConfig = {
    accessResolver: () => ("access" in options ? options.access : ADMIN),
    // The default composition resolves a real peer for every request; a test
    // that mounts the group alone has to say which one.
    resolvePeerAddress: () => (options.peer === undefined ? "127.0.0.1" : options.peer),
    // No real waiting: the tray's answer is written by the test itself.
    changeOptions: options.changeOptions ?? { timeoutMs: 0, sleep: async () => undefined },
  };
  return new Elysia().use(createTrayRoutes(config));
}

function post(action: unknown): Request {
  return new Request("http://127.0.0.1/tray/visibility", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

function get(url = "http://127.0.0.1/tray/status"): Request {
  return new Request(url);
}

/**
 * Answers the pending request the way the tray's poll loop does: consume the
 * request file, then write the state that quotes its nonce back.
 *
 * Consuming matters: the tray takes the request exactly once, so a route that
 * left the file behind would be answered twice.
 */
function answerPendingRequest(hidden: boolean): void {
  const request = consumeTrayRequest();
  if (request === null) throw new Error("no pending request to answer");
  writeTrayState({ pid: process.pid, hidden, nonce: request.nonce });
}

test("status reports no tray when no state file exists", async () => {
  const response = await app().handle(get());

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    running: false,
    hidden: false,
    pid: null,
    lastHidden: null,
    lastChangedAt: null,
  });
});

test("status reports the last icon state while no tray is running", async () => {
  // The icon can stay hidden across restarts, so a stopped tray has to be able
  // to say where it left it: otherwise the panel offers nothing and the
  // operator has no reason for the missing icon.
  writeTrayState({ pid: process.pid, hidden: true });
  clearTrayState();

  const body = (await (await app().handle(get())).json()) as Record<string, unknown>;

  expect(body).toMatchObject({ running: false, hidden: false, pid: null, lastHidden: true });
  expect(Number.isNaN(Date.parse(String(body.lastChangedAt)))).toBe(false);
});

test("status reports the running tray and its visibility", async () => {
  writeTrayState({ pid: process.pid, hidden: true });

  const response = await app().handle(get());

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    running: true,
    hidden: true,
    pid: process.pid,
    lastHidden: true,
  });
});

test("status treats a dead pid as no tray rather than an icon that is not there", async () => {
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  writeTrayState({ pid: child.pid, hidden: true });

  const body = await (await app().handle(get())).json();

  expect(body).toMatchObject({ running: false, hidden: false, pid: null });
  expect(existsSync(join(configDir, "tray-state.json"))).toBe(false);
});

test("hide writes a request and answers only after the tray confirms it", async () => {
  writeTrayState({ pid: process.pid, hidden: false });
  const server = app({
    changeOptions: {
      timeoutMs: 1_000,
      pollMs: 0,
      // Stands in for the tray: the first poll finds the request and answers it.
      sleep: async () => answerPendingRequest(true),
    },
  });

  const response = await server.handle(post("hide"));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ running: true, hidden: true, pid: process.pid });
  // A request left behind would act on the tray again minutes later.
  expect(existsSync(requestPath())).toBe(false);
});

test("show writes a show request the tray can consume", async () => {
  writeTrayState({ pid: process.pid, hidden: true });
  const server = app({
    changeOptions: {
      timeoutMs: 1_000,
      pollMs: 0,
      sleep: async () => {
        const written = JSON.parse(readFileSync(requestPath(), "utf8")) as {
          request: string;
          nonce: string;
        };
        expect(written.request).toBe("show");
        answerPendingRequest(false);
      },
    },
  });

  const body = await (await server.handle(post("show"))).json();

  expect(body.hidden).toBe(false);
});

test("asking for the state the tray is already in answers from the record", async () => {
  writeTrayState({ pid: process.pid, hidden: true });

  const response = await app().handle(post("hide"));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ running: true, hidden: true, pid: process.pid });
  // No request: waking the tray to do nothing would report a failure the
  // operator cannot act on.
  expect(existsSync(requestPath())).toBe(false);
});

test("a tray that never confirms fails with 504 and leaves no request behind", async () => {
  writeTrayState({ pid: process.pid, hidden: false });

  const response = await app().handle(post("hide"));

  expect(response.status).toBe(504);
  expect((await response.json()).code).toBe("tray_visibility_timeout");
  expect(existsSync(requestPath())).toBe(false);
});

test("hiding with no tray running is a 409, not a write", async () => {
  const response = await app().handle(post("hide"));

  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("tray_not_running");
  expect(existsSync(requestPath())).toBe(false);
});

test("a non-loopback peer is refused and writes nothing", async () => {
  writeTrayState({ pid: process.pid, hidden: false });

  const response = await app({ peer: "203.0.113.9" }).handle(post("hide"));

  expect(response.status).toBe(403);
  expect((await response.json()).code).toBe("tray_control_local_only");
  expect(existsSync(requestPath())).toBe(false);
});

test("an unknown peer fails closed", async () => {
  writeTrayState({ pid: process.pid, hidden: false });

  const response = await app({ peer: null }).handle(post("hide"));

  expect(response.status).toBe(403);
  expect(existsSync(requestPath())).toBe(false);
});

test("a tenant-scoped session cannot read or change the icon", async () => {
  writeTrayState({ pid: process.pid, hidden: false });

  const read = await app({ access: TENANT }).handle(get());
  const write = await app({ access: TENANT }).handle(post("hide"));

  expect(read.status).toBe(403);
  expect((await read.json()).code).toBe("insufficient_scope");
  expect(write.status).toBe(403);
  expect((await write.json()).code).toBe("insufficient_scope");
  expect(existsSync(requestPath())).toBe(false);
});

test("an unauthenticated request is 401", async () => {
  const response = await app({ access: undefined }).handle(get());

  expect(response.status).toBe(401);
});

test("an unknown action is rejected before it reaches the channel", async () => {
  writeTrayState({ pid: process.pid, hidden: false });

  const response = await app().handle(post("destroy"));

  expect(response.status).toBe(422);
  expect(existsSync(requestPath())).toBe(false);
});

test("a gateway with no config directory reports 409 instead of 500", async () => {
  delete process.env.CARTETHYIA_CONFIG_DIR;

  const status = await app().handle(get());
  const change = await app().handle(post("hide"));

  expect(status.status).toBe(409);
  expect((await status.json()).code).toBe("tray_control_unavailable");
  expect(change.status).toBe(409);
  expect((await change.json()).code).toBe("tray_control_unavailable");
});

test("a corrupt state file reads as no tray", async () => {
  writeFileSync(join(configDir, "tray-state.json"), "{ not json", "utf8");

  const body = await (await app().handle(get())).json();

  expect(body).toMatchObject({ running: false, hidden: false, pid: null });
});
