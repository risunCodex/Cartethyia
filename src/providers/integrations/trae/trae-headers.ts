// Trae request headers: auth + device fingerprint.
//
// Aligned with Trae 1.107.1 (Linux x64 bundle, unpacked from TRAE-linux-x64.rpm).
// The canonical client sends:
//   - Authorization: Cloud-IDE-JWT <token>  (both realms, no Bearer)
//   - X-App-Id, x-plugin-channel, x-ide-version-code
//   - X-Device-Cpu, X-Device-Id, X-Machine-Id, X-Device-Brand,
//     X-Device-Type, X-Os-Version  (all encodeURIComponent'd)
//   - User-Agent: TraeClient/TTNet
//
// The native Agent transport also sends x-ide-token alongside Authorization.
// Version headers remain separate: they are not universally required by Agent
// and commercial requests.

import { createHash } from "node:crypto";
import {
  TRAE_APP_ID,
  TRAE_PLUGIN_CHANNEL,
  TRAE_REALMS,
  type TraeRealm,
} from "./trae-realm";

/** Device fingerprint derived from an account identity. */
export interface TraeDeviceIdentity {
  /** Stable per account: sha256 of a seeded string, 64 hex chars. */
  readonly machineId: string;
  /** Numeric, 19 digits: the upstream client reuses the account's numeric id. */
  readonly deviceId: string;
}

/**
 * Derives the device pair the upstream client sends.
 *
 * Both are pure one-way derivations from the account id, so one account always
 * presents one device and two accounts never share one — this is the
 * risk-control correlation surface, so a per-process random id would look like
 * many devices behind one account and a shared id would link them.
 */
export function traeDeviceIdentity(uid: string): TraeDeviceIdentity {
  const seed = String(uid ?? "").trim() || "anonymous";
  const machineId = createHash("sha256").update(`trae-machine:${seed}`).digest("hex");
  const raw = String(uid ?? "").trim();
  if (/^\d+$/.test(raw)) {
    // The official client reuses the 19-digit userId verbatim.
    return { machineId, deviceId: raw };
  }
  const digest = createHash("sha256").update(`trae-device:${raw || "anonymous"}`).digest("hex");
  const numeric = BigInt(`0x${digest.slice(0, 16)}`);
  return { machineId, deviceId: String(10n ** 18n + (numeric % (9n * 10n ** 18n))) };
}

/**
 * OS string reported as `X-Os-Version`.
 *
 * Upstream reads this from the host registry, which would leak the operator's
 * real Windows build. This gateway is not the operator's desktop, so a fixed
 * value of the same shape is both more private and more stable.
 */
export const TRAE_OS_VERSION = "Windows 11 Pro";

/** Reported hardware brand, same reasoning as the OS string. */
export const TRAE_DEVICE_BRAND = "Default string";

/** Inputs for {@link buildTraeHeaders}. */
export interface TraeHeaderInput {
  readonly realm: TraeRealm;
  /** Access token, sent as both `x-ide-token` and Cloud-IDE-JWT. */
  readonly token: string;
  /** Account id the device fingerprint is derived from. */
  readonly uid: string;
  /** Version code sent as `x-ide-version-code`. */
  readonly versionCode?: string;
  /** True for the streaming chat call, which overrides `Accept`. */
  readonly stream?: boolean;
  /** Extra/replacement headers, applied case-insensitively. */
  readonly extra?: Readonly<Record<string, string | null>>;
}

/**
 * Builds the header set for one Trae request.
 *
 * `null` in `extra` deletes the header.
 *
 * Deliberately does NOT send:
 * - `x-ide-token` — the canonical client (Trae 1.107.1 bundle, commit
 *   `b6786417`) does not send it on the chat/agent data plane; it is an
 *   OAuth/business-host header only. Sending it changed nothing for auth but
 *   diverges from the reference wire.
 * - `store-country-code` — not sent on the data plane either. The pay/quota
 *   collector adds it explicitly where the commercial surface requires it.
 */
export function buildTraeHeaders(input: TraeHeaderInput): Record<string, string> {
  const config = TRAE_REALMS[input.realm];
  const device = traeDeviceIdentity(input.uid);
  const headers: Record<string, string> = {
    "X-App-Id": TRAE_APP_ID,
    "x-plugin-channel": TRAE_PLUGIN_CHANNEL,
    "x-ide-version-code": input.versionCode ?? config.versionCode,
    Authorization: `Cloud-IDE-JWT ${input.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "TraeClient/TTNet",
    "X-Device-Cpu": encodeURIComponent("Intel"),
    "X-Device-Id": encodeURIComponent(device.deviceId),
    "X-Machine-Id": encodeURIComponent(device.machineId),
    "X-Device-Brand": encodeURIComponent(TRAE_DEVICE_BRAND),
    "X-Device-Type": encodeURIComponent("windows"),
    "X-Os-Version": encodeURIComponent(TRAE_OS_VERSION),
  };

  if (input.stream === true) {
    headers["Accept"] = "text/event-stream";
    headers["Cache-Control"] = "no-cache";
  }

  for (const [key, value] of Object.entries(input.extra ?? {})) {
    const lower = key.toLowerCase();
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower) delete headers[existing];
    }
    if (value !== null) headers[key] = value;
  }
  return headers;
}

