import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
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
  const url = "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
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

test("COSY sigpath strips the /algo prefix exactly like upstream", () => {
  const url = "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result";
  const headers = qoderSignerFor(AUTH)(url, "body");
  expect(headers["cosy-sigpath"]).toBe("/api/v2/service/pro/sse/agent_chat_generation");
});

test("COSY headers emit X-Qoder-HTTPDNS-IP only when the auth carries one", () => {
  const url = "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result";

  // No IP on the auth → header absent (same shape as a non-HTTPDNS client).
  const plain = qoderSignerFor(AUTH)(url, "body");
  expect(plain["X-Qoder-HTTPDNS-IP"]).toBeUndefined();

  // With the HTTPDNS-route IP stored → header emitted, mirroring the desktop
  // client's `networkMode=httpdns` worker state.
  const withIp = qoderSignerFor({ ...AUTH, httpDnsIp: "103.130.222.58" })(url, "body");
  expect(withIp["X-Qoder-HTTPDNS-IP"]).toBe("103.130.222.58");
});

test("COSY headers mirror the desktop-worker capture (clienttype/business/scene/UA/accept-encoding/trace)", () => {
  const url = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
  const headers = qoderSignerFor(AUTH)(url, "body");

  // Desktop-worker capture 2026-11-11 (app 0.5.7 / worker 1.1.79-hotfix.19).
  expect(headers["cosy-clienttype"]).toBe("10");
  expect(headers["cosy-business-product"]).toBe("app");
  expect(headers["cosy-scene"]).toBe("app");
  expect(headers["user-agent"]).toBe("undici");
  expect(headers["accept-encoding"]).toBe("br, gzip, deflate");
  expect(headers["accept-language"]).toBe("*");
  expect(headers["sec-fetch-mode"]).toBe("cors");
  expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test("callQoder sends a zstd-compressed body signed over the scrambled transform", async () => {
  const url = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
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
  expect(captured!.headers.get("content-encoding")).toBe("zstd");
  const body = captured!.body;
  expect(body).toBeInstanceOf(Uint8Array);
  // zstd magic: 28 b5 2f fd
  expect([...body.slice(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);

  // Decompress back to the scrambled transform; the signer hashes/signs the
  // *scrambled* body (the server decompresses before verifying — proven live
  // 2026-11-11: signing over the zstd bytes returns `403 Signature invalid`).
  const decompressed = Bun.zstdDecompressSync(body) as Uint8Array;
  const expectedScrambled = transformQoderBody(JSON.stringify(payload));
  expect(Buffer.from(decompressed).equals(Buffer.from(expectedScrambled))).toBe(true);
  const bodyHash = createHash("md5").update(expectedScrambled).digest("hex");
  expect(captured!.headers.get("cosy-bodyhash")).toBe(bodyHash);
});
