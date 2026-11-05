/**
 * Regression tests: Qoder provider-request/response capture for the gRPC
 * transport.
 *
 * The gateway's payload capture wraps HTTP `fetch` (see
 * `captureProviderExchange`), but Qoder's production chat transport is gRPC —
 * not a fetch. Before this fix the Provider Request / Provider Response panels
 * in Request Detail showed the PAT → job-token exchange body
 * (`center.qoder.sh/api/v1/jobToken/exchange`) for PAT accounts, and nothing
 * at all for OAuth device-token accounts.
 *
 * These tests pin the pure pieces of the fix:
 * 1. `buildUpstreamDispatchContext` forwards the capture sink to adapters.
 * 2. `captureQoderGrpcRequest` renders the gRPC call as a capture record.
 */
import { expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { buildUpstreamDispatchContext } from "../../../src/transport/dispatch/upstream";
import { captureQoderGrpcRequest } from "../../../src/providers/integrations/qoder/qoder-grpc";
import type { ProviderCaptureExchange } from "../../../src/providers/provider-contracts";

test("buildUpstreamDispatchContext forwards the provider capture sink", () => {
  const sink: ProviderCaptureExchange = { request: null, response: Promise.resolve(null) };
  const ctx = buildUpstreamDispatchContext({
    credential: { credential_kind: "oauth" },
    deadline: 0,
    signal: new AbortController().signal,
    headers: {},
    providerCapture: sink,
  }) as { provider_capture?: ProviderCaptureExchange };
  expect(ctx.provider_capture).toBe(sink);
});

test("buildUpstreamDispatchContext omits the capture sink when not provided", () => {
  const ctx = buildUpstreamDispatchContext({
    credential: { credential_kind: "oauth" },
    deadline: 0,
    signal: new AbortController().signal,
    headers: {},
  }) as { provider_capture?: ProviderCaptureExchange };
  expect(ctx.provider_capture).toBeUndefined();
});

test("captureQoderGrpcRequest renders the gRPC call", () => {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", "Bearer super-secret-token");
  metadata.set("x-session-id", "sess-123");
  metadata.set("x-request-id", "req-1");
  metadata.set("cosy-version", "1.1.80");
  const request = { model: "dfmodel", messages: [{ role: "user", text_content: "halo" }], stream: true };
  const capture = captureQoderGrpcRequest(request, metadata, "intl") as {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  expect(capture.method).toBe("POST");
  expect(capture.url).toBe("grpc://api2-v2.qoder.sh/model.chat.ChatService/ChatCompletionStream");
  expect(capture.headers["authorization"]).toBeUndefined();
  expect(capture.headers["x-session-id"]).toBe("sess-123");
  expect(capture.headers["x-request-id"]).toBe("req-1");
  expect(capture.headers["cosy-version"]).toBe("1.1.80");
  expect(capture.body).toBe(request);
});

test("captureQoderGrpcRequest never persists credential-like metadata", () => {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", "Bearer super-secret-token");
  metadata.set("cosy-machinetoken", "device-secret");
  metadata.set("cosy-machinetype", "machine-type");
  metadata.set("x-api-key", "sk-secret");
  const capture = captureQoderGrpcRequest({ model: "cmodel" }, metadata, "intl") as { headers: Record<string, string> };
  for (const [key, value] of Object.entries(capture.headers)) {
    expect(key.toLowerCase()).not.toMatch(/authorization|token|api-key|secret|bearer/);
    expect(String(value)).not.toMatch(/secret|Bearer/);
  }
});

test("captureQoderGrpcRequest uses the CN host for the cn realm", () => {
  const capture = captureQoderGrpcRequest({ model: "cmodel" }, new grpc.Metadata(), "cn") as { url: string };
  expect(capture.url).toBe("grpc://gateway.qoder.com.cn/model.chat.ChatService/ChatCompletionStream");
});
