import { Elysia, type AnyElysia } from "elysia";
import { spawn } from "node:child_process";
import { consoleErrorHandler, requireTenantScope } from "../shared/errors";
import { consoleSseResponse, createConsoleSseStream } from "../observability/sse";
import type { ObservabilityStore } from "../observability/contracts";
import type { ConsoleAccessResolver } from "../auth/access";
import { fetchLatestRelease, type LatestRelease } from "./repository-updates";
import { isNewerRelease } from "./version-compare";

const MEMORY_SAMPLE_INTERVAL_MS = 10_000;
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

export interface NotificationEvent {
  readonly id: string;
  readonly kind: "memory-high" | "memory-growth" | "update-available";
  readonly title: string;
  readonly message: string;
  readonly createdAt: string;
  readonly level: "warning" | "info";
  readonly href?: string;
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
}): AnyElysia {
  const fetchRelease = config.fetchRelease ?? fetchLatestRelease;
  return new Elysia()
    .error(consoleErrorHandler("Update check failed"))
    .get("/updates/release", async () => await fetchRelease())
    .post("/updates/apply", ({ request }) => {
      requireTenantScope(config.accessResolver(request), "dashboard:write");
      const isWin = process.platform === "win32";
      const shell = isWin ? "cmd.exe" : "/bin/sh";
      const install = "npm install -g cartethyia@latest --prefer-online";
      const restart = isWin
        ? "cartethyia start"
        : "systemctl restart cartethyia 2>/dev/null || cartethyia start";
      const script = `${install} && ${restart}`;
      const args = isWin ? ["/c", script] : ["-c", script];
      const child = spawn(shell, args, { detached: true, stdio: "ignore" });
      child.unref();
      setTimeout(() => process.exit(0), 1500);
      return { started: true };
    })
    .get("/notifications/stream", ({ request }) => {
      const tenantId = requireTenantScope(
        config.accessResolver(request),
        "dashboard:read",
      ).tenantId;
      return consoleSseResponse(
        createConsoleSseStream(request.signal, (sender) => {
          let closed = false;
          let memoryTimer: ReturnType<typeof setTimeout> | undefined;
          let updateTimer: ReturnType<typeof setTimeout> | undefined;
          let latestTag: string | undefined;
          let memoryState = { high: false, growth: false };
          let samples: Array<{ at: number; rss: number; percent: number }> = [];

          const publishMemory = async (): Promise<void> => {
            if (closed) return;
            try {
              const at = Date.now();
              // Fresh, not `health`: that read is cached for 10 s and this
              // samples on that exact cadence, so the cached bytes would make
              // consecutive samples identical and a growth trend unreadable.
              const live = await config.observabilityStore.liveMemory();
              samples = [
                ...samples,
                { at, rss: live.memory_bytes, percent: live.memory_percent },
              ].filter((sample) => at - sample.at <= MEMORY_GROWTH_WINDOW_MS * 2)
                .slice(-MAX_MEMORY_SAMPLES);
              const computed = memoryNotifications(samples, memoryState);
              memoryState = { high: computed.high, growth: computed.growth };
              for (const notification of computed.notifications) sender.send("notification", notification);
            } catch {
              // A transient check must not terminate the feed or hide later events.
            }
          };

          const publishUpdate = async (): Promise<void> => {
            if (closed) return;
            try {
              const release = await fetchRelease();
              if (release === null || release.tag_name === latestTag) return;
              const health = (await config.observabilityStore.health(tenantId)).value;
              if (!isNewerRelease(health.version, release.tag_name)) return;
              latestTag = release.tag_name;
              sender.send("notification", {
                id: `update-${release.tag_name}`,
                kind: "update-available",
                title: "Cartethyia update available",
                message: `Version ${release.tag_name} is available; this gateway runs ${health.version}.`,
                createdAt: new Date().toISOString(),
                level: "info",
                href: RELEASES_URL,
              } satisfies NotificationEvent);
            } catch {
              // Release discovery is best-effort and cannot interrupt memory sampling.
            }
          };

          const scheduleMemory = (): void => {
            memoryTimer = setTimeout(() => {
              void publishMemory().finally(() => {
                if (!closed) scheduleMemory();
              });
            }, MEMORY_SAMPLE_INTERVAL_MS);
          };
          const scheduleUpdate = (): void => {
            updateTimer = setTimeout(() => {
              void publishUpdate().finally(() => {
                if (!closed) scheduleUpdate();
              });
            }, UPDATE_SAMPLE_INTERVAL_MS);
          };

          void publishMemory().finally(() => {
            if (!closed) scheduleMemory();
          });
          void publishUpdate().finally(() => {
            if (!closed) scheduleUpdate();
          });
          return () => {
            closed = true;
            clearTimeout(memoryTimer);
            clearTimeout(updateTimer);
          };
        }),
      );
    });
}
