/**
 * Devin unary Connect-RPC client (`application/proto`).
 *
 * Responses may arrive as raw protobuf or gzipped protobuf (Connect servers
 * compress when the client advertises `connect-accept-encoding: gzip`), so
 * decode always has a gunzip fallback. Ported from oh-my-pi
 * (`packages/catalog/src/wire/devin-proto.ts` + `discovery/devin.ts`, MIT).
 */

import { gunzipSync } from "node:zlib";
import type { Type } from "protobufjs";
import { GatewayError } from "../../../protocol/gateway-error";
import { DEVIN_CONNECT_UA } from "./devin-shared";

export interface DevinUnaryOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Include `connect-go` User-Agent (chat path) rather than plain unary. */
  readonly connectGoUA?: boolean;
}

/** Calls one unary RPC and decodes the response message. */
export async function callDevinUnary<T extends object>(
  path: string,
  requestType: Type,
  responseType: Type,
  request: object,
  options: DevinUnaryOptions = {},
): Promise<T> {
  const baseUrl = (options.baseUrl ?? "https://server.codeium.com").replace(/\/+$/, "");
  const fetcher = options.fetchImpl ?? fetch;
  const body = Buffer.from(requestType.encode(request).finish());

  const headers: Record<string, string> = {
    "content-type": "application/proto",
    "connect-protocol-version": "1",
    accept: "*/*",
  };
  if (options.connectGoUA) headers["user-agent"] = DEVIN_CONNECT_UA;

  const signal =
    options.signal === undefined
      ? options.timeoutMs !== undefined
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined
      : options.timeoutMs !== undefined
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
        : options.signal;

  const response = await fetcher(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body,
    ...(signal === undefined ? {} : { signal }),
  });

  const buf = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = buf.subarray(0, 2048).toString("utf8");
    throw new GatewayError(
      "upstream_unprocessable",
      response.status,
      `Devin upstream error ${response.status}: ${text} (request {requestId})`,
      { providerId: "devin", upstreamCode: String(response.status) },
      "upstream",
    );
  }

  return decodeDevinUnary<T>(responseType, buf);
}

/** Decodes a unary response, trying raw protobuf then gunzip. */
export function decodeDevinUnary<T extends object>(type: Type, buf: Buffer): T {
  try {
    return type.decode(buf) as T;
  } catch {
    try {
      return type.decode(gunzipSync(buf)) as T;
    } catch {
      throw new GatewayError(
        "internal_error",
        500,
        "Devin upstream returned an undecodable response (request {requestId})",
        { providerId: "devin" },
        "upstream",
      );
    }
  }
}
