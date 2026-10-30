/**
 * Console account reset: `POST /admin/reset-console-account`.
 *
 * Why this exists. A forgotten console password had no recovery path at all:
 * `/console/api/auth/change-password` requires the current password, and
 * first-boot setup only runs when no console user exists. The only documented
 * escape was deleting the database by hand. This endpoint removes every console
 * user and login lockouts, which puts `requiresSetup()` back to true so the
 * next visit to `/console` runs the create-an-account wizard again without
 * inheriting a stale failure lock.
 *
 * What it does not touch: providers, provider accounts, API keys, routing,
 * combos, aliases, usage, and telemetry. Those are not authentication state and
 * an operator resetting a password has no reason to lose them.
 *
 * Gated exactly like the drain endpoint — loopback peer plus a constant-time
 * token comparison — because it destroys every operator credential on the
 * install. The two gates are independent, so a leaked token alone cannot reach
 * it from another host.
 *
 * The caller must send the literal confirmation `RESET` in the body. That is a
 * deliberate speed bump: this is destructive and irreversible, and the TUI asks
 * the operator to type it rather than press Enter on a menu row.
 */
import { GatewayError } from "../../protocol/gateway-error";
import { isLoopbackPeer, tokenMatches } from "../../transport/drain-endpoint";

export interface ConsoleAccountResetDeps {
  /** Shared secret; the route is registered only when this is set. */
  readonly token: string;
  /** Removes every console user and session. Resolves to the number removed. */
  readonly resetConsoleAccount: () => Promise<number>;
  /** Peer address of the request, resolved by the composition root. */
  readonly resolvePeerAddress: (request: Request) => string | null;
}

const CONFIRMATION = "RESET";

export function createConsoleAccountResetHandler(
  deps: ConsoleAccountResetDeps,
): (context: { request: Request; body: unknown }) => Promise<Response> {
  return async ({ request, body }) => {
    if (!isLoopbackPeer(deps.resolvePeerAddress(request)))
      throw new GatewayError(
        "policy_rejected",
        403,
        "console account reset is only available from loopback (request {requestId}). This operation is only allowed from a trusted loopback connection — no hard feelings 🫂",
      );
    if (!tokenMatches(request.headers.get("x-drain-token"), deps.token))
      throw new GatewayError("authentication_failed", 401, "invalid reset token (request {requestId}). Wrong key, right door — check the token 🔑");
    const confirm =
      body !== null && typeof body === "object" && "confirm" in body
        ? body.confirm
        : undefined;
    if (confirm !== CONFIRMATION)
      throw new GatewayError(
        "invalid_request",
        400,
        `send {"confirm":"${CONFIRMATION}"} to confirm (request {requestId}); this deletes every console account. Make sure you mean it — there's no undo 🫂`,
      );

    const removed = await deps.resetConsoleAccount();
    return new Response(
      JSON.stringify({ status: "reset", removed }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  };
}
