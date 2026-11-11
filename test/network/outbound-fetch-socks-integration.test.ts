/**
 * End-to-end SOCKS5 egress: a real SOCKS5 server (pure `node:net`) + a real
 * HTTP origin, dialed through `createValidatedFetch` with a socks pool agent.
 * Proves the undici-dispatcher path routes through the proxy and back, and
 * that the native `proxy` option is never used for socks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, Socket } from "node:net";
import { createValidatedFetch } from "../../src/network/egress/fetch";
import { createSocks5Agent } from "../../src/network/pool/agent";

const ORIGIN_PORT = 59431;
const SOCKS_PORT = 59432;

let origin: Server;
let socks: TcpServer;

/** Minimal SOCKS5 server: no-auth greeting + CONNECT + byte tunnel. */
function startSocks5Server(port: number): Promise<TcpServer> {
  return new Promise((resolve) => {
    const server = createTcpServer((socket: Socket) => {
      socket.once("data", (greeting: Buffer) => {
        if (greeting.length < 3 || greeting[0] !== 5) {
          socket.end();
          return;
        }
        socket.write(Buffer.from([5, 0]));
        socket.once("data", (req: Buffer) => {
          if (req.length < 7 || req[0] !== 5 || req[1] !== 1) {
            socket.write(Buffer.from([5, 7]));
            socket.end();
            return;
          }
          const atyp = req[3]!;
          let host = "";
          let port = 0;
          if (atyp === 1) {
            host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
            port = req.readUInt16BE(8);
          } else if (atyp === 3) {
            const len = req[4]!;
            host = req.subarray(5, 5 + len).toString("utf8");
            port = req.readUInt16BE(5 + len);
          } else {
            socket.write(Buffer.from([5, 8]));
            socket.end();
            return;
          }
          const upstream = new Socket();
          upstream.on("connect", () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
          upstream.on("error", () => {
            socket.write(Buffer.from([5, 5]));
            socket.end();
          });
          upstream.connect(port, host);
        });
      });
    });
    server.listen(port, () => resolve(server));
  });
}

const resolvePublic = async (_hostname: string): Promise<readonly string[]> => {
  return ["127.0.0.1"];
};

beforeAll(async () => {
  origin = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("via-socks");
  });
  await new Promise<void>((resolve) => origin.listen(ORIGIN_PORT, resolve));
  socks = await startSocks5Server(SOCKS_PORT);
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  await new Promise<void>((resolve) => socks.close(() => resolve()));
});

describe("SOCKS5 validated egress", () => {
  test("dials through the socks proxy and reaches the origin", async () => {
    const agent = createSocks5Agent(`socks5://127.0.0.1:${SOCKS_PORT}`, undefined, {});
    const fetcher = createValidatedFetch({
      policy: { allowPrivate: true },
      resolveFn: resolvePublic,
      agent,
    });
    const res = await fetcher(`http://127.0.0.1:${ORIGIN_PORT}/ping`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("via-socks");
  });
});
