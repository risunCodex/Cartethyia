/**
 * Free-pi upstream probe — identity, catalog, chat wire, model sweep.
 *
 * Uses the same wire the shipped 0.6.14 client uses (see freepi-shared.ts).
 * The credential comes from either an account export file (--creds) or a
 * guest session (--guest), which the CLI itself supports.
 *
 * Modes:
 *   --creds <file>          read a saved JWT account export
 *   --guest                 start a guest session (no login needed)
 *   --me                    GET /me (account/allowance state)
 *   --models                GET /client-version and print the model catalog
 *   --chat --model <id>     one chat completion
 *   --sweep                 chat-probe every catalog model
 *   --no-stream             non-streaming completion
 *
 * Tokens are never printed — only masked prefixes.
 *
 * Usage:
 *   bun run scripts/provider-probing/freepi/probe-freepi.ts --guest --models
 *   bun run scripts/provider-probing/freepi/probe-freepi.ts --creds <file> --chat
 *   bun run scripts/provider-probing/freepi/probe-freepi.ts --guest --sweep
 */

import { parseArgs } from "node:util";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import {
  FREEPI_BASE_URL,
  FREEPI_CLI_VERSION,
  FREEPI_DEFAULT_MODEL,
  FREEPI_MAX_OUTPUT_TOKENS,
  chatCompletion,
  fetchClientVersion,
  fetchMe,
  maskJwt,
  startGuestSession,
} from "./freepi-shared";

const args = parseArgs({
  options: {
    creds: { type: "string" },
    guest: { type: "boolean", default: false },
    me: { type: "boolean", default: false },
    models: { type: "boolean", default: false },
    chat: { type: "boolean", default: false },
    sweep: { type: "boolean", default: false },
    model: { type: "string", default: FREEPI_DEFAULT_MODEL },
    message: { type: "string", default: "How are you?" },
    "no-stream": { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const v = args.values;
const baseUrl = FREEPI_BASE_URL;

let jwt = "";
let source = "";
if (v.guest) {
  const guest = await startGuestSession(baseUrl);
  jwt = guest.token;
  source = `guest (allowance ${guest.allowance_usd}, remaining ${guest.remaining_usd})`;
} else {
  if (!v.creds) throw new Error("pass --creds <file> or --guest");
  const account = pickAccount(readAccountsFile(v.creds!), { providerId: "freepi" });
  jwt = requireAccountToken(account);
  source = account.label ?? "freepi";
}
console.log(`free-pi @ ${baseUrl} — ${source} — token ${maskJwt(jwt)} (${FREEPI_CLI_VERSION})`);

if (v.me) {
  const me = await fetchMe(baseUrl, jwt);
  if (!me) {
    console.log("GET /me -> no body (not ok)");
  } else {
    console.log("\n=== /me ===");
    console.log(JSON.stringify(me, null, 2).slice(0, 3000));
  }
}

if (v.models) {
  const cv = await fetchClientVersion(baseUrl, jwt);
  if (!cv) {
    console.log("\nGET /client-version -> no body (not ok)");
  } else {
    console.log("\n=== /client-version — model catalog ===");
    const models = Array.isArray(cv["models"]) ? (cv["models"] as Record<string, unknown>[]) : [];
    console.log(`min=${String(cv["min"] ?? "?")} latest=${String(cv["latest"] ?? "?")} model=${String(cv["model"] ?? "?")}`);
    if (cv["notice"]) console.log(`notice: ${String(cv["notice"])}`);
    if (cv["fusion"]) console.log(`fusion: ${JSON.stringify(cv["fusion"])}`);
    console.log(`models (${models.length}):`);
    for (const m of models) {
      const id = String(m["id"] ?? "");
      const name = String(m["name"] ?? "");
      const section = String(m["section"] ?? "");
      const tier = String(m["tier"] ?? "");
      if (id) console.log(`  - ${id}${name && name !== id ? ` (${name})` : ""}${section ? ` [${section}]` : ""}${tier ? ` tier=${tier}` : ""}`);
    }
    if (v.out) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(v.out, JSON.stringify(cv, null, 2), "utf8");
      console.log(`\ncatalog written to ${v.out}`);
    }
  }
}

const model = v.model!;
const message = v.message!;
const stream = !v["no-stream"];
console.log(`\nmodel: ${model} stream: ${stream} message: ${JSON.stringify(message)}`);

if (v.chat) {
  const outcome = await chatCompletion(baseUrl, jwt, model, message, { stream, maxTokens: FREEPI_MAX_OUTPUT_TOKENS });
  console.log(`\n[chat ${model}] http=${outcome.status} events=${outcome.events.join(",") || "(none)"}`);
  if (outcome.error) console.log(`  error: ${outcome.error}`);
  if (outcome.result) console.log(`  result: ${outcome.result}`);
  console.log(`  verdict: ${outcome.ok ? "PASS" : "FAIL"}`);
  if (!outcome.ok) console.log(`  raw head: ${outcome.raw.slice(0, 300).replace(/\n/g, " | ")}`);
}

if (v.sweep) {
  const cv = await fetchClientVersion(baseUrl, jwt);
  const models = Array.isArray(cv?.["models"]) ? (cv["models"] as Record<string, unknown>[]) : [];
  const ids = models.map((m) => String(m["id"] ?? "")).filter(Boolean);
  if (ids.length === 0) ids.push(FREEPI_DEFAULT_MODEL);
  console.log(`\n=== sweep (${ids.length} models) ===`);
  for (const id of ids) {
    const outcome = await chatCompletion(baseUrl, jwt, id, message, { stream, maxTokens: FREEPI_MAX_OUTPUT_TOKENS, timeoutMs: 90_000 });
    console.log(`${outcome.ok ? "PASS" : "FAIL"} ${id} [http ${outcome.status} ${outcome.events.join(",") || ""}]${outcome.result ? ` -> ${outcome.result}` : ""}${outcome.error ? ` ERROR ${outcome.error}` : ""}`);
  }
}
