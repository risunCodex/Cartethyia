/**
 * Probe GitHub Copilot central CAPI host + model-router intent endpoint.
 * Validates whether the gateway can drop the per-account apiHost and use the
 * same central host the official extension uses, and what /models/session/intent
 * requires. No secrets are printed.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { parseGithubCredential, GITHUB_REQUEST_HEADERS } from "../../../src/providers/integrations/github/github-oauth";

const { values } = parseArgs({ options: { creds: { type: "string" } } });
if (!values.creds) throw new Error("--creds <path>");
const acc = JSON.parse(readFileSync(values.creds, "utf8")).accounts[0];
const cred = parseGithubCredential(acc.accessToken);

const PROMPT = "Explain in one sentence what a bitmap allocator is.";
const centralHost = "https://api.githubcopilot.com";

console.log("=== account ===");
console.log("  stored apiHost:", cred.apiHost);
console.log("  token prefix:", cred.access.slice(0, 8) + "…");

async function tryJson(label: string, url: string, body: unknown, headers: Record<string, string>): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...GITHUB_REQUEST_HEADERS, authorization: `Bearer ${cred.access}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text().catch(() => "");
    console.log(`\n[${label}] HTTP ${res.status}`);
    console.log("  head:", text.replace(/\s+/g, " ").slice(0, 400));
  } catch (error) {
    console.log(`\n[${label}] ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}

await tryJson("central /responses (no session)", `${centralHost}/responses`, {
  model: "gpt-6-luna",
  input: [{ role: "user", content: [{ type: "input_text", text: PROMPT }] }],
  stream: false,
  reasoning: { effort: "high", summary: "detailed" },
}, {});

await tryJson("central /chat/completions (gpt-4.1)", `${centralHost}/chat/completions`, {
  model: "gpt-4.1",
  messages: [{ role: "user", content: PROMPT }],
  stream: false,
}, {});

// Model router intent endpoint (used for conversation-agent routing).
await tryJson("central /models/session/intent", `${centralHost}/models/session/intent`, {
  prompt: PROMPT,
  intent: "conversation-agent",
}, {});

// Auto on the central host too.
await tryJson("central /auto", `${centralHost}/auto`, {
  prompt: PROMPT,
  tier: "efficiency",
}, {});
