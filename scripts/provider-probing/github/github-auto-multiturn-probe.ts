/**
 * Copilot Auto multi-turn stability probe.
 *
 * Tests both adapter modes end-to-end across two turns:
 *
 *   mode vscode-client-real: minted Copilot token + full VS Code reference
 *         headers (VScode-*, Editor-*, node-http library).
 *   mode opencode-copilot:  raw GitHub OAuth token + minimal OpenCode headers.
 *
 * Flow per mode:
 *   1. POST /auto -> session_token + selected model (gpt-6-luna).
 *   2. Turn 1: POST /responses (stream) with Copilot-Session-Token -> capture
 *      the response id from the SSE `response.created` event.
 *   3. Turn 2: POST /responses again with `previous_response_id` set to the
 *      turn-1 id + the second user message. Report the status and the
 *      response id.
 *   4. Repeat twice to check stability (fresh /auto opened per run).
 *
 * Usage:
 *   bun run scripts/provider-probing/github/github-auto-multiturn-probe.ts \
 *     --creds <file> [--mode vscode-client-real|opencode-copilot]
 */
import { parseArgs } from "node:util";
import { readAccountsFile, pickAccount } from "../lib/accounts";
import { parseGithubCredential, GITHUB_REQUEST_HEADERS } from "../../../src/providers/integrations/github/github-oauth";
import { getOrCreateInstallId } from "../../../src/providers/integrations/shared/install-id";

const PROMPTS = [
  "Name the fastest land animal in one word.",
  "Now name the second fastest in one word.",
];

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    mode: { type: "string", default: "opencode-copilot" },
    runs: { type: "string", default: "2" },
  },
});
if (!values.creds) throw new Error("--creds <path>");
const mode = values.mode;
if (mode !== "vscode-client-real" && mode !== "opencode-copilot") {
  throw new Error("--mode vscode-client-real|opencode-copilot");
}

const account = pickAccount(readAccountsFile(values.creds), { providerId: "github" });
if (!account.accessToken) throw new Error("no accessToken");
const credential = parseGithubCredential(account.accessToken);
const githubToken = String(account.refreshToken ?? "");

const API_VERSION = "2026-08-01";

async function mintCopilotToken(): Promise<string> {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${githubToken}`,
      ...GITHUB_REQUEST_HEADERS,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`token mint ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { token?: string };
  if (typeof body.token !== "string" || !body.token) throw new Error("no token minted");
  return body.token;
}

async function headersFor(mode: string, bearer: string): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearer}`,
    "Openai-Intent": "conversation-edits",
    "X-Interaction-Type": "conversation-agent",
    "X-Interaction-Id": "mt-probe",
    "x-initiator": "user",
  };
  if (mode === "opencode-copilot") {
    // Single api-version header (uppercase is what the plugin sends).
    return {
      ...base,
      "User-Agent": "opencode/0.1.0",
      "X-GitHub-Api-Version": API_VERSION,
    };
  }
  const machineId = await getOrCreateInstallId("github");
  // Reference mode: GITHUB_REQUEST_HEADERS already carries `x-github-api-version`
  // (2026-08-01). Do NOT add a second api-version header — the upstream answers
  // 400 "invalid apiVersion" when two casing variants are present.
  return {
    ...base,
    "User-Agent": "GitHubCopilotChat/0.72.0",
    ...GITHUB_REQUEST_HEADERS,
    "editor-device-id": machineId,
    "VScode-MachineId": machineId,
    "VScode-SessionId": "mt-probe",
    "x-vscode-user-agent-library-version": "node-http",
  };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, text: await res.text().catch(() => "") };
}

/** Extract response id from an SSE stream (first `response.created`). */
function extractResponseId(sse: string): string | undefined {
  const m = /event:\s*response\.created[\s\S]*?"id"\s*:\s*"([^"]+)"/.exec(sse);
  return m?.[1];
}

/** Extract the assistant output text from an SSE stream (first output_text). */
function extractAssistantText(sse: string): string | undefined {
  const m = /"type"\s*:\s*"output_text"[\s\S]*?"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(sse);
  return m?.[1]?.replace(/\\n/g, " ");
}

const bearer = mode === "opencode-copilot" ? githubToken : await mintCopilotToken();
console.log("=== multi-turn probe ===");
console.log("  mode:", mode, "| bearer:", mode === "opencode-copilot" ? "github" : "copilot-minted", "| apiHost:", credential.apiHost);

const hosts = [credential.apiHost];
const base = `https://${hosts[0]}`;
const headers = await headersFor(mode, bearer);
const runs = Number(values.runs);

for (let run = 0; run < runs; run += 1) {
  // 1. /auto
  const auto = await postJson(`${base}/auto`, headers, { prompt: PROMPTS[0], tier: "efficiency" });
  console.log(`\n--- run ${run + 1} ---`);
  if (auto.status !== 200) {
    console.log(`  [/auto] ${auto.status}: ${auto.text.replace(/\s+/g, " ").slice(0, 200)}`);
    continue;
  }
  const parsedAuto = JSON.parse(auto.text) as { session_token?: string; selected_model?: { id?: string } };
  const sessionToken = parsedAuto.session_token;
  const model = parsedAuto.selected_model?.id;
  if (!sessionToken || !model) {
    console.log("  [/auto] no session_token/model");
    continue;
  }
  console.log(`  [/auto] 200 selected=${model}`);

  const streamHeaders = { ...headers, "Copilot-Session-Token": sessionToken };

  // 2. Turn 1
  const turn1Body = {
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: PROMPTS[0] }] }],
    stream: true,
  };
  const t1 = await postJson(`${base}/responses`, streamHeaders, turn1Body);
  console.log(`  [turn1 /responses] ${t1.status}`);
  if (t1.status !== 200) {
    console.log(`    ${t1.text.replace(/\s+/g, " ").slice(0, 250)}`);
    continue;
  }
  const responseId = extractResponseId(t1.text) ?? "MISSING";
  console.log(`    response.id=${responseId}`);

  // 3. Turn 2 — previous_response_id is NOT supported by Copilot, so revisit
  // the full history in `input` (turn-1 user + assistant + turn-2 user).
  const assistantText = extractAssistantText(t1.text);
  const turn2Input = [
    { role: "user", content: [{ type: "input_text", text: PROMPTS[0] }] },
    ...(assistantText ? [{ role: "assistant", content: [{ type: "output_text", text: assistantText }] }] : []),
    { role: "user", content: [{ type: "input_text", text: PROMPTS[1] }] },
  ];
  const turn2Body = {
    model,
    input: turn2Input,
    stream: true,
  };
  const t2 = await postJson(`${base}/responses`, streamHeaders, turn2Body);
  const t2Head = t2.text.replace(/\s+/g, " ").slice(0, 250);
  console.log(`  [turn2 /responses full-history] ${t2.status}`);
  console.log(`    ${t2Head || "(empty)"}`);

  // 4. Turn 2b — minimal input (just the second question), same session.
  const t2b = await postJson(`${base}/responses`, streamHeaders, {
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: PROMPTS[1] }] }],
    stream: true,
  });
  const t2bHead = t2b.text.replace(/\s+/g, " ").slice(0, 250);
  console.log(`  [turn2b /responses minimal-input] ${t2b.status}`);
  console.log(`    ${t2bHead || "(empty)"}`);
}
