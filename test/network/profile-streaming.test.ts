import { describe, expect, test } from "bun:test";
import { createValidatedFetch } from "../../src/network/egress/fetch";

describe("createValidatedFetch streaming with TLS profile", () => {
  test("profile dial resolves as soon as headers arrive and delivers incremental chunks", async () => {
    // A tiny local TLS server that sends headers immediately, then three body
    // chunks on separate ticks. The fetch must resolve on headers (20ms-ish)
    // and yield the chunks as separate read() results — not buffer the whole
    // body before resolving.
    const { readFileSync } = await import("node:fs");
    const tls = await import("node:tls");
    const key = readFileSync("test/fixtures/localhost-key.pem");
    const cert = readFileSync("test/fixtures/localhost-cert.pem");
    const body = "data: first\n\ndata: second\n\ndata: third\n\n";
    const server = tls.createServer({ key, cert });
    server.on("secureConnection", (sock: unknown) => {
      const s = sock as { write(s: string): void };
      s.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${body.length}\r\n\r\n`);
      s.write(body.slice(0, 12));
      setTimeout(() => s.write(body.slice(12, 24)), 150);
      setTimeout(() => s.write(body.slice(24)), 300);
    });
    await new Promise<void>((resolve) => {
      server.listen(4603, "127.0.0.1", () => resolve());
    });

    try {
      const fetchFn = createValidatedFetch({
        tlsProfile: "qoder-app",
        policy: { allowPrivate: true },
        ca: Buffer.from(readFileSync("test/fixtures/localhost-cert.pem")),
      });
      const t0 = Date.now();
      const res = await fetchFn("https://127.0.0.1:4603/stream", { method: "GET" });
      const headersMs = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(headersMs).toBeLessThan(1500);

      const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const parts: string[] = [];
      let firstChunkMs = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkMs === 0) firstChunkMs = Date.now() - t0;
        parts.push(Buffer.from(value).toString());
      }
      expect(parts.join("")).toBe(body);
      expect(firstChunkMs).toBeLessThan(1500);
    } finally {
      server.close();
    }
  });
});
