/**
 * Qoder entitlement probe (read-only) — the single canonical quota /
 * entitlement probe. It absorbs the old `qoder-quota-probe.ts` (header modes),
 * `qoder-roster-model.ts` (roster record lookup), and `qoder-account-info.ts`
 * (raw full dump). Tokens are never printed; `--full` redacts secret-named
 * string values instead of trusting the source's old redaction claim.
 *
 * Endpoints (all under QODER_OPENAPI_BASE = https://openapi.qoder.sh):
 *   /api/v1/userinfo          — run under every requested header mode
 *   /api/v2/quota/usage       — run under every requested header mode
 *   /api/v2/userinfo          — account-info behavior, only in `--full` mode
 *   /algo/api/v2/model/list   — roster (requires COSY signature on the GET)
 *
 * Header modes (--header-mode):
 *   Bearer  plain `Authorization: Bearer <token>`
 *   Cosy    Bearer + IDE Cosy identity headers (machine id/type, version, …)
 *   signed  COSY-signed request (buildCosyHeaders) — the default
 *   all     run all three
 *
 * Usage:
 *   # Default: signed userinfo + quota, plus a compact roster list
 *   bun run scripts/provider-probing/qoder/quota/qoder-entitlement-probe.ts \
 *     --creds D:\tmp\scratch\qoder-new.json
 *
 *   # All header modes on userinfo/quota
 *   bun run scripts/provider-probing/qoder/quota/qoder-entitlement-probe.ts \
 *     --creds <file> --header-mode all
 *
 *   # Raw (redacted) dumps, including the v2 userinfo endpoint
 *   bun run scripts/provider-probing/qoder/quota/qoder-entitlement-probe.ts \
 *     --creds <file> --full
 *
 *   # Full roster record for one model key (JSON pretty or summarized)
 *   bun run scripts/provider-probing/qoder/quota/qoder-entitlement-probe.ts \
 *     --creds <file> --roster-key qfmodel --json
 *
 *   # Write the roster (or a single record) to a file
 *   bun run scripts/provider-probing/qoder/quota/qoder-entitlement-probe.ts \
 *     --creds <file> --out roster.json
 *
 *   # Select the account explicitly
 *   bun run scripts/provider-probing/qoder/quota/qoder-entitlement-probe.ts \
 *     --creds <file> --label my-qoder
 *   bun run scripts/provider-probing/qoder/quota/qoder-entitlement-probe.ts \
 *     --creds <file> --index 1
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import {
  QODER_OPENAPI_BASE,
  QODER_VERSION,
  ideChatHeaders,
  loadProbeAccount,
  machineHostname,
  machineOs,
  summarizeRedacted,
} from "../lib/shared";
import { buildCosyHeaders } from "../lib/shared";
import type { QoderProbeAuth } from "../lib/shared";
import { maskUuid } from "../../lib/accounts";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    label: { type: "string" },
    index: { type: "string" },
    "header-mode": { type: "string", default: "signed" },
    full: { type: "boolean", default: false },
    "roster-key": { type: "string" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const USERINFO_V1 = `${QODER_OPENAPI_BASE}/api/v1/userinfo`;
const USERINFO_V2 = `${QODER_OPENAPI_BASE}/api/v2/userinfo`;
const QUOTA_USAGE = `${QODER_OPENAPI_BASE}/api/v2/quota/usage`;
const ROSTER = `${QODER_OPENAPI_BASE}/algo/api/v2/model/list?Encode=1`;

const HEADER_MODES = ["Bearer", "Cosy", "signed"] as const;
type HeaderMode = (typeof HEADER_MODES)[number];

/** Raw-body cap for `--full`; the fallback cap for non-JSON bodies. */
const FULL_CAP = 6000;
const FALLBACK_CAP = 300;

interface ProbeResult {
  readonly status: number;
  readonly ok: boolean;
  readonly len: number;
  readonly text: string;
}

/**
 * Replaces string values of secret-named JSON fields with `"…"` in a raw
 * response body. Only quoted string values are touched (the bodies probed
 * here are JSON); the field name is matched case-insensitively.
 */
function redactRaw(text: string): string {
  return text.replace(
    /"([^"]*(?:access_token|refresh_token|security_oauth_token|token|secret|api_key|credential)[^"]*)":\s*"((?:[^"\\]|\\.)*)"/gi,
    (_match: string, fieldName: string): string => `"${fieldName}": "…"`,
  );
}

function requestedModes(flag: string): readonly HeaderMode[] {
  if (flag === "all") return HEADER_MODES;
  const mode = HEADER_MODES.find((m) => m === flag);
  if (mode === undefined) {
    throw new Error(`--header-mode must be one of: Bearer, Cosy, signed, all (got "${flag}")`);
  }
  return [mode];
}

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

/**
 * Bearer + IDE Cosy identity headers (like the chat surface). The IDE default
 * Accept is SSE; these endpoints return JSON, so Accept is overridden.
 */
function cosyHeaders(token: string, machineId: string): Record<string, string> {
  return {
    ...ideChatHeaders({ token, machineId, os: machineOs(), hostname: machineHostname() }),
    Accept: "application/json",
  };
}

function signedHeaders(url: string, auth: QoderProbeAuth): Record<string, string> {
  return buildCosyHeaders(url, "", auth, QODER_VERSION);
}

function buildModeHeaders(
  mode: HeaderMode,
  url: string,
  token: string,
  machineId: string,
  auth: QoderProbeAuth,
): Record<string, string> {
  switch (mode) {
    case "Bearer":
      return bearerHeaders(token);
    case "Cosy":
      return cosyHeaders(token, machineId);
    case "signed":
      return signedHeaders(url, auth);
  }
}

async function probe(url: string, headers: Record<string, string>): Promise<ProbeResult> {
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  return { status: res.status, ok: res.ok, len: text.length, text };
}

function printBody(text: string, full: boolean): void {
  if (full) {
    console.log(redactRaw(text.slice(0, FULL_CAP)));
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    console.log(summarizeRedacted(parsed));
  } catch {
    console.log(text.slice(0, FALLBACK_CAP));
  }
}

async function runEndpoint(
  label: string,
  url: string,
  token: string,
  machineId: string,
  auth: QoderProbeAuth,
  modes: readonly HeaderMode[],
  full: boolean,
): Promise<void> {
  for (const mode of modes) {
    const headers = buildModeHeaders(mode, url, token, machineId, auth);
    const res = await probe(url, headers);
    console.log(`\n=== ${label} [${mode}] ===`);
    console.log(`status=${res.status} len=${res.len}`);
    printBody(res.text, full);
  }
}

interface RosterRecord {
  readonly group: string;
  readonly record: Record<string, unknown>;
}

/** Flattens the roster response (grouped arrays) into `{ group, record }` pairs. */
function rosterRecords(parsed: unknown): RosterRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const out: RosterRecord[] = [];
  for (const [group, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "object" && item !== null) {
        out.push({ group, record: item as Record<string, unknown> });
      }
    }
  }
  return out;
}

function recordKey(record: Record<string, unknown>): string | undefined {
  for (const k of ["key", "model", "model_id", "name"] as const) {
    const value = record[k];
    if (value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

function findRosterRecord(records: readonly RosterRecord[], target: string): RosterRecord | undefined {
  return records.find(({ record }) => recordKey(record) === target);
}

/** Compact per-model list, mirroring the chat probe's roster print. */
function printRosterSummary(records: readonly RosterRecord[]): void {
  if (records.length === 0) {
    console.log("  (empty roster)");
    return;
  }
  for (const { group, record } of records) {
    const key = recordKey(record) ?? "";
    const display = String(record["display_name"] ?? "");
    const flags: string[] = [];
    if (record["is_vl"] === true) flags.push("vl");
    if (record["is_reasoning"] === true) flags.push("reasoning");
    if (record["is_free"] === true) flags.push("free");
    if (record["is_default"] === true) flags.push("default");
    if (record["status"] !== undefined) flags.push(`status=${String(record["status"])}`);
    if (record["format"] !== undefined) flags.push(`fmt=${String(record["format"])}`);
    if (record["max_input_tokens"] !== undefined) flags.push(`ctx=${String(record["max_input_tokens"])}`);
    const suffix = flags.length > 0 ? ` ${flags.join(" ")}` : "";
    console.log(`  - [${group}] ${key} (${display})${suffix}`);
  }
}

/** Prints the keys of the first non-empty group (for the not-found case). */
function printSampleKeys(parsed: unknown): void {
  if (typeof parsed !== "object" || parsed === null) return;
  for (const [group, value] of Object.entries(parsed)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const first = value[0];
    if (typeof first === "object" && first !== null) {
      console.log(`sample keys (${group}): ${Object.keys(first).join(", ")}`);
    }
    return;
  }
}

async function main(): Promise<void> {
  const v = args.values;
  const loaded = loadProbeAccount({
    creds: v.creds!,
    ...(v.label !== undefined ? { label: v.label } : {}),
    ...(v.index !== undefined ? { index: v.index } : {}),
  });
  const { token, userId, machineId, auth } = loaded;

  console.log(`using account: ${loaded.account.label ?? loaded.account.id ?? "?"}`);
  if (userId.length > 0) console.log(`userId: ${maskUuid(userId)}`);
  console.log(`machineId: ${maskUuid(machineId)}`);

  const modes = requestedModes(v["header-mode"]);
  const full = v.full === true;

  await runEndpoint("userinfo v1", USERINFO_V1, token, machineId, auth, modes, full);
  await runEndpoint("quota/usage", QUOTA_USAGE, token, machineId, auth, modes, full);

  // v2 userinfo was only probed by the account-info dump; keep it raw-only.
  if (full) {
    await runEndpoint("userinfo v2 (raw)", USERINFO_V2, token, machineId, auth, ["Bearer"], true);
  }

  // Roster — the GET carries a COSY signature (a bare/plain-bearer GET fails).
  const rosterRes = await probe(ROSTER, signedHeaders(ROSTER, auth));
  console.log(`\n=== model roster (signed) ===`);
  console.log(`status=${rosterRes.status} len=${rosterRes.len}`);
  if (!rosterRes.ok) {
    console.log(rosterRes.text.slice(0, FALLBACK_CAP));
    process.exitCode = 1;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rosterRes.text);
  } catch {
    console.log(rosterRes.text.slice(0, FALLBACK_CAP));
    process.exitCode = 1;
    return;
  }

  const records = rosterRecords(parsed);
  const target = v["roster-key"];

  if (target !== undefined) {
    const found = findRosterRecord(records, target);
    if (found === undefined) {
      console.log(`model ${target} not found in roster`);
      printSampleKeys(parsed);
      process.exitCode = 1;
      return;
    }
    if (v.json === true) {
      console.log(JSON.stringify(found.record, null, 2));
    } else {
      console.log(summarizeRedacted(found.record));
    }
    if (v.out !== undefined) {
      writeFileSync(v.out, `${JSON.stringify(found.record, null, 2)}\n`, "utf8");
      console.log(`wrote ${v.out}`);
    }
    return;
  }

  printRosterSummary(records);
  if (v.out !== undefined) {
    writeFileSync(v.out, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    console.log(`wrote ${v.out}`);
  }
}

await main();
