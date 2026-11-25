// Tray domain: the menu bar / notification-area icon of the tray process on
// this machine.
//
// V1 exposed this through `carte tray hide|show|toggle|status`. The console
// gets the same control through the same file channel, so the two surfaces
// cannot disagree about what the tray is doing.
//
// Two gates, and both are needed:
// - `platform:admin`, because the icon is host state rather than tenant data,
//   the same guard the other instance-level operations use.
// - a loopback peer, because a browser on another machine has no tray to talk
//   to: its request would reach this host's gateway and hide an icon the
//   operator over there can neither see nor restore from here.

import { Elysia, t, type AnyElysia } from "elysia";
import {
  ConsoleDomainError,
  consoleErrorHandler,
  requireGlobalAdmin,
} from "../shared/errors";
import type { ConsoleRouteConfig } from "../shared/route-factory";
import { literalUnion } from "../shared/elysia-schema";
import { isLoopbackPeer } from "../../shared/peer";
import {
  TRAY_VISIBILITY_ACTIONS,
  type TrayStatusResponse,
  type TrayVisibilityAction,
} from "./contracts";
import {
  TrayChangeTimeoutError,
  TrayControlUnavailableError,
  awaitTrayChange,
  readTrayPreference,
  readTrayState,
  writeTrayRequest,
  type TrayChangeOptions,
  type TrayPreference,
  type TrayState,
} from "./control";

export interface TrayRoutesConfig extends ConsoleRouteConfig {
  /**
   * Peer address of the request, resolved by the composition root. Absent in
   * reduced compositions (tests mounting this group alone), where the
   * visibility route answers as if the peer were unknown — refused.
   */
  readonly resolvePeerAddress?: (request: Request) => string | null;
  /** Pacing for the confirmation wait. Tests shrink it; production uses the defaults. */
  readonly changeOptions?: TrayChangeOptions;
}

/** Projects the channel's records onto the console's response shape. */
function statusResponse(state: TrayState | null, preference: TrayPreference | null): TrayStatusResponse {
  return {
    running: state !== null,
    hidden: state?.hidden ?? false,
    pid: state?.pid ?? null,
    lastHidden: preference?.hidden ?? null,
    lastChangedAt: preference?.updatedAt ?? null,
  };
}

/**
 * Maps the channel's failures onto the console's error contract.
 *
 * The channel is shared with the CLI, so its errors are plain `Error`s with a
 * sentence meant for a terminal. Each of the two that a browser can actually
 * cause gets its own code; anything else keeps the group's fallback.
 */
function trayError(error: unknown): never {
  if (error instanceof TrayControlUnavailableError) {
    throw new ConsoleDomainError(
      "tray_control_unavailable",
      409,
      "The gateway was started without a config directory, so it cannot control a tray",
    );
  }
  if (error instanceof TrayChangeTimeoutError) {
    throw new ConsoleDomainError("tray_visibility_timeout", 504, error.message);
  }
  throw error;
}

export function createTrayRoutes(config: TrayRoutesConfig): AnyElysia {
  const { accessResolver, resolvePeerAddress, changeOptions } = config;
  return new Elysia({ prefix: "/tray" })
    .error(consoleErrorHandler("Tray operation failed"))
    .get("/status", ({ request }) => {
      requireGlobalAdmin(accessResolver(request));
      try {
        // Both records are read: the live one decides the buttons, the
        // remembered one explains a menu bar with no icon on it.
        return statusResponse(readTrayState(), readTrayPreference());
      } catch (error) {
        return trayError(error);
      }
    })
    .post(
      "/visibility",
      { body: t.Object({ action: literalUnion(TRAY_VISIBILITY_ACTIONS) }) },
      async ({ request, body }) => {
        requireGlobalAdmin(accessResolver(request));
        const action: TrayVisibilityAction = body.action;
        // Unknown peer fails closed: the peer is only unknown when the
        // composition mounted this group without one, and a gate that opens on
        // "cannot tell" is not a gate.
        if (!isLoopbackPeer(resolvePeerAddress?.(request) ?? null)) {
          throw new ConsoleDomainError(
            "tray_control_local_only",
            403,
            "Tray control is only available from the machine running the gateway",
          );
        }
        try {
          const current = readTrayState();
          if (current === null) {
            throw new ConsoleDomainError(
              "tray_not_running",
              409,
              "No Cartethyia tray is running on this machine",
            );
          }
          // Asking for the state the tray is already in is answered from the
          // record: writing a request for it would wake the tray to do nothing
          // and would report a failure if the tray were busy.
          if (current.hidden === (action === "hide")) {
            return statusResponse(current, readTrayPreference());
          }
          const confirmed = await awaitTrayChange(action, writeTrayRequest(action), changeOptions);
          return statusResponse(confirmed, readTrayPreference());
        } catch (error) {
          return trayError(error);
        }
      },
    );
}
