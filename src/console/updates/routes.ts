import { Elysia, type AnyElysia } from "elysia";
import { consoleErrorHandler, requireTenantScope, ConsoleDomainError } from "../shared/errors";
import { consoleSseResponse, createConsoleSseStream } from "../observability/sse";
import type { ObservabilityStore } from "../observability/contracts";
import type { ConsoleAccessResolver } from "../auth/access";
import { fetchLatestRelease, type LatestRelease } from "./repository-updates";
import { isNewerRelease } from "./version-compare";
import {
  isFreshlyInstalling,
  readUpdateStatus,
  spawnDetachedUpdate,
  updateStatusPath,
  writeUpdateStatus,
} from "./apply-update";
import { CARTETHYIA_VERSION } from "../../version";

/** Minimal drain surface the apply route needs from the process coordinator. */
export interface UpdateShutdownCoordinator {
  readonly begin: (reason: "update") => Promise<void>;
  readonly totalShutdownBudgetMs: () => number;
}

// Memory is sampled once per process (a single shared sampler feeding every
// notifications subscriber), not per visible tab: ten seconds per stream made a
// console with many open tabs wake up constantly for numbers nobody is reading.
// 30 s is still responsive for a memory warning while cutting that work by three.
const MEMORY_SAMPLE_INTERVAL_MS = 30_000;
const UPDATE_SAMPLE_INTERVAL_MS = 60_000;
const HIGH_MEMORY_PERCENT = 85;
const HIGH_MEMORY_CLEAR_PERCENT = 80;
const MEMORY_GROWTH_WINDOW_MS = 60_000;
/**
 * Absolute RSS growth required before a growth alert is raised, alongside the
 * ratio below.
 *
 * The ratio alone reported a 2607% "sustained growth" alert for what was a
 * baseline jump: the window's oldest sample predated an idle reclaim, so a
 * gateway that had just given memory back looked like it had leaked 27x. A
 * leak worth an operator's attention is measured in bytes, not multiples —
 * 20MiB to 24MiB is a 20% ratio and means nothing.
 */
const MEMORY_GROWTH_MIN_BYTES = 64 * 1024 * 1024;
const MEMORY_GROWTH_RATIO = 1.2;
const MAX_MEMORY_SAMPLES = 8;
const RELEASES_URL = "https://github.com/risunCodex/Cartethyia/releases";

interface NotificationEvent {
  readonly id: string;
  readonly kind: "memory-high" | "memory-growth" | "update-available";
  readonly title: string;
  readonly message: string;
  readonly createdAt: string;
  readonly level: "warning" | "info";
  readonly href?: string;
  /** The release tag that triggered an `update-available` alert (with `v` prefix). */
  readonly version?: string;
}

export function memoryNotifications(
  samples: readonly { readonly at: number; readonly rss: number; readonly percent: number }[],
  previous: { high: boolean; growth: boolean },
): { notifications: NotificationEvent[]; high: boolean; growth: boolean } {
  const latest = samples.at(-1);
  if (latest === undefined) return { notifications: [], ...previous };
  const notifications: NotificationEvent[] = [];
  const high = previous.high
    ? latest.percent >= HIGH_MEMORY_CLEAR_PERCENT
    : latest.percent >= HIGH_MEMORY_PERCENT;
  if (high && !previous.high) {
    notifications.push({
      id: "memory-high",
      kind: "memory-high",
      title: "High gateway memory",
      message: `Gateway RSS is using ${latest.percent.toFixed(1)}% of system memory.`,
      createdAt: new Date(latest.at).toISOString(),
      level: "warning",
    });
  }

  const oldest = samples.find((sample) => latest.at - sample.at >= MEMORY_GROWTH_WINDOW_MS);
  const growth = oldest !== undefined &&
    latest.rss >= oldest.rss * MEMORY_GROWTH_RATIO &&
    latest.rss - oldest.rss >= MEMORY_GROWTH_MIN_BYTES &&
    samples.filter((sample) => sample.at >= oldest.at).every((sample, index, window) =>
      index === 0 || sample.rss >= (window[index - 1]?.rss ?? sample.rss),
    );
  if (growth && !previous.growth && !high) {
    notifications.push({
      id: "memory-growth",
      kind: "memory-growth",
      title: "Sustained memory growth",
      message: `Gateway RSS grew ${Math.round((latest.rss / oldest.rss - 1) * 100)}% over the last minute.`,
      createdAt: new Date(latest.at).toISOString(),
      level: "warning",
    });
  }
  return {
    notifications,
    high: high && latest.percent >= HIGH_MEMORY_CLEAR_PERCENT,
    growth,
  };
}

/** A subscriber of the process-wide update/notification sampler. */
type NotificationListener = (notification: NotificationEvent) => void;

/**
 * One sampler per gateway composition (the console mounts `createUpdateRoutes`
 * exactly once per process, so this is process-scoped in production). It owns
 * the memory and release cadences and fans results out to every subscriber;
 * an SSE connection only subscribes. The timer runs while at least one
 * subscriber is connected and stops with the last one, so an idle gateway
 * samples nothing.
 */
function createUpdateSampler(config: {
  readonly observabilityStore: ObservabilityStore;
  readonly fetchRelease: () => Promise<LatestRelease | null>;
}): { subscribe(listener: NotificationListener): () => void } {
  const subscribers = new Set<NotificationListener>();
  const samples: Array<{ at: number; rss: number; percent: number }> = [];
  let memoryState = { high: false, growth: false };
  let latestTag: string | undefined;
  let memoryTimer: ReturnType<typeof setTimeout> | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;

  const broadcast = (notifications: readonly NotificationEvent[]): void => {
    if (notifications.length === 0) return;
    for (const listener of subscribers) {
      for (const notification of notifications) listener(notification);
    }
  };

  const sampleMemory = async (): Promise<void> => {
    try {
      const at = Date.now();
      // Fresh, not `health`: that read is cached for 10 s and this samples on
      // that exact cadence, so the cached bytes would make consecutive samples
      // identical and a growth trend unreadable.
      const live = await config.observabilityStore.liveMemory();
      samples.push({ at, rss: live.memory_bytes, percent: live.memory_percent });
      while (samples.length > 0 && at - samples[0]!.at > MEMORY_GROWTH_WINDOW_MS * 2) samples.shift();
      if (samples.length > MAX_MEMORY_SAMPLES) samples.splice(0, samples.length - MAX_MEMORY_SAMPLES);
      const computed = memoryNotifications(samples, memoryState);
      memoryState = { high: computed.high, growth: computed.growth };
      broadcast(computed.notifications);
    } catch {
      // A transient check must not terminate the feed or hide later events.
    }
  };

  const sampleUpdate = async (): Promise<void> => {
    try {
      const release = await config.fetchRelease();
      if (release === null || release.tag_name === latestTag) return;
      if (!isNewerRelease(CARTETHYIA_VERSION, release.tag_name)) return;
      latestTag = release.tag_name;
      broadcast([{
        id: `update-${release.tag_name}`,
        kind: "update-available",
        title: "Cartethyia update available",
        message: `Version ${release.tag_name} is available; this gateway runs ${CARTETHYIA_VERSION}.`,
        createdAt: new Date().toISOString(),
        level: "info",
        href: RELEASES_URL,
        version: release.tag_name,
      } satisfies NotificationEvent]);
    } catch {
      // Release discovery is best-effort and cannot interrupt memory sampling.
    }
  };

  const start = (): void => {
    if (memoryTimer !== undefined) return;
    memoryTimer = setTimeout(async function tick() {
      memoryTimer = setTimeout(tick, MEMORY_SAMPLE_INTERVAL_MS);
      await sampleMemory();
    }, MEMORY_SAMPLE_INTERVAL_MS);
    updateTimer = setTimeout(async function tick() {
      updateTimer = setTimeout(tick, UPDATE_SAMPLE_INTERVAL_MS);
      await sampleUpdate();
    }, UPDATE_SAMPLE_INTERVAL_MS);
  };

  const stop = (): void => {
    if (memoryTimer !== undefined) clearTimeout(memoryTimer);
    if (updateTimer !== undefined) clearTimeout(updateTimer);
    memoryTimer = undefined;
    updateTimer = undefined;
  };

  return {
    subscribe(listener) {
      subscribers.add(listener);
      // Bootstrap: the first frames a fresh connection sees are the current
      // alerts — a memory state that is high right now, an update that exists
      // now — computed with a fresh transition state exactly like the old
      // per-connection initial tick did. After that, the shared cadence takes
      // over.
      void (async () => {
        try {
          const at = Date.now();
          const live = await config.observabilityStore.liveMemory();
          const ring = [
            ...samples,
            { at, rss: live.memory_bytes, percent: live.memory_percent },
          ].filter((sample) => at - sample.at <= MEMORY_GROWTH_WINDOW_MS * 2)
            .slice(-MAX_MEMORY_SAMPLES);
          for (const notification of memoryNotifications(ring, { high: false, growth: false }).notifications) {
            listener(notification);
          }
        } catch {
          // A transient read must not fail the subscription.
        }
        try {
          const release = await config.fetchRelease();
          if (release !== null && isNewerRelease(CARTETHYIA_VERSION, release.tag_name)) {
            listener({
              id: `update-${release.tag_name}`,
              kind: "update-available",
              title: "Cartethyia update available",
              message: `Version ${release.tag_name} is available; this gateway runs ${CARTETHYIA_VERSION}.`,
              createdAt: new Date().toISOString(),
              level: "info",
              href: RELEASES_URL,
              version: release.tag_name,
            } satisfies NotificationEvent);
          }
        } catch {
          // Best-effort release discovery.
        }
      })();
      if (subscribers.size > 0) start();
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) stop();
      };
    },
  };
}

/**
 * Read-only update discovery for the console sidebar.
 *
 * Public release metadata only — no credentials, no local paths, nothing the
 * caller supplied — so this group needs no session scope. A GitHub failure
 * answers `null` rather than an error: an absent update badge is the honest
 * result when the upstream cannot be reached.
 */
export function createUpdateRoutes(config: {
  readonly accessResolver: ConsoleAccessResolver;
  readonly observabilityStore: ObservabilityStore;
  readonly fetchRelease?: () => Promise<LatestRelease | null>;
  /**
   * The process `ShutdownCoordinator`, narrowed to the drain surface the apply
   * route needs. Optional only so reduced compositions (tests of the read-only
   * routes) build without one; the apply route itself throws when absent,
   * because exiting without a drain is the bug this redesign removes.
   */
  readonly shutdownCoordinator?: UpdateShutdownCoordinator;
  /** Overrides status-file resolution (tests); defaults to the config dir. */
  readonly configDir?: string;
  /** Overrides the detached spawn (tests); defaults to the real installer. */
  readonly spawnUpdate?: typeof spawnDetachedUpdate;
}): AnyElysia {
  const fetchRelease = config.fetchRelease ?? fetchLatestRelease;
  const configDir = config.configDir;
  const spawnUpdate = config.spawnUpdate ?? spawnDetachedUpdate;
  const sampler = createUpdateSampler({
    observabilityStore: config.observabilityStore,
    fetchRelease,
  });
  return new Elysia()
    .error(consoleErrorHandler("Update check failed"))
    .get("/updates/release", async () => await fetchRelease())
    // Same no-scope posture as `/updates/release`: the status file holds no
    // credentials and no tenant data, only whether the last install landed.
    .get("/updates/status", () => readUpdateStatus(configDir) ?? { status: "idle", startedAt: new Date(0).toISOString() })
    .post("/updates/apply", async ({ request }) => {
      requireTenantScope(config.accessResolver(request), "dashboard:write");
      if (config.shutdownCoordinator === undefined) {
        throw new ConsoleDomainError(
          "update_unavailable",
          503,
          "The update flow needs a shutdown coordinator; this composition cannot apply updates.",
        );
      }
      const status = readUpdateStatus(configDir);
      // Double-apply guard: a status file younger than ten minutes that still
      // says "installing" means the detached installer is running and another
      // spawn would race it for the same npm cache and package directory.
      if (isFreshlyInstalling(status)) {
        throw new ConsoleDomainError(
          "update_in_progress",
          409,
          "An update is already installing. Check /updates/status for its result.",
        );
      }
      // The target tag is best-effort: it labels the intent file, but a failed
      // release lookup must not block the install itself.
      const release = await fetchRelease().catch(() => null);
      const targetTag = release?.tag_name.replace(/^v/, "");
      writeUpdateStatus(
        {
          status: "installing",
          ...(targetTag === undefined ? {} : { targetTag }),
          startedAt: new Date().toISOString(),
        },
        configDir,
      );
      const spawnResult = spawnUpdate(configDir === undefined ? {} : { configDir });
      if (!spawnResult.started) {
        // Flip the intent file to `failed` here, regardless of whether the spawn
        // implementation already did: the dashboard's poll loop must see a
        // terminal status, never a silent `installing` with no installer behind it.
        writeUpdateStatus(
          {
            status: "failed",
            startedAt: new Date().toISOString(),
            exitCode: -1,
            stderrTail: spawnResult.error ?? "unknown error",
          },
          configDir,
        );
        throw new ConsoleDomainError(
          "update_spawn_failed",
          500,
          "The detached installer could not be started.",
          { error: spawnResult.error ?? "unknown" },
        );
      }
      const coordinator = config.shutdownCoordinator;
      // Drain like a planned stop, then exit. The safety timer is the
      // coordinator's own total budget: begin() is bounded by design, but a
      // hung hook must not keep a half-updated process alive past it.
      const budgetMs = coordinator.totalShutdownBudgetMs();
      const safety = setTimeout(() => process.exit(0), budgetMs);
      if (typeof safety.unref === "function") safety.unref();
      void coordinator
        .begin("update")
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(safety);
          process.exit(0);
        })
        // The finally callback itself must never surface as an unhandled
        // rejection: exit either succeeded or the process is already leaving.
        .catch(() => undefined);
      return { started: true, statusPath: updateStatusPath(configDir) };
    })
    .get("/notifications/stream", ({ request }) => {
      requireTenantScope(
        config.accessResolver(request),
        "dashboard:read",
      );
      return consoleSseResponse(
        createConsoleSseStream(request.signal, (sender) => {
          return sampler.subscribe((notification) => sender.send("notification", notification));
        }),
      );
    });
}
