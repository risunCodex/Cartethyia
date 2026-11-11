/**
 * Shared helpers for Qoder probe scripts.
 *
 * Consolidates the code that used to be copy-pasted across every probe:
 * machine identity, IDE chat headers, chat body builders, the account loader,
 * the SSE reader, and a redacting printer. One source of truth, strict TS, no
 * `any`.
 *
 * Upstream hosts below are the ones the probes were verified against live
 * (2026-11-04). The gateway's canonical per-realm constants live in
 * `src/providers/integrations/qoder/qoder-realm.ts`; these literals keep the
 * exact hosts the probes proved (legacy COSY on `api2.qoder.sh`, IDE on
 * `api1.qoder.sh`, control plane on `openapi.qoder.sh`). Note the model-list
 * endpoint is reachable on both `api2` and `openapi` — the discrepancy is
 * documented, not silently resolved.
 */
import { createHash, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
  type ExportedAccount,
} from "../../lib/accounts";
import {
  qoderBuildCosyHeaders,
  transformQoderBody,
  type QoderCosyProfile,
} from "../../../../src/providers/integrations/qoder/qoder-cosy";
import type { QoderAuth } from "../../../../src/providers/integrations/qoder/qoder-types";

export { transformQoderBody };

/**
 * Probe identity shape — the COSY signer's auth. Kept as a distinct alias so
 * probes read `QoderProbeAuth` (the gateway's `QoderAuth` is the source of
 * truth and lives in `src/`).
 */
export type QoderProbeAuth = QoderAuth;

/** Single source for the probe client version (was 9 literals, 2 values). */
export const QODER_VERSION = "1.1.79-hotfix.19";

export const QODER_LEGACY_CHAT_URL =
  "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
// Model list: the gateway's canonical path (`/algo/api/v2/model/list`) — the
// same one discovery uses and the only one verified alive (2026-11-11; the
// non-prefixed `/api/v2/model/list` answers 404 on api2).
export const QODER_MODEL_LIST_URL = "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1";
export const QODER_OPENAPI_BASE = "https://openapi.qoder.sh";

/** Machine OS token as the upstream expects it (`aarch64_macos`, `x86_64_linux`, …). */
export function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}

/** Safe machine hostname, normalized to the IDE's header-safe form. */
export function machineHostname(): string {
  const raw = (osHostname() ?? "").trim().toLowerCase();
  const safe = raw
    .replace(/[^\x21-\x7e]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (safe.length <= 96) return safe;
  return `${safe.slice(0, 87)}-${createHash("sha256").update(safe).digest("hex").slice(0, 8)}`;
}

/** Builds the `QoderProbeAuth` identity for one account. */
export function authFromAccount(account: ExportedAccount): QoderProbeAuth {
  return {
    userId: account.authState?.userId ?? "",
    userName: account.label ?? "",
    userType: "personal_standard",
    securityOauthToken: requireAccountToken(account),
    refreshToken: "",
    machineId: account.authState?.machineId ?? "",
  };
}

/** Result bag for the shared account loader. */
export interface LoadedProbeAccount {
  readonly account: ExportedAccount;
  readonly token: string;
  readonly userId: string;
  readonly machineId: string;
  readonly auth: QoderProbeAuth;
}

/**
 * Loads the account from `--creds` and derives everything a probe needs.
 * Replaces the 14 near-identical account-loading sequences.
 */
export function loadProbeAccount(values: {
  readonly creds?: string;
  readonly label?: string;
  readonly index?: string;
  readonly providerId?: string;
}): LoadedProbeAccount {
  const creds = values.creds;
  if (creds === undefined) throw new Error("--creds <path> is required");
  const accounts = readAccountsFile(creds);
  const account = pickAccount(accounts, {
    ...(values.providerId !== undefined ? { providerId: values.providerId } : {}),
    ...(values.label !== undefined ? { label: values.label } : {}),
    ...(values.index !== undefined ? { index: Number(values.index) } : {}),
  });
  const token = requireAccountToken(account);
  const userId = account.authState?.userId ?? "";
  const machineId =
    account.authState?.machineId && account.authState.machineId.length > 0
      ? account.authState.machineId
      : randomUUID();
  return { account, token, userId, machineId, auth: authFromAccount(account) };
}

/**
 * Builds the COSY Bearer request headers for one signed probe request.
 *
 * Delegate to the gateway's own signer (`src/`), so probes always send
 * exactly the wire the adapter sends. `profile` selects the client identity:
 * `app` (default, desktop worker — clienttype 10, app product/scene, undici
 * UA, zstd body) or `cli` (qodercli — clienttype 5, cli/assistant, Bun UA).
 */
export function buildCosyHeaders(
  url: string,
  rawBody: string,
  auth: QoderProbeAuth,
  version: string,
  machine?: { readonly id?: string; readonly token?: string; readonly type?: string; readonly code?: string },
  modelKey?: { readonly key: string; readonly source?: string },
  profile: QoderCosyProfile = "app",
): Record<string, string> {
  const encoded = transformQoderBody(rawBody);
  const headers = qoderBuildCosyHeaders(encoded, url, auth, version, profile);
  if (machine !== undefined) {
    delete headers["cosy-machinetoken"];
    delete headers["cosy-machinetype"];
    if (machine.id !== undefined && machine.id.length > 0) headers["Cosy-MachineId"] = machine.id;
    if (machine.token !== undefined && machine.token.length > 0) headers["Cosy-MachineToken"] = machine.token;
    if (machine.type !== undefined && machine.type.length > 0) headers["Cosy-MachineType"] = machine.type;
    if (machine.code !== undefined && machine.code.length > 0) headers["Cosy-MachineCode"] = machine.code;
  }
  if (modelKey !== undefined) {
    headers["X-Model-Key"] = modelKey.key;
    headers["X-Model-Source"] = modelKey.source ?? "system";
  }
  return headers;
}

/** Full IDE `/model/v1` header set (machine-id tripled only when provided). */
export function ideChatHeaders(opts: {
  readonly token: string;
  readonly version?: string;
  readonly machineId?: string;
  readonly hostname?: string;
  readonly os?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
}): Record<string, string> {
  const version = opts.version ?? QODER_VERSION;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": opts.requestId ?? randomUUID(),
    "X-Session-ID": opts.sessionId ?? randomUUID(),
    "Cosy-Version": version,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": opts.os ?? machineOs(),
    "Cosy-MachineHostname": opts.hostname ?? machineHostname(),
  };
  if (opts.machineId !== undefined) {
    headers["Cosy-MachineId"] = opts.machineId;
    headers["Cosy-MachineToken"] = opts.machineId;
    headers["Cosy-MachineType"] = "5";
  }
  return headers;
}

/** Recursive printer that never shows token/secret/key/credential fields. */
export function summarizeRedacted(value: unknown, depth = 0): string {
  if (depth > 2) return "…";
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    return `[${value.slice(0, 5).map((x) => summarizeRedacted(x, depth + 1)).join(", ")}${value.length > 5 ? ", …" : ""}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !/token|secret|key|credential/i.test(k))
      .map(([k, v]) => `${k}:${summarizeRedacted(v, depth + 1)}`);
    return `{${entries.slice(0, 12).join(", ")}${entries.length > 12 ? ", …" : ""}}`;
  }
  return JSON.stringify(value);
}
