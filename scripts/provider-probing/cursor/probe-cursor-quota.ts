/**
 * Cursor quota probe — reads both quota surfaces the gateway adapter uses:
 * the legacy `{api}/auth/usage` (request-count buckets) and the
 * `cursor.com/api/usage-summary` (USD cents, session-cookie auth). Prints
 * parsed windows exactly as `fetchCursorQuota` would report them.
 *
 * Usage:
 *   bun run scripts/provider-probing/cursor/probe-cursor-quota.ts \
 *     --token <jwt> [--api-endpoint https://api2.cursor.sh]
 *   bun run ... --creds cursor-accounts-<ts>.json [--label <account>]
 *
 * Tokens are never printed — only masked prefixes.
 */
import { parseArgs } from "node:util";
import {
  maskSecret,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { probeGet } from "../lib/http";
import { CURSOR_API_HOST, CURSOR_WEBSITE_HOST } from "../../../src/providers/integrations/cursor/cursor-shared";
import { cursorAccountIdentity } from "../../../src/providers/integrations/cursor/cursor-auth";

const args = parseArgs({
  options: {
    creds: { type: "string" },
    token: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    "api-endpoint": { type: "string" },
    timeout: { type: "string", default: "20000" },
  },
});

async function main(): Promise<void> {
  const v = args.values;
  let credential = v.token?.trim() ?? "";
  if (!credential) {
    if (!v.creds) throw new Error("pass --token <jwt> or --creds <accounts.json>");
    const accounts = readAccountsFile(v.creds!);
    const account = pickAccount(accounts, {
      providerId: "cursor",
      ...(v.label !== undefined ? { label: v.label } : {}),
      ...(v.index !== undefined ? { index: Number(v.index) } : {}),
    });
    credential = requireAccountToken(account);
  }
  console.log(`token prefix: ${maskSecret(credential)}`);

  const baseUrl = (v["api-endpoint"] ?? `https://${CURSOR_API_HOST}`).replace(/\/+$/, "");

  // 1. Legacy {api}/auth/usage
  console.log(`\nGET ${baseUrl}/auth/usage`);
  const legacy = await probeGet(`${baseUrl}/auth/usage`, {
    accept: "application/json",
    authorization: `Bearer ${credential}`,
  }, { timeoutMs: Number(v.timeout), bodyCap: 10_000 });
  console.log(`status=${legacy.status}${legacy.ok ? "" : " (not ok)"}`);
  if (legacy.body) {
    try {
      const parsed = JSON.parse(legacy.body) as Record<string, unknown>;
      console.log(`buckets: ${JSON.stringify(parsed, null, 2)}`);
    } catch {
      console.log(`body: ${legacy.body.slice(0, 600)}`);
    }
  }

  // 2. cursor.com/api/usage-summary (session cookie)
  const userId = cursorAccountIdentity(credential);
  console.log(`\nGET https://${CURSOR_WEBSITE_HOST}/api/usage-summary`);
  if (!userId) {
    console.log("(skip — no userId claim in token; only OAuth accounts can read this surface)");
    return;
  }
  const summary = await probeGet(`https://${CURSOR_WEBSITE_HOST}/api/usage-summary`, {
    accept: "application/json",
    cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${credential}`)}`,
  }, { timeoutMs: Number(v.timeout), bodyCap: 20_000 });
  console.log(`status=${summary.status}${summary.ok ? "" : " (not ok)"}`);
  if (summary.body) {
    try {
      const parsed = JSON.parse(summary.body) as Record<string, unknown>;
      console.log(`summary: ${JSON.stringify(parsed, null, 2)}`);
    } catch {
      console.log(`body: ${summary.body.slice(0, 600)}`);
    }
  }
}

await main();
