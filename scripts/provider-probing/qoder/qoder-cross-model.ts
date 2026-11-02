/**
 * Cross-model chat probe on one account — is 116 per-account or per-model?
 *
 *   bun run scripts/provider-probing/qoder/qoder-cross-model.ts \
 *     --creds D:\tmp\scratch\qoder-new.json [--model qfmodel,...]
 */
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    model: { type: "string", default: "qfmodel,qmodel,dmodel" },
  },
});

const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j);
const token = requireAccountToken(account);
const models = args.values.model!.split(",").map((s) => s.trim()).filter(Boolean);

const VERSION = "1.1.80";
const url = "https://api2-v2.qoder.sh/model/v1/chat/completions";

function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}

function machineHostname(): string {
  const raw = (osHostname() ?? "").trim().toLowerCase();
  if (!raw) return "";
  const safe = raw
    .replace(/[^\x21-\x7e]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (safe.length <= 96) return safe;
  return `${safe.slice(0, 87)}-${createHash("sha256").update(safe, "utf8").digest("hex").slice(0, 8)}`;
}

async function probe(model: string) {
  const rid = randomUUID();
  const sid = randomUUID();
  const body = {
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
    },
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": rid,
    "X-Session-ID": sid,
    "Cosy-Version": VERSION,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": machineOs(),
    "Cosy-MachineHostname": machineHostname(),
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  console.log(`\n=== ${model} ===`);
  console.log(`status=${res.status}`);
  console.log("body:", text.slice(0, 300));
}

for (const m of models) {
  await probe(m);
}
