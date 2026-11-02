/**
 * Wire-family and surface contract coverage.
 *
 * The gateway understands each wire shape twice: the registry codecs
 * (`src/protocol/registry.ts`) for the OpenAI-compatible adapters, and the
 * bespoke per-integration builders for the branded providers. The two trees
 * must stay in step with the canonical model, and the client-surface map must
 * stay one-to-one. These tests pin the structural invariants around that
 * contract so a drift is a failing test, not a silent mis-encode.
 */
import { describe, expect, test } from "bun:test";
import { encodeWireRequest } from "../../src/protocol/registry";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import {
  SurfaceAdapterRegistry,
  SURFACE_DESCRIPTORS,
} from "../../src/transport/surface/adapters";

function minimalRequest(): CanonicalRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

describe("wire-family codec coverage", () => {
  test("registry encodes a request for every non-native wire family", async () => {
    for (const family of ["chat", "responses", "messages"] as const) {
      const payload = await encodeWireRequest(family, minimalRequest());
      expect(payload).toBeTypeOf("object");
      expect(Object.keys(payload).length).toBeGreaterThan(0);
    }
  });

  test("gemini has no registry codec — it dispatches through its native path", async () => {
    await expect(encodeWireRequest("gemini", minimalRequest())).rejects.toThrow();
  });
});

describe("client surface map", () => {
  test("every descriptor names a distinct surface and path prefix", () => {
    const surfaces = new Set(SURFACE_DESCRIPTORS.map((d) => d.surface));
    const prefixes = new Set(SURFACE_DESCRIPTORS.map((d) => d.pathPrefix));
    expect(surfaces.size).toBe(SURFACE_DESCRIPTORS.length);
    expect(prefixes.size).toBe(SURFACE_DESCRIPTORS.length);
  });

  test("detection maps each canonical endpoint to exactly its surface", () => {
    const registry = new SurfaceAdapterRegistry(
      SURFACE_DESCRIPTORS.map((d) => ({
        surface: d.surface,
        matchesBodyShape: () => false,
      })),
    );
    for (const d of SURFACE_DESCRIPTORS) {
      const detected = registry.detectOnce({
        body: {},
        headers: {},
        path: d.pathPrefix,
      });
      expect(detected.surface).toBe(d.surface);
    }
  });
});
