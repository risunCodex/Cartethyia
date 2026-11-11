/**
 * DeepAI wire probe — model listing, quota, and model hit.
 * Language: JavaScript (Bun), file: scripts/provider-probing/deepai/probe-deepai.mjs
 *
 * Reads DeepAI account credentials from a JSON file (from
 * `deepai-oauth-capture.mjs` or the console export — `accessToken` is the
 * DeepAI `api_key`), then exercises the wire reconstructed from the 0.3.35
 * bundle:
 *
 *   - `--models`  GET /deepai_code/models (unauthenticated) → model roster
 *   - `--quota`   GET /deepai_code/theos + /get_usage_summary (authed)
 *   - `--chat`    POST /deepai_code/chat/completions (authed, OpenAI-compatible)
 *
 * Every request carries the lane/instance/machine headers. Tokens are never
 * printed — only masked prefixes.
 *
 * Usage:
 *   bun scripts/provider-probing/deepai/probe-deepai.mjs --models
 *   bun ... --models --out models.json
 *   bun ... --quota --creds <accounts.json>
 *   bun ... --chat "hello" --creds <accounts.json> [--model glm-5.3-flash]
 *   bun ... --chat "hello" --creds <file> --stream
 *   bun ... --label <name> --index <n>
 */

import { writeFileSync } from "node:fs";

import {
  arg,
  hasFlag,
  redact,
  deepaiFetch,
  deepaiBaseHeaders,
  readAccountsFile,
  pickAccount,
  requireDeepAIApiKey,
  DEEPAI_API_ORIGIN,
  PATH_MODELS,
  PATH_THEOS,
  PATH_USAGE_SUMMARY,
  PATH_CHAT,
} from "./_lib.mjs";

const outFile = arg("out", "");
const model = arg("model", "glm-5.3-flash");
const maxTokens = Number(arg("max-tokens", "64"));
const stream = hasFlag("stream");

function showAccounts(accounts) {
  console.log(`[accounts] ${accounts.length} account(s)`);
  for (const a of accounts) {
    const key = a.accessToken ?? a.apiKey;
    console.log(`  - ${a.label ?? a.id ?? "?"} | ${a.credentialKind ?? "?"} | key=${key ? redact(key) : "none"} | user=${a.authState?.userId ?? "?"}`);
  }
}

async function probeModels() {
  console.log(`\n=== DeepAI model list ===`);
  console.log(`GET ${PATH_MODELS}`);
  const res = await deepaiFetch(PATH_MODELS, {
    headers: await deepaiBaseHeaders(),
    timeoutMs: 15000,
  });
  const list = Array.isArray(res.json?.models) ? res.json.models : [];
  console.log(`status=${res.status} ok=${res.ok} models=${list.length}`);
  if (res.ok) {
    for (const m of list) {
      console.log(
        `  ${m.id} | ${m.name ?? ""} | reasoning=${m.reasoning ?? false} | input=${(m.input ?? []).join(",")} | ctx=${m.contextWindow ?? "?"} | max=${m.maxTokens ?? "?"} | theos/req=${m.theosPerRequest ?? "-"} | api=${m.api ?? "-"}`,
      );
    }
    if (outFile) {
      writeFileSync(outFile, JSON.stringify(list, null, 2) + "\n", "utf8");
      console.log(`[models] written to ${outFile}`);
    }
  } else {
    console.log(`  head: ${res.text.slice(0, 300)}`);
  }
}

async function probeQuota(apiKey) {
  console.log(`\n=== DeepAI quota ===`);
  for (const [name, path] of [["theos", PATH_THEOS], ["usage_summary", PATH_USAGE_SUMMARY]]) {
    const url = path;
    console.log(`GET ${url}`);
    const res = await deepaiFetch(url, {
      headers: await deepaiBaseHeaders(apiKey),
      timeoutMs: 30000,
    });
    console.log(`  [${name}] status=${res.status} ok=${res.ok}`);
    if (res.json && typeof res.json === "object") {
      const j = res.json;
      const checkIn = j.check_in && typeof j.check_in === "object"
        ? `nonce=${j.check_in.nonce ?? "-"} seconds=${j.check_in.seconds ?? "-"}`
        : "";
      console.log(`    enabled=${j.enabled ?? "-"} lane_version=${j.lane_version ?? "-"} balance=${j.balance ?? "-"} granted=${j.granted ?? "-"} refresh_at=${j.refresh_at ?? "-"} ${checkIn}`);
    } else {
      console.log(`    head: ${res.text.slice(0, 300)}`);
    }
  }
}

async function probeChat(apiKey, message) {
  console.log(`\n=== DeepAI chat hit ===`);
  const body = {
    model,
    max_tokens: maxTokens,
    stream,
    messages: [{ role: "user", content: message }],
  };
  console.log(`POST ${PATH_CHAT} model=${model} stream=${stream} max_tokens=${maxTokens}`);
  const res = await deepaiFetch(PATH_CHAT, {
    method: "POST",
    headers: await deepaiBaseHeaders(apiKey),
    body,
    timeoutMs: 60000,
  });
  console.log(`status=${res.status} ok=${res.ok} content-type=${res.headers.get("content-type") ?? ""}`);
  if (stream) {
    console.log(`  first bytes: ${res.text.slice(0, 400)}`);
  } else {
    const choice = res.json?.choices?.[0];
    const usage = res.json?.usage;
    console.log(`  model=${res.json?.model ?? "-"} finish=${choice?.finish_reason ?? "-"}`);
    if (typeof choice?.message?.content === "string") {
      console.log(`  reply: ${choice.message.content.slice(0, 200)}`);
    }
    if (usage) console.log(`  usage: ${JSON.stringify(usage)}`);
    if (!res.ok) console.log(`  head: ${res.text.slice(0, 300)}`);
  }
}

async function main() {
  const showsModels = hasFlag("models");
  const wantsQuota = hasFlag("quota");
  const chatMessage = arg("chat");

  if (!showsModels && !wantsQuota && !chatMessage) {
    console.error("usage: --models | --quota --creds <file> | --chat <msg> --creds <file>");
    process.exit(1);
  }

  let apiKey = "";
  if (wantsQuota || chatMessage) {
    const creds = arg("creds");
    if (!creds) {
      console.error("--creds <accounts.json> is required for --quota / --chat");
      process.exit(1);
    }
    const accounts = readAccountsFile(creds);
    showAccounts(accounts);
    const account = pickAccount(accounts, { label: arg("label"), index: Number(arg("index", "-1")) >= 0 ? Number(arg("index")) : undefined });
    apiKey = requireDeepAIApiKey(account);
  }

  if (showsModels) await probeModels();
  if (wantsQuota) await probeQuota(apiKey);
  if (chatMessage) await probeChat(apiKey, chatMessage);
}

main().catch((err) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
