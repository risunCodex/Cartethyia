/**
 * GitHub Copilot wire audit probe.
 *
 * Compares header variants 1:1 against the live upstream to isolate what
 * triggers "not licensed to use Copilot" / 403 forbidden on `gpt-6-luna`
 * (Auto model). Each variant is fired against the same endpoints:
 *
 *   - POST /auto            (Auto model selection — gpt-6-luna goes through here)
 *   - GET  /models           (model directory / policy check)
 *   - POST /chat/completions (chat surface, gpt-4.1)
 *
 * Variants:
 *   0. baseline        — exactly what the adapter sends today (GITHUB_REQUEST_HEADERS
 *                        + prepareHeaders).
 *   1. +vscode        — baseline plus `VScode-SessionId` + `VScode-MachineId`.
 *   2. library-ref     — baseline but `X-VSCode-User-Agent-Library-Version` set to
 *                        `node-http` (as the reference extension sends).
 *   3. reference       — full reference shape: vscode ids + node-http library +
 *                        `Openai-Organization: github-copilot` + separate
 *                        `X-Interaction-Id`.
 *
 * Usage:
 *   bun run scripts/provider-probing/github/github-wire-audit-probe.ts \
 *     --creds "C:\Users\...\github-accounts-<ts>.json"
 *
 * Never prints full credentials.
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readAccountsFile, pickAccount } from "../lib/accounts";
import { parseGithubCredential, GITHUB_REQUEST_HEADERS } from "../../../src/providers/integrations/github/github-oauth";
import { getOrCreateInstallId } from "../../../src/providers/integrations/shared/install-id";

const PROMPT = "Explain in one sentence what a bitmap allocator is.";

const CHAT_BODY = {
  model: "gpt-4.1",
  messages: [{ role: "user", content: PROMPT }],
  stream: false,
};

const AUTO_BODY = {
  prompt: PROMPT,
  tier: "efficiency",
};

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    hosts: { type: "string", default: "account" }, // account | central | both
    timeout: { type: "string", default: "30000" },
  },
});
if (!values.creds) throw new Error("--creds <path> is required");

const timeoutMs = Number(values.timeout);
const accounts = readAccountsFile(values.creds);
const account = pickAccount(accounts, {
  providerId: "github",
  ...(values.label !== undefined ? { label: values.label } : {}),
  ...(values.index !== undefined ? { index: Number(values.index) } : {}),
});
if (!account.accessToken) throw new Error(`Account "${account.label ?? account.id}" has no accessToken`);

// The stored envelope carries the minted Copilot token + apiHost + GitHub token.
const stored = parseGithubCredential(account.accessToken);
console.log("=== account ===");
console.log("  label:", account.label ?? account.id);
console.log("  stored apiHost:", stored.apiHost);
console.log("  stored token prefix:", stored.access.slice(0, 8) + "…");

// --- 1. Re-mint the Copilot token from the long-lived GitHub token ---
async function mintCopilotToken(githubToken: string, domain: string): Promise<{ access: string; apiHost: string }> {
  const res = await fetch(`https://api.${domain}/copilot_internal/v2/token`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${githubToken}`,
      ...GITHUB_REQUEST_HEADERS,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`token mint HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  const body = JSON.parse(text) as { token?: string };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error(`token mint returned no token: ${text.slice(0, 200)}`);
  }
  // apiHost from the fresh token's proxy-ep claim.
  const match = body.token.match(/proxy-ep=([^;]+)/);
  const proxy = match?.[1]?.trim();
  const apiHost = proxy ? proxy.replace(/^proxy\./, "api.") : "api.individual.githubcopilot.com";
  return { access: body.token, apiHost };
}

// Prefer the long-lived GitHub token for re-minting.
let access = stored.access;
let apiHost = stored.apiHost;
if (typeof account.refreshToken === "string" && account.refreshToken.length > 0) {
  try {
    const minted = await mintCopilotToken(account.refreshToken, "github.com");
    access = minted.access;
    apiHost = minted.apiHost;
    console.log("  token re-minted from refresh token -> apiHost:", apiHost);
  } catch (error) {
    console.log("  token mint failed (using stored copilot token):", error instanceof Error ? error.message : String(error));
  }
} else {
  console.log("  no refresh token; using stored copilot token as-is");
}
console.log("  effective apiHost:", apiHost);

// --- 2. Header variants ---
const machineId = await getOrCreateInstallId("github");
const sessionId = randomUUID(); // stable for this probe run
const interactionId = randomUUID();

function baselineHeaders(): Record<string, string> {
  return {
    ...GITHUB_REQUEST_HEADERS,
    "editor-device-id": machineId,
    "VScode-MachineId": machineId,
    "VScode-SessionId": sessionId,
    "openai-intent": "conversation-agent",
    "Openai-Organization": "github-copilot",
    "x-agent-task-id": interactionId,
    "x-interaction-id": interactionId,
    "x-initiator": "user",
    "x-interaction-type": "conversation-agent",
    "x-request-id": interactionId,
    "x-vscode-user-agent-library-version": "node-http",
    authorization: `Bearer ${access}`,
    "content-type": "application/json",
  };
}

interface Variant {
  readonly name: string;
  readonly headers: Record<string, string>;
}

const variants: Variant[] = [
  {
    name: "0-baseline (adapter 1:1)",
    headers: baselineHeaders(),
  },
  {
    name: "1-dup",
    headers: {
      ...baselineHeaders(),
    },
  },
  {
    name: "2-interaction-separate",
    headers: {
      ...baselineHeaders(),
      "X-Interaction-Id": randomUUID(),
      "X-Agent-Task-Id": randomUUID(),
      "X-Request-Id": randomUUID(),
    },
  },
  {
    name: "3-no-org",
    headers: {
      ...baselineHeaders(),
      "Openai-Organization": undefined as unknown as string,
    },
  },
];

// --- 3. Fire all variants against each endpoint ---
async function tryRequest(name: string, method: string, url: string, body: unknown, headers: Record<string, string>): Promise<void> {
  const start = Date.now();
  try {
    const isGet = method === "GET";
    const res = await fetch(url, {
      method,
      headers,
      ...(isGet ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    const head = text.replace(/\s+/g, " ").slice(0, 300);
    console.log(`\n[${name}] ${method} ${url.replace("https://", "")} -> ${res.status} (${Date.now() - start}ms)`);
    console.log("  head:", head || "(empty body)");
  } catch (error) {
    console.log(`\n[${name}] ${method} ${url.replace("https://", "")} -> ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}

const host = (values.hosts === "central") ? "api.githubcopilot.com" : apiHost;
if (values.hosts === "both") {
  for (const h of new Set([apiHost, "api.githubcopilot.com"])) {
    console.log(`\n========== host ${h} ==========`);
    for (const v of variants) {
      const hd = { ...v.headers, authorization: `Bearer ${access}` };
      await tryRequest(`${v.name}/auto`, "POST", `https://${h}/auto`, AUTO_BODY, hd);
      await tryRequest(`${v.name}/models`, "GET", `https://${h}/models`, undefined, hd);
      await tryRequest(`${v.name}/chat`, "POST", `https://${h}/chat/completions`, CHAT_BODY, hd);
    }
  }
} else {
  console.log(`\n========== host ${host} ==========`);
  for (const v of variants) {
    const hd = { ...v.headers, authorization: `Bearer ${access}` };
    await tryRequest(`${v.name}/auto`, "POST", `https://${host}/auto`, AUTO_BODY, hd);
    await tryRequest(`${v.name}/models`, "GET", `https://${host}/models`, undefined, hd);
    await tryRequest(`${v.name}/chat`, "POST", `https://${host}/chat/completions`, CHAT_BODY, hd);
  }
}

console.log("\n=== done ===");
