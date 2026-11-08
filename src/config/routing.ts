// Routing configuration knobs.
import { CONFIG_SPEC, readInt } from "./spec";

/** Routing reserve percent (0–100). Accounts at/below this remaining-quota % are demoted. */
export function accountReservePct(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_RESERVE_PCT",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_RESERVE_PCT,
  );
}

/** Session-sticky warm window in ms. 0 disables stickiness. */
export function routingStickyWarmMs(): number {
  return readInt(
    "CARTETHYIA_ROUTING_STICKY_WARM_MS",
    CONFIG_SPEC.CARTETHYIA_ROUTING_STICKY_WARM_MS,
  );
}

/** LRU cap on remembered session→account sticky state per provider. */
export function routingStickyMaxSessions(): number {
  return readInt(
    "CARTETHYIA_ROUTING_STICKY_MAX_SESSIONS",
    CONFIG_SPEC.CARTETHYIA_ROUTING_STICKY_MAX_SESSIONS,
  );
}
