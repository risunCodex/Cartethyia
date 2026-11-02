/**
 * Live Kiro OAuth probe: IdC/Builder-ID browser PKCE + social.
 *
 * Exercises the 1.4.62 client auth flow live:
 *
 *   - IdC/Builder-ID: register a public client against AWS SSO OIDC
 *     (`client/register`), print the authorize URL (PKCE S256, loopback
 *     redirect `http://127.0.0.1/oauth/callback`), wait for the pasted
 *     callback URL, then exchange the code via `CreateToken`
 *     (`authorization_code`) and refresh via `CreateToken` (`refresh_token`).
 *   - Social (Google/GitHub): prints the vendor sign-in URL
 *     (`https://prod.us-east-1.auth.desktop.kiro.dev/login?…`) and exchanges
 *     the pasted code against `/oauth/token`.
 *
 * Reads the account file only for selecting which method/region to start from;
 * tokens are never printed. This is the live counterpart of
 * `KiroOAuthClient#prepareAuthorize` / `#buildAuthorizeUrl` /
 * `#exchangeIdcCode` / `exchangeSocialCode`.
 *
 * Usage:
 *   bun run scripts/provider-probing/kiro/probe-kiro-oauth.ts --creds <file>
 *   bun run scripts/provider-probing/kiro/probe-kiro-oauth.ts \
 *     --creds <file> --method idc --region eu-central-1
 */
import { parseArgs } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  maskSecret,
  pickAccount,
  readAccountsFile,
  type ExportedAccount,
} from "../lib/accounts";

const SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];
const REDIRECT = "http://127.0.0.1/oauth/callback";
const SOCIAL_AUTH = "https://prod.us-east-1.auth.desktop.kiro.dev";
const SOCIAL_PORTAL = "https://app.kiro.dev";
// Mirror the real portal flow: the PortalAuthServer's redirectUri is the
// origin only (`http://localhost:<port>`), no path — Cognito rejects any
// path-carrying redirect URI with `redirect_mismatch`.
const SOCIAL_REDIRECT = "http://localhost:3128";

const base64Url = (b: Buffer) => b.toString("base64url");
const sha256b64url = (s: string) => base64Url(createHash("sha256").update(s).digest());

function ssoHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "aws-sdk-js/3.980.0 ua/2.1 KiroIDE",
    "x-amz-user-agent": "aws-sdk-js/3.980.0 KiroIDE",
    "amz-sdk-request": "attempt=1; max=4",
    "amz-sdk-invocation-id": randomUUID(),
  };
}

interface IdcSession {
  readonly authMethod: string;
  readonly region: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl: string;
  readonly state: string;
  readonly verifier: string;
  readonly startUrl: string;
  readonly machineId?: string;
}

async function registerAndPrintUrl(
  region: string,
  authMethod: string,
  startUrl: string,
  sessionPath: string,
): Promise<void> {
  const oidc = `https://oidc.${region}.amazonaws.com`;
  console.log("\n== IdC/Builder-ID (browser PKCE) ==");

  // 1. Register client.
  const regRes = await fetch(`${oidc}/client/register`, {
    method: "POST",
    headers: ssoHeaders(),
    body: JSON.stringify({
      clientName: "Kiro IDE",
      clientType: "public",
      scopes: SCOPES,
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [REDIRECT],
      issuerUrl: startUrl,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const regText = await regRes.text();
  let reg: Record<string, unknown> = {};
  try {
    reg = JSON.parse(regText) as Record<string, unknown>;
  } catch {
    console.log(`register HTTP ${regRes.status} non-JSON: ${regText.slice(0, 400)}`);
    return;
  }
  if (!regRes.ok || !reg.clientId || !reg.clientSecret) {
    console.log(`register HTTP ${regRes.status}: ${JSON.stringify(reg).slice(0, 600)}`);
    return;
  }
  const clientId = String(reg.clientId);
  const clientSecret = String(reg.clientSecret);
  const tokenUrl = String(reg.tokenEndpoint ?? `${oidc}/token`);

  // 2. Authorize URL.
  const verifier = base64Url(randomBytes(32));
  const challenge = sha256b64url(verifier);
  const state = randomUUID();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scopes: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorizeUrl = `${oidc}/authorize?${params.toString()}`;

  const session: IdcSession = {
    authMethod: authMethod === "idc" ? "idc" : "builder-id",
    region,
    clientId,
    clientSecret,
    tokenUrl,
    state,
    verifier,
    startUrl,
  };
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");

  console.log(`\nBUKA URL INI DI BROWSER & LOGIN:\n`);
  console.log(authorizeUrl);
  console.log(`\nstate=${state}`);
  console.log(`session tersimpan: ${sessionPath}`);
  console.log(`Setelah approve, jalankan:\n  bun run scripts/provider-probing/kiro/probe-kiro-oauth.ts --exchange "${sessionPath}" "<callback-or-code>"`);
}

async function exchangeSession(
  sessionPath: string,
  callback: string,
  opts: { readonly out?: string } = {},
): Promise<void> {
  const session = JSON.parse(readFileSync(sessionPath, "utf8")) as IdcSession;
  const code = callback.includes("code=") ? new URL(callback).searchParams.get("code") ?? "" : callback;
  if (!code) {
    console.log("tidak ada code di callback.");
    return;
  }
  console.log("\n== exchange (CreateToken authorization_code) ==");
  const exchangeRes = await fetch(session.tokenUrl, {
    method: "POST",
    headers: ssoHeaders(),
    body: JSON.stringify({
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      grantType: "authorization_code",
      code,
      redirectUri: REDIRECT,
      codeVerifier: session.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const exchangeText = await exchangeRes.text();
  let tok: Record<string, unknown> = {};
  try {
    tok = JSON.parse(exchangeText) as Record<string, unknown>;
  } catch {
    console.log(`exchange HTTP ${exchangeRes.status} non-JSON: ${exchangeText.slice(0, 500)}`);
    return;
  }
  if (!exchangeRes.ok || !tok.accessToken) {
    console.log(`exchange HTTP ${exchangeRes.status}: ${JSON.stringify(tok).slice(0, 600)}`);
    return;
  }
  console.log(`accessToken=${maskSecret(String(tok.accessToken))} expiresIn=${tok.expiresIn}`);

  if (tok.refreshToken) {
    console.log("\n== refresh (CreateToken refresh_token) ==");
    const refreshRes = await fetch(session.tokenUrl, {
      method: "POST",
      headers: ssoHeaders(),
      body: JSON.stringify({
        clientId: session.clientId,
        clientSecret: session.clientSecret,
        grantType: "refresh_token",
        refreshToken: tok.refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const refreshText = await refreshRes.text();
    try {
      const fresh = JSON.parse(refreshText) as Record<string, unknown>;
      console.log(`refresh HTTP ${refreshRes.status} accessToken=${maskSecret(String(fresh.accessToken ?? ""))}`);
    } catch {
      console.log(`refresh HTTP ${refreshRes.status} non-JSON: ${refreshText.slice(0, 400)}`);
    }
  }

  const creds = {
    providerId: "kiro",
    label: "kiro",
    credentialKind: "oauth",
    status: "active",
    accessToken: String(tok.accessToken),
    refreshToken: String(tok.refreshToken ?? ""),
    authState: {
      authMethod: session.authMethod,
      region: session.region,
      clientId: session.clientId,
      machineId: session.machineId ?? "",
      startUrl: session.startUrl,
    },
  };
  if (opts.out !== undefined) {
    writeFileSync(opts.out, `${JSON.stringify(creds, null, 2)}\n`, "utf8");
    console.log(`creds tersimpan: ${opts.out}`);
  }

  console.log("\n=== RINGKASAN (masked) ===");
  console.log(
    JSON.stringify(
      {
        authMethod: session.authMethod,
        region: session.region,
        clientId: session.clientId,
        accessToken: maskSecret(String(tok.accessToken)),
        refreshToken: tok.refreshToken ? maskSecret(String(tok.refreshToken)) : "(none)",
        startUrl: session.startUrl,
        savedTo: opts.out ?? "(not saved)",
      },
      null,
      2,
    ),
  );
}

interface SocialSession {
  readonly authMethod: string;
  readonly region: string;
  readonly state: string;
  readonly verifier: string;
  readonly tokenUrl: string;
}

async function registerSocialAndPrintUrl(idp: string, sessionPath: string): Promise<void> {
  console.log(`\n== Social (${idp}) (portal PKCE) ==`);
  const verifier = base64Url(randomBytes(32));
  const challenge = sha256b64url(verifier);
  const state = randomUUID();
  const params = new URLSearchParams({
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: SOCIAL_REDIRECT,
    redirect_from: "KiroIDE",
  });
  const url = `${SOCIAL_PORTAL}/signin?${params.toString()}`;

  const session: SocialSession = {
    authMethod: idp === "github" ? "github" : "google",
    region: "us-east-1",
    state,
    verifier,
    tokenUrl: `${SOCIAL_AUTH}/oauth/token`,
  };
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");

  console.log("\nBUKA URL INI DI BROWSER & LOGIN:\n");
  console.log(url);
  console.log(`\nstate=${state}`);
  console.log(`session tersimpan: ${sessionPath}`);
  console.log(`Pilih "Google" di portal, lalu paste URL redirect loopback (yg berisi ?login_option=google&code=…):`);
}

async function exchangeSocialSession(sessionPath: string, callback: string, opts: { readonly out?: string } = {}): Promise<void> {
  const session = JSON.parse(readFileSync(sessionPath, "utf8")) as SocialSession;
  let cb: URL;
  try {
    cb = new URL(callback);
  } catch {
    console.log("callback bukan URL valid.");
    return;
  }
  const code = cb.searchParams.get("code") ?? "";
  const loginOption = cb.searchParams.get("login_option") ?? session.authMethod;
  const state = cb.searchParams.get("state") ?? "";
  if (!code) {
    console.log("tidak ada code di callback.");
    return;
  }
  if (state !== session.state) {
    console.log(`state tidak cocok (dapat ${state}, harap ${session.state}).`);
    return;
  }
  // The client rebuilds the redirectUri from the callback path + login_option.
  const redirectUri = `${cb.origin}${cb.pathname}?login_option=${loginOption}`;
  console.log(`\n== exchange (social ${loginOption}) ==`);
  console.log(`  redirectUri=${redirectUri}`);
  const res = await fetch(session.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "KiroIDE",
      "x-amz-user-agent": "KiroIDE",
    },
    body: JSON.stringify({ code, code_verifier: session.verifier, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let tok: Record<string, unknown> = {};
  try {
    tok = JSON.parse(text) as Record<string, unknown>;
  } catch {
    console.log(`exchange HTTP ${res.status} non-JSON: ${text.slice(0, 500)}`);
    return;
  }
  if (!res.ok || !tok.accessToken) {
    console.log(`exchange HTTP ${res.status}: ${JSON.stringify(tok).slice(0, 600)}`);
    return;
  }
  console.log(`accessToken=${maskSecret(String(tok.accessToken))} expiresIn=${tok.expiresIn}`);

  const creds = {
    providerId: "kiro",
    label: "kiro",
    credentialKind: "oauth",
    status: "active",
    accessToken: String(tok.accessToken),
    refreshToken: String(tok.refreshToken ?? ""),
    authState: {
      authMethod: session.authMethod,
      region: session.region,
      clientId: "",
      machineId: "",
      startUrl: "",
    },
  };
  if (opts.out !== undefined) {
    writeFileSync(opts.out, `${JSON.stringify(creds, null, 2)}\n`, "utf8");
    console.log(`creds tersimpan: ${opts.out}`);
  }

  console.log("\n=== RINGKASAN (masked) ===");
  console.log(
    JSON.stringify(
      {
        authMethod: session.authMethod,
        region: session.region,
        accessToken: maskSecret(String(tok.accessToken)),
        refreshToken: tok.refreshToken ? maskSecret(String(tok.refreshToken)) : "(none)",
        savedTo: opts.out ?? "(not saved)",
      },
      null,
      2,
    ),
  );
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    method: { type: "string", default: "builder-id" },
    region: { type: "string", default: "us-east-1" },
    "start-url": { type: "string", default: "https://view.awsapps.com/start" },
    "idp": { type: "string", default: "google" },
    label: { type: "string" },
    index: { type: "string" },
    "url-only": { type: "boolean", default: false },
    session: { type: "string" },
    exchange: { type: "boolean", default: false },
    callback: { type: "string" },
    out: { type: "string" },
  },
});

if (values.exchange) {
  if (values.session === undefined) throw new Error("--exchange requires --session <session.json>");
  if (values.callback === undefined) throw new Error("--exchange requires --callback <callback-url-or-code>");
  const saved = JSON.parse(readFileSync(values.session, "utf8")) as Record<string, unknown>;
  if ("clientId" in saved && typeof saved.clientId === "string") {
    await exchangeSession(values.session, values.callback, {
      ...(values.out !== undefined ? { out: values.out } : {}),
    });
  } else {
    await exchangeSocialSession(values.session, values.callback, {
      ...(values.out !== undefined ? { out: values.out } : {}),
    });
  }
  process.exit(0);
}

const credsPath = values.creds;
if (credsPath === undefined) throw new Error("--creds <path> is required");

const accounts = readAccountsFile(credsPath);
const account: ExportedAccount = pickAccount(accounts, {
  providerId: "kiro",
  ...(values.label !== undefined ? { label: values.label } : {}),
  ...(values.index !== undefined ? { index: Number(values.index) } : {}),
});
console.log(`account=${account.label ?? "?"} (${account.providerId ?? "?"}/${account.credentialKind ?? "?"})`);

const method = values.method as string;
const sessionPath =
  values.session ?? `D:\\tmp\\scratch\\kiro-oauth-${method}-${Date.now()}.json`;
if (method === "google" || method === "github") {
  await registerSocialAndPrintUrl(method, sessionPath);
} else {
  await registerAndPrintUrl(values.region as string, method, values["start-url"] as string, sessionPath);
}
