/**
 * Qoder COSY Bearer signer — the scheme the native chat surface uses.
 *
 * Reimplemented from the unpacked Qoder JetBrains plugin / desktop client
 * (see documentation/archive/research/qoder/2026-11-01-qoder-chat-wire-verification.md).
 * The same constants live in src/providers/integrations/qoder/qoder.ts; this
 * module is a self-contained copy so probes can run without importing the
 * gateway.
 *
 * Wire shape (as verified live):
 *   - body is base64, split into thirds and rotated, then each char mapped
 *     through a scrambled alphabet (`=` becomes `$`)
 *   - a per-request AES-128-CBC key encrypts a compact JSON identity; the key
 *     itself is RSA-encrypted (PKCS#1) into `cosy-key`
 *   - the Authorization header is `Bearer COSY.{payload}.{signature}` where
 *     signature = md5(payload \n cosyKey \n date \n body(latin1) \n sigPath)
 */
import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";

const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_APPCODE = "cosy";
const QODER_SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";

const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export interface QoderProbeAuth {
  readonly userId: string;
  readonly userName: string;
  readonly userType: string;
  readonly securityOauthToken: string;
  readonly refreshToken: string;
}

function md5(value: string | Uint8Array): string {
  return createHash("md5").update(value).digest("hex");
}

/** Canonical compact JSON: keys sorted, no whitespace, null/undefined → "". */
function sortedCompact(map: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(map).sort()) {
    const value = map[key] === null || map[key] === undefined ? "" : map[key];
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Strips a leading `/algo` segment from a URL path, as the signer expects. */
export function qoderPathSignature(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith("/algo") ? path.slice(5) : path;
}

/** The scrambled alphabet body encoding the wire uses. */
export function transformQoderBody(plaintext: string): Buffer {
  const base64 = Buffer.from(plaintext).toString("base64");
  const third = Math.floor(base64.length / 3);
  const reordered =
    base64.slice(base64.length - third) +
    base64.slice(third, base64.length - third) +
    base64.slice(0, third);
  let encoded = "";
  for (const char of reordered) {
    if (char === "=") encoded += "$";
    else encoded += QODER_ALPHABET[QODER_STANDARD_ALPHABET.indexOf(char)] ?? char;
  }
  return Buffer.from(encoded, "latin1");
}

/**
 * Builds the COSY Bearer request headers for one signed chat request.
 *
 * `rawBody` is the plain JSON string the client would send; it is encoded
 * with `transformQoderBody` and hashed/measured for the signing chain.
 */
export function buildCosyHeaders(
  url: string,
  rawBody: string,
  auth: QoderProbeAuth,
  version: string,
): Record<string, string> {
  const body = transformQoderBody(rawBody);
  const key = randomUUID().replaceAll("-", "").slice(0, 16);
  const identity = sortedCompact({
    name: auth.userName,
    aid: auth.userId,
    uid: auth.userId,
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: auth.userType,
    security_oauth_token: auth.securityOauthToken,
    refresh_token: auth.refreshToken,
  });
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(key));
  const info = Buffer.concat([cipher.update(identity), cipher.final()]).toString("base64");
  const cosyKey = publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(key),
  ).toString("base64");
  const payload = Buffer.from(
    sortedCompact({ version: "v1", requestId: randomUUID(), info, cosyVersion: version, ideVersion: "" }),
  ).toString("base64");
  const date = String(Math.floor(Date.now() / 1000));
  const signature = md5(`${payload}\n${cosyKey}\n${date}\n${body.toString("latin1")}\n${qoderPathSignature(url)}`);
  return {
    authorization: `Bearer COSY.${payload}.${signature}`,
    "cosy-data-policy": "agree",
    "cosy-machinetype": "5",
    "cosy-machineos": "aarch64_macos",
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": auth.userId,
    "cosy-key": cosyKey,
    "cosy-bodyhash": md5(body),
    "cosy-bodylength": String(body.byteLength),
    "cosy-sigpath": qoderPathSignature(url),
    "cosy-organization-id": "",
    "cosy-organization-tags": "",
    "x-request-id": randomUUID(),
    "cosy-business-product": "cli",
    "cosy-business-type": "agent",
    "cosy-business-version": version,
    "cosy-scene": "assistant",
    "cosy-version": version,
    "login-version": "v2",
    appcode: QODER_APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    date: new Date().toUTCString(),
    signature: md5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${new Date().toUTCString()}`),
    "content-type": "application/json",
    "user-agent": "Go-http-client/2.0",
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
}
