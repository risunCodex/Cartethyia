/**
 * Perch minimal probe (pure HTTP): one model-call with a stored session.
 *
 * Reads an existing session blob (accounts.json), mints a CLI turn ticket,
 * and runs a single `/api/perch-terminal/model-call` for each tier in
 * `PERCH_MODELS`. No OAuth flow, no plan selection — just "is the account
 * alive and can it serve this tier".
 *
 * Usage:
 *   bun run scripts/provider-probing/perch/probe-perch-min.ts \
 *     [--accounts <path>] [--model <tier>]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildPerchModelCallBody, parsePerchSse, summarizePerchStream } from "../../../src/providers/integrations/perch/perch-protocol";
import { PERCH_MODELS } from "../../../src/providers/integrations/perch/perch-catalog";
import { PERCH_APP_URL } from "./perch-shared";

const CLI_USER_AGENT = "perchai-cli/unknown";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const accountsFile = argValue("--accounts") ?? path.resolve(import.meta.dir, "accounts.json");
const onlyModel = argValue("--model");

const session = JSON.parse(await readFile(accountsFile, "utf8")) as Record<string, unknown>;
const access = String(session.access_token ?? session.accessToken ?? "");
if (!access) {
  console.error("no access token in", accountsFile);
  process.exit(1);
}

async function mintTicket(): Promise<{ ticket: string; runId: string }> {
  const res = await fetch(`${PERCH_APP_URL}/api/perch-terminal/turn-ticket`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${access}`,
      "content-type": "application/json",
      "user-agent": CLI_USER_AGENT,
      "x-perch-locale": "en",
    },
    body: JSON.stringify({ surface: "cli", profile: "standard" }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; ticket?: string; runId?: string; error?: string } | null;
  if (!res.ok || !body?.ok || !body.ticket) {
    throw new Error(`ticket failed: ${body?.error ?? `HTTP ${res.status}`}`);
  }
  return { ticket: body.ticket, runId: body.runId ?? `run-${Date.now()}` };
}

const tiers = onlyModel
  ? [onlyModel]
  : PERCH_MODELS.map((m) => String(m.modelId));

for (const tier of tiers) {
  try {
    const ticket = await mintTicket();
    const body = buildPerchModelCallBody(
      {
        model: tier,
        messages: [{ role: "user", content: [{ kind: "text", text: "ping" }] }],
        generation_controls: { max_tokens: 64, max_output_tokens: 64 },
        stream: false,
        source_surface: "chat",
      },
      tier,
      { userId: null, workspaceId: null, orgId: null, planCode: null, runId: ticket.runId },
    );
    const res = await fetch(`${PERCH_APP_URL}/api/perch-terminal/model-call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": CLI_USER_AGENT,
        "x-perch-locale": "en",
        "x-perch-call-delta": "1",
        "x-perch-turn-ticket": ticket.ticket,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      console.log(`${tier}: FAIL ${res.status} ${raw.slice(0, 200)}`);
      continue;
    }
    const result = summarizePerchStream(parsePerchSse(raw));
    if (result.ok) {
      console.log(`${tier}: OK "${result.text.slice(0, 60)}" (${result.model})`);
    } else {
      console.log(`${tier}: FAIL ${result.error ?? "no answer"} (${result.errorCode ?? ""})`);
    }
  } catch (error) {
    console.log(`${tier}: ERR ${(error as Error).message.slice(0, 160)}`);
  }
  // Be gentle: rate limits are per-turn and tight.
  await new Promise((r) => setTimeout(r, 2000));
}
