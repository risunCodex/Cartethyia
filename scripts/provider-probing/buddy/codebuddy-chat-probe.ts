/**
 * Live chat probe for the buddy family (CodeBuddy / WorkBuddy) using the exact
 * header + payload builders the gateway adapter uses.
 *
 * Usage:
 *   bun scripts/provider-probing/buddy/codebuddy-chat-probe.ts \
 *     --creds C:\Users\Aria\Desktop\cb-accounts-…json \
 *     --provider cb --model deepseek-v4.1-flash \
 *     --proxy http://127.0.0.1:18443
 *
 * Never prints the raw token — authorization is masked. `--proxy` routes the
 * request through a mitmproxy capture; without it the request goes direct.
 */
import { parseArgs } from "node:util";
import type { ProviderDispatchContext } from "../../../src/providers/provider-contracts";
import { readAccountsFile, pickAccount, requireAccountToken, maskSecret } from "../lib/accounts";
import { codebuddyHeaders } from "../../../src/providers/integrations/buddy/codebuddy/shared";
import { CODEBUDDY_SYSTEM_PROMPT } from "../../../src/providers/integrations/buddy/codebuddy/index";
import { buddyPrePayloadCommon, applyBuddySystemPrompt } from "../../../src/providers/integrations/buddy/chat";

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "auto" },
    provider: { type: "string", default: "cb" },
    proxy: { type: "string" },
    prompt: { type: "string", default: "Reply with the single word pong." },
    index: { type: "string" },
  },
});
if (!values.creds) throw new Error("--creds <path>");
const model = values.model!;
const provider = values.provider!.toLowerCase();

const account = pickAccount(readAccountsFile(values.creds), {
  providerId: provider,
  ...(values.index === undefined ? {} : { index: Number(values.index) }),
});
const token = requireAccountToken(account);
const secret = new TextEncoder().encode(token);
const context = {
  credential: {
    provider_id: provider,
    account_id: account.id,
    credential_kind: "oauth",
    secret,
    auth_state: (account.authState as Record<string, unknown> | undefined) ?? {},
  },
  request_headers: {},
} as unknown as ProviderDispatchContext;

interface ProbeTarget {
  readonly baseUrl: string;
  readonly path: string;
  readonly endpoint: string;
  readonly headers: Promise<Record<string, string>>;
  readonly systemPrompt: string;
  readonly realm: "intl" | "cn";
}
let target: ProbeTarget;
switch (provider) {
  case "cb": {
    const baseUrl = "https://www.codebuddy.ai/v2";
    target = {
      baseUrl,
      path: "/chat/completions",
      endpoint: `${baseUrl}/chat/completions`,
      headers: codebuddyHeaders("IDE", context, undefined, true),
      systemPrompt: CODEBUDDY_SYSTEM_PROMPT,
      realm: "intl",
    };
    break;
  }
  case "cbcn": {
    const baseUrl = "https://copilot.tencent.com/v2";
    target = {
      baseUrl,
      path: "/chat/completions",
      endpoint: `${baseUrl}/chat/completions`,
      headers: codebuddyHeaders("CLI", context, undefined),
      systemPrompt: "You are a helpful AI assistant that helps with software engineering tasks.",
      realm: "cn",
    };
    break;
  }
  default:
    throw new Error(`Unsupported --provider ${provider} (cb|cbcn)`);
}

const payload: Record<string, unknown> = {
  model,
  messages: [{ role: "user", content: values.prompt }],
};
buddyPrePayloadCommon(payload, undefined, target.realm, context);
const messages = payload["messages"] as Array<Record<string, unknown>>;
applyBuddySystemPrompt(messages, target.systemPrompt);

const headers = await target.headers;
const maskedHeaders: Record<string, string> = { ...headers };
if (maskedHeaders["Authorization"] !== undefined) maskedHeaders["Authorization"] = `Bearer ${maskSecret(token)}`;
if (maskedHeaders["authorization"] !== undefined) maskedHeaders["authorization"] = `Bearer ${maskSecret(token)}`;

console.log("=== request ===");
console.log("  provider:", provider, " model:", String(payload["model"]));
console.log("  url:", target.endpoint);
console.log("  headers:", JSON.stringify(maskedHeaders, null, 2));
console.log("  body:", JSON.stringify(payload));

async function run(): Promise<void> {
  let dispatcher: unknown;
  if (values.proxy !== undefined) {
    const undici = await import("undici");
    const ProxyAgent = (undici as unknown as { ProxyAgent: new (proxy: string) => unknown }).ProxyAgent;
    dispatcher = new ProxyAgent(values.proxy);
  }
  const res = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(dispatcher === undefined ? {} : { dispatcher: dispatcher as any }),
  });
  console.log("\n=== response ===");
  console.log("  status:", res.status, res.statusText);
  console.log("  content-type:", res.headers.get("content-type"));
  const text = await res.text().catch(() => "");
  console.log("  body head:", text.replace(/\s+/g, " ").slice(0, 2000));
}

await run().catch((error) => {
  console.log("\n=== ERROR ===", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
