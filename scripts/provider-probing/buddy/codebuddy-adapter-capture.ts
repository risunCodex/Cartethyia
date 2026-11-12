/**
 * Records the exact outbound wire the buddy adapter builds — headers + body —
 * without sending anything over the network. Uses the real provider adapter's
 * dispatch path with a capturing outbound_fetch, so what is printed is the byte
 * shape the gateway would put on the wire for that account/model.
 *
 * Usage:
 *   bun scripts/provider-probing/buddy/codebuddy-adapter-capture.ts \
 *     --creds C:\Users\Aria\Desktop\cb-accounts-…json \
 *     --provider cb --model deepseek-v4.1-flash
 */
import { parseArgs } from "node:util";
import type { ProviderDispatchContext } from "../../../src/providers/provider-contracts";
import { readAccountsFile, pickAccount, requireAccountToken, maskSecret } from "../lib/accounts";
import { createCodeBuddyAdapter } from "../../../src/providers/integrations/buddy/codebuddy/index";
import { createCodeBuddyCnAdapter } from "../../../src/providers/integrations/buddy/codebuddy/index";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "auto" },
    provider: { type: "string", default: "cb" },
    index: { type: "string" },
  },
});
if (!values.creds) throw new Error("--creds <path>");
const provider = values.provider!.toLowerCase();
const account = pickAccount(readAccountsFile(values.creds), {
  providerId: provider,
  ...(values.index === undefined ? {} : { index: Number(values.index) }),
});
const token = requireAccountToken(account);
const secret = new TextEncoder().encode(token);

interface Capture {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
let captured: Capture | undefined;
const outbound = (async (url: string | URL | Request, init?: RequestInit) => {
  const rawHeaders = (init?.headers ?? {}) as Record<string, string> | Headers | Array<[string, string]>;
  const headers: Record<string, string> = {};
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(rawHeaders)) {
    for (const [key, value] of rawHeaders) headers[key] = value;
  } else {
    Object.assign(headers, rawHeaders);
  }
  captured = {
    url: String(url),
    headers,
    body: JSON.parse(String(init?.body ?? "{}")) as unknown,
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"id\":\"cap-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"pong\"},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n"));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}) as unknown as ProviderDispatchContext["outbound_fetch"];

const adapter =
  provider === "cb"
    ? createCodeBuddyAdapter()
    : provider === "cbcn"
      ? createCodeBuddyCnAdapter()
      : undefined;
if (adapter === undefined) throw new Error(`Unsupported --provider ${provider}`);

const request: CanonicalRequest = {
  model: values.model!,
  messages: [{ role: "user", content: [{ kind: "text", text: "Reply with the single word pong." }] }],
  generation_controls: {},
  stream: true,
  source_surface: "chat",
};
const candidate = {
  provider_id: provider,
  model_id: values.model!,
  wire_family: "chat",
  endpoint_path: provider === "cb" || provider === "cbcn" ? "/chat/completions" : "/v2/chat/completions",
  capabilities: {},
} as unknown as Parameters<typeof adapter.dispatch>[1];

const context = {
  credential: {
    provider_id: provider,
    account_id: account.id,
    credential_kind: "oauth",
    secret,
    auth_state: (account.authState as Record<string, unknown> | undefined) ?? {},
  },
  request_headers: {},
  deadline: Date.now() + 30_000,
  abort_signal: new AbortController().signal,
  outbound_fetch: outbound,
  request_id: "adapter-capture-1",
} as unknown as ProviderDispatchContext;

const stream = adapter.dispatch(request, candidate, context);
for await (const _event of stream) void _event;

if (captured === undefined) throw new Error("no request captured");
const headers = { ...captured.headers };
if (headers["authorization"] !== undefined) headers["authorization"] = `Bearer ${maskSecret(token)}`;
console.log("=== adapter outbound wire ===");
console.log("url:", captured.url);
console.log("headers:", JSON.stringify(headers, null, 2));
console.log("body:", JSON.stringify(captured.body, null, 2));
console.log("\n=== qimei36 / turing presence ===");
console.log("X-Device-Id-List:", headers["x-device-id-list"] ?? headers["X-Device-Id-List"] ?? "(absent)");
console.log("X-Device-Token:", headers["x-device-token"] ?? headers["X-Device-Token"] ?? "(absent)");
console.log("X-Device-Token-Error:", headers["x-device-token-error"] ?? headers["X-Device-Token-Error"] ?? "(absent)");
console.log("X-Custom-Channel-Id:", headers["x-custom-channel-id"] ?? headers["X-Custom-Channel-Id"] ?? "(absent)");
console.log("X-User-Id:", headers["x-user-id"] ?? headers["X-User-Id"] ?? "(absent)");
