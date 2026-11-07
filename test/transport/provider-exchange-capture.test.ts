import { describe, expect, test } from "bun:test";
import { providerCaptureMaxBytes } from "../../src/transport/dispatch/capture-policy";
import { captureProviderExchange } from "../../src/transport/dispatch/attempt-finalize";

describe("provider capture size follows the capture depth", () => {
  // The tee's cap is the most a Provider Request/Response panel can ever
  // show. It was a flat 256 KiB at every depth, so a tenant who raised the
  // depth to Maximum still saw a quarter-megabyte translated request and an
  // empty raw response on any larger exchange.
  test("the cap grows with the depth", () => {
    // Minimum tees a full MiB in `full` mode: the record budget at this depth
    // is 1 MiB and a 256 KiB tee clipped bodies the record could keep whole.
    expect(providerCaptureMaxBytes("minimum")).toBe(1024 * 1024);
    expect(providerCaptureMaxBytes("moderate")).toBe(2 * 1024 * 1024);
    expect(providerCaptureMaxBytes("maximum")).toBe(4 * 1024 * 1024);
  });

  test("a larger depth keeps a translated body the flat cap clipped", async () => {
    const body = JSON.stringify({ text: "y".repeat(600_000) });
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
      true,
      providerCaptureMaxBytes("moderate"),
    );
    await fetcher("https://example.test/v1/chat/completions", { method: "POST", body });
    const kept = JSON.stringify(((capture.request ?? {}) as { body?: unknown }).body ?? null);
    expect(kept.length).toBeGreaterThan(256 * 1024);
  });

  test("the response tee is read to the same cap", async () => {
    const big = JSON.stringify({ text: "z".repeat(600_000) });
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () => new Response(big, { headers: { "content-type": "application/json" } }),
      capture,
      true,
      providerCaptureMaxBytes("moderate"),
    );
    await fetcher("https://example.test/v1/chat/completions", { method: "POST", body: "{}" });
    const providerResponse = await capture.response;
    expect(JSON.stringify(providerResponse).length).toBeGreaterThan(256 * 1024);
  });
});

describe("provider exchange capture", () => {
  test("captures a Uint8Array body (Qoder cosy encoding)", async () => {
    // Qoder sends its transformed body as `Uint8Array`, not a string. The tee
    // used to record only `{method, url, headers}` for it — the provider
    // request panel was empty. It must decode and retain the bytes like any
    // other string body.
    const body = Buffer.from(JSON.stringify({ model: "qoder/test" }), "latin1");
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
    );
    await fetcher("https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation", {
      method: "POST",
      body: body as unknown as BodyInit,
    });
    expect(capture.request).toMatchObject({
      method: "POST",
      body: { model: "qoder/test" },
    });
  });

  test("captures OpenCode fingerprint headers without persisting credentials", async () => {
    const capture = {
      request: null,
      response: Promise.resolve(null),
    };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
    );

    await fetcher("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "******",
        "x-opencode-client": "cli",
        "x-opencode-project": "stable-project-hash",
        "x-opencode-session": "ses_test",
        "x-opencode-session-id": "ses_test",
        "x-opencode-parent-session-id": "ses_parent",
        "x-session-affinity": "ses_test",
        "x-session-id": "ses_test",
        "x-parent-session-id": "ses_parent",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        b3: "0123456789abcdef0123456789abcdef-0123456789abcdef-1-fedcba9876543210",
        "user-agent": "opencode/latest/2.0.28/cli",
      },
      body: "{}",
    });

    expect(capture.request).toMatchObject({
      headers: {
        "x-opencode-client": "cli",
        "x-opencode-project": "stable-project-hash",
        "x-opencode-session": "ses_test",
        "x-opencode-session-id": "ses_test",
        "x-opencode-parent-session-id": "ses_parent",
        "x-session-affinity": "ses_test",
        "x-session-id": "ses_test",
        "x-parent-session-id": "ses_parent",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        b3: "0123456789abcdef0123456789abcdef-0123456789abcdef-1-fedcba9876543210",
        "user-agent": "opencode/latest/2.0.28/cli",
      },
    });
    expect(JSON.stringify(capture.request)).not.toContain("******");
  });

  test("captures the buddy conversation headers the channel check reads", async () => {
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
    );

    await fetcher("https://www.codebuddy.ai/v2/chat/completions", {
      method: "POST",
      headers: {
        authorization: "******",
        "x-session-id": "session-1",
        "x-conversation-id": "conv-1",
        "x-conversation-request-id": "turn-1",
        "x-conversation-message-id": "msg-1",
        "x-root-request-id": "turn-1",
        "x-request-id": "msg-1",
        "x-trace-id": "trace-1",
        "x-b3-traceid": "trace-1",
        "x-b3-spanid": "span-1",
        "x-b3-sampled": "1",
        "user-agent": "WorkBuddy/5.7.6",
      },
      body: "{}",
    });

    expect(capture.request).toMatchObject({
      headers: {
        "x-conversation-id": "conv-1",
        "x-conversation-request-id": "turn-1",
        "x-conversation-message-id": "msg-1",
        "x-root-request-id": "turn-1",
        "x-request-id": "msg-1",
        "x-b3-traceid": "trace-1",
        "x-b3-spanid": "span-1",
      },
    });
    expect(JSON.stringify(capture.request)).not.toContain("******");
  });
});

/**
 * Metadata-mode provider capture: stage presence + size, no content.
 *
 * `captureBody=false` used to slice up to `maxBytes` of the translated request
 * body and JSON.parse it on every attempt — content the tenant explicitly
 * declined to retain, paid on every dispatch. Now the request line records
 * `body_present` + `body_bytes` (UTF-8) and the body is never touched.
 */
describe("provider exchange capture — metadata mode", () => {
  test("records presence and UTF-8 size without slicing or parsing the body", async () => {
    // CJK-heavy body: 3 bytes per code point, so UTF-8 byte accounting is
    // distinguishable from code-unit accounting (9 vs 3 here).
    const body = JSON.stringify({ text: "汉汉汉" });
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
      false,
      providerCaptureMaxBytes("maximum"),
    );
    await fetcher("https://example.test/v1/chat/completions", { method: "POST", body });

    const request = capture.request as unknown as Record<string, unknown>;
    expect(request["method"]).toBe("POST");
    expect(request["url"]).toBe("https://example.test/v1/chat/completions");
    expect(request["body_present"]).toBe(true);
    expect(request["body_bytes"]).toBe(Buffer.byteLength(body, "utf8"));
    // No body content retained.
    expect(request["body"]).toBeUndefined();
    // Response tee skipped in metadata mode.
    expect(await capture.response).toBeNull();
  });

  test("a request with no body records neither presence nor bytes", async () => {
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
      false,
    );
    await fetcher("https://example.test/v1/models", { method: "GET" });
    const request = capture.request as unknown as Record<string, unknown>;
    expect(request["body_present"]).toBeUndefined();
    expect(request["body_bytes"]).toBeUndefined();
  });
});
