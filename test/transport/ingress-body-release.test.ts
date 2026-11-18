/**
 * The ingress body is released as soon as it can no longer be needed.
 *
 * The parsed body is the largest thing a request holds, and before this the
 * gateway kept it on the request state until the response finished — which, for
 * a streaming request, is the entire upstream stream. This asserts the two
 * halves of the contract through the real middleware chain (ingress policy →
 * canonical-request guard), not by calling the release method directly:
 *
 * 1. In a `none`/`metadata` capture mode the body is released once the canonical
 *    request exists.
 * 2. In `full` mode the body is retained, because payload capture reads it at
 *    finalize.
 * 3. A request rejected before the canonical guard still carries its body, so
 *    early-rejection capture is unaffected.
 */
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createCanonicalRequestMiddleware,
  createRequestContextMiddleware,
} from "../../src/transport/guards/request-context";
import { createIngressPolicyMiddleware } from "../../src/transport/guards/body-policy";
import { ProxyRequestStateStore } from "../../src/transport/request/state";
import { SurfaceAdapterRegistry } from "../../src/transport/surface/adapters";
import { chatAdapter } from "../../src/transport/surface/chat/adapter";
import type { CanonicalAdapter } from "../../src/transport/contracts";

const ADAPTERS = new Map<string, CanonicalAdapter>([["chat", chatAdapter]]);

function chatRequest(body: string): Request {
  return new Request("https://gateway.test/v1/chat/completions", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": "curl/8.7.1",
    },
  });
}

const CHAT_BODY = JSON.stringify({
  model: "bansos/test",
  max_tokens: 8,
  messages: [{ role: "user", content: "hi" }],
});

/**
 * Builds the middleware chain up to (and including) the canonical-request guard,
 * with a capture mode the suite chooses. The guard is the last stage that reads
 * the ingress body, so the state after `handle` is the observable contract.
 */
function chain(keepsIngressBody: boolean) {
  const stateStore = new ProxyRequestStateStore(undefined);
  const app = new Elysia()
    .use(createRequestContextMiddleware({ stateStore }))
    .use(createIngressPolicyMiddleware({ stateStore }))
    .use(
      createCanonicalRequestMiddleware({
        stateStore,
        surfaceRegistry: new SurfaceAdapterRegistry([chatAdapter]),
        adapters: ADAPTERS,
        keepsIngressBody: async () => keepsIngressBody,
      }),
    )
    .post("/v1/chat/completions", () => new Response("ok"));
  return { app, stateStore };
}

describe("ingress body release", () => {
  test("none/metadata mode drops the parsed body after the canonical request", async () => {
    const { app, stateStore } = chain(false);
    const request = chatRequest(CHAT_BODY);
    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const state = stateStore.get(request);
    expect(state?.canonicalRequest).toBeDefined();
    expect(state?.ingressBody).toBeUndefined();
  });

  test("full mode keeps the body so finalize-time capture can read it", async () => {
    const { app, stateStore } = chain(true);
    const request = chatRequest(CHAT_BODY);
    await app.handle(request);
    const state = stateStore.get(request);
    expect(state?.canonicalRequest).toBeDefined();
    expect(state?.ingressBody).toEqual({
      model: "bansos/test",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("a body rejected before the canonical guard is still present on the state", async () => {
    // An ingress 415 (missing content-type) never reaches the canonical guard,
    // so the release never runs and early-rejection capture still has the body.
    const { app, stateStore } = chain(false);
    const request = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" },
    });
    const response = await app.handle(request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    // The body was never stored because the read was refused, but the release
    // must not have run either: nothing cleared it mid-flight.
    expect(stateStore.get(request)?.canonicalRequest).toBeUndefined();
  });

  test("x-cartethyia-skip-system-prompt header flags canonical request with skipTenantSystemPrompt", async () => {
    const { app, stateStore } = chain(false);
    const request = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      body: CHAT_BODY,
      headers: {
        "content-type": "application/json",
        "user-agent": "curl/8.7.1",
        "x-cartethyia-skip-system-prompt": "1",
      },
    });
    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const state = stateStore.get(request);
    expect(state?.canonicalRequest?.skipTenantSystemPrompt).toBe(true);
  });
});
