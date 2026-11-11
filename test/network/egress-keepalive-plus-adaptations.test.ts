import { describe, expect, test } from "bun:test";
import { isStaleSocketError } from "../../src/network/egress/fetch";
import { applyParamQuirks } from "../../src/protocol/translation/quirks";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import {
  SENSENOVA_MODELS,
  SENSENOVA_INTL_MODELS,
  SENSENOVA_SPEC,
  SENSENOVA_INTL_SPEC,
} from "../../src/providers/integrations/sensenova/provider";

function err(message: string, code?: string): Error {
  const e = new Error(message);
  if (code !== undefined) (e as { code?: string }).code = code;
  return e;
}

describe("keep-alive stale socket classification", () => {
  test("proves socket death by code", () => {
    expect(isStaleSocketError(err("socket error", "UND_ERR_SOCKET"))).toBe(true);
    expect(isStaleSocketError(err("socket reset", "ECONNRESET"))).toBe(true);
    expect(isStaleSocketError(err("pipe", "EPIPE"))).toBe(true);
    expect(isStaleSocketError(err("headers timeout", "UND_ERR_HEADERS_TIMEOUT"))).toBe(true);
  });

  test("proves socket death by message", () => {
    expect(isStaleSocketError(err("other side closed"))).toBe(true);
    expect(isStaleSocketError(err("socket hang up"))).toBe(true);
  });

  test("host-unreachable errors are never stale sockets", () => {
    expect(isStaleSocketError(err("not found", "ENOTFOUND"))).toBe(false);
    expect(isStaleSocketError(err("refused", "ECONNREFUSED"))).toBe(false);
    expect(isStaleSocketError(err("connect timeout", "UND_ERR_CONNECT_TIMEOUT"))).toBe(false);
  });

  test("aborts and ambiguous failures are excluded", () => {
    const aborted = new DOMException("aborted", "AbortError");
    expect(isStaleSocketError(aborted)).toBe(false);
    expect(isStaleSocketError(err("fetch failed"))).toBe(false);
  });
});

describe("NVIDIA NIM parameter quirks", () => {
  const base: CanonicalRequest = {
    model: "nvidia/nemotron-3.5-lightning",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };

  test("strips cross-wire fields NIM rejects", () => {
    const request: CanonicalRequest = {
      ...base,
      generation_controls: {
        "extension:client_metadata": { foo: "bar" },
        "extension:custom_field": "x",
        service_tier: "default",
        "extension:thinking_budget": 4000,
      },
    };
    const out = applyParamQuirks(request, "nvidia");
    expect(out.generation_controls["extension:client_metadata"]).toBeUndefined();
    expect(out.generation_controls["extension:custom_field"]).toBeUndefined();
    expect(out.generation_controls["extension:thinking_budget"]).toBeUndefined();
    expect(out.generation_controls.service_tier).toBeUndefined();
  });

  test("leaves other providers untouched", () => {
    const request: CanonicalRequest = {
      ...base,
      generation_controls: { service_tier: "default" },
    };
    expect(applyParamQuirks(request, "openrouter").generation_controls.service_tier).toBe("default");
  });
});

describe("SenseNova providers", () => {
  test("both realms expose chat and image rows", () => {
    for (const models of [SENSENOVA_MODELS, SENSENOVA_INTL_MODELS]) {
      expect(models.some((m) => m.serviceKind === "imageGeneration")).toBe(true);
      expect(models.some((m) => (m.serviceKind ?? "llm") === "llm")).toBe(true);
    }
  });

  test("specs target the right realms", () => {
    expect(SENSENOVA_SPEC.provider_id).toBe("sensenova");
    expect(SENSENOVA_INTL_SPEC.provider_id).toBe("sensenova-intl");
    expect(SENSENOVA_SPEC.endpoint_paths_by_wire_family?.["chat"]).toBe("/chat/completions");
  });
});
