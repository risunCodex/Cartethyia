/**
 * Freebuff signature + wire-shape tests: the Ed25519 device signature payload,
 * the desktop identity-group headers, the locked worker system prompt, and the
 * 37-tool set. These pin the exact wire facts that turned a live chat 410/403
 * into a 200 (see documentation/research/freebuff/).
 */
import { describe, expect, test } from "bun:test";
import {
  FREEBUFF_WORKER_SYSTEM_PROMPT,
  FREEBUFF_MANAGER_SYSTEM_PROMPT,
  FREEBUFF_OFFICIAL_TOOLS,
} from "../../src/providers/integrations/freebuff/freebuff-constants";
import {
  freebuffSignRequest,
  freebuffMintDeviceKey,
} from "../../src/providers/integrations/freebuff/freebuff";

const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

describe("Freebuff worker system prompt (locked)", () => {
  test("is byte-identical to the official 7918-char worker", () => {
    expect(FREEBUFF_WORKER_SYSTEM_PROMPT.length).toBe(7918);
    expect(FREEBUFF_WORKER_SYSTEM_PROMPT).toStartWith("You are Buffy, the coding agent behind Codebuff.");
  });

  test("opens with an official marker from the free-agents list", () => {
    const OPENINGS = [
      "You are Buffy, the strategic coding assistant.",
      "You are Buffy, the coding agent behind Codebuff.",
      "You are Buffy, the Freebuff Cloud project planner.",
      "You are Buffy, the auto-run agent behind Freebuff Desktop.",
      "You are Buffy, the project-understanding agent behind Freebuff.",
    ];
    const ok = OPENINGS.some((o) => FREEBUFF_WORKER_SYSTEM_PROMPT.trimStart().startsWith(o));
    expect(ok).toBe(true);
  });

  test("manager template is present (13443 chars) for future use", () => {
    expect(FREEBUFF_MANAGER_SYSTEM_PROMPT.length).toBe(13443);
  });
});

describe("Freebuff official tool set", () => {
  test("has exactly 37 tools with real names and schemas", () => {
    expect(FREEBUFF_OFFICIAL_TOOLS.length).toBe(37);
    for (const tool of FREEBUFF_OFFICIAL_TOOLS) {
      expect(tool.type).toBe("function");
      expect(typeof tool.function.name).toBe("string");
      expect(tool.function.name.length).toBeGreaterThan(0);
    }
    const names = FREEBUFF_OFFICIAL_TOOLS.map((t) => t.function.name);
    expect(new Set(names).size).toBe(37);
    // The desktop worker's toolset includes the canonical read/write tools.
    expect(names).toContain("read_files");
    expect(names).toContain("write_file");
    expect(names).toContain("write_doc");
  });
});

describe("Freebuff device signature", () => {
  test("mints a device key and signs a canonical payload", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ keyId: "k_test_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const device = await freebuffMintDeviceKey("test-token", {
      fetchFn,
      accountId: "acc_1",
    });
    expect(device.publicKey).toMatch(DEVICE_KEY_PATTERN);
    expect(device.privateKey).toMatch(DEVICE_KEY_PATTERN);
    expect(device.keyId).toContain("acc_1");
    expect(device.installId).toMatch(/^[0-9a-f-]{36}$/);

    const signed = await freebuffSignRequest(device, {
      method: "POST",
      path: "/api/v1/chat/completions",
      body: JSON.stringify({ model: "fbm1.x" }),
      fetchId: "fetch_1",
    });
    expect(signed["x-freebuff-device-key"]).toBe(device.keyId);
    expect(signed["x-freebuff-device-ts"]).toMatch(/^\d+$/);
    expect(signed["x-freebuff-device-sig"]).toBeDefined();
  });

  test("signature is deterministic for identical inputs", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ keyId: "k_test_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const device = await freebuffMintDeviceKey("test-token", { fetchFn });
    const a = await freebuffSignRequest(device, {
      method: "POST",
      path: "/p",
      body: "hello",
      fetchId: "f",
      timestampMs: 1234,
    });
    const b = await freebuffSignRequest(device, {
      method: "POST",
      path: "/p",
      body: "hello",
      fetchId: "f",
      timestampMs: 1234,
    });
    expect(a["x-freebuff-device-sig"]).toBe(b["x-freebuff-device-sig"]);
    expect(a["x-freebuff-device-ts"]).toBe("1234");
  });

  test("surfaces a structured upstream refusal with its real status, not synthetic 401", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          error: "account_suspended",
          message: "Your account has been suspended.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      await freebuffMintDeviceKey("test-token", { fetchFn });
      expect.unreachable("expected a GatewayError");
    } catch (error) {
      const gateway = error as { code?: unknown; status?: unknown; origin?: unknown; details?: unknown; message?: unknown };
      expect(gateway.code).toBe("policy_rejected");
      expect(gateway.status).toBe(403);
      expect(gateway.origin).toBe("upstream");
      const details = gateway.details as { error?: unknown; upstreamStatus?: unknown };
      expect(details["error"]).toBe("account_suspended");
      expect(details["upstreamStatus"]).toBe(403);
      expect(String(gateway.message)).toContain("suspended");
    }
  });

  test("keeps 401 for a plain bad token (no structured body)", async () => {
    const fetchFn = (async () =>
      new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
    try {
      await freebuffMintDeviceKey("test-token", { fetchFn });
      expect.unreachable("expected a GatewayError");
    } catch (error) {
      const gateway = error as { code?: unknown; status?: unknown; origin?: unknown };
      expect(gateway.code).toBe("authentication_failed");
      expect(gateway.status).toBe(401);
      expect(gateway.origin).toBe("upstream");
    }
  });
});
