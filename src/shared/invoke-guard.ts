/**
 * InvokeGuard — a process-local foreground-activity gauge (G-03).
 *
 * Every foreground request path signals its activity here: the console control
 * plane bumps the counter for the duration of each request, and the proxy data
 * plane exposes its in-flight count through `setProxyBusySource`. The scheduled
 * worker registry (and the sweep runner between waves) consults
 * `foregroundBusy()` before starting background work, so a page open / an
 * invoke in progress is never forced to share the single event loop with a
 * heavy sweep.
 *
 * The defer policy is at the call sites (scheduler: bounded pause before a
 * tick; sweep runner: bounded pause between waves). This module only owns the
 * gauge — it never decides when to pause.
 */

/** Console request counter. Bumped per in-flight console request. */
let consoleActivity = 0;

/** Optional live source of "the proxy plane is busy" (the in-flight store). */
let proxyBusySource: (() => boolean) | undefined;

/** Registers the proxy plane's busy source (wired once from the app root). */
export function setProxyBusySource(source: () => boolean): void {
  proxyBusySource = source;
}

/** Marks a foreground console request; returns the matching end callback. */
export function beginConsoleActivity(): () => void {
  consoleActivity += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    consoleActivity = Math.max(0, consoleActivity - 1);
  };
}

/** Live foreground-request count (console counter + proxy source if wired). */
export function foregroundActivityCount(): number {
  return consoleActivity + (proxyBusySource?.() === true ? 1 : 0);
}

/** True when any foreground work is in flight right now. */
export function foregroundBusy(): boolean {
  return consoleActivity > 0 || (proxyBusySource?.() ?? false);
}
