// IP-ban domain: manual IP bans visible in the Banned Users modal.
//
// The gateway's abuse store keeps automatic bans (escalation after a burst).
// This domain exposes the same store to the operator so an address can be
// banned BY HAND and listed/unbanned from the console. IP bans are instance
// state, not tenant data, so every route is guarded by `platform:admin` like
// the other instance-level operations.

import { Elysia, t, type AnyElysia } from "elysia";
import { errorResponse, requireGlobalAdmin } from "../shared/errors";
import type { IpAbuseStore } from "../../security/abuse";
import type { ConsoleAccessResolver } from "../auth/access";
import { BAN_DURATION_CHOICES } from "../api-keys/ban-constants";

/** One active IP ban, as the console returns it. */
export interface IpBanResponse {
  /** The banned address. */
  readonly ip: string;
  /** When the ban lifts, as ISO timestamp; null = permanent. */
  readonly bannedUntil: string | null;
  /** True when the ban was set by hand rather than by abuse escalation. */
  readonly manual: boolean;
}

export interface IpBanRoutesConfig {
  readonly accessResolver: ConsoleAccessResolver;
  readonly store: IpAbuseStore;
}

/** Parses a duration choice into minutes; null = permanent; undefined = invalid. */
function parseBanDuration(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return value === null ? null : undefined;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return Math.round(minutes);
}

export function createIpBanRoutes(config: IpBanRoutesConfig): AnyElysia {
  const { accessResolver, store } = config;
  return new Elysia()
    .get("/ip-bans", async ({ request, set }) => {
      try {
        requireGlobalAdmin(accessResolver(request));
        const bans = await store.listBans();
        return bans.map((ban) => ({
          ip: ban.identity,
          bannedUntil: ban.bannedUntil === null ? null : new Date(ban.bannedUntil).toISOString(),
          manual: true,
        }));
      } catch (e) {
        return errorResponse(e, set, "Could not list IP bans");
      }
    })
    .post(
      "/ip-bans",
      { body: t.Object({ ip: t.String(), minutes: t.Optional(t.Nullable(t.Number())) }) },
      async ({ request, body, set }) => {
        try {
          requireGlobalAdmin(accessResolver(request));
          const ip = body.ip.trim();
          if (ip.length === 0)
            return errorResponse(new Error("ip is required"), set, "Invalid IP ban request");
          // Absent is permanent (the default), exactly like an explicit null;
          // parseBanDuration maps those to null and rejects anything else.
          const minutes = body.minutes === undefined ? null : parseBanDuration(body.minutes);
          if (minutes === undefined)
            return errorResponse(new Error("minutes must be a positive integer or null"), set, "Invalid IP ban request");
          await store.ban(ip, minutes === null ? 0 : minutes * 60_000);
          return {
            ip,
            bannedUntil: minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString(),
            manual: true,
          };
        } catch (e) {
          return errorResponse(e, set, "Could not ban IP");
        }
      },
    )
    .delete("/ip-bans/:ip", async ({ request, params, set }) => {
      try {
        requireGlobalAdmin(accessResolver(request));
        const ip = typeof params?.["ip"] === "string" ? decodeURIComponent(params["ip"]) : "";
        if (ip.length === 0)
          return errorResponse(new Error("ip is required"), set, "Invalid unban request");
        await store.unban(ip);
        return { success: true, ip };
      } catch (e) {
        return errorResponse(e, set, "Could not unban IP");
      }
    });
}

export { BAN_DURATION_CHOICES };
