// Must run before any module that registers a route: it wires Elysia's TypeBox
// bridge statically, which the source-run path needs under NODE_ENV=production.
import "./boot/elysia-typebox-bridge";
import { createGatewayApp, createGatewayShell } from "./boot/app";
import { bootstrap } from "./boot/lifecycle";
import type { CartethyiaBoot } from "./boot/lifecycle";
import {
  resolveDrainToken,
  resolveIdleTimeout,
  resolveMaxBodyBytes,
  resolvePort,
  resolveProcessTopology,
} from "./config/runtime";
import { Manifest } from "elysia";
import { log } from "./observability/logger";

const port = resolvePort();
const entryMemory = process.memoryUsage();
log.info(
  `[startup] phase=entrypoint-ready elapsed_ms=${Math.round(process.uptime() * 1_000)} ` +
    `rss_mb=${(entryMemory.rss / 1024 / 1024).toFixed(1)} ` +
    `heap_used_mb=${(entryMemory.heapUsed / 1024 / 1024).toFixed(1)}`,
);

declare global {
  // eslint-disable-next-line no-var -- globalThis augmentation requires `var`
  var __cartethyiaBoot: CartethyiaBoot | undefined;
  // eslint-disable-next-line no-var
  var __cartethyiaSignalsRegistered: boolean | undefined;
}

const boot = Manifest.isCapturing()
  ? undefined
  : (globalThis.__cartethyiaBoot ??= await bootstrap());

// Hoisted once: each resolver is an env parse + range check on a cold path, and
// the values are boot-stable, so computing them repeatedly buys nothing.
const maxBodyBytes = resolveMaxBodyBytes();
const topology = resolveProcessTopology();
const drainToken = resolveDrainToken();

const app = boot
  ? createGatewayApp({
      mode: "production",
      db: boot.deps.db,
      proxyPreparer: boot.deps.proxyPreparer,
      resolveProviderAdapter: boot.deps.resolveProviderAdapter,
      byokUpstreamHosts: boot.deps.byokUpstreamHosts,
      networkBindingFactory: boot.deps.networkBindingFactory,
      ipAbuseProtection: boot.deps.ipAbuseProtection,
      trustedProxyBoundary: boot.deps.trustedProxyBoundary,
      poolSelector: boot.deps.poolSelector,
      snapshotService: boot.deps.snapshotService,
      readiness: boot.deps.readiness,
      telemetryBuffer: boot.deps.telemetryBuffer,
      resolveOAuthRefresher: boot.deps.resolveOAuthRefresher,
      oauthRefreshService: boot.deps.oauthRefreshService,
      maxBodyBytes,
      scheduledTasks: boot.deps.scheduledTasks,
      // The sampler is constructed in the dependency graph and already
      // sampling on its own interval; without passing it here the app cannot
      // bind its in-flight source, so `cartethyia_process_in_flight` stays
      // pinned at the constructor's `() => 0` placeholder forever while the
      // registry it was meant to read reports real flights.
      runtimeMetricsSampler: boot.deps.runtimeMetricsSampler,
      shutdownCoordinator: boot.shutdownCoordinator,
      // Signal-free graceful stop for platforms where a catchable signal cannot
      // be delivered (Windows). Off unless `CARTETHYIA_DRAIN_TOKEN` is set.
      ...(drainToken !== undefined
        ? { drainToken, triggerDrain: () => shutdown("SIGTERM") }
        : {}),
      // The console mounts in every boot: without REDIS_URL it runs on the
      // in-process memory backend like the rest of the gateway.
      consoleApi: {
        db: boot.deps.db,
        accessResolver: () => undefined,
        routeSnapshotService: boot.deps.snapshotService,
        poolSelector: boot.deps.poolSelector,
        telemetryBuffer: boot.deps.telemetryBuffer,
        providerRegistry: boot.deps.providerRegistry,
        bundledModelCatalog: boot.deps.bundledModelCatalog,
        networkBindingFactory: boot.deps.networkBindingFactory,
        redis: boot.deps.redis,
        oauthRefreshService: boot.deps.oauthRefreshService,
        admissionService: boot.deps.admissionService,
        readRoutingAccountInflight: boot.deps.readRoutingAccountInflight,
        // The same three writers the shutdown coordinator drains, so a manual
        // flush from the console does exactly what a graceful stop would do
        // for the queues, minus the stop.
        flushBuffers: {
          flush: async () => {
            await boot.deps.telemetryBuffer.flush();
            await boot.deps.usageFlush.flush();
            await boot.deps.healthEventFlush.flush();
          },
        },
      },
    })
  : createGatewayShell();
export { app };

function shutdown(signal: "SIGINT" | "SIGTERM", reason: "SIGINT" | "SIGTERM" | "update" = signal): void {
  if (!boot) return;
  log.info(`[shutdown] ${signal} received, draining...`);
  // Derived from the coordinator's own budget, not a hand-kept literal: a
  // force-exit shorter than the drain would hard-kill a process that was about
  // to finish gracefully, truncating the in-flight responses the drain exists
  // to protect.
  const forceExit = setTimeout(() => {
    log.error("[shutdown] forced exit after drain budget elapsed");
    process.exit(1);
  }, boot.shutdownCoordinator.totalShutdownBudgetMs());
  forceExit.unref();
  boot.shutdownCoordinator
    .begin(reason)
    .then(() => {
      log.info("[shutdown] complete");
      process.exit(0);
    })
    .catch((error: unknown) => {
      log.error("[shutdown] failed", error as Error);
      process.exit(1);
    });
}

if (boot) {
  // `bun --hot` re-runs this module against the cached boot object; stop the
  // previous listener before rebinding so a reload does not stack two servers
  // on the same port.
  if (boot.server && typeof boot.server.stop === "function") {
    try {
      boot.server.stop();
    } catch {
      // Best-effort on reload; the bind below would fail loudly if it stuck.
    }
  }
  boot.server = app.listen(
    {
      port,
      // Cap idle sockets so a Slowloris/keep-alive-abuse client cannot
      // pin one of the server's `maxRequestBodySize`-budgeted sockets
      // indefinitely. 60 s aligns with the DB pool idle timeout so all
      // long-idle resources reap together.
      idleTimeout: resolveIdleTimeout(),
      // SO_REUSEPORT load-balancing, so several processes can share the port
      // without a reverse proxy. Tied to the declared topology rather than
      // left always-on: with one process declared, enabling it lets an
      // unrelated process on the same port silently take half the traffic —
      // which is worse than a bind error, because nothing reports it.
      reusePort: topology.multiProcess,
      // 8 MiB cap on request bodies keeps a rogue client from allocating
      // gigabytes of memory in the ingress path before validation rejects.
      maxRequestBodySize: maxBodyBytes,
    },
    () => {
      log.info(`Cartethyia listening on :${port} (Bun ${Bun.version})`);
      const memory = process.memoryUsage();
      log.info(
        `[startup] phase=listener-ready rss_mb=${(memory.rss / 1024 / 1024).toFixed(1)} ` +
          `heap_used_mb=${(memory.heapUsed / 1024 / 1024).toFixed(1)}`,
      );
    },
  );
  // Started here rather than inside the dependency builder: the first tick of
  // the lease sweep and the health sweep should not run before the listener
  // exists to serve traffic.
  boot.deps.scheduledTasks.start();
  // Warm the route snapshot before the first request lands: the first /v1/*
  // request otherwise pays the full catalog build synchronously (ten+ SELECTs).
  // A failure here is a soft miss — the next request rebuilds as before.
  void boot.deps.snapshotService.getSnapshot().catch((error: unknown) => {
    log.warn("[startup] initial route snapshot warm failed", error as Error);
  });
  if (!globalThis.__cartethyiaSignalsRegistered) {
    globalThis.__cartethyiaSignalsRegistered = true;
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    // A rejected promise nothing awaited (a sweep, a cache warm, a read whose
    // parameters a bug elsewhere ballooned) must not kill the listener: the
    // default is fatal exit, which turned one query fault into a systemd
    // restart loop. Logged and absorbed — the failure stays visible, the
    // process stays up.
    process.on("unhandledRejection", (reason) => {
      log.error(
        "[process] unhandled rejection (kept alive)",
        reason instanceof Error ? reason : new Error(String(reason)),
      );
    });
    // An in-place update signals SIGUSR2 before swapping the image so the old
    // process drains with the `update` reason and its callers are told the
    // replacement is seconds away instead of seeing a generic shutdown. Not
    // available on Windows, where the listener is simply never registered —
    // production runs in Linux containers, which is where an update happens.
    try {
      process.on("SIGUSR2", () => shutdown("SIGTERM", "update"));
    } catch {
      // Platform without SIGUSR2: update drains fall back to the SIGTERM notice.
    }
  }
}
