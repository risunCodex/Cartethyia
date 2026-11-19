/**
 * Qoder COSY signing — AES-128-CBC identity encryption + RSA PKCS1 key +
 * md5 chain, and the alphabet-scrambled body transform. This is the donor of
 * the WASM `prepareInferRequest` output of the real client, and the only chat
 * surface a free/lite account can use.
 *
 * Header values mirror live captures of the real client (worker-core
 * 1.1.86-hotfix.5, 2026-11-17): machine identity headers from the UMID
 * (`cosy-machineid/token/type/code/os/hostname`), business headers, and the
 * static `signature` md5 chain. `cosy-clienttype: 10`, `cosy-business-product:
 * app`, `cosy-scene: app` for the app surface; the CLI core sends `5`/`cli`/
 * `assistant`. Both profiles carry `traceparent`, `sec-fetch-mode: cors`,
 * `accept-language: *`, and `accept-encoding: br, gzip, deflate`. The
 * `profile` switch selects the identity: `app` (default, desktop worker) or
 * `cli` (qodercli).
 */
import { constants, createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import { getQoderVersion } from "../../operations/client-versions";
import { qoderMachineHostname, qoderMachineOs } from "../../operations/cli-platform";
import { QODER_UA_APP } from "./qoder-realm";
import type { QoderAuth } from "./qoder-types";

/** Which Qoder client identity a COSY request presents. */
export type QoderCosyProfile = "app" | "cli";

const QODER_APPCODE = "cosy";
const QODER_SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const QODER_STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
/**
 * Per-character translation for `transformQoderBody`: standard base64 → the
 * scrambled alphabet, `=` → `$`. Built once at module init — the previous
 * per-character `indexOf` was a 64-slot linear scan for every character of
 * the entire request body. Characters outside the standard alphabet fall
 * through unchanged, exactly like the `indexOf` → `-1` → `?? char` path.
 */
const QODER_CHAR_TRANSLATION = new Map<string, string>(
  [...QODER_STANDARD_ALPHABET].map((char, index): [string, string] => [char, QODER_ALPHABET[index] ?? char]),
);
QODER_CHAR_TRANSLATION.set("=", "$");
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

function qoderMd5(value: string | Uint8Array): string {
  return createHash("md5").update(value).digest("hex");
}

/**
 * Canonical compact JSON used by Qoder's COSY signing: keys sorted
 * lexicographically, no whitespace, null/undefined rendered as empty string.
 * The upstream verifies the signature against this exact serialization, so a
 * payload built with plain `JSON.stringify` (insertion order) fails with
 * `code 101 / Signature invalid`.
 */
function qoderJsonSortedCompact(mapping: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(mapping).sort()) {
    const value = mapping[key] === null || mapping[key] === undefined ? "" : mapping[key];
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

function qoderPathSignature(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith("/algo") ? path.slice(5) : path;
}

/**
 * Qoder's own base64 alphabet transform for a request body: base64, rotate
 * thirds, then map each character through the custom alphabet (`=` → `$`).
 */
export function transformQoderBody(plaintext: string): Uint8Array {
  const base64 = Buffer.from(plaintext).toString("base64");
  const third = Math.floor(base64.length / 3);
  const reordered = base64.slice(base64.length - third) + base64.slice(third, base64.length - third) + base64.slice(0, third);
  let encoded = "";
  for (const char of reordered) {
    encoded += QODER_CHAR_TRANSLATION.get(char) ?? char;
  }
  return Buffer.from(encoded, "latin1");
}

/**
 * Builds the COSY Bearer headers for one signed request. The identity payload
 * is encrypted AES-128-CBC (random 16-byte key, IV = key), the key is RSA
 * PKCS1-encrypted, and the signature is md5 over
 * `payload\ncosyKey\ndate\nbody\nsigPath`.
 *
 * Machine identity headers mirror the worker-core capture (2026-11-17):
 * `cosy-machineid` (the account's machine id), `cosy-machinetoken/type/code`
 * when a native UMID identity is bound (otherwise they fall back to the
 * machine id / `5`), real `cosy-machineos`, and the hostname. Header order is
 * not observable at this layer (fetch normalizes), only presence.
 */
export function qoderBuildCosyHeaders(
  body: Uint8Array,
  url: string,
  auth: QoderAuth,
  version = getQoderVersion(),
  profile: QoderCosyProfile = "app",
): Record<string, string> {
  const key = randomUUID().replaceAll("-", "").slice(0, 16);
  const identity = qoderJsonSortedCompact({
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
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(key)).toString("base64");
  const payload = Buffer.from(
    qoderJsonSortedCompact({ version: "v1", requestId: randomUUID(), info, cosyVersion: version, ideVersion: "" }),
  ).toString("base64");
  const date = String(Math.floor(Date.now() / 1000));
  const signature = qoderMd5(`${payload}\n${cosyKey}\n${date}\n${Buffer.from(body).toString("latin1")}\n${qoderPathSignature(url)}`);
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const app = profile === "app";
  return {
    authorization: `Bearer COSY.${payload}.${signature}`,
    "cosy-data-policy": "agree",
    "cosy-machinetype": auth.machineType ?? "5",
    "cosy-machineos": qoderMachineOs(),
    // Worker-core capture (2026-11-17): `cosy-clienttype: 10` identifies the
    // app/worker client; the CLI core sends `5`.
    "cosy-clienttype": app ? "10" : "5",
    "cosy-date": date,
    "cosy-user": auth.userId,
    "cosy-key": cosyKey,
    "cosy-machineid": auth.machineId,
    ...(auth.machineToken !== undefined && auth.machineToken.length > 0 ? { "cosy-machinetoken": auth.machineToken } : {}),
    ...(auth.machineCode !== undefined && auth.machineCode.length > 0 ? { "cosy-machinecode": auth.machineCode } : {}),
    "cosy-machinehostname": qoderMachineHostname(),
    "x-request-id": randomUUID(),
    ...(auth.httpDnsIp !== undefined && auth.httpDnsIp.length > 0
      ? { "X-Qoder-HTTPDNS-IP": auth.httpDnsIp }
      : {}),
    // Worker-core capture (2026-11-17): the CLI core sends `cli`/`assistant`
    // and the app/worker surface sends `app`/`app`.
    "cosy-business-product": app ? "app" : "cli",
    "cosy-business-type": "agent",
    "cosy-scene": app ? "app" : "assistant",
    "cosy-version": version,
    "login-version": "v2",
    appcode: QODER_APPCODE,
    accept: "application/json",
    // Worker-core capture (2026-11-17): `br, gzip, deflate` on every signed
    // call, on both profiles (undici's own default).
    "accept-encoding": "br, gzip, deflate",
    "accept-language": "*",
    "sec-fetch-mode": "cors",
    // W3C trace context, as the worker's undici fetch emits it: `00-<traceid>-<spanid>-01`.
    traceparent: `00-${traceId}-${spanId}-01`,
    date: new Date().toUTCString(),
    signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${new Date().toUTCString()}`),
    "content-type": "application/json",
    // Worker-core capture (2026-11-17): every signed call sends `undici` —
    // the core runs under Node; the `Bun/1.4.2` UA belongs to the separate
    // bun-compiled CLI product, not this wire.
    "user-agent": QODER_UA_APP,
  };
}

/**
 * A COSY signer for one already-resolved account identity.
 *
 * Discovery needs signed headers but lives in `qoder-catalog.ts`, which cannot
 * import this module (the adapter imports its rosters — that would be a cycle).
 * Exporting the signer keeps one signing implementation and lets discovery
 * stay pure and injectable.
 */
export function qoderSignerFor(
  auth: QoderAuth,
  version = getQoderVersion(),
  profile: QoderCosyProfile = "app",
): (url: string, body: string) => Record<string, string> {
  return (url: string, body: string): Record<string, string> =>
    qoderBuildCosyHeaders(Buffer.from(body, "latin1"), url, auth, version, profile);
}

/** Qoder's own base64 alphabet transform, for a request body. */
export function qoderEncodeBody(plaintext: Uint8Array | string): string {
  const text = typeof plaintext === "string" ? plaintext : new TextDecoder().decode(plaintext);
  return Buffer.from(transformQoderBody(text)).toString("latin1");
}
