/**
 * Qoder COSY signing — AES-128-CBC identity encryption + RSA PKCS1 key +
 * md5 chain, and the alphabet-scrambled body transform. This is the donor of
 * the WASM `prepareInferRequest` output of the real client, and the only chat
 * surface a free/lite account can use.
 *
 * Header values mirror live captures of the real client (v1.1.83,
 * 2026-11-05): `User-Agent: Bun/1.4.2`, machine identity headers from the
 * UMID (`cosy-machineid/token/type/code/os/hostname`), business headers,
 * and the static `signature` md5 chain.
 */
import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import { getQoderVersion } from "../../operations/client-versions";
import { qoderMachineHostname, qoderMachineOs } from "../../operations/cli-platform";
import { QODER_UA_CLI } from "./qoder-realm";
import type { QoderAuth } from "./qoder-types";

const QODER_APPCODE = "cosy";
const QODER_SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const QODER_STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
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
    if (char === "=") encoded += "$";
    else encoded += QODER_ALPHABET[QODER_STANDARD_ALPHABET.indexOf(char)] ?? char;
  }
  return Buffer.from(encoded, "latin1");
}

/**
 * Builds the COSY Bearer headers for one signed request. The identity payload
 * is encrypted AES-128-CBC (random 16-byte key, IV = key), the key is RSA
 * PKCS1-encrypted, and the signature is md5 over
 * `payload\ncosyKey\ndate\nbody\nsigPath`.
 *
 * Machine identity headers mirror the live 1.1.83 capture: `cosy-machineid`
 * (the account's machine id), `cosy-machinetoken/type/code` when a native
 * UMID identity is bound (otherwise they fall back to the machine id / `5`),
 * real `cosy-machineos`, and the sanitized hostname.
 */
export function qoderBuildCosyHeaders(
  body: Uint8Array,
  url: string,
  auth: QoderAuth,
  version = getQoderVersion(),
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
  return {
    authorization: `Bearer COSY.${payload}.${signature}`,
    "cosy-data-policy": "agree",
    "cosy-machinetype": auth.machineType ?? "5",
    "cosy-machineos": qoderMachineOs(),
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": auth.userId,
    "cosy-key": cosyKey,
    "cosy-bodyhash": qoderMd5(body),
    "cosy-bodylength": String(body.byteLength),
    "cosy-sigpath": qoderPathSignature(url),
    "cosy-machineid": auth.machineId,
    ...(auth.machineToken !== undefined && auth.machineToken.length > 0 ? { "cosy-machinetoken": auth.machineToken } : {}),
    ...(auth.machineCode !== undefined && auth.machineCode.length > 0 ? { "cosy-machinecode": auth.machineCode } : {}),
    "cosy-machinehostname": qoderMachineHostname(),
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
    signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${new Date().toUTCString()}`),
    "content-type": "application/json",
    "user-agent": QODER_UA_CLI,
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
): (url: string, body: string) => Record<string, string> {
  return (url: string, body: string): Record<string, string> =>
    qoderBuildCosyHeaders(Buffer.from(body, "latin1"), url, auth, version);
}

/** Qoder's own base64 alphabet transform, for a request body. */
export function qoderEncodeBody(plaintext: Uint8Array | string): string {
  const text = typeof plaintext === "string" ? plaintext : new TextDecoder().decode(plaintext);
  return Buffer.from(transformQoderBody(text)).toString("latin1");
}
