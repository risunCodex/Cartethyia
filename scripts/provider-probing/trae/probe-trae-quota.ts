/**
 * Trae quota probe (read-only) — hits the same upstream surfaces the
 * `fetchTraeQuota` collector reads, with the exact same headers, so the live
 * response shape can be compared 1:1 against what `trae-quota.ts` parses.
 *
 * Surfaces (all POST with an empty JSON body, matching the collector):
 *   GET-usage   {core}/api/v1/commercial/get_session_usage
 *   ent v1      {pay}/trae/api/v1/pay/ide_user_ent_usage
 *   ent v2      {pay}/trae/api/v2/pay/ide_user_ent_usage
 *   pay status   {pay}/trae/api/v1/pay/ide_user_pay_status
 *
 * The auth header (`Cloud-IDE-JWT`) and device fingerprint come from
 * `buildTraeHeaders`, the same builder the gateway uses at dispatch. The
 * account's recorded `region` picks the core host (`sg` → coresg-normal).
 *
 * Usage:
 *   bun run scripts/provider-probing/trae/probe-trae-quota.ts \
 *     --creds C:\Users\Aria\Desktop\trae-accounts-<ts>.json
 *   bun run ... --creds <file> --label <account> --surfaces session
 *   bun run ... --creds <file> --full
 *
 * Tokens are never printed — only masked prefixes.
 */
import { parseArgs } from "node:util";
import {
  maskSecret,
  maskUuid,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { probePostText } from "../lib/http";
import { buildTraeHeaders } from "../../../src/providers/integrations/trae/trae-headers";
import {
  TRAE_ENT_USAGE_PATH,
  TRAE_REGION_CORE_HOSTS,
  TRAE_REGION_PAY_HOSTS,
  TRAE_REALMS,
  TRAE_SESSION_USAGE_PATH,
  type TraeRealm,
} from "../../../src/providers/integrations/trae/trae-realm";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    label: { type: "string" },
    index: { type: "string" },
    surfaces: { type: "string", default: "all" },
    full: { type: "boolean", default: false },
    "pay-host": { type: "string" },
    cc: { type: "string" },
  },
});

const SURFACES = ["session", "ent-v1", "ent-v2", "pay-status"] as const;
type Surface = (typeof SURFACES)[number];

const FULL_CAP = 6000;
const FALLBACK_CAP = 300;

/** Redacts secret-named string values from a raw body before printing. */
function redactRaw(text: string): string {
  return text.replace(
    /"([^"]*(?:access_token|refresh_token|token|secret|api_key|credential|jwt)[^"]*)":\s*"((?:[^"\\]|\\.)*)"/gi,
    (_match: string, fieldName: string): string => `"${fieldName}": "…"`,
  );
}

function requestedSurfaces(flag: string): readonly Surface[] {
  if (flag === "all") return SURFACES;
  const parsed = flag.split(",").map((s) => s.trim()) as Surface[];
  for (const s of parsed) {
    if (!(SURFACES as readonly string[]).includes(s)) {
      throw new Error(`--surfaces must be one of: ${SURFACES.join(", ")}, all (got "${s}")`);
    }
  }
  return parsed;
}

/** Pretty-prints a JSON body compactly, or the raw head when it is not JSON. */
function printBody(text: string, full: boolean): void {
  if (full) {
    console.log(redactRaw(text.slice(0, FULL_CAP)));
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    console.log(`  body: ${JSON.stringify(parsed).slice(0, 1200)}`);
  } catch {
    console.log(`  body: ${text.slice(0, FALLBACK_CAP)}`);
  }
}

async function runSurface(
  label: string,
  url: string,
  headers: Record<string, string>,
  opts: { readonly full: boolean },
): Promise<void> {
  const res = await probePostText(url, headers, "{}", { timeoutMs: 25_000 });
  console.log(`\n=== ${label} ===`);
  console.log(`  url: ${url}`);
  console.log(`  status=${res.status}${res.ok ? "" : " (not ok)"} content-type=${res.contentType}`);
  if (!res.ok) {
    console.log(`  body: ${res.body.slice(0, FALLBACK_CAP)}`);
    return;
  }
  printBody(res.body, opts.full);
}

function coreHost(region: string, realm: TraeRealm): string {
  const override = region !== "" ? TRAE_REGION_CORE_HOSTS[region] : undefined;
  return override ?? TRAE_REALMS[realm].core;
}

function payHost(region: string, realm: TraeRealm): string {
  const override = region !== "" ? TRAE_REGION_PAY_HOSTS[region] : undefined;
  return override ?? TRAE_REALMS[realm].pay;
}

async function main(): Promise<void> {
  const v = args.values;
  const accounts = readAccountsFile(v.creds!);
  const account = pickAccount(accounts, {
    providerId: "trae",
    ...(v.label !== undefined ? { label: v.label } : {}),
    ...(v.index !== undefined ? { index: Number(v.index) } : {}),
  });
  const token = requireAccountToken(account);

  const realm: TraeRealm = account.providerId === "traecn" ? "cn" : "intl";
  const region = (account.authState?.region ?? "").trim().toLowerCase();
  const uid = String(account.authState?.userId ?? "").trim();

  console.log(`using account: ${account.label ?? account.id ?? "?"} (${realm})`);
  console.log(`region: ${region || "(none)"} uid: ${uid ? maskUuid(uid) : "(none)"}`);
  console.log(`token prefix: ${maskSecret(token)}`);

  const surfaces = requestedSurfaces(v.surfaces);
  const opts = { full: v.full === true };
  const payHostOverride = v["pay-host"] ?? payHost(region, realm);
  const countryCode = v.cc ?? (region || "sg");

  const headers: Record<string, string> = {
    ...buildTraeHeaders({
      realm,
      token,
      uid,
      extra: {
        authorization: `Cloud-IDE-JWT ${token}`,
        "store-country-code": countryCode,
      },
    }),
    authorization: `Cloud-IDE-JWT ${token}`,
    "store-country-code": countryCode,
  };

  if (surfaces.includes("session")) {
    await runSurface(
      "session usage (core)",
      coreHost(region, realm) + TRAE_SESSION_USAGE_PATH,
      headers,
      opts,
    );
  }
  if (surfaces.includes("ent-v1")) {
    await runSurface(
      "entitlement v1 (pay)",
      payHostOverride + TRAE_ENT_USAGE_PATH,
      headers,
      opts,
    );
  }
  if (surfaces.includes("ent-v2")) {
    await runSurface(
      "entitlement v2 (pay)",
      payHostOverride + "/trae/api/v2/pay/ide_user_ent_usage",
      headers,
      opts,
    );
  }
  if (surfaces.includes("pay-status")) {
    await runSurface(
      "pay status (pay)",
      payHostOverride + "/trae/api/v1/pay/ide_user_pay_status",
      headers,
      opts,
    );
  }
}

await main();
