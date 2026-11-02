/**
 * Roster inspection: pull the model list and print the full record for a
 * given model key (default qfmodel), plus the quota summary. Tokens are never
 * printed.
 *
 *   bun run scripts/provider-probing/qoder/qoder-roster-model.ts \
 *     --creds D:\tmp\scratch\qoder-new.json [--model qfmodel]
 */
import { parseArgs } from "node:util";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { buildCosyHeaders } from "./cosy-signer";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    model: { type: "string", default: "qfmodel" },
  },
});

const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j);
const token = requireAccountToken(account);
const userId = account.authState?.userId ?? "";

const VERSION = "1.1.81";
const url = "https://openapi.qoder.sh/algo/api/v2/model/list?Encode=1";
const auth = {
  userId,
  userName: account.label ?? "",
  userType: "personal_standard",
  securityOauthToken: token,
  refreshToken: "",
};

const headers = buildCosyHeaders(url, "", auth, VERSION);
const res = await fetch(url, { method: "GET", headers });
const text = await res.text();
console.log(`status=${res.status} len=${text.length}`);
if (!res.ok) {
  console.log(text.slice(0, 300));
  process.exit(0);
}

const parsed = JSON.parse(text) as Record<string, unknown>;
const target = args.values.model!;
let found = 0;
for (const [group, models] of Object.entries(parsed)) {
  if (!Array.isArray(models)) continue;
  for (const m of models as Array<Record<string, unknown>>) {
    const key = m["key"] ?? m["model"] ?? m["model_id"] ?? m["name"];
    if (String(key) === target) {
      found++;
      console.log(`\n=== ${group}/${target} ===`);
      console.log(JSON.stringify(m, null, 2));
    }
  }
}
if (found === 0) {
  console.log(`\nmodel "${target}" not found in roster`);
  // print the keys that exist on one entry for reference
  for (const [group, models] of Object.entries(parsed)) {
    if (Array.isArray(models) && models.length > 0) {
      const first = models[0] as Record<string, unknown>;
      console.log(`sample keys (${group}):`, Object.keys(first).join(", "));
      break;
    }
  }
}
