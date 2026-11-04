/**
 * Probe: Antigravity websearch grounding via the gateway `/v1/search` route.
 * Exercises the adapter's websearch method end-to-end against the live local
 * gateway.
 */
import { parseArgs } from "node:util";
import { pickAccount, readAccountsFile, requireAccountToken } from "../lib/accounts";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    label: { type: "string" },
    model: { type: "string", default: "gemini-2.5-flash" },
    gateway: { type: "string", default: "http://127.0.0.1:12800" },
  },
});

const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j, { ...(args.values.label !== undefined ? { label: args.values.label } : {}) });
const token = requireAccountToken(account);
const model = args.values.model!;
const gateway = args.values.gateway!;

console.log(`account=${account.label} model=${model} gateway=${gateway}`);
const res = await fetch(`${gateway}/v1/search`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ model: `antigravity/${model}`, query: "latest AI news 2026", max_results: 3 }),
  signal: AbortSignal.timeout(45_000),
});
const text = await res.text().catch(() => "");
console.log(`status=${res.status}`);
console.log(text.slice(0, 800));
