/**
 * Freebuff upstream probe — token → /me → device-keys → catalog → admission.
 * Language: JavaScript (Bun), file: scripts/provider-probing/freebuff/freebuff-probe.mjs
 *
 * Reads a Freebuff token (from `--token`, `FREEBUFF_TOKEN`, or the capture
 * credential file) and runs the authenticated upstream surface:
 *
 *   1. GET /api/v1/me?fields=id,email,name,accessTier,paidPlan
 *   2. POST /api/v1/freebuff/device-keys (Ed25519 publicKey) → keyId
 *   3. GET /api/v1/freebuff/models            (catalog protocol 1)
 *   4. POST /api/v1/freebuff/session/admission (model + instance headers)
 *
 * The admission probe buys/opens a session for the chosen model — that is the
 * "hit model" gate. It does not stream a conversation (that runs through the
 * cloud workspace/runs surface); it proves the model id is serviceable for
 * this account.
 *
 * Usage:
 *   bun scripts/provider-probing/freebuff/freebuff-probe.mjs --token=... --model=deepseek/deepseek-v4-flash
 *   FREEBUFF_TOKEN=... bun scripts/provider-probing/freebuff/freebuff-probe.mjs --model=openai/gpt-6-luna
 *   bun scripts/provider-probing/freebuff/freebuff-probe.mjs --creds=D:/tmp/scratch/freebuff-probe/credential.txt
 *   bun scripts/provider-probing/freebuff/freebuff-probe.mjs --list-models
 */

import { readFileSync } from "node:fs";
import {
  API_HOST,
  ME_PATH,
  MODEL_CATALOG_PATH,
  SESSION_ADMISSION_PATH,
  SESSION_EPOINT,
  CATALOG_PROTOCOL_HEADER,
  CATALOG_PROTOCOL_VERSION,
  FREEBUFF_CLIENT_HEADER,
  CLIENT as FREEBUFF_CLIENT,
  FREEBUFF_MODEL_HEADER,
  FREEBUFF_WALLET_SPEND_LIMIT_HEADER,
  FREEBUFF_INSTANCE_HEADER,
  FREEBUFF_MULTI_SESSION_HEADER,
  FREEBUFF_PURCHASE_CONTINUITY_HEADER,
  FREEBUFF_DESKTOP_ATTEMPT_HEADER,
  FREE_BUFF_MODELS,
  fbFetch,
  redact,
  arg,
  hasFlag,
  FreebuffDeviceSigner,
} from "./_lib.mjs";

function readToken() {
  const inline = arg("token");
  if (inline) return inline;
  const envToken = process.env.FREEBUFF_TOKEN;
  if (envToken) return envToken;
  const creds = arg("creds");
  if (creds) {
    const content = readFileSync(creds, "utf8");
    const m = content.match(/FREEBUFF_TOKEN=(.+)/);
    if (m) return m[1].trim();
  }
  throw new Error("no token: pass --token=…, set FREEBUFF_TOKEN, or use --creds=<capture file>");
}

async function probeMe(token) {
  const url = `${API_HOST}${ME_PATH}?fields=${encodeURIComponent("id,email,name,accessTier,paidPlan")}`;
  const res = await fbFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`[me] ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

async function probeDeviceKeys(token, signer) {
  const keyId = await signer.register(token);
  console.log(`[device-keys] registered keyId=${redact(keyId)}`);
  return keyId;
}

async function probeCatalog(token) {
  const res = await fbFetch(`${API_HOST}${MODEL_CATALOG_PATH}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      [CATALOG_PROTOCOL_HEADER]: CATALOG_PROTOCOL_VERSION,
      [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT,
    },
  });
  const catalog = res.json;
  console.log(`[catalog] ${res.status} protocol=${catalog?.protocol} version=${catalog?.version} rows=${catalog?.rows?.length ?? 0}`);
  if (Array.isArray(catalog?.rows)) {
    for (const row of catalog.rows.slice(0, 30)) {
      console.log(`  ${row.key} | ${row.handle} | ${row.displayName} | access=${row.access} | premium=${row.premium}`);
    }
    if (catalog.rows.length > 30) console.log(`  … (${catalog.rows.length - 30} more)`);
  }
  return catalog;
}

async function probeAdmission(token, signer, model) {
  const instanceId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const path = SESSION_ADMISSION_PATH;
  const headers = {
    Authorization: `Bearer ${token}`,
    [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT,
    [FREEBUFF_MODEL_HEADER]: model,
    [FREEBUFF_WALLET_SPEND_LIMIT_HEADER]: "session",
    [FREEBUFF_INSTANCE_HEADER]: instanceId,
    [FREEBUFF_MULTI_SESSION_HEADER]: "1",
    [FREEBUFF_PURCHASE_CONTINUITY_HEADER]: "1",
    [FREEBUFF_DESKTOP_ATTEMPT_HEADER]: attemptId,
  };
  // The admission request is device-signed in the desktop client; sign it when
  // the key is registered (a missing key currently fails the register path, so
  // we fall back to unsigned and report the result).
  let signed = {};
  try {
    signed = await signer.sign(token, { method: "POST", path, body: null });
  } catch (e) {
    console.log(`[admission] device signature unavailable (${e.message}); continuing unsigned`);
  }
  const res = await fbFetch(`${API_HOST}${path}`, {
    method: "POST",
    headers: { ...headers, ...signed },
    timeoutMs: 45000,
    allowNonOk: true,
  });
  console.log(`[admission] ${res.status}`);
  console.log(`  instanceId=${redact(instanceId)} model=${model}`);
  console.log(`  body=${JSON.stringify(res.json ?? res.text.slice(0, 300))}`);
  if (res.status === 409 && res.json?.error === "freebuff_catalog_stale") {
    console.log("  → catalog stale; refresh catalog and retry admission.");
  }
  return { res, instanceId };
}

async function releaseSession(token, signer, instanceId) {
  let signed = {};
  try {
    signed = await signer.sign(token, { method: "DELETE", path: SESSION_EPOINT, body: null });
  } catch {
    // best-effort
  }
  const res = await fbFetch(`${API_HOST}${SESSION_EPOINT}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT,
      [FREEBUFF_INSTANCE_HEADER]: instanceId,
      [FREEBUFF_MULTI_SESSION_HEADER]: "1",
      ...signed,
    },
    timeoutMs: 15000,
    allowNonOk: true,
  });
  console.log(`[session release] ${res.status} ${JSON.stringify(res.json ?? res.text.slice(0, 120))}`);
}

async function main() {
  if (hasFlag("list-models")) {
    console.log(`\nwire model ids (${FREE_BUFF_MODELS.length}):`);
    for (const id of FREE_BUFF_MODELS) console.log(`  ${id}`);
    return;
  }

  const token = readToken();
  console.log(`Freebuff probe — API ${API_HOST}`);
  console.log(`token: ${redact(token)}`);
  const signer = new FreebuffDeviceSigner();
  const model = arg("model", "deepseek/deepseek-v4-flash");

  await probeMe(token);
  await probeDeviceKeys(token, signer);
  await probeCatalog(token);

  console.log(`\n[admission] model=${model}`);
  const { res, instanceId } = await probeAdmission(token, signer, model);
  if (res.ok) {
    console.log("\n[result] MODEL ADMITTED ✅");
    if (!hasFlag("no-release")) await releaseSession(token, signer, instanceId);
  } else {
    console.log("\n[result] model NOT admitted — see admission body above ❌");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
