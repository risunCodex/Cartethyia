/**
 * Probe: mint a job token from a Qoder PAT (pt-...) using the gateway's own
 * `exchangeQoderPat` path — same endpoint, same headers, same machine identity
 * logic. Prints the full exchange response (token kind/prefix, expires info,
 * refresh token presence).
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/direct-mint.ts \
 *     --pat pt-... [--realm intl|cn]
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { getQoderVersion } from "../../../../src/providers/operations/client-versions";
import { qoderMachineOs } from "../../../../src/providers/operations/cli-platform";
import { QODER_REALMS } from "../../../../src/providers/integrations/qoder/qoder-realm";

const { values } = parseArgs({
  options: {
    pat: { type: "string" },
    realm: { type: "string", default: "intl" },
  },
});

const pat = values.pat;
if (!pat) throw new Error("--pat <pt-...> is required");
const realm = values.realm === "cn" ? "cn" : "intl";

const VERSION = getQoderVersion();
const url = QODER_REALMS[realm].jobTokenUrl;
const machineId = randomUUID();

console.log(`realm=${realm} url=${url}`);
console.log(`version=${VERSION} machineId=${machineId.slice(0, 8)}…`);

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `qoder/${VERSION}`,
    "X-Request-ID": randomUUID().toUpperCase(),
    "Cosy-ClientType": "5",
    "Cosy-Version": VERSION,
    "Cosy-MachineOS": qoderMachineOs(),
  },
  body: JSON.stringify({ personal_token: pat, machine_id: machineId }),
  signal: AbortSignal.timeout(30_000),
});

const text = await res.text();
console.log(`\nHTTP ${res.status}`);
try {
  const parsed = JSON.parse(text);
  console.log(JSON.stringify(parsed, null, 2));
  if (parsed.token) {
    const t = String(parsed.token);
    console.log(`\ntoken kind: ${t.startsWith("jt-") ? "jt-" : t.slice(0, 3)}…`);
    console.log(`token: ${t.slice(0, 6)}…${t.slice(-4)}`);
  }
  if (parsed.refresh_token) {
    const r = String(parsed.refresh_token);
    console.log(`refresh_token: ${r.slice(0, 6)}…${r.slice(-4)}`);
  }
  if (parsed.expires_at) console.log(`expires_at: ${parsed.expires_at}`);
} catch {
  console.log(text.slice(0, 500));
}
