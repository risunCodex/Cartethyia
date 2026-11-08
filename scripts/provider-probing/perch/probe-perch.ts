/**
 * Perch probe (pure HTTP).
 *
 * Flow:
 *   1. Starts a loopback server on 127.0.0.1:<port>/callback.
 *   2. Prints the Supabase authorize URL; open it in a browser (Google).
 *   3. On callback, exchanges the code (grant_type=pkce, auth_code).
 *   4. Ensures the Starter free plan is selected via cli-plan.
 *   5. Mints a CLI turn ticket and invokes `/api/perch-terminal/model-call`
 *      with the full CLI envelope (Saffron system prompt, Roost tier,
 *      attribution) — the same wire the adapter uses.
 *   6. Prints a masked summary. Tokens are never printed.
 *
 * Environment:
 *   ACCOUNTS_FILE — where the session blob is written (default:
 *                   scripts/provider-probing/perch/accounts.json)
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PERCH_APP_URL,
  perchAuthorizeUrl,
  perchChooseStarter,
  perchExchangeCode,
  perchPlanStatus,
} from "./perch-shared";
import {
  buildPerchModelCallBody,
  parsePerchSse,
  summarizePerchStream,
} from "../../../src/providers/integrations/perch/perch-protocol";

const PORT = Number(process.env.PORT ?? 1455);
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const ACCOUNTS_FILE =
  process.env.ACCOUNTS_FILE ??
  path.resolve(import.meta.dir, "accounts.json");
const CLI_USER_AGENT = "perchai-cli/unknown";

const b64u = (buf: Uint8Array) => Buffer.from(buf).toString("base64url");
const verifier = b64u(randomBytes(32));
const challenge = b64u(createHash("sha256").update(verifier).digest());
const state = b64u(randomBytes(16));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end();
    return;
  }
  const code = url.searchParams.get("code");
  res.writeHead(200, { "content-type": "text/html" });
  if (!code) {
    res.end("<h2>No code in callback</h2>");
    return;
  }
  res.end("<h2>Login captured — close this tab.</h2>");
  server.close();
  void run(code);
});

async function run(code: string): Promise<void> {
  try {
    const exchanged = await perchExchangeCode(code, REDIRECT, verifier);
    if (!exchanged?.access_token) {
      console.error("token exchange failed");
      process.exit(1);
    }
    const access = String(exchanged.access_token);

    const plan = await perchPlanStatus(access);
    if (plan?.ok === true && plan.planRequired === true) {
      const chosen = await perchChooseStarter(access);
      console.log("choose starter:", chosen ? JSON.stringify(chosen).slice(0, 120) : "(failed)");
    }

    await writeFile(ACCOUNTS_FILE, JSON.stringify(exchanged, null, 2), { mode: 0o600 });
    console.log("session saved ->", ACCOUNTS_FILE);

    await probeModelCall(exchanged);
  } catch (error) {
    console.error("probe error:", (error as Error).message);
    process.exit(1);
  }
}

async function probeModelCall(session: Record<string, unknown>): Promise<void> {
  const access = String(session.access_token);
  const account = await readAccount(access);
  const userId = typeof account?.session?.userId === "string" ? account.session.userId : null;
  const workspaceId = typeof account?.session?.workspaceId === "string" ? account.session.workspaceId : null;

  for (const model of ["standard", "standard 1m"]) {
    console.log(`\n=== model-call --model ${model} ===`);
    try {
      const ticket = await mintTicket(access);
      const body = buildPerchModelCallBody(
        {
          model,
          messages: [{ role: "user", content: [{ kind: "text", text: "Reply with exactly: pong" }] }],
          generation_controls: {},
          stream: false,
          source_surface: "chat",
        },
        model,
        { userId, workspaceId, orgId: null, planCode: null, runId: ticket.runId },
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
      });
      const raw = await res.text();
      if (!res.ok) {
        console.log("status:", res.status, "| body:", raw.slice(0, 300));
        continue;
      }
      const result = summarizePerchStream(parsePerchSse(raw));
      if (result.ok) {
        console.log("ok: true");
        console.log("assistantText:", JSON.stringify(result.text));
        console.log("model:", result.model, "| provider:", result.provider);
        if (result.usage) console.log("usage:", JSON.stringify(result.usage));
      } else {
        console.log("ok: false | error:", result.error, "| errorCode:", result.errorCode);
      }
    } catch (error) {
      console.log("probe error:", (error as Error).message.slice(0, 200));
    }
  }
}

async function readAccount(access: string): Promise<{
  session?: { userId?: string; workspaceId?: string };
} | null> {
  try {
    const res = await fetch(`${PERCH_APP_URL}/api/perchai/account`, {
      headers: { authorization: `Bearer ${access}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { session?: { userId?: string; workspaceId?: string } };
  } catch {
    return null;
  }
}

async function mintTicket(access: string): Promise<{ ticket: string; runId: string }> {
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
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    ticket?: string;
    runId?: string;
    error?: string;
  } | null;
  if (!res.ok || !body?.ok || !body.ticket || !body.runId) {
    throw new Error(`ticket mint failed: ${body?.error ?? `HTTP ${res.status}`}`);
  }
  return { ticket: body.ticket, runId: body.runId };
}

server.listen(PORT, "127.0.0.1", () => {
  const url = perchAuthorizeUrl(REDIRECT, challenge, state);
  console.log(`[auth] open in browser:\n${url}`);
  console.log(`[auth] loopback: ${REDIRECT}`);
});
