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

/** Whether a tray is running, and whether its icon is currently on screen. */
export interface TrayStatusResponse {
  readonly running: boolean;
  readonly hidden: boolean;
  /** The tray process, when one is running; `null` otherwise. */
  readonly pid: number | null;
}
