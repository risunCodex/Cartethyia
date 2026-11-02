/**
 * Probe /models/session/intent with available_models field.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { parseGithubCredential, GITHUB_REQUEST_HEADERS } from "../../../src/providers/integrations/github/github-oauth";

const { values } = parseArgs({ options: { creds: { type: "string" } } });
if (!values.creds) throw new Error("--creds <path>");
const acc = JSON.parse(readFileSync(values.creds, "utf8")).accounts[0];
const cred = parseGithubCredential(acc.accessToken);
const centralHost = "https://api.githubcopilot.com";
const PROMPT = "Explain in one sentence what a bitmap allocator is.";

// Get session token
const autoRes = await fetch(`${centralHost}/auto`, {
  method: "POST",
  headers: { ...GITHUB_REQUEST_HEADERS, authorization: `Bearer ${cred.access}`, "content-type": "application/json" },
  body: JSON.stringify({ prompt: PROMPT, tier: "efficiency" }),
  signal: AbortSignal.timeout(20_000),
});
const autoJson = (await autoRes.json()) as Record<string, unknown>;
const sessionToken = typeof autoJson.session_token === "string" ? autoJson.session_token : undefined;

// /models central
const modelsRes = await fetch(`${centralHost}/models`, {
  headers: { ...GITHUB_REQUEST_HEADERS, authorization: `Bearer ${cred.access}` },
  signal: AbortSignal.timeout(20_000),
});
const modelsJson = (await modelsRes.json()) as { data?: Array<Record<string, unknown>> };
const modelIds = (modelsJson.data ?? []).map((m) => String(m.id)).slice(0, 12);

const payloads: Array<Record<string, unknown>> = [
  { prompt: PROMPT, intent: "conversation-agent", available_models: modelIds },
  { prompt: PROMPT, intent: "conversation-agent", available_models: modelIds, session_id: "test-session" },
  { prompt: PROMPT, intent: "conversation-agent", available_models: modelIds, client: "vscode-chat", user_agent: "GitHubCopilotChat/0.72.0" },
];

for (const [i, body] of payloads.entries()) {
  const res = await fetch(`${centralHost}/models/session/intent`, {
    method: "POST",
    headers: {
      ...GITHUB_REQUEST_HEADERS,
      authorization: `Bearer ${cred.access}`,
      "content-type": "application/json",
      ...(sessionToken ? { "Copilot-Session-Token": sessionToken } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text().catch(() => "");
  console.log(`\n[intent variant ${i + 1}] HTTP ${res.status}`);
  console.log("  body:", JSON.stringify(body).slice(0, 300));
  console.log("  resp:", text.replace(/\s+/g, " ").slice(0, 800));
}
