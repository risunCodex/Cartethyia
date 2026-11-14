// Root-level OAuth browser callbacks.
//
// Providers whose redirect port this gateway owns — DeepAI's `port=` desktop
// sign-in, Devin's CLI OAuth, and Trae's `/authorize` callback — redirect the
// browser to `http://127.0.0.1:<gateway port>/<path>`. That port is the same
// listener serving the dashboard and `/v1`, so the callback arrives here
// without any ephemeral socket. It is delivered on the machine the *browser*
// runs on: for a local operator that is this gateway and the login completes
// in place; for a remote operator it is their own machine, the browser shows
// "connection refused", and the console dialog's paste path completes the
// login instead — that split is the design, not a failure.
//
// Paths served — every callback path any provider's redirect advertises, so a
// redirect that names the gateway's own port is always deliverable no matter
// which provider sent it: `/callback` (the shared default, and Devin),
// `/auth-callback` (DeepAI's desktop flow, observed live), `/authorize`
// (Trae's login page, which refuses every other path), plus the pinned
// providers' paths (`/auth/callback`, `/oauth/callback`, `/signin/callback`,
// `/oauth-callback`) for the rare case the gateway itself holds such a port.
// The `state` query parameter is the correlation key and the pending flow
// names its provider, so one handler serves every provider without
// per-provider routes. Unauthenticated by design: the browser redirect
// carries no console session, and the single-use `state` is what guards the
// exchange.
import { Elysia, type AnyElysia } from "elysia";
import {
  createOAuthLoginOperations,
  failurePage,
  type OAuthLoginConfig,
} from "./operations";

/** Query params this handler consumes itself; everything else rides along. */
const CONSUMED_PARAMS = new Set(["code", "state", "error", "error_description"]);

/** Every callback path a provider's redirect URI advertises. */
const CALLBACK_PATHS = [
  "/callback",
  "/auth-callback",
  "/auth/callback",
  "/oauth/callback",
  "/signin/callback",
  "/oauth-callback",
  "/authorize",
] as const;

export function createOAuthRootCallbackRoutes(config: OAuthLoginConfig): AnyElysia {
  const operations = createOAuthLoginOperations(config);

  const handle = async (
    query: Record<string, string | undefined>,
    request: Request,
  ): Promise<Response> => {
    const state = typeof query["state"] === "string" ? query["state"] : "";
    // No state, or no live flow under it: the login cannot be correlated. The
    // paste path in the console dialog remains usable for providers whose
    // redirect URL the operator can still copy.
    if (state.length === 0) return failurePage("OAuth session not found or expired.", false);
    const flow = await config.oauthFlowStore.peekPending(state);
    if (flow === undefined) return failurePage("OAuth session not found or expired.", false);
    const providerId = flow.providerId;
    if (typeof query["error"] === "string" && query["error"].length > 0) {
      return operations.handleCallbackError(providerId, state, false);
    }
    // Not every authorization server hands back a `code`. Trae's page redirects
    // with the refresh token already in the query, and the client's parser
    // reads the whole query — the same fallback the loopback listener applies.
    const codeParam = typeof query["code"] === "string" ? query["code"] : "";
    const callbackParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (CONSUMED_PARAMS.has(key) || typeof value !== "string") continue;
      callbackParams[key] = value;
    }
    const code =
      codeParam.length > 0 ? codeParam : new URL(request.url).search.slice(1);
    if (code.length === 0 && Object.keys(callbackParams).length === 0) {
      return failurePage("missing code", false);
    }
    return operations.handleCallback(
      providerId,
      code,
      state,
      false,
      Object.keys(callbackParams).length > 0 ? callbackParams : undefined,
    );
  };

  const routes = new Elysia();
  for (const path of CALLBACK_PATHS) {
    routes.get(path, ({ query, request }) => handle(query, request));
  }
  return routes;
}
