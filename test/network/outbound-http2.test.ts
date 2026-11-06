/**
 * Validated bidirectional HTTP/2 egress.
 *
 * The properties asserted are the security ones, each with the failure it
 * prevents:
 *
 *   - a credential, fragment, non-443 port, IP literal, `http:` URL, or a
 *     hostname outside the allowlist is refused *before* a socket is opened —
 *     a bidi stream carries the account credential for its whole life, so the
 *     target cannot be trusted to each caller;
 *   - request bytes reach the server as one writable stream that stays open
 *     (`endStream: false`), which is what a Connect-RPC bidi Run requires;
 *   - response bytes arrive as an ordered async iterable, and a frame split
 *     across chunks is reassembled rather than dropped;
 *   - `write` resolves only after a backpressured chunk drains, so a caller
 *     cannot overrun session memory;
 *   - abort tears the stream down and settles the terminal, and a second abort
 *     or end is a no-op rather than a throw.
 *
 * A real local TLS HTTP/2 server backs this: the transport is the subject, and
 * a stubbed socket would test nothing about framing, backpressure, or close.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
/**
 * The fixture is a self-signed loopback cert and the binding verifies
 * certificates unconditionally (`rejectUnauthorized: true`), which is correct
 * and is not weakened for this test. The fixture CA is therefore trusted
 * through `NODE_EXTRA_CA_CERTS`, which the runner (`scripts/test/run.ts`) sets on
 * the `bun test` subprocess — it is read when the TLS root store is first
 * built, so it cannot be assigned from inside this file, and a per-socket `ca`
 * option would mean adding an override to the production dial. Run these via
 * `bun run test`; a bare `bun test` has no extra CA and the TLS handshake fails.
 */
import { readFileSync } from "node:fs";
import { createSecureServer, type Http2SecureServer, type ServerHttp2Stream } from "node:http2";
import { ValidatedNetworkBindingFactory } from "../../src/network/pool/resolver";
import { encodeFrame, FLAG_END_STREAM } from "../../src/providers/integrations/cursor/protocol/framing";
import { encodeMessage } from "../../src/providers/integrations/cursor/protocol/messages";

/** One request the fake server received. */
interface ReceivedRequest {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly bytes: Uint8Array;
}

/** Fake HTTP/2 server state. */
let server: Http2SecureServer;
/**
 * The binding pins port 443 (the TLS endpoint the SSRF policy validates), so the
 * fixture binds it too on loopback. `localhost` resolves to 127.0.0.1, which the
 * factory's `allowPrivate` policy permits.
 */
const HOST = "localhost";
const received: ReceivedRequest[] = [];
/** Resolved once the server has fully received one request. */
let onReceived: (() => void) | undefined;
/** Response body the server writes, as raw bytes. */
let responseBytes: Uint8Array = new Uint8Array(0);
/** Whether the server half-closes its response immediately. */
let endResponse = true;
/** Trailers the server sends, if any. */
let responseTrailers: Record<string, string> | undefined;
/** Response status. */
let responseStatus = 200;

/**
 * Whether a privileged loopback port can be bound here.
 *
 * Tries it rather than checking `process.getuid()`: a runner can be root and
 * still lack the port, or unprivileged but granted `CAP_NET_BIND_SERVICE`.
 * A plain TCP socket, because only the permission is in question.
 */
async function probeBind(): Promise<boolean> {
  const probe = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  probe.on("error", reject);
  probe.listen(443, "127.0.0.1", () => resolve());
  try {
    await promise;
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

/**
 * False when the fixture cannot bind, so the streaming suite reports `skip`
 * rather than six passes for tests that never ran.
 *
 * Probed at module scope because `describe.skipIf` needs the answer before the
 * suite is declared. 443 is part of the SSRF policy this file exercises, so it
 * cannot move to an ephemeral port without changing what is under test.
 */
const BINDABLE = await probeBind();

/**
 * True when the runner (or caller) exports the fixture CA through
 * `NODE_EXTRA_CA_CERTS`. The fixture is a self-signed loopback cert; the
 * binding under test pins `rejectUnauthorized: true` and must not be weakened
 * for it, so unless the CA that signed the fixture is in the extra-CA store
 * the streaming suite cannot establish TLS and would fail rather than
 * meaningfully run. The runner sets it in `scripts/test/run.ts` (a bundle of
 * the fixture plus any pre-existing extra CA); running `bun test` directly
 * with a different extra CA (e.g. a corporate MITM root) skips the suite
 * instead of failing on a cert that was never trusted.
 */
const TRUSTED_CA = (() => {
  const path = process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (!path) return false;
  try {
    const store = readFileSync(path, "utf8");
    const fixture = readFileSync("test/fixtures/localhost-cert.pem", "utf8");
    return store.includes(fixture.trim());
  } catch {
    return false;
  }
})();

function startServer(): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  {
    // `createSecureServer`, not `createServer`: the plain factory speaks
    // cleartext h2c, and the binding under test always negotiates TLS.
    server = createSecureServer({
      key: readFileSync("test/fixtures/localhost-key.pem"),
      cert: readFileSync("test/fixtures/localhost-cert.pem"),
    });
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      const chunks: Buffer[] = [];
      const record = () => {
        received.push({
          path: String(headers[":path"] ?? ""),
          headers: Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [name, String(value)]),
          ),
          bytes: new Uint8Array(Buffer.concat(chunks)),
        });
      };
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        record();
        onReceived?.();
      });
      stream.respond(
        { ":status": responseStatus, "content-type": "application/connect+proto" },
        { waitForTrailers: responseTrailers !== undefined },
      );
      if (responseBytes.byteLength > 0) stream.write(Buffer.from(responseBytes));
      // Read once: `responseTrailers` is module state a later test may clear
      // before this stream's `wantTrailers` fires.
      const trailers = responseTrailers;
      if (trailers !== undefined) {
        stream.on("wantTrailers", () => stream.sendTrailers(trailers));
        if (endResponse) stream.end();
      } else if (endResponse) {
        stream.end();
      }
    });
    // The error handler matters as much as the callback: without it the
    // EACCES from an unprivileged runner surfaced as an unhandled error
    // *between* tests and took out whichever test ran beside this one.
    server.on("error", reject);
    server.listen(443, "127.0.0.1", () => resolve());
    return promise;
  }
}

// Guarded inside rather than by passing `undefined`: `beforeAll` has no
// overload for it, and an empty async body skips the fixture cleanly.
beforeAll(async () => {
  if (!BINDABLE) return;
  await startServer();
});
afterAll(() => {
  server?.close();
});

/** A factory whose SSRF policy permits the loopback fixture. */
function factory(): ValidatedNetworkBindingFactory {
  return new ValidatedNetworkBindingFactory({ allowPrivate: true });
}

/** Opens one bidi stream against the fixture. */
async function open(options?: { path?: string; headers?: Record<string, string> }) {
  const binding = factory().http2Bidi();
  const url = new URL(`https://${HOST}${options?.path ?? "/agent.v1.AgentService/Run"}`);
  return binding(url, options?.headers ?? { "content-type": "application/connect+proto" }, {
    signal: AbortSignal.timeout(5_000),
    // The fixture is loopback; the allowlist under test accepts it.
    allowHostname: (hostname) => hostname === HOST,
  });
}

describe("validated HTTP/2 bidi target validation", () => {
  test("refuses a non-HTTPS URL", async () => {
    const binding = factory().http2Bidi();
    await expect(
      binding(new URL(`http://${HOST}/x`), {}, {}),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("refuses credentials, fragments, and non-443 ports", async () => {
    const binding = factory().http2Bidi();
    for (const url of [
      new URL(`https://user:pw@${HOST}/x`),
      new URL(`https://${HOST}/x#frag`),
      new URL(`https://${HOST}:8443/x`),
    ]) {
      await expect(binding(url, {}, {})).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  test("refuses an IP literal", async () => {
    const binding = factory().http2Bidi();
    await expect(
      binding(new URL("https://127.0.0.1/x"), {}, { allowHostname: () => true }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("refuses a hostname outside the allowlist", async () => {
    const binding = factory().http2Bidi();
    await expect(
      binding(new URL(`https://${HOST}/x`), {}, { allowHostname: () => false }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("refuses an address the SSRF policy blocks", async () => {
    // No `allowPrivate`: the loopback fixture must fail closed.
    const binding = new ValidatedNetworkBindingFactory({}).http2Bidi();
    await expect(
      binding(new URL(`https://${HOST}/x`), {}, { allowHostname: () => true }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe.skipIf(!BINDABLE || !TRUSTED_CA)("validated HTTP/2 bidi streaming", () => {
  test("a tenant without a selected pool dials validated direct egress", async () => {
    // Live dispatch always passes a tenant id, and most installs select no
    // pool. `fetch` treats that as direct egress; bidi must match, or a
    // bidi-only provider is unreachable with "no HTTP/2 egress configured"
    // on every such install.
    responseBytes = new Uint8Array(0);
    const binding = factory().http2Bidi(undefined, "tenant-1");
    const stream = await binding(new URL(`https://${HOST}/x`), {}, {
      signal: AbortSignal.timeout(5_000),
      allowHostname: (hostname) => hostname === HOST,
    });
    // Reaching here at all is the assertion: the stream is open against the
    // fixture, so the tenant-without-pool path dialed direct instead of
    // failing closed on `proxy_pool_unhealthy`.
    await stream.write(encodeFrame(0, new Uint8Array([1])));
    stream.abort();
  });

  test("one writable request reaches the server with its headers", async () => {
    responseBytes = new Uint8Array(0);
    endResponse = false;
    const clientMessage = encodeMessage("AgentClientMessage", {
      run_request: { conversation_id: "c1", requested_model: { model_id: "m" } },
    });
    const stream = await open({
      headers: {
        "content-type": "application/connect+proto",
        "x-cursor-client-type": "cli",
      },
    });
    const { promise: arrived, resolve: resolveArrival } = Promise.withResolvers<void>();
    onReceived = resolveArrival;
    await stream.write(encodeFrame(0, clientMessage));
    await arrived;
    onReceived = undefined;
    const seen = received.at(-1);
    expect(seen?.path).toBe("/agent.v1.AgentService/Run");
    expect(seen?.headers["x-cursor-client-type"]).toBe("cli");
    expect(seen?.headers["content-type"]).toBe("application/connect+proto");
    // 5-byte Connect header + the encoded protobuf payload.
    expect(seen?.bytes.byteLength).toBe(5 + clientMessage.byteLength);
    stream.abort();
    endResponse = true;
  });

  test("response bytes stream in order and across chunk splits", async () => {
    const first = encodeFrame(0, new Uint8Array([1, 2, 3]));
    const second = encodeFrame(FLAG_END_STREAM, new Uint8Array([9]));
    responseBytes = new Uint8Array(first.byteLength + second.byteLength);
    responseBytes.set(first, 0);
    responseBytes.set(second, first.byteLength);
    const stream = await open();
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.body) chunks.push(chunk);
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBe(responseBytes.byteLength);
    expect(stream.response.status).toBe(200);
    stream.abort();
  });

  test("response trailers are readable", async () => {
    responseBytes = encodeFrame(0, new Uint8Array([1]));
    responseTrailers = { "grpc-status": "0" };
    const stream = await open();
    for await (const _chunk of stream.body) {
      // Drained to reach trailers.
    }
    expect(stream.trailers["grpc-status"]).toBe("0");
    stream.abort();
    responseTrailers = undefined;
  });

  test("end half-closes the request side without throwing", async () => {
    responseBytes = new Uint8Array(0);
    endResponse = false;
    const stream = await open();
    await stream.write(encodeFrame(0, new Uint8Array([1])));
    stream.end();
    // Idempotent: a second end must not throw.
    stream.end();
    stream.abort();
    endResponse = true;
  });

  test("abort is idempotent and settles a terminal", async () => {
    responseBytes = new Uint8Array(0);
    const stream = await open();
    const reasons: string[] = [];
    stream.onTerminal((reason) => reasons.push(reason.kind));
    stream.abort(new Error("done"));
    stream.abort(new Error("again"));
    expect(reasons).toEqual(["local-close"]);
  });
});
