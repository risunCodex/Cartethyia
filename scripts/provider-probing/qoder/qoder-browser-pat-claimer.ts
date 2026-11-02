/**
 * Qoder browser-session PAT claimer.
 *
 * Claims Personal Access Tokens from the Qoder web console using the session
 * cookie the browser exported (Netscape cookies.txt). A minted PAT (`pt-…`)
 * is exchanged by the adapter into a per-request job token — the durable
 * identity path, valid up to 1 year — versus the device token (`dt-…`) that
 * the OAuth flow issues.
 *
 * The console's APIs live on `https://qoder.com/api/v1/me/personal-access-tokens`
 * and require the page's CSRF double-submit pair: the `window.csrfToken` that
 * the inline script injects, and the `qoder_csrf_token` cookie the page sets.
 * Both are fetched fresh from the page before any write.
 *
 *   bun run scripts/provider-probing/qoder/qoder-browser-pat-claimer.ts \
 *     --cookies "C:\Users\Aria\Downloads\qoder.com_cookies_netscape.txt" \
 *     --list
 *
 *   bun run scripts/provider-probing/qoder/qoder-browser-pat-claimer.ts \
 *     --cookies "C:\Users\Aria\Downloads\qoder.com_cookies_netscape.txt" \
 *     --check
 *
 *   bun run scripts/provider-probing/qoder/qoder-browser-pat-claimer.ts \
 *     --cookies "C:\Users\Aria\Downloads\qoder.com_cookies_netscape.txt" \
 *     --create --name cartethyia --days 365 \
 *     --out "D:\tmp\scratch\qoder-pat.json"
 *
 *   bun run scripts/provider-probing/qoder/qoder-browser-pat-claimer.ts \
 *     --cookies "C:\Users\Aria\Downloads\qoder.com_cookies_netscape.txt" \
 *     --revoke <token_id>
 *
 * The minted PAT value is written only to `--out`; it is never printed. Every
 * other output masks secrets via `lib/accounts`.
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { maskUuid } from "../lib/accounts";

const args = parseArgs({
  options: {
    cookies: { type: "string", required: true },
    list: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    create: { type: "boolean", default: false },
    name: { type: "string", default: "" },
    days: { type: "string", default: "365" },
    out: { type: "string", default: "" },
    revoke: { type: "string", default: "" },
  },
});

/** One Netscape cookies.txt row. */
interface Cookie {
  readonly domain: string;
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly secure: boolean;
  readonly expires: number;
}

function parseNetscape(text: string): Cookie[] {
  const out: Cookie[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    out.push({
      domain: f[0]!,
      name: f[5]!,
      value: f[6]!,
      path: f[2]!,
      secure: f[3]!.toLowerCase() === "true",
      expires: Number(f[4]!),
    });
  }
  return out;
}

function cookieHeader(cookies: Cookie[], url: string): string {
  const u = new URL(url);
  const host = u.hostname;
  const secure = u.protocol === "https:";
  return cookies
    .filter((c) => {
      const d = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      if (host !== d && !host.endsWith("." + d)) return false;
      if (c.secure && !secure) return false;
      if (c.expires !== 0 && c.expires * 1000 < Date.now()) return false;
      return true;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

const BASE = "https://qoder.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0 Safari/537.36";
const cookies = parseNetscape(readFileSync(args.values.cookies!, "utf8"));
const baseHeaders = {
  Cookie: cookieHeader(cookies, BASE),
  Accept: "application/json",
  "User-Agent": UA,
};

/**
 * The console injects `window.csrfToken` into an inline script and the server
 * sets a `qoder_csrf_token` cookie on page load. Writes require both, and they
 * must agree (double-submit CSRF).
 *
 * The page redirects to `/users/sign-in` when the session cookie has expired.
 * That is caught here as an explicit, actionable error instead of letting the
 * sign-in page's own csrf token pass through and fail later on a write.
 */
async function fetchCsrf(): Promise<{ token: string; cookieValue: string }> {
  const res = await fetch(`${BASE}/account/integrations`, { headers: baseHeaders, redirect: "manual" });
  if (res.status === 302 || res.status === 303) {
    throw new Error(
      "Qoder session cookie expired or invalid (HTTP 302 → /users/sign-in). " +
        "Open qoder.com in your browser, sign in again, and re-export the cookies.txt.",
    );
  }
  if (!res.ok) throw new Error(`page fetch failed: ${res.status}`);
  const html = await res.text();
  const m = /window\.csrfToken\s*=\s*'([^']+)'/.exec(html);
  if (!m) throw new Error("csrfToken not found in page HTML");
  const setCookie = res.headers.getSetCookie().find((sc) => sc.startsWith("qoder_csrf_token="));
  if (!setCookie) throw new Error("qoder_csrf_token cookie not set by page");
  return { token: m[1]!, cookieValue: /^qoder_csrf_token=([^;]*)/.exec(setCookie)?.[1] ?? "" };
}

interface PatRow {
  readonly token_id: string;
  readonly name: string;
  readonly created_at: number;
  readonly expired_at: number;
  readonly is_expired: boolean;
}

async function list(): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/me/personal-access-tokens?page=1&page_size=50`, { headers: baseHeaders });
  if (!res.ok) {
    console.error(`list failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const json = (await res.json()) as { personal_tokens?: PatRow[] };
  const rows = json.personal_tokens ?? [];
  console.log(`PATs: ${rows.length}`);
  for (const t of rows) {
    const expired = new Date(t.expired_at);
    const daysLeft = Math.floor((t.expired_at - Date.now()) / 86_400_000);
    console.log(
      `  ${maskUuid(t.token_id)} name="${t.name}" expires=${expired.toISOString().slice(0, 10)} ` +
        `(${daysLeft >= 0 ? `${daysLeft}d left` : "EXPIRED"})`,
    );
  }
  if (rows.length === 0 || rows.every((r) => r.is_expired)) {
    console.log("no live PAT — create one with --create --out <path>");
  }
}

async function create(): Promise<void> {
  const outPath = args.values.out!;
  if (!outPath) {
    console.error("--create requires --out <path> (where the minted PAT is saved)");
    process.exit(1);
  }
  if (existsSync(outPath)) {
    console.error(`output file already exists: ${outPath}`);
    process.exit(1);
  }
  const name = args.values.name || `cartethyia-${new Date().getFullYear()}`;
  // The console's date picker caps expiry at 1 year from today.
  const days = Math.min(Math.max(1, Number(args.values.days) || 365), 365);
  const expiresAt = Date.now() + days * 86_400_000;

  const { token: csrf, cookieValue: csrfCookie } = await fetchCsrf();
  const res = await fetch(`${BASE}/api/v1/me/personal-access-tokens`, {
    method: "POST",
    headers: {
      ...baseHeaders,
      Cookie: `${baseHeaders.Cookie}; qoder_csrf_token=${csrfCookie}`,
      "Content-Type": "application/json",
      "X-CSRF-TOKEN": csrf,
      "x-requested-with": "XMLHttpRequest",
    },
    body: JSON.stringify({ name, expires_at: expiresAt }),
  });
  const raw = await res.text();
  if (!res.ok) {
    console.error(`create failed: ${res.status} ${raw.slice(0, 300)}`);
    process.exit(1);
  }
  const json = JSON.parse(raw) as { token_id?: string; name?: string; token?: string; created_at?: number; expires_at?: number; is_expired?: boolean };
  if (typeof json.token !== "string" || json.token.length === 0) {
    console.error("create response omitted the token value (upstream shape changed)");
    process.exit(1);
  }
  writeFileSync(outPath, JSON.stringify(json, null, 2));
  console.log(`created PAT "${json.name}" ${maskUuid(json.token_id ?? "")} expires=${new Date(json.expires_at ?? expiresAt).toISOString().slice(0, 10)}`);
  console.log(`token saved -> ${outPath} (${json.token.length} chars, never printed)`);
}

async function revoke(tokenId: string): Promise<void> {
  const { token: csrf, cookieValue: csrfCookie } = await fetchCsrf();
  const res = await fetch(`${BASE}/api/v1/me/personal-access-tokens/${tokenId}`, {
    method: "DELETE",
    headers: {
      ...baseHeaders,
      Cookie: `${baseHeaders.Cookie}; qoder_csrf_token=${csrfCookie}`,
      "X-CSRF-TOKEN": csrf,
      "x-requested-with": "XMLHttpRequest",
    },
  });
  const raw = await res.text();
  if (!res.ok) {
    console.error(`revoke failed: ${res.status} ${raw.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`revoked PAT ${maskUuid(tokenId)}`);
}

/**
 * Verifies the session is still alive and reports when the session cookie
 * expires, so the operator knows when to refresh the page and re-export
 * before it silently dies. The session cookie itself is not renewed by the
 * server on ordinary requests (only `qoder_csrf_token` is), so re-exporting
 * only helps while it is still valid.
 */
async function check(): Promise<void> {
  const { token } = await fetchCsrf();
  console.log(`session: valid (csrf ${token.slice(0, 6)}…)`);
  const sessionCookie = cookies.find((c) => c.name === "qoder_session_cookie");
  if (!sessionCookie) {
    console.log("session cookie: not found in cookies.txt (qoder_session_cookie)");
    return;
  }
  if (sessionCookie.expires === 0) {
    console.log("session cookie: browser-session (no expiry) — re-export keeps it alive while the sign-in lives");
    return;
  }
  const expiresMs = sessionCookie.expires * 1000;
  const daysLeft = Math.floor((expiresMs - Date.now()) / 86_400_000);
  const when = new Date(expiresMs).toISOString().slice(0, 10);
  if (daysLeft <= 0) {
    console.log(`session cookie: EXPIRED ${when} — sign in again and re-export`);
  } else {
    console.log(`session cookie: expires ${when} (${daysLeft}d left) — re-export after refreshing the page while it is still valid`);
  }
  if (daysLeft <= 2) {
    console.log("hint: sign in again in the browser and re-export before the session dies.");
  }
}

if (args.values.revoke) await revoke(args.values.revoke);
else if (args.values.check) await check();
else if (args.values.create) await create();
else await list();
