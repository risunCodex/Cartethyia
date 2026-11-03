/**
 * Antigravity Google OAuth probe (PKCE browser flow + token refresh).
 *
 * Reuses the adapter's OAuth client identity (client id/secret/redirect,
 * scopes) so a successful exchange proves the exact credential set the
 * gateway uses is valid end-to-end. Tokens are never printed — only
 * masked prefixes. A successful refresh can be used to update an account
 * export by hand.
 *
 *   bun run scripts/provider-probing/antigravity/probe-antigravity-oauth.ts \
 *     --creds "C:\...\antigravity-accounts-<ts>.json" --authorize
 *   bun run scripts/provider-probing/antigravity/probe-antigravity-oauth.ts \
 *     --creds <file> --refresh
 *
 * Flags:
 *   --creds <path>     account export file (or a single-account object file)
 *   --label <name>     account by label
 *   --index <n>        account by index
 *   --authorize        run the browser PKCE flow (print authorize URL, paste callback)
 *   --refresh          exchange the account's refreshToken for a new access token
 *   --code <code>      pre-supplied authorization code (skips paste prompt)
 *   --state <s>        state value to embed (default random)
 *   --timeout-ms <n>  HTTP timeout (default 30000)
 */
import { parseArgs } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import {
  readAccountsFile,
  pickAccount,
} from "../lib/accounts";
import { maskToken } from "./antigravity-shared";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_AUTHORIZE_URL,
  ANTIGRAVITY_TOKEN_URL,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
} from "../../../src/providers/integrations/antigravity/antigravity-oauth";

interface CliArgs {
  creds?: string | undefined;
  label?: string | undefined;
  index?: number | undefined;
  authorize?: boolean;
  refresh?: boolean;
  code?: string | undefined;
  state?: string | undefined;
  timeoutMs?: number;
  help?: boolean;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      creds: { type: "string" },
      label: { type: "string" },
      index: { type: "string" },
      authorize: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      code: { type: "string" },
      state: { type: "string" },
      "timeout-ms": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  return {
    creds: values.creds,
    label: values.label,
    index: values.index === undefined ? undefined : Number(values.index),
    authorize: values.authorize ?? false,
    refresh: values.refresh ?? false,
    code: values.code,
    state: values.state,
    timeoutMs: values["timeout-ms"] === undefined ? 30_000 : Number(values["timeout-ms"]),
    help: values.help ?? false,
  };
}

const HELP = `Antigravity Google OAuth probe

  bun run scripts/provider-probing/antigravity/probe-antigravity-oauth.ts --creds <file> --authorize
  bun run scripts/provider-probing/antigravity/probe-antigravity-oauth.ts --creds <file> --refresh
`;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizeUrl(verifier: string, state: string): string {
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    response_type: "code",
    scope: ANTIGRAVITY_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: verifier,
    code_challenge_method: "S256",
  });
  return `${ANTIGRAVITY_AUTHORIZE_URL}?${params.toString()}`;
}

async function promptLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function exchangeCode(
  code: string,
  verifier: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    code_verifier: verifier,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ANTIGRAVITY_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text.slice(0, 200), status: res.status };
    }
    console.log(`token exchange status=${res.status}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshToken(refresh: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ANTIGRAVITY_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text.slice(0, 200), status: res.status };
    }
    console.log(`refresh status=${res.status}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const args = parseCli();
  if (args.help || !args.creds || (!args.authorize && !args.refresh)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  const accounts = readAccountsFile(args.creds);
  const account = pickAccount(accounts, {
    providerId: "antigravity",
    ...(args.label === undefined ? {} : { label: args.label }),
    ...(args.index === undefined ? {} : { index: args.index }),
  });
  console.log(`account=${account.label ?? account.id ?? "?"}`);

  if (args.refresh) {
    const refresh = account.refreshToken?.trim();
    if (!refresh) {
      console.error("account has no refreshToken; cannot --refresh");
      process.exit(1);
    }
    console.log(`refresh token=${maskToken(refresh)}`);
    const result = await refreshToken(refresh, args.timeoutMs ?? 30_000);
    const access = typeof result.access_token === "string" ? result.access_token : "";
    const newRefresh = typeof result.refresh_token === "string" ? result.refresh_token : "";
    console.log(`access_token=${access ? maskToken(access) : "(none)"}`);
    if (newRefresh) console.log(`refresh_token=${maskToken(newRefresh)} (rotated)`);
    if (typeof result.expires_in === "number") console.log(`expires_in=${result.expires_in}`);
    if ("error" in result) console.log(`error=${String(result.error)} description=${String(result.error_description ?? "")}`);
    return;
  }

  // authorize flow
  const { verifier, challenge } = pkcePair();
  const state = args.state ?? base64url(randomBytes(12));
  console.log(`\nPKCE verifier (keep) = ${verifier}`);
  console.log(`PKCE challenge (S256) = ${challenge}`);
  console.log(`state = ${state}`);
  console.log("\nOpen this URL in a browser (Google login), then paste the full callback URL or the `code` parameter:\n");
  console.log(buildAuthorizeUrl(verifier, state));
  console.log("");

  let code = args.code;
  if (!code) {
    const callback = await promptLine("Paste callback URL (or code): ");
    const parsed = new URL(callback.startsWith("http") ? callback : `http://127.0.0.1/?${callback}`);
    code = parsed.searchParams.get("code") ?? callback;
  }
  if (!code) {
    console.error("no code obtained");
    process.exit(1);
  }
  const result = await exchangeCode(code, verifier, args.timeoutMs ?? 30_000);
  const access = typeof result.access_token === "string" ? result.access_token : "";
  const refresh = typeof result.refresh_token === "string" ? result.refresh_token : "";
  console.log(`access_token=${access ? maskToken(access) : "(none)"}`);
  if (refresh) console.log(`refresh_token=${maskToken(refresh)}`);
  if (typeof result.expires_in === "number") console.log(`expires_in=${result.expires_in}`);
  if ("error" in result) console.log(`error=${String(result.error)} description=${String(result.error_description ?? "")}`);
  if (!access) {
    console.error("\nexchange failed — verify redirect_uri allowlist and client/secret.");
    process.exit(2);
  }
}

await main();
