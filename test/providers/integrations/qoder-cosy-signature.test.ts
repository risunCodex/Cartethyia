import { expect, test } from "bun:test";
import { qoderSignerFor } from "../../../src/providers/integrations/qoder/qoder";
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
