/**
 * A pause a shutdown can cut short.
 *
 * The tray's two poll loops are the only thing keeping the process alive while
 * the icon is hidden: there is no helper process then, and the gateway is
 * detached and unref'd, so their timers must stay referenced for as long as the
 * tray runs.
 *
 * A plain `Bun.sleep` also holds the process open after it has stopped being
 * useful. Shutting down deletes `tray-state.json` and then waits for the loop to
 * finish, so the tray kept its controller lease — and went on reading as a live
 * tray — for up to one poll interval after its state record was gone. The next
 * `carte --tray` in that window was told no tray was running, which is the
 * command it had just run. Clearing the timer is what lets the process exit as
 * soon as its shutdown work is done.
 */
export interface ShutdownPause {
  /** Resolves after `ms`, or as soon as {@link ShutdownPause.interrupt} is called. */
  pause(ms: number): Promise<void>;
  /** Wakes every pending pause. Pauses taken afterwards resolve immediately. */
  interrupt(): void;
}

export function createShutdownPause(): ShutdownPause {
  const pending = new Set<() => void>();
  let interrupted = false;
  return {
    pause(ms: number): Promise<void> {
      if (interrupted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const wake = (): void => {
          clearTimeout(timer);
          pending.delete(wake);
          resolve();
        };
        timer = setTimeout(wake, ms);
        pending.add(wake);
      });
    },
    interrupt(): void {
      interrupted = true;
      // Copied first: each `wake` removes itself from the set it is being
      // iterated over.
      for (const wake of [...pending]) wake();
    },
  };
}
