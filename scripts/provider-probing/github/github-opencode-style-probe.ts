/**
 * Copilot Auto endpoint probe (the surface gpt-6-luna actually uses).
 *
 * `gpt-6-luna` is an Auto model: the client first POSTs to `/auto` with
 * `{ prompt, tier, has_image? }` and receives a `session_token` + selected
 * model, then streams that model with the session token. This probe tests the
 * `/auto` step across token/host/header variants — including what the official
 * OpenCode plugin would send (raw GitHub OAuth token, minimal headers) versus
 * the reference extension shape (minted Copilot token, VScode/Editor headers).
 *
 * Variants:
 *   token = copilot (minted Copilot token) | github (raw GitHub OAuth token)
 *   host  = account (apiHost from token) | central (api.githubcopilot.com)
 *   headers = opencode (minimal plugin headers) | reference (full extension headers)
 *   tier = efficiency | balance | intelligence
 *
 * Usage:
 *   bun run scripts/provider-probing/github/github-opencode-style-probe.ts \
 *     --creds "C:\Users\...\github-accounts-<ts>.json" \
 *     [--token copilot|github] [--host account|central] [--headers opencode|reference] [--tier efficiency]
 */
import { parseArgs } from "node:util";
import { readAccountsFile, pickAccount } from "../lib/accounts";
import { parseGithubCredential, GITHUB_REQUEST_HEADERS } from "../../../src/providers/integrations/github/github-oauth";
import { getOrCreateInstallId } from "../../../src/providers/integrations/shared/install-id";

const PROMPT = "Explain in one sentence what a bitmap allocator is.";
const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    token: { type: "string", default: "copilot" },
    host: { type: "string", default: "account" },
    headers: { type: "string", default: "reference" },
    tier: { type: "string", default: "efficiency" },
  },
});
if (!values.creds) throw new Error("--creds <path>");
if (values.token !== "copilot" && values.token !== "github") throw new Error("--token copilot|github");
if (values.host !== "account" && values.host !== "central") throw new Error("--host account|central");
if (values.headers !== "opencode" && values.headers !== "reference") throw new Error("--headers opencode|reference");

const account = pickAccount(readAccountsFile(values.creds), { providerId: "github" });
if (!account.accessToken) throw new Error("no accessToken");
const cred = parseGithubCredential(account.accessToken);

const bearer =
  values.token === "github"
    ? String(account.refreshToken ?? "")
    : cred.access;
if (!bearer) throw new Error(`no ${values.token} token available`);

const host = values.host === "central" ? "api.githubcopilot.com" : cred.apiHost;

async function buildHeaders(): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearer}`,
    "Openai-Intent": "conversation-edits",
    "X-GitHub-Api-Version": "2026-08-01",
    "X-Interaction-Type": "conversation-agent",
    "X-Interaction-Id": "probe-session",
    "x-initiator": "user",
  };
  if (values.headers === "opencode") {
    return { ...base, "User-Agent": "opencode/0.1.0" };
  }
  const machineId = await getOrCreateInstallId("github");
  return {
    ...base,
    "User-Agent": "GitHubCopilotChat/0.72.0",
    ...GITHUB_REQUEST_HEADERS,
    "editor-device-id": machineId,
    "VScode-MachineId": machineId,
    "VScode-SessionId": "probe-session",
    "x-vscode-user-agent-library-version": "node-http",
  };
}

const autoBody = {
  prompt: PROMPT,
  tier: values.tier,
};

console.log("=== /auto probe ===");
console.log("  token:", values.token, "| host:", host, "| headers:", values.headers, "| tier:", values.tier);
console.log("  bearer prefix:", bearer.slice(0, 8) + "…");
const headers = await buildHeaders();

const url = `https://${host}/auto`;
const start = Date.now();
try {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(autoBody),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  console.log(`\n[POST /auto] ${res.status} (${Date.now() - start}ms)`);
  console.log("  head:", text.replace(/\s+/g, " ").slice(0, 400) || "(empty)");
  let sessionToken: string | undefined;
  let selectedModel: string | undefined;
  if (res.ok) {
    const parsed = JSON.parse(text) as {
      session_token?: string;
      selected_model?: { id?: string };
      model?: string;
    };
    sessionToken = typeof parsed.session_token === "string" ? parsed.session_token : undefined;
    selectedModel = parsed.selected_model?.id;
    console.log("  selected_model:", selectedModel);
    console.log("  top-level model field:", parsed.model);
    console.log("  full keys:", Object.keys(parsed).join(", "));
    console.log("  has session_token:", typeof sessionToken === "string" && sessionToken.length > 0);
  }
  // If /auto worked, try streaming the selected model with the session token.
  if (sessionToken && selectedModel) {
    const chatBody = {
      model: selectedModel,
      messages: [{ role: "user", content: PROMPT }],
      stream: true,
    };
    const chatHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
      "Copilot-Session-Token": sessionToken,
      "Openai-Intent": "conversation-agent",
      "X-GitHub-Api-Version": "2025-04-01",
      "X-Interaction-Type": "conversation-agent",
      "X-Interaction-Id": "probe-session",
      "x-initiator": "user",
      "User-Agent": "opencode/0.1.0",
    };

    // Try both surfaces: OpenCode routes gpt-5+ to /responses.
    for (const surface of ["responses", "chat/completions"]) {
      const body =
        surface === "responses"
          ? {
              model: selectedModel,
              input: [{ role: "user", content: [{ type: "input_text", text: PROMPT }] }],
              stream: true,
            }
          : chatBody;
      const surfaceStart = Date.now();
      try {
        const res = await fetch(`https://${host}/${surface}`, {
          method: "POST",
          headers: chatHeaders,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });
        const text = await res.text().catch(() => "");
        console.log(`\n[POST /${surface} + session_token] ${res.status} (${Date.now() - surfaceStart}ms)`);
        console.log("  head:", text.replace(/\s+/g, " ").slice(0, 400) || "(empty)");
      } catch (error) {
        console.log(`\n[POST /${surface}] ERROR ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} catch (error) {
  console.log(`\n[POST /auto] ERROR ${error instanceof Error ? error.message : String(error)}`);
}
