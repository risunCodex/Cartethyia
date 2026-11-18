/**
 * Copilot Auto tier probe: hit POST /auto once per tier (efficiency,
 * balance, intelligence) and prove each decision answers a real turn.
 *
 * Flow per tier:
 *   1. POST /auto {prompt, tier} -> selected_model + session_token.
 *   2. POST /chat/completions with Copilot-Session-Token on the selected
 *      model -> one short completion (status, latency, text head).
 *
 * Usage:
 *   bun run scripts/provider-probing/github/github-auto-tier-probe.ts \
 *     --creds <file> [--label <account>]
 */
import { parseArgs } from "node:util";
import { readAccountsFile, pickAccount } from "../lib/accounts";
import { parseGithubCredential } from "../../../src/providers/integrations/github/github-oauth";

const TIERS = ["efficiency", "balance", "intelligence"] as const;
const API_VERSION = "2026-08-01";

const { values } = parseArgs({
  options: { creds: { type: "string" }, label: { type: "string" }, index: { type: "string" } },
});
if (!values.creds) throw new Error("--creds <path>");

const account = pickAccount(readAccountsFile(values.creds), {
  providerId: "github",
  ...(values.label ? { label: values.label } : {}),
  ...(values.index ? { index: Number(values.index) } : {}),
});
if (!account.accessToken) throw new Error("no accessToken");
const cred = parseGithubCredential(account.accessToken);
const githubToken = String(account.refreshToken ?? "");
if (!githubToken) throw new Error("no GitHub token (refreshToken)");

const base = {
  Accept: "application/json",
  Authorization: `Bearer ${githubToken}`,
  "User-Agent": "opencode/0.1.0",
  "X-GitHub-Api-Version": API_VERSION,
  "X-Interaction-Type": "conversation-agent",
  "X-Interaction-Id": `probe-tier-${Date.now()}`,
  "x-initiator": "user",
  "Openai-Intent": "conversation-edits",
};

console.log(`account=${account.label ?? "?"} apiHost=${cred.apiHost} profile=${cred.profile}`);

for (const tier of TIERS) {
  const t0 = Date.now();
  const autoRes = await fetch(`https://${cred.apiHost}/auto`, {
    method: "POST",
    headers: { ...base, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Reply with one word: pong", tier }),
    signal: AbortSignal.timeout(30_000),
  });
  const autoText = await autoRes.text().catch(() => "");
  if (!autoRes.ok) {
    console.log(`tier=${tier}: /auto HTTP ${autoRes.status} ${autoText.replace(/\s+/g, " ").slice(0, 300)}`);
    continue;
  }
  const auto = JSON.parse(autoText) as {
    session_token?: string;
    selected_model?: { id?: string };
    selection_reason?: unknown;
    expires_at?: number;
  };
  const model = auto.selected_model?.id ?? "";
  console.log(`tier=${tier}: /auto 200 ${Date.now() - t0}ms model=${model} reason=${JSON.stringify(auto.selection_reason ?? null).slice(0, 120)}`);
  if (!auto.session_token || !model) {
    console.log(`  incomplete decision: ${autoText.replace(/\s+/g, " ").slice(0, 300)}`);
    continue;
  }

  const t1 = Date.now();
  try {
    const res = await fetch(`https://${cred.apiHost}/responses`, {
      method: "POST",
      headers: { ...base, "Content-Type": "application/json", "Copilot-Session-Token": auto.session_token },
      body: JSON.stringify({ model, input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: pong" }] }], stream: false }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text().catch(() => "");
    if (res.ok) {
      const j = JSON.parse(text) as { output?: { content?: { text?: string }[] }[] };
      const outText = (j.output ?? []).flatMap((o) => (o.content ?? []).map((c) => c.text ?? "")).join("");
      console.log(`  responses: 200 ${Date.now() - t1}ms text=${JSON.stringify(outText.slice(0, 40))}`);
    } else {
      console.log(`  responses: HTTP ${res.status} ${text.replace(/\s+/g, " ").slice(0, 250)}`);
    }
  } catch (error) {
    console.log(`  responses: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
  await new Promise((r) => setTimeout(r, 1_500));
}
