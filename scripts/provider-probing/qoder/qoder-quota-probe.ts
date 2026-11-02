/**
 * Qoder quota probe — raw HTTP responses for quota/usage + userinfo under
 * different header sets. Tokens are never printed.
 *
 *   bun run scripts/provider-probing/qoder/qoder-quota-probe.ts \
 *     --creds D:\tmp\scratch\qoder-new.json
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { buildCosyHeaders } from "./cosy-signer";

const args = parseArgs({
  options: { creds: { type: "string", required: true } },
});

const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j);
const token = requireAccountToken(account);
const userId = account.authState?.userId ?? "";
const machineId = account.authState?.machineId ?? randomUUID();

const VERSION = "1.1.81";
const BASE = "https://openapi.qoder.sh";

const auth = {
  userId,
  userName: account.label ?? "",
  userType: "personal_standard",
  securityOauthToken: token,
  refreshToken: "",
};

async function show(label: string, url: string, headers: Record<string, string>) {
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  console.log(`\n=== ${label} ===`);
  console.log(`status=${res.status}`);
  console.log("body:", text.slice(0, 500));
}

const paths = [
  "/api/v1/userinfo",
  "/api/v2/quota/usage",
] as const;

for (const path of paths) {
  const url = `${BASE}${path}`;

  // 1. plain Bearer
  await show(`${path} Bearer-only`, url, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  });

  // 2. Bearer + Cosy identity headers (like chat)
  await show(`${path} Bearer+Cosy`, url, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Cosy-Version": VERSION,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": "x86_64_linux",
    "Cosy-MachineHostname": "DESKTOP-QODER",
    "Cosy-MachineId": machineId,
    "Cosy-MachineToken": machineId,
    "Cosy-MachineType": "5",
  });

  // 3. COSY-signed (like the roster)
  const signed = buildCosyHeaders(url, "", auth, VERSION);
  await show(`${path} COSY-signed`, url, signed);
}
