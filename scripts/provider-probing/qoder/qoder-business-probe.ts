/**
 * Qoder IDE wire variant probe — business metadata + machine headers.
 *   bun run scripts/provider-probing/qoder/qoder-business-probe.ts \
 *     --creds D:\tmp\scratch\qoder-new.json
 */
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";

const args = parseArgs({ options: { creds: { type: "string", required: true } } });
const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j);
const token = requireAccountToken(account);
const machineId = account.authState?.machineId ?? randomUUID();

const VERSION = "1.1.80";
const url = "https://api2-v2.qoder.sh/model/v1/chat/completions";

function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}

function machineHostname(): string {
  const raw = (osHostname() ?? "").trim().toLowerCase();
  const safe = raw
    .replace(/[^\x21-\x7e]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return safe.length <= 96 ? safe : `${safe.slice(0, 87)}-${createHash("sha256").update(safe).digest("hex").slice(0, 8)}`;
}

function bodyFor(model: string) {
  const rid = randomUUID();
  const sid = randomUUID();
  return {
    body: {
      model,
      messages: [{ role: "user", content: "ping" }],
      stream: true,
      stream_options: { include_usage: true },
      metadata: {
        context: {
          request_id: rid,
          request_set_id: randomUUID(),
          session_id: sid,
          source_session_id: "",
          task_id: "common",
          client_type: "5",
        },
        business: {
          business_product: "cli",
          business_type: "agent",
          business_version: VERSION,
          scene: "assistant",
        },
      },
    },
    rid,
    sid,
  };
}

const minimalHeaders = (rid: string, sid: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Accept: "text/event-stream",
  "X-Request-ID": rid,
  "X-Session-ID": sid,
  "Cosy-Version": VERSION,
  "Cosy-ClientType": "5",
  "Cosy-MachineOS": machineOs(),
  "Cosy-MachineHostname": machineHostname(),
});

const machineHeaders = (rid: string, sid: string): Record<string, string> => ({
  ...minimalHeaders(rid, sid),
  "Cosy-MachineId": machineId,
  "Cosy-MachineToken": machineId,
  "Cosy-MachineType": "5",
});

async function run(label: string, headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  console.log(`\n=== ${label} ===`);
  console.log(`status=${res.status}`);
  console.log("body:", text.slice(0, 250));
}

for (const model of ["qfmodel", "qmodel"]) {
  const b = bodyFor(model);
  await run(`${model} business+minimal`, minimalHeaders(b.rid, b.sid), b.body);
  const b2 = bodyFor(model);
  await run(`${model} business+machineHdr`, machineHeaders(b2.rid, b2.sid), b2.body);
}
