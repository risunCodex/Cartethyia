/**
 * Minimal HTTP probe helpers.
 *
 * A probe needs to see what the upstream answers for a given header/body
 * combination without committing to a full stream: fetch once, read the first
 * bytes, then cancel and free the connection. This module enforces a timeout
 * on every request so a hung upstream can never hang the probe.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface ProbeResponse {
  readonly status: number;
  readonly ok: boolean;
  /** First chunk(s) decoded, whitespace-collapsed, capped for display. */
  readonly head: string;
  /** Content-Type header value; empty string when the header is absent. */
  readonly contentType: string;
}

const HEAD_CAP = 160;

export interface ProbeOptions {
  readonly timeoutMs?: number;
  /** Max text body length to retain for parsing (default 4000). */
  readonly bodyCap?: number;
}

/**
 * POSTs `body` to `url` with `headers`, reads the first bytes of the
 * response, cancels the stream, and returns status + a capped text head.
 */
export async function probePost(
  url: string,
  headers: Record<string, string>,
  body: BodyInit,
  opts: ProbeOptions = {},
): Promise<ProbeResponse> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body) return { status: response.status, ok: response.ok, head: "", contentType };
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      if (!first.value || first.value.byteLength === 0) return { status: response.status, ok: response.ok, head: "", contentType };
      const text = new TextDecoder().decode(first.value).replace(/\s+/g, " ");
      return { status: response.status, ok: response.ok, head: text.slice(0, HEAD_CAP), contentType };
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms (${url})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends a request with an optional body via node's http(s) client.
 *
 * Some upstreams validate a signature over the body on a GET (Qoder's model
 * list does), and `fetch` rejects `GET` + body. This helper exists for those
 * cases: it performs the request with `node:https`/`node:http` so a GET can
 * carry a body the way the real client sends it.
 */
function rawRequest(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body: Uint8Array | undefined,
  timeoutMs: number,
): Promise<{ status: number; contentType: string; text: string }> {
  const u = new URL(url);
  const mod = u.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = mod(
      u,
      {
        method,
        headers: {
          ...headers,
          ...(body !== undefined ? { "Content-Length": String(body.byteLength) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            contentType: (res.headers["content-type"] as string | undefined) ?? "",
            text,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms (${url})`));
    });
    req.on("error", (err) => reject(err));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * GETs `url` with `headers`, optionally carrying `body` (for servers that
 * validate the signature over a GET body), and returns the full text body
 * (capped).
 */
export async function probeGet(
  url: string,
  headers: Record<string, string>,
  opts: ProbeOptions & { readonly body?: Uint8Array } = {},
): Promise<ProbeResponse & { readonly body: string }> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const bodyCap = opts.bodyCap ?? 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { status, contentType, text } = await rawRequest(url, "GET", headers, opts.body, timeoutMs);
    return {
      status,
      ok: status >= 200 && status < 300,
      contentType,
      head: text.replace(/\s+/g, " ").slice(0, HEAD_CAP),
      body: text.slice(0, bodyCap),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms (${url})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Formats one probe result for console output (never includes the body). */
export function formatProbe(label: string, res: ProbeResponse): string {
  const lines = [`[${label}] status=${res.status}${res.ok ? "" : " (not ok)"}`];
  if (res.contentType !== undefined) lines.push(`  content-type: ${res.contentType}`);
  if (res.head.length > 0) lines.push(`  head: ${JSON.stringify(res.head)}`);
  return lines.join("\n");
}
