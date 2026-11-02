/**
 * Full userinfo + quota dump (redacts tokens). 
 *   bun run scripts/provider-probing/qoder/qoder-account-info.ts \
 *     --creds D:\tmp\scratch\qoder-new.json
 */
import { parseArgs } from "node:util";
import { pickAccount, readAccountsFile, requireAccountToken } from "../lib/accounts";

const args = parseArgs({ options: { creds: { type: "string", required: true } } });
const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j);
const token = requireAccountToken(account);

async function show(label: string, url: string, headers: Record<string, string>) {
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  console.log(`\n=== ${label} status=${res.status} ===`);
  console.log(text.slice(0, 6000));
}

await show("userinfo", "https://openapi.qoder.sh/api/v1/userinfo", {
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
});

await show("quota/usage", "https://openapi.qoder.sh/api/v2/quota/usage", {
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
});

await show("v2 userinfo", "https://openapi.qoder.sh/api/v2/userinfo", {
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
});
