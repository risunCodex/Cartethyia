import { expect, test } from "bun:test";
import { getQoderVersion } from "../../../src/providers/operations/client-versions";
import { callQoder, qoderSignerFor, transformQoderBody } from "../../../src/providers/integrations/qoder/qoder";
import type { QoderAuth } from "../../../src/providers/integrations/qoder/qoder";

/**
 * Pins the COSY signature canonicalization. Upstream verifies the Bearer
 * signature against a sorted-compact JSON serialization; building the payload
 * with plain `JSON.stringify` (insertion order) makes the signature mismatch
 * and the server answers `code 101 / Signature invalid`.
 */
const AUTH: QoderAuth = {
  userId: "u-01a185c9",
  userName: "test",
  userType: "personal_professional_trial",
  securityOauthToken: "dt-testtoken",
  refreshToken: "drt-testrefresh",
  machineId: "m-11111111-2222-3333-4444-555555555555",
};

test("COSY Bearer payload uses sorted-compact JSON (canonical)", () => {
  const url = "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=*";
  const body = "encoded-body-bytes";

  const headers = qoderSignerFor(AUTH)(url, body);

  const authorization = headers.authorization;
  expect(authorization).toBeDefined();
  expect(authorization).toMatch(/^Bearer COSY\./);
  const payloadB64 = authorization!.split(".")[1];
  expect(payloadB64).toBeDefined();
  const payload = JSON.parse(Buffer.from(payloadB64!, "base64").toString("utf8"));

  // Canonical key order (sorted lexicographically), not insertion order.
  expect(Object.keys(payload)).toEqual(["cosyVersion", "ideVersion", "info", "requestId", "version"]);
  expect(payload.version).toBe("v1");
  expect(payload.ideVersion).toBe("");
  expect(typeof payload.info).toBe("string");
  expect(typeof payload.requestId).toBe("string");
});

test("COSY wire headers the client never sends stay absent (sigpath/bodyhash/bodylength/organization)", () => {
  const url = "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result";
  const headers = qoderSignerFor(AUTH)(url, "body");
  // The worker-core capture (2026-11-17) shows none of these on any signed
  // surface; the signature itself still covers the stripped /algo path.
  expect(headers["cosy-sigpath"]).toBeUndefined();
  expect(headers["cosy-bodyhash"]).toBeUndefined();
  expect(headers["cosy-bodylength"]).toBeUndefined();
  expect(headers["cosy-organization-id"]).toBeUndefined();
  expect(headers["cosy-organization-tags"]).toBeUndefined();
});

test("COSY headers emit X-Qoder-HTTPDNS-IP only when the auth carries one", () => {
  const url = "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result";

  // No IP on the auth → header absent (same shape as a non-HTTPDNS client).
  const plain = qoderSignerFor(AUTH)(url, "body");
  expect(plain["X-Qoder-HTTPDNS-IP"]).toBeUndefined();

  // With the HTTPDNS-route IP stored → header emitted, mirroring the
  // client's `x-qoder-httpdns-ip` (capture 2026-11-17, conditional).
  const withIp = qoderSignerFor({ ...AUTH, httpDnsIp: "103.130.222.58" })(url, "body");
  expect(withIp["X-Qoder-HTTPDNS-IP"]).toBe("103.130.222.58");
});

test("COSY headers mirror the worker-core capture (app profile and cli profile)", () => {
  const url = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=*";

  // App profile (desktop worker, capture 0.5.7 + identity knobs).
  const app = qoderSignerFor(AUTH)(url, "body");
  expect(app["cosy-clienttype"]).toBe("10");
  expect(app["cosy-business-product"]).toBe("app");
  expect(app["cosy-scene"]).toBe("app");

  // CLI core profile — worker-core capture 2026-11-17 (1.1.86-hotfix.5):
  // clienttype 5, product cli, scene assistant, and every profile carries
  // undici UA, `br, gzip, deflate`, `*`, cors, and a W3C traceparent.
  const cli = qoderSignerFor(AUTH, getQoderVersion(), "cli")(url, "body");
  expect(cli["cosy-clienttype"]).toBe("5");
  expect(cli["cosy-business-product"]).toBe("cli");
  expect(cli["cosy-scene"]).toBe("assistant");
  for (const headers of [app, cli]) {
    expect(headers["user-agent"]).toBe("undici");
    expect(headers["accept-encoding"]).toBe("br, gzip, deflate");
    expect(headers["accept-language"]).toBe("*");
    expect(headers["sec-fetch-mode"]).toBe("cors");
    expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  }
});

test("callQoder sends the plain scrambled body (Encode=* wire, no zstd)", async () => {
  const url = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=*";
  let captured: { headers: Headers; body: Uint8Array } | undefined;
  const fetcher = async (_url: string, init: RequestInit) => {
    captured = {
      headers: new Headers(init.headers),
      body: init.body as Uint8Array,
    };
    return new Response("", { status: 200 });
  };

  const payload = { model: "cmodel", model_config: { key: "cmodel", source: "system" }, stream: true };
  await callQoder(url, payload, "cmodel", AUTH, new AbortController().signal, fetcher);

  expect(captured).toBeDefined();
  // Worker-core capture 2026-11-17: with `Encode=*` the wire carries the
  // scramble transform only — no `Content-Encoding`, no zstd magic.
  expect(captured!.headers.get("content-encoding")).toBeNull();
  const body = captured!.body;
  expect(body).toBeInstanceOf(Uint8Array);
  const expectedScrambled = transformQoderBody(JSON.stringify(payload));
  expect(Buffer.from(body).equals(Buffer.from(expectedScrambled))).toBe(true);
  expect(captured!.headers.get("cosy-bodyhash")).toBeNull();
});
