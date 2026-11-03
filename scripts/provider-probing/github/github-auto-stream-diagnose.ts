/**
 * Diagnose the /auto -> stream path for a free Copilot account.
 * Uses the API version /auto actually accepts (2026-08-01), prints the full
 * /auto decision, then tries streaming each candidate model id with the
 * session token on /responses and /chat/completions.
 */
import { parseArgs } from "node:util";
import { readAccountsFile, pickAccount } from "../lib/accounts";
import { parseGithubCredential } from "../../../src/providers/integrations/github/github-oauth";

const { values } = parseArgs({ options: { creds: { type: "string" } } });
if (!values.creds) throw new Error("--creds <path>");

const account = pickAccount(readAccountsFile(values.creds), { providerId: "github" });
if (!account.accessToken) throw new Error("no accessToken");
const cred = parseGithubCredential(account.accessToken);
const githubToken = String(account.refreshToken ?? "");

const API_VERSION = "2026-08-01";
const base = {
  Accept: "application/json",
  Authorization: `Bearer ${githubToken}`,
  "User-Agent": "opencode/0.1.0",
  "X-GitHub-Api-Version": API_VERSION,
  "X-Interaction-Type": "conversation-agent",
  "X-Interaction-Id": "probe-session",
  "x-initiator": "user",
  "Openai-Intent": "conversation-edits",
};

// 1. /auto with the correct api version.
const autoRes = await fetch(`https://${cred.apiHost}/auto`, {
  method: "POST",
  headers: { ...base, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "hi", tier: "efficiency" }),
  signal: AbortSignal.timeout(30_000),
});
const autoText = await autoRes.text().catch(() => "");
console.log(`[/auto] HTTP ${autoRes.status}`);
if (!autoRes.ok) {
  console.log("  body:", autoText.replace(/\s+/g, " ").slice(0, 400));
  process.exit(0);
}
const auto = JSON.parse(autoText) as {
  session_token?: string;
  selected_model?: Record<string, unknown>;
  expires_at?: number;
  multi_turn?: unknown;
  multi_turn_mode?: unknown;
  selection_reason?: unknown;
};
console.log("  selected_model:", JSON.stringify(auto.selected_model));
console.log("  selection_reason:", JSON.stringify(auto.selection_reason));
console.log("  multi_turn:", JSON.stringify(auto.multi_turn));
console.log("  multi_turn_mode:", JSON.stringify(auto.multi_turn_mode));
console.log("  expires_at:", auto.expires_at);
const sessionToken = auto.session_token;
if (!sessionToken) {
  console.log("  no session_token — cannot stream");
  process.exit(0);
}

// 2. Candidate model ids to try in stream.
const selectedId = (auto.selected_model?.id as string | undefined) ?? "";
const candidates = [
  selectedId,
  "gpt-5.6-luna-free-auto",
  "gpt-5.6-luna",
  "gpt-6-luna",
  "gpt-4o-mini",
].filter((v, i, a) => v && a.indexOf(v) === i);

const streamHeaders = {
  ...base,
  "Content-Type": "application/json",
  "Copilot-Session-Token": sessionToken,
};

for (const model of candidates) {
  for (const surface of ["responses", "chat/completions"]) {
    const body =
      surface === "responses"
        ? {
            model,
            input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
            stream: true,
          }
        : {
            model,
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          };
    const t0 = Date.now();
    try {
      const res = await fetch(`https://${cred.apiHost}/${surface}`, {
        method: "POST",
        headers: streamHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text().catch(() => "");
      const head = text.replace(/\s+/g, " ").slice(0, 200);
      console.log(`\n[${surface}] model=${model} -> ${res.status} (${Date.now() - t0}ms) ${head}`);
    } catch (error) {
      console.log(`\n[${surface}] model=${model} -> ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
