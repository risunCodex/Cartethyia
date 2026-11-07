// scripts/provider-probing/devin/_lib.mjs — shared CLI/wire helpers for the
// Devin upstream probes. Every probe imports the shipped adapter modules so a
// capture/login/test exercises the exact code dispatch will use.

import { gunzipSync } from "node:zlib";
import { callDevinUnary } from "../../../src/providers/integrations/devin/devin-http.ts";
import { DevinMessageTypes } from "../../../src/providers/integrations/devin/protocol/devin-proto.ts";
import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_USER_JWT_PATH,
  DEVIN_GET_USER_STATUS_PATH,
  DEVIN_EXCHANGE_PATH,
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  DEVIN_CHAT_MESSAGE_PATH,
  DEVIN_ASSIGN_MODEL_PATH,
  devinCliMetadata,
  devinDiscoveryMetadata,
} from "../../../src/providers/integrations/devin/devin-shared.ts";
import { encodeFrame, ConnectFrameDecoder } from "../../../src/providers/integrations/devin/protocol/framing.ts";

export {
  callDevinUnary,
  DevinMessageTypes,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_USER_JWT_PATH,
  DEVIN_GET_USER_STATUS_PATH,
  DEVIN_EXCHANGE_PATH,
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  DEVIN_CHAT_MESSAGE_PATH,
  DEVIN_ASSIGN_MODEL_PATH,
  devinCliMetadata,
  devinDiscoveryMetadata,
  encodeFrame,
  ConnectFrameDecoder,
  gunzipSync,
};

/** CLI arg: env `DEVIN_<FLAG>` wins (Bun swallows `--flag=value`). */
export function arg(name, fallback = "") {
  const key = `DEVIN_${name.toUpperCase().replace(/-/g, "_")}`;
  if (process.env[key] !== undefined) return process.env[key];
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/** Never print a raw credential. */
export function redact(cred) {
  const s = String(cred ?? "");
  if (!s) return "<empty>";
  return `${s.slice(0, 6)}…${s.slice(-4)} (len=${s.length})`;
}

export function requireCred() {
  const cred = arg("cred") || process.env.DEVIN_API_KEY || "";
  if (!cred) {
    console.error("missing credential: set DEVIN_CRED or DEVIN_API_KEY");
    process.exit(2);
  }
  return cred;
}

/** Decodes bytes as raw protobuf, falling back to gunzip (Connect unary). */
export function decodeUnary(type, buf) {
  const asMessage = (b) => type.decode(b).toJSON ? type.toObject(type.decode(b), { longs: String, enums: String, bytes: Buffer }) : type.decode(b);
  try {
    return asMessage(buf);
  } catch {
    return asMessage(gunzipSync(buf));
  }
}

export function dump(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
