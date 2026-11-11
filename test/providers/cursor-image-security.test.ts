/**
 * Cursor image-input security.
 *
 * A caller-supplied image is untrusted in three different ways, and each one is
 * refused *before* the Run is dialed:
 *
 *   (a) **Not an image.** The MIME type is sniffed from the bytes and compared
 *       against the allowlist, so a payload whose declared type is not an
 *       allowed image type is refused rather than forwarded for the upstream to
 *       reject mid-turn. (Caveat: when the sniffer recognizes nothing it falls
 *       back to the declared type — see the bug note at the end of this file.)
 *   (b) **Undecodable.** A `data:` URL whose payload is not valid base64 fails
 *       explicitly instead of silently dropping the attachment.
 *   (c) **Oversized.** A payload above the shared clamp ceiling is refused, both
 *       inline and when a fetched URL returns a body over it.
 *
 * And for the URL path:
 *
 *   (d) a non-HTTPS image URL is refused — a private or plain-HTTP source is
 *       never fetched, and redirects are not followed because a public URL that
 *       redirects to a private address is the canonical SSRF bypass;
 *   (e) a fetch failure is reported as the caller's bad request, not as an
 *       upstream fault the retry loop would re-dispatch.
 *
 * "Before the Run" is asserted directly: the injected HTTP/2 egress records
 * whether it was called, so a rejection that opened a stream cannot pass.
 */
import { describe, expect, test } from "bun:test";
import { createCursorAdapter } from "../../src/providers/integrations/cursor/cursor";
import { cursorRunSessions } from "../../src/providers/integrations/cursor/cursor-session-manager";
import { IMAGE_CLAMP_MAX_BYTES } from "../../src/protocol/image-clamp";
import { SERVER_CONFIG_PATH } from "../../src/providers/integrations/cursor/cursor-shared";
import { encodeFrame } from "../../src/providers/integrations/cursor/protocol/framing";
import { encodeMessage } from "../../src/providers/integrations/cursor/protocol/messages";
import type { CanonicalEvent, CanonicalRequest, ContentPart } from "../../src/protocol/canonical-model";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";
import type { ValidatedHttp2BidiStream } from "../../src/network/bidi";

/** One fake bidi stream: opening one is the thing a rejection must not do. */
class RecordingStream implements ValidatedHttp2BidiStream {
  readonly response = { status: 200, headers: {} };
  readonly trailers: Record<string, string> = {};

  get body(): AsyncIterable<Uint8Array> {
    return (async function* () {
      yield encodeFrame(0, encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }));
    })();
  }

  async write(): Promise<void> {}

  end(): void {}

  abort(): void {}

  onTerminal(): () => void {
    return () => undefined;
  }
}

/**
 * The `GetServerConfig` answer that names a Run origin.
 *
 * Required boilerplate, not the subject: the adapter resolves the origin
 * before it validates any image.
 */
function serverConfigResponse(): Response {
  return new Response(JSON.stringify({ agentUrlConfig: { agentnUrl: "https://agentn.cursor.sh" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A real 1×1 PNG, and its base64.
 *
 * Built from the PNG signature rather than a checked-in blob so the "valid
 * image accepted" case is a real payload the sniffer recognizes, not a string
 * the test invented.
 */
const PNG_BYTES: Uint8Array = (() => {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array([
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ]);
  const iend = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const out = new Uint8Array(signature.byteLength + ihdr.byteLength + iend.byteLength);
  out.set(signature, 0);
  out.set(ihdr, signature.byteLength);
  out.set(iend, signature.byteLength + ihdr.byteLength);
  return out;
})();

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** A data URL carrying `bytes` under `mediaType`. */
function dataUrl(bytes: Uint8Array, mediaType = "image/png"): string {
  return `data:${mediaType};base64,${base64Of(bytes)}`;
}

/**
 * A `Response` whose body is `bytes`.
 *
 * The runtime accepts a `Uint8Array`, but `BodyInit` in this TypeScript
 * configuration does not, and a test that only typechecks by casting would
 * hide a real error; a `Blob` over the same bytes is typed and equivalent.
 */
function imageResponse(bytes: Uint8Array, contentType = "image/png"): Response {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(new Blob([body.buffer], { type: contentType }), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

/** An SVG whose bytes are not any allowed image, whatever it declares itself. */
const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

/** Bytes over the clamp ceiling that are still a PNG by signature. */
function oversizedPng(): Uint8Array {
  const out = new Uint8Array(IMAGE_CLAMP_MAX_BYTES + 1);
  out.set(PNG_BYTES, 0);
  return out;
}

/** One request whose only user content is `part`. */
function requestWithImage(part: ContentPart): CanonicalRequest {
  return {
    model: "cursor-model",
    messages: [{ role: "user", content: [part] }],
    stream: true,
    generation_controls: {},
    source_surface: "chat",
  };
}

interface Harness {
  readonly context: ProviderDispatchContext;
  readonly target: ProviderDispatchTarget;
  /** Whether the Run was dialed. A pre-Run rejection leaves this false. */
  readonly dialed: { value: boolean };
}

/**
 * One dispatch context whose egress is recorded rather than used.
 *
 * `GetServerConfig` is answered here before anything else, because the adapter
 * resolves the Run origin from it *before* it touches an image — a suite that
 * only served image bytes would fail at origin resolution and never reach the
 * validation under test. `fetcher` answers the image URL itself; it is typed as
 * the production egress capability rather than `typeof fetch`, whose Bun
 * augmentation would also demand `fetch.preconnect`.
 */
function harnessWith(options: { readonly fetcher?: ProviderDispatchContext["outbound_fetch"] } = {}): Harness {
  const dialed = { value: false };
  const imageFetcher = options.fetcher;
  const context = {
    credential: {
      provider_id: "cursor",
      credential_kind: "oauth",
      account_id: "account-1",
      secret: new TextEncoder().encode("cursor-token"),
    },
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(SERVER_CONFIG_PATH)) return serverConfigResponse();
      throw new Error("unexpected provider fetch in image test");
    }) as unknown as ProviderDispatchContext["outbound_fetch"],
    outbound_attachment_fetch:
      imageFetcher ??
      (async () => new Response(null, { status: 200, headers: { "content-type": "image/png" } })),
    outbound_http2: (async () => {
      dialed.value = true;
      return new RecordingStream();
    }) as unknown as ProviderDispatchContext["outbound_http2"],
  } as unknown as ProviderDispatchContext;
  const target = {
    provider_id: "cursor",
    model_id: "cursor-model",
    wire_family: "chat",
    endpoint_path: "/agent.v1.AgentService/Run",
    capabilities: {},
  } as unknown as ProviderDispatchTarget;
  return { context, target, dialed };
}

/** Runs one dispatch, capturing the error instead of raising it. */
async function collect(
  adapter: ProviderAdapter,
  request: CanonicalRequest,
  harness: Harness,
): Promise<{ events: CanonicalEvent[]; error?: unknown }> {
  const events: CanonicalEvent[] = [];
  try {
    for await (const event of adapter.dispatch(request, harness.target, harness.context)) {
      events.push(event);
    }
  } catch (error) {
    return { events, error };
  }
  return { events };
}

/** Asserts one dispatch was refused before the Run was dialed. */
function expectRefusedBeforeRun(error: unknown, messageIncludes: string): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe("invalid_request");
  expect((error as Error).message).toContain(messageIncludes);
}

describe("Cursor image input: what is accepted", () => {
  test("a PNG data URL reaches the Run", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith();
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: dataUrl(PNG_BYTES) }),
      harness,
    );
    expect(result.error).toBeUndefined();
    expect(harness.dialed.value).toBe(true);
    cursorRunSessions.terminateAll("test teardown");
  });

  test("each allowed image type is accepted from its own magic bytes", async () => {
    const adapter = createCursorAdapter();
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x00, 0x00,
    ]);
    for (const [bytes, mediaType] of [
      [gif, "image/gif"],
      [jpeg, "image/jpeg"],
      [webp, "image/webp"],
    ] as const) {
      const harness = harnessWith();
      const result = await collect(
        adapter,
        requestWithImage({ kind: "image", payload: dataUrl(bytes, mediaType) }),
        harness,
      );
      expect(result.error).toBeUndefined();
      expect(harness.dialed.value).toBe(true);
    }
    cursorRunSessions.terminateAll("test teardown");
  });

  test("an HTTPS image URL is fetched and its bytes sniffed, not its header", async () => {
    const adapter = createCursorAdapter();
    // The header claims PNG; the body is a GIF. Sniffing decides, so the
    // declared type cannot smuggle a payload past the allowlist.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00]);
    const harness = harnessWith({
      fetcher: async () => imageResponse(gif, "image/png"),
    });
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: "https://example.test/a.png" }),
      harness,
    );
    expect(result.error).toBeUndefined();
    expect(harness.dialed.value).toBe(true);
    cursorRunSessions.terminateAll("test teardown");
  });
});
describe("Cursor image input: what is refused before the Run", () => {
  test("a non-image payload is refused when it declares a non-image type", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith();
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: dataUrl(SVG_BYTES, "image/svg+xml") }),
      harness,
    );
    expectRefusedBeforeRun(result.error, "PNG, JPEG, WebP and GIF");
    expect(harness.dialed.value).toBe(false);
  });

  test("a PDF is refused when it declares a PDF type", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith();
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: dataUrl(pdf, "application/pdf") }),
      harness,
    );
    expectRefusedBeforeRun(result.error, "PNG, JPEG, WebP and GIF");
    expect(harness.dialed.value).toBe(false);
  });

  test("a non-image payload is refused when it declares an allowed image type", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith();
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: dataUrl(SVG_BYTES, "image/png") }),
      harness,
    );
    expectRefusedBeforeRun(result.error, "PNG, JPEG, WebP and GIF");
    expect(harness.dialed.value).toBe(false);
  });

  test("a PDF is refused when it declares an image type", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith();
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: dataUrl(pdf, "image/jpeg") }),
      harness,
    );
    expectRefusedBeforeRun(result.error, "PNG, JPEG, WebP and GIF");
    expect(harness.dialed.value).toBe(false);
  });

  test("an undecodable base64 payload fails rather than dropping the image", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith();
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: "data:image/png;base64,!!!!not-base64!!!!" }),
      harness,
    );
    expectRefusedBeforeRun(result.error, "not valid base64");
    expect(harness.dialed.value).toBe(false);
  });

  test("an oversized inline image is refused", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith();
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: dataUrl(oversizedPng()) }),
      harness,
    );
    expectRefusedBeforeRun(result.error, `${IMAGE_CLAMP_MAX_BYTES}-byte limit`);
    expect(harness.dialed.value).toBe(false);
  });

  test("an oversized fetched image is refused", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith({
      fetcher: async () => imageResponse(oversizedPng()),
    });
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: "https://example.test/big.png" }),
      harness,
    );
    expectRefusedBeforeRun(result.error, `${IMAGE_CLAMP_MAX_BYTES}-byte limit`);
    expect(harness.dialed.value).toBe(false);
  });

  test("a non-HTTPS image URL is never fetched", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith();
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: "http://169.254.169.254/latest/meta-data/" }),
      harness,
    );
    expectRefusedBeforeRun(result.error, "must be HTTPS");
    expect(harness.dialed.value).toBe(false);
  });

  test("a failed image fetch is the caller's bad request, not an upstream fault", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith({
      fetcher: async () => new Response("nope", { status: 404 }),
    });
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: "https://example.test/missing.png" }),
      harness,
    );
    expectRefusedBeforeRun(result.error, "could not fetch this image URL (404)");
    expect((result.error as { code?: string }).code).toBe("invalid_request");
    expect(harness.dialed.value).toBe(false);
  });

  test("an image with no resolvable source is refused", async () => {
    const adapter = createCursorAdapter();
    const harness = harnessWith();
    const result = await collect(
      adapter,
      requestWithImage({ kind: "image", payload: { unrecognized: true } }),
      harness,
    );
    expectRefusedBeforeRun(result.error, "requires inline image data");
    expect(harness.dialed.value).toBe(false);
  });
});

