/**
 * Tray-control wire contracts.
 *
 * Kept free of Elysia and Node imports so the dashboard can project these types
 * directly instead of declaring a second copy that drifts. `routes.ts` owns the
 * validation schemas; this module owns what goes on the wire.
 */

/** What the console can ask the tray to do. */
export const TRAY_VISIBILITY_ACTIONS = ["hide", "show"] as const;

export type TrayVisibilityAction = (typeof TRAY_VISIBILITY_ACTIONS)[number];

/**
 * Whether a tray is running, and whether its icon is currently on screen.
 *
 * `hidden` is the live icon state and nothing else: with no tray running it is
 * `false`, because there is no icon to describe. The last recorded state — which
 * outlives the tray — travels separately in `lastHidden`, so a caller cannot
 * mistake a remembered icon for a running one.
 */
export interface TrayStatusResponse {
  readonly running: boolean;
  readonly hidden: boolean;
  /** The tray process, when one is running; `null` otherwise. */
  readonly pid: number | null;
  /** Where the icon was left last time; `null` when nothing was ever recorded. */
  readonly lastHidden: boolean | null;
  /** When that state was recorded, ISO 8601; `null` when nothing was recorded. */
  readonly lastChangedAt: string | null;
}
