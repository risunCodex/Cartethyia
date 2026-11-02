/**
 * Qoder entitlement probe (read-only): quota usage + model roster for an
 * account. Token is never printed.
 *
 *   bun run scripts/provider-probing/qoder/qoder-entitlement-probe.ts \
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
const QUOTA = "https://openapi.qoder.sh/api/v2/quota/usage";
const ROSTER = "https://openapi.qoder.sh/algo/api/v2/model/list?Encode=1";
const USERINFO = "https://openapi.qoder.sh/api/v1/userinfo";

const auth = {
  userId,
  userName: account.label ?? "",
  userType: "personal_standard",
  securityOauthToken: token,
  refreshToken: "",
};

async function get(url: string, label: string) {
  const headers = buildCosyHeaders(url, "", auth, VERSION);
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  console.log(`\n=== ${label} ===`);
  console.log(`status=${res.status} len=${text.length}`);
  if (res.ok) {
    // print structured keys, never tokens
    try {
      const obj = JSON.parse(text);
      const summarize = (o: unknown, depth = 0): string => {
        if (depth > 2) return "…";
        if (o === null || o === undefined) return String(o);
        if (Array.isArray(o)) return `[${o.slice(0, 5).map((x) => summarize(x, depth + 1)).join(", ")}${o.length > 5 ? ", …" : ""}]`;
        if (typeof o === "object") {
          const entries = Object.entries(o as Record<string, unknown>)
            .filter(([k]) => !/token|secret|key|credential/i.test(k))
            .map(([k, v]) => `${k}:${summarize(v, depth + 1)}`);
          return `{${entries.slice(0, 12).join(", ")}${entries.length > 12 ? ", …" : ""}}`;
        }
        return JSON.stringify(o);
      };
      console.log(summarize(obj));
    } catch {
      console.log(text.slice(0, 300));
    }
  } else {
    console.log(text.slice(0, 300));
  }
  return res;
}

await get(USERINFO, "userinfo");
await get(QUOTA, "quota/usage");
await get(ROSTER, "model roster (top)");
