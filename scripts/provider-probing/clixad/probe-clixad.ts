/**
 * Clixad gateway wire probe.
 *
 * Static reconstruction of the Clixad gateway API from the clixad@0.0.1-beta.50
 * bundle (`dist/clixad.mjs` + `dist/chunk-XNMSUN52.mjs`), call-site verified.
 * See `documentation/research/clixad/2026-11-11-clixad-wire.md` for the full
 * evidence ledger. Nothing here is executed unless you run it.
 *
 * Usage (run directly; there is no `probe:*` npm script):
 *
 *   # Gateway health (no credentials).
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts health
 *
 *   # Model catalog (no credentials).
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts models
 *
 *   # Wallet / account endpoints (requires a token account).
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts wallet --creds <accounts.json>
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts wallet-raw --creds <accounts.json> --premium
 *
 *   # Dev signup — CREATES A REAL ACCOUNT on the live service. Use a
 *   # throwaway email; the returned token is printed masked, never echoed.
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts login-dev --creds <accounts.json> --email throwaway@example.com
 *
 *   # Interactive GitHub device-flow login (polls until approved / timeout).
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts login-device --creds <accounts.json>
 *
 *   # Chat probe (stream forced by default; --stream toggles).
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts ask "hello" --creds <accounts.json> --model gemini-2.5-flash-lite --stream
 *
 *   # Web search through the gateway.
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts search "clixad" --creds <accounts.json>
 *
 *   # Sponsor / ad-network endpoints.
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts sponsor-config --creds <accounts.json>
 *   bun run scripts/provider-probing/clixad/probe-clixad.ts sponsor-direct --creds <accounts.json>
 *
 * Account files are the console export shape (`providerId`, `label`,
 * `accessToken`, ...). The account's `accessToken` is used as the bearer
 * token. Tokens are never printed — only masked prefixes.
 *
 * Safety:
 *   - No hard-coded keys; credentials come only from the `--creds` file.
 *   - `login-dev` creates a real account on the live service — only use it
 *     with a throwaway email and only if you intend to do so.
 *   - Never commit account files; never paste tokens into chat/issue reports.
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  readAccountsFile,
  pickAccount,
  requireAccountToken,
  maskSecret,
} from "../lib/accounts";

// ---------------------------------------------------------------- identity

const GATEWAY_URL = process.env.CLIXAD_GATEWAY_URL ?? "https://clixad.onrender.com";
const DASHBOARD_URL = process.env.CLIXAD_DASHBOARD_URL ?? "https://app.clixad.io";

const OUTAGE_STATUSES = new Set([429, 502, 503, 504]);
const LIMIT_REFUSALS = new Set(["paid_user_limit_reached", "paid_budget_spent", "paid_budget_unavailable"]);
const MAINTENANCE = "maintenance";
const PROMPT_TOO_LONG = "prompt_too_long";
const MAX_RETRY_AFTER_MS = 30_000;
const OUTAGE_RETRIES = 5;
const AD_FORMATS = ["top_bar", "sidebar_card", "status_bar"] as const;
const MAX_TEXT = 200;

// ---------------------------------------------------------------- errors

class ProbeError extends Error {}

class AuthError extends Error {
  constructor() {
    super("Not logged in. Pass --creds with an account that has an accessToken.");
    this.name = "AuthError";
  }
}

class GatewayUnreachableError extends Error {
  constructor(host: string, code?: string) {
    super(`Can't reach the Clixad gateway at ${host}${code ? ` (${code})` : ""}. Nothing was sent, so nothing was charged.`);
    this.name = "GatewayUnreachableError";
  }
}

class EdgeBlockedError extends Error {
  constructor(block: { status: number; via?: string; rayId?: string }, kind: string) {
    super(`Edge blocked (${kind}): ${block.status} via ${block.via ?? "intermediary"}` + (block.rayId ? ` ray ${block.rayId}` : ""));
    this.name = "EdgeBlockedError";
  }
}

class EdgeOutageError extends Error {
  constructor(outage: { status: number; via?: string; rayId?: string }, resends: { count: number; waitedMs: number }, healthUrl?: string) {
    const tried = resends.count > 0 ? ` (resent ${resends.count}×, waited ~${Math.round(resends.waitedMs / 1000)}s)` : "";
    super(`Gateway outage ${outage.status} via ${outage.via ?? "intermediary"}${tried}${healthUrl ? ` — ${healthUrl}` : ""}`);
    this.name = "EdgeOutageError";
  }
}

class PaywallError extends Error {
  readonly body: Record<string, unknown> | undefined;
  constructor(body: Record<string, unknown> | undefined) {
    super(`Out of credits: balance=${body?.balance}, estimated_cost=${body?.estimated_cost}, grant_per_ad=${body?.grant_per_ad}`);
    this.name = "PaywallError";
    this.body = body;
  }
}

class PremiumLockedError extends Error {
  constructor(message: string | undefined) {
    super(message ?? "premium_locked");
    this.name = "PremiumLockedError";
  }
}

class MaintenanceError extends Error {
  constructor(message: string | undefined) {
    super(message ?? "maintenance");
    this.name = "MaintenanceError";
  }
}

class PromptTooLongError extends Error {
  constructor(message: string | undefined) {
    super(message ?? "prompt_too_long");
    this.name = "PromptTooLongError";
  }
}

class LimitRefusalError extends Error {
  readonly type: string;
  constructor(message: string, type: string) {
    super(message);
    this.name = "LimitRefusalError";
    this.type = type;
  }
}

// ---------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isOutageStatus(status: number): boolean {
  return OUTAGE_STATUSES.has(status);
}

function isGatewayError(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed?.error === "string";
  } catch {
    return false;
  }
}

function rayId(headers: Headers, body: string): string | undefined {
  const header = headers.get("cf-ray");
  if (header) return header.split("-")[0];
  const text = body.replace(/<[^>]*>/g, " ");
  return /ray\s*id:?\s*([0-9a-f]{16})/i.exec(text)?.[1];
}

function detectEdgeBlock(status: number, headers: Headers, body: string) {
  if (status !== 403) return undefined;
  if (isGatewayError(body)) return undefined;
  const via = headers.get("server") ?? undefined;
  const ray = rayId(headers, body);
  return { status, ...(ray ? { rayId: ray } : {}), ...(via ? { via } : {}) };
}

function detectEdgeOutage(status: number, headers: Headers, body: string) {
  if (!isOutageStatus(status)) return undefined;
  if (isGatewayError(body)) return undefined;
  const kind = status === 502 || status === 504 ? "interrupted" : "unreachable";
  const via = headers.get("server") ?? undefined;
  const ray = rayId(headers, body);
  const raw = headers.get("retry-after");
  const parsedRetry = raw !== null && Number.isFinite(Number(raw.trim())) && Number(raw.trim()) >= 0
    ? Math.min(Number(raw.trim()) * 1000, MAX_RETRY_AFTER_MS)
    : undefined;
  return { status, kind, ...(ray ? { rayId: ray } : {}), ...(via ? { via } : {}), ...(parsedRetry !== undefined ? { retryAfterMs: parsedRetry } : {}) };
}

async function gatewayFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const aborted = init?.signal?.aborted || (err instanceof Error && err.name === "AbortError");
    if (aborted || !(err instanceof TypeError)) throw err;
    let host = String(url);
    try {
      host = new URL(url).host;
    } catch {
      // keep raw
    }
    const code = (err as { cause?: { code?: string } }).cause?.code;
    throw new GatewayUnreachableError(host, code);
  }
}

async function peek(res: Response): Promise<{ body: string; res: Response }> {
  const body = await res.text().catch(() => "");
  return { body, res: new Response(body, { status: res.status, headers: res.headers }) };
}

async function triage(res: Response) {
  const peeked = await peek(res);
  const block = detectEdgeBlock(res.status, res.headers, peeked.body);
  return { ...(block ? { block } : {}), res: peeked.res };
}

function safeDetail(text: string): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    return typeof parsed?.message === "string" ? parsed.message.slice(0, 500) : "";
  } catch {
    return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 500);
  }
}

async function httpFailure(res: Response, what: string): Promise<string> {
  const detail = safeDetail(await res.text().catch(() => ""));
  return detail ? `${what} failed: ${res.status} — ${detail}` : `${what} failed: ${res.status}`;
}

async function authFailure(res: Response, what: string): Promise<string> {
  const detail = safeDetail(await res.text().catch(() => ""));
  return detail ? `auth (${what}) failed: ${res.status} — ${detail}` : `auth (${what}) failed: ${res.status}`;
}

function parseTaskShape(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown, min: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= 1_000_000 ? Math.floor(v) : undefined;
  const callsTypical = count(r.calls_typical, 1);
  const callsLong = count(r.calls_long, 1);
  const growthTokens = count(r.growth_tokens, 0);
  const outputTokens = count(r.output_tokens, 0);
  if (callsTypical === undefined || callsLong === undefined) return undefined;
  if (growthTokens === undefined || outputTokens === undefined) return undefined;
  if (callsLong < callsTypical) return undefined;
  return { callsTypical, callsLong, growthTokens, outputTokens };
}

function parseSpendable(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!ok(r.budget) || !ok(r.premium) || !ok(r.budget_after_reset)) return undefined;
  return { budget: r.budget as number, premium: r.premium as number, budgetAfterReset: r.budget_after_reset as number };
}

function parseAccountSettings(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const efforts: Record<string, string> = {};
  if (b.efforts && typeof b.efforts === "object" && !Array.isArray(b.efforts)) {
    for (const [k, v] of Object.entries(b.efforts)) if (typeof v === "string") efforts[k] = v;
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    model: str(b.model),
    efforts,
    name: str(b.name),
    instructions: str(b.instructions),
    sponsorLine: typeof b.sponsor_line === "boolean" ? b.sponsor_line : null,
  };
}

function sanitizeAdText(raw: unknown): string {
  return String(raw)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[‪-‮⁦-⁩‎‏؜]/g, "")
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortLinkText(clickUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(clickUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.search || url.hash) return undefined;
  const host = url.hostname.replace(/^www\./, "");
  return host.length <= 40 ? host : undefined;
}

function readServedLine(e: Record<string, unknown>) {
  const format = e.format;
  if (typeof format !== "string" || !(AD_FORMATS as readonly string[]).includes(format)) return null;
  if (typeof e.text !== "string" || typeof e.serve_token !== "string" || typeof e.click_url !== "string") return null;
  const text = sanitizeAdText(e.text).slice(0, MAX_TEXT);
  if (!text || !e.serve_token || e.serve_token.length > 2000) return null;
  let clickUrl: string;
  try {
    const url = new URL(e.click_url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    clickUrl = url.toString();
  } catch {
    return null;
  }
  const shortUrl = typeof e.short_url === "string" && shortLinkText(e.short_url) ? e.short_url : undefined;
  return { format, text, serveToken: e.serve_token, clickUrl, ...(shortUrl ? { shortUrl } : {}) };
}

function parseDirectLines(body: Record<string, unknown>) {
  const raw = body.lines;
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const format = e.format;
    if (typeof format !== "string" || !(AD_FORMATS as readonly string[]).includes(format) || seen.has(format)) continue;
    if (e.hold === true) {
      out.push({ format, hold: true });
      seen.add(format);
      continue;
    }
    const line = readServedLine(e);
    if (!line) continue;
    out.push(line);
    seen.add(format);
  }
  return out;
}

function parseFallbackLines(body: Record<string, unknown>) {
  const raw = body.fallbacks;
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const line = readServedLine(item as Record<string, unknown>);
    if (!line || out.some((o) => o.format === line.format)) continue;
    out.push(line);
  }
  return out;
}

function parseMeasure(body: Record<string, unknown>): string | undefined {
  const raw = body.measure;
  return typeof raw === "string" && raw.length > 0 && raw.length <= 2000 ? raw : undefined;
}

function asSignupClosed(status: number, data: unknown) {
  if (status !== 403) return undefined;
  const d = data as { error?: unknown; message?: unknown; waitlist_url?: unknown } | null;
  return d && d.error === "signup_closed" && typeof d.message === "string"
    ? { error: d.error, message: d.message, waitlistUrl: typeof d.waitlist_url === "string" ? d.waitlist_url : "https://clixad.io" }
    : undefined;
}

function accumulateToolCall(calls: Map<number, { id: string; type: string; function: { name: string; arguments: string } }>, part: Record<string, unknown>, fallbackIndex: number) {
  const index = typeof part.index === "number" ? part.index : fallbackIndex;
  const current = calls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
  if (typeof part.id === "string") current.id = part.id;
  const fn = part.function as { name?: unknown; arguments?: unknown } | undefined;
  if (typeof fn?.name === "string") current.function.name = fn.name;
  if (typeof fn?.arguments === "string") current.function.arguments += fn.arguments;
  calls.set(index, current);
}

function mergeReasoningDetails(acc: Array<{ type: string; text: string }>, delta: unknown) {
  if (!Array.isArray(delta)) return;
  for (const p of delta) {
    if (!p || typeof p !== "object") continue;
    const o = p as { type?: unknown; text?: unknown };
    acc.push({ type: typeof o.type === "string" ? o.type : "text", text: typeof o.text === "string" ? o.text : "" });
  }
}

async function* parseSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  }
}

// ---------------------------------------------------------------- client

interface GatewayClientOptions {
  token?: string;
  gatewayUrl?: string;
}

class GatewayClient {
  readonly token: string;
  readonly gatewayUrl: string;
  seen: { web_search: boolean } = { web_search: false };
  unlockUsd: number | null = null;
  shape: ReturnType<typeof parseTaskShape> = undefined;
  searchCredits: number | undefined = undefined;
  latest: string | undefined = undefined;
  retired: Record<string, string> = {};
  chatTransport: "json" | "encoded" = "json";

  constructor(opts: GatewayClientOptions = {}) {
    this.token = opts.token ?? "";
    this.gatewayUrl = (opts.gatewayUrl ?? GATEWAY_URL).replace(/\/+$/, "");
  }

  headers(auth = true): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) {
      if (!this.token) throw new AuthError();
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  async request(
    method: string,
    path: string,
    opts: { auth?: boolean; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {},
  ) {
    const url = `${this.gatewayUrl}${path}`;
    const init: RequestInit = { method, headers: opts.headers ?? this.headers(opts.auth ?? true) };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal !== undefined) init.signal = opts.signal;
    return gatewayFetch(url, init);
  }

  async healthz() {
    const res = await gatewayFetch(`${this.gatewayUrl}/healthz`);
    return { status: res.status, body: await res.text().catch(() => "") };
  }

  // -- auth --------------------------------------------------------------

  async signupDev(email?: string, invite?: string) {
    const res = await this.request("POST", "/dev/users", {
      auth: false,
      body: { ...(email ? { email } : {}), ...(invite ? { invite } : {}) },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const closed = asSignupClosed(res.status, data);
      if (closed) throw new ProbeError(`signup closed: ${closed.message} (${closed.waitlistUrl})`);
      throw new ProbeError(`signup failed: ${res.status} ${JSON.stringify(data ?? "")}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  async deviceStart() {
    const res = await this.request("POST", "/v1/auth/device/start", { auth: false });
    if (res.status === 501) return null;
    if (!res.ok) throw new ProbeError(await httpFailure(res, "device start"));
    return res.json() as Promise<Record<string, unknown>>;
  }

  async devicePoll(session: string, invite?: string) {
    const res = await this.request("POST", "/v1/auth/device/poll", {
      auth: false,
      body: invite ? { session, invite } : { session },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const closed = asSignupClosed(res.status, data);
    if (closed) return { status: "closed", message: closed.message, waitlistUrl: closed.waitlistUrl };
    if (!res.ok && !("status" in data && data.status)) {
      if (res.status >= 500 || res.status === 429) return { status: "unavailable", error: `http ${res.status}` };
      return { status: "error", error: `http ${res.status}` };
    }
    return data;
  }

  async handoffCode() {
    try {
      const res = await this.request("POST", "/v1/auth/handoff");
      if (!res.ok) return undefined;
      const body = (await res.json()) as { code?: unknown };
      return typeof body.code === "string" ? body.code : undefined;
    } catch {
      return undefined;
    }
  }

  // -- account -----------------------------------------------------------

  async getSettings(signal?: AbortSignal) {
    try {
      const res = await this.request("GET", "/v1/account/settings", { ...(signal ? { signal } : {}) });
      if (!res.ok) return null;
      return parseAccountSettings(await res.json());
    } catch {
      return null;
    }
  }

  async saveSettings(change: Record<string, unknown>) {
    try {
      const res = await this.request("PUT", "/v1/account/settings", {
        body: change,
        headers: { ...this.headers(), "Content-Type": "application/json" },
      });
      if (!res.ok) return null;
      return parseAccountSettings(await res.json());
    } catch {
      return null;
    }
  }

  async claimStreak(signal?: AbortSignal) {
    try {
      const res = await this.request("POST", "/v1/streak/claim", { ...(signal ? { signal } : {}) });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.day !== "number" || typeof body.credits !== "number") return null;
      return {
        day: body.day,
        credits: body.credits,
        claimed: body.claimed === true,
        balance: typeof body.balance === "number" ? body.balance : 0,
        schedule: Array.isArray(body.schedule) ? body.schedule : [],
        length: typeof body.length === "number" ? body.length : 0,
      };
    } catch {
      return null;
    }
  }

  async feedback(report: Record<string, unknown>, signal?: AbortSignal) {
    try {
      const res = await this.request("POST", "/v1/feedback", { body: report, ...(signal ? { signal } : {}) });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      return {
        recorded: body.recorded === true,
        credited: typeof body.credited === "number" ? body.credited : 0,
        balance: typeof body.balance === "number" ? body.balance : 0,
      };
    } catch {
      return null;
    }
  }

  async referral(signal?: AbortSignal) {
    const res = await this.request("GET", "/v1/referrals", { ...(signal ? { signal } : {}) });
    if (res.status === 401) throw new ProbeError(await authFailure(res, "referrals"));
    if (!res.ok) throw new ProbeError(await httpFailure(res, "referrals"));
    const body = (await res.json()) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" ? v : 0);
    if (typeof body.code !== "string" || !body.code) throw new ProbeError("the gateway did not return a referral code");
    return {
      code: body.code,
      invited: num(body.invited),
      credited: num(body.credited),
      creditsEarned: num(body.credits_earned),
      remaining: num(body.remaining),
      maxCredited: num(body.max_credited),
      inviterCredits: num(body.inviter_credits),
      inviteeCredits: num(body.invitee_credits),
    };
  }

  async redeem(code: string, signal?: AbortSignal) {
    const res = await this.request("POST", "/v1/redeem", { body: { code }, ...(signal ? { signal } : {}) });
    if (res.status === 401) throw new ProbeError(await authFailure(res, "redeem"));
    if (!res.ok) throw new ProbeError(await httpFailure(res, "redeem"));
    const body = (await res.json()) as Record<string, unknown>;
    return {
      status: typeof body.status === "string" ? body.status : "unknown",
      credited: typeof body.credited === "number" ? body.credited : 0,
      balance: typeof body.balance === "number" ? body.balance : 0,
    };
  }

  async creditPacks(signal?: AbortSignal) {
    const res = await this.request("GET", "/v1/billing/packs", { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new ProbeError(`packs failed: ${res.status}`);
    return res.json();
  }

  async checkout(pack: string, consent: boolean, signal?: AbortSignal) {
    const res = await this.request("POST", "/v1/billing/checkout", { body: { pack, consent }, ...(signal ? { signal } : {}) });
    if (res.status === 401) throw new ProbeError(await authFailure(res, "checkout"));
    if (res.status === 501) throw new ProbeError("Buying credits isn't enabled (Stripe not configured on the gateway).");
    if (!res.ok) throw new ProbeError(await httpFailure(res, "checkout"));
    return res.json();
  }

  // -- catalog & wallet --------------------------------------------------

  async models(signal?: AbortSignal) {
    const res = await gatewayFetch(`${this.gatewayUrl}/v1/models`, { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new ProbeError(`models failed: ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    this.seen = { web_search: (data.capabilities as { web_search?: unknown } | undefined)?.web_search === true };
    this.unlockUsd = typeof data.premium_unlock_usd === "number" && data.premium_unlock_usd > 0 ? data.premium_unlock_usd : null;
    this.shape = parseTaskShape(data.task_shape);
    this.searchCredits = typeof data.web_search_credits === "number" && Number.isFinite(data.web_search_credits) && data.web_search_credits > 0 ? Math.round(data.web_search_credits) : undefined;
    this.latest = typeof data.cli_latest === "string" ? data.cli_latest : undefined;
    const list = Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
    const live = new Set(list.map((m) => m.id).filter((id): id is string => typeof id === "string"));
    this.retired = {};
    if (data.retired_models && typeof data.retired_models === "object") {
      for (const [from, to] of Object.entries(data.retired_models)) {
        if (typeof to === "string" && live.has(to) && !live.has(from)) this.retired[from] = to;
      }
    }
    return list;
  }

  async wallet(signal?: AbortSignal, opts: { premium?: boolean } = {}) {
    const url = `${this.gatewayUrl}/v1/wallet${opts.premium ? "?premium=1" : ""}`;
    const res = await gatewayFetch(url, { headers: this.headers(), ...(signal ? { signal } : {}) });
    if (res.status === 401) throw new ProbeError(await authFailure(res, "wallet"));
    if (!res.ok) throw new ProbeError(`wallet failed: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  // -- chat --------------------------------------------------------------

  sendChat(payload: Record<string, unknown>, encoded: boolean, signal?: AbortSignal) {
    const json = JSON.stringify(payload);
    const init: RequestInit = {
      method: "POST",
      headers: encoded ? { ...this.headers(), "Content-Type": "application/vnd.clixad.chat+gzip" } : this.headers(),
      body: encoded ? gzipSync(Buffer.from(json, "utf8")) : json,
    };
    if (signal !== undefined) init.signal = signal;
    return gatewayFetch(`${this.gatewayUrl}/v1/chat/completions`, init);
  }

  async postWithFallbackEncoding(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const already = this.chatTransport === "encoded";
    const first = await this.sendChat(payload, already, signal);
    if (first.status !== 403) return first;
    const { block, res } = await triage(first);
    if (!block) return res;
    if (already) throw new EdgeBlockedError(block, "retried");
    const retry = await this.sendChat(payload, true, signal);
    if (retry.status === 415) throw new EdgeBlockedError(block, "unsupported");
    if (retry.status === 403) {
      const second = await triage(retry);
      if (second.block) throw new EdgeBlockedError(second.block, "retried");
      return second.res;
    }
    if (isOutageStatus(retry.status)) return retry;
    this.chatTransport = "encoded";
    return retry;
  }

  async postChat(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const resends = { count: 0, waitedMs: 0 };
    for (;;) {
      const res = await this.postWithFallbackEncoding(payload, signal);
      if (!isOutageStatus(res.status)) {
        return res;
      }
      const peeked = await peek(res);
      const outage = detectEdgeOutage(res.status, res.headers, peeked.body);
      if (!outage) return peeked.res;
      const health = `${this.gatewayUrl}/healthz`;
      if (outage.kind === "interrupted") throw new EdgeOutageError(outage, resends, health);
      if (resends.count >= OUTAGE_RETRIES) throw new EdgeOutageError(outage, resends, health);
      const wait = Math.max(outage.retryAfterMs ?? 0, 1000 * 2 ** resends.count);
      await sleep(wait);
      if (signal?.aborted) throw new ProbeError("aborted");
      resends.count++;
      resends.waitedMs += wait;
    }
  }

  async refinement402(res: Response) {
    const body = (await res.json()) as Record<string, unknown>;
    if (body.error === "premium_locked") return new PremiumLockedError(typeof body.message === "string" ? body.message : undefined);
    return new PaywallError(body);
  }

  async refusal400(res: Response) {
    const text = await res.text().catch(() => "");
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (body.error === PROMPT_TOO_LONG && typeof body.message === "string") return new PromptTooLongError(body.message);
    } catch {
      // fall through
    }
    return new ProbeError(`chat failed: 400 — ${safeDetail(text)}`);
  }

  async refusal429(res: Response) {
    const text = await res.text().catch(() => "");
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof body.error === "string" && LIMIT_REFUSALS.has(body.error) && typeof body.message === "string") {
        return new LimitRefusalError(body.message, body.error);
      }
    } catch {
      // fall through
    }
    return new ProbeError(`chat failed: 429 — ${safeDetail(text)}`);
  }

  async refusal503(res: Response) {
    const text = await res.text().catch(() => "");
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (body.error === MAINTENANCE && typeof body.message === "string") return new MaintenanceError(body.message);
    } catch {
      // fall through
    }
    return new ProbeError(`chat failed: 503 — ${safeDetail(text)}`);
  }

  async chat(messages: Array<Record<string, unknown>>, model: string, opts: { tools?: Array<Record<string, unknown>>; effort?: string; signal?: AbortSignal } = {}) {
    const payload: Record<string, unknown> = { model, messages, stream: false };
    if (opts.tools !== undefined) payload.tools = opts.tools;
    if (opts.effort !== undefined) payload.reasoning_effort = opts.effort;
    const res = await this.postChat(payload, opts.signal);
    if (res.status === 401) throw new ProbeError(await authFailure(res, "chat"));
    if (res.status === 402) throw await this.refinement402(res);
    if (res.status === 400) throw await this.refusal400(res);
    if (res.status === 429) throw await this.refusal429(res);
    if (res.status === 503) throw await this.refusal503(res);
    if (!res.ok) throw new ProbeError(await httpFailure(res, "chat"));
    const data = (await res.json()) as Record<string, unknown>;
    const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) throw new ProbeError("chat: no choices in response");
    const clixad = data.clixad as Record<string, unknown> | undefined;
    return {
      message: choice.message,
      finishReason: choice.finish_reason,
      creditsCharged: clixad?.credits_charged,
      balance: clixad?.balance,
      free: clixad?.free === true ? { creditsWaived: clixad.credits_waived ?? 0, freeCreditsLeft: clixad.free_credits_left ?? 0 } : undefined,
      spendable: parseSpendable(clixad?.spendable),
      raw: data,
    };
  }

  async chatStream(messages: Array<Record<string, unknown>>, model: string, opts: { tools?: Array<Record<string, unknown>>; effort?: string; signal?: AbortSignal; onDelta?: (d: string) => void } = {}) {
    const payload: Record<string, unknown> = { model, messages, stream: true };
    if (opts.tools !== undefined) payload.tools = opts.tools;
    if (opts.effort !== undefined) payload.reasoning_effort = opts.effort;
    const res = await this.postChat(payload, opts.signal);
    if (res.status === 401) throw new ProbeError(await authFailure(res, "chat"));
    if (res.status === 402) throw await this.refinement402(res);
    if (res.status === 503) throw await this.refusal503(res);
    if (!res.ok || !res.body) throw new ProbeError(await httpFailure(res, "chat"));
    let content = "";
    let finishReason = "stop";
    let creditsCharged = 0;
    let free: { creditsWaived: number; freeCreditsLeft: number } | undefined;
    let balance = 0;
    let spendable: ReturnType<typeof parseSpendable> = undefined;
    let streamError: string | undefined;
    let streamErrorType: string | undefined;
    const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
    const reasoning: Array<{ type: string; text: string }> = [];
    for await (const evt of parseSSE(res.body)) {
      if (evt === "[DONE]") break;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(evt) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      const deltaContent = delta?.content;
      if (typeof deltaContent === "string") {
        content += deltaContent;
        opts.onDelta?.(deltaContent);
      }
      const toolCalls = delta?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const [index, part] of toolCalls.entries()) {
          if (part && typeof part === "object") accumulateToolCall(calls, part as Record<string, unknown>, index);
        }
      }
      mergeReasoningDetails(reasoning, delta?.reasoning_details);
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      if (json.error && typeof json.error === "object") {
        const e = json.error as { message?: unknown; type?: unknown };
        streamError = typeof e.message === "string" ? e.message : "the model stream failed";
        streamErrorType = typeof e.type === "string" ? e.type : undefined;
      }
      const clixad = json.clixad as Record<string, unknown> | undefined;
      if (clixad) {
        if (typeof clixad.credits_charged === "number") creditsCharged = clixad.credits_charged;
        if (typeof clixad.balance === "number") balance = clixad.balance;
        if (clixad.free === true) {
          free = { creditsWaived: typeof clixad.credits_waived === "number" ? clixad.credits_waived : 0, freeCreditsLeft: typeof clixad.free_credits_left === "number" ? clixad.free_credits_left : 0 };
        }
        const parsed = parseSpendable(clixad.spendable);
        if (parsed) spendable = parsed;
      }
    }
    if (streamErrorType === "premium_locked") throw new PremiumLockedError(streamError);
    if (streamErrorType === MAINTENANCE) throw new MaintenanceError(streamError);
    if (streamErrorType === PROMPT_TOO_LONG) throw new PromptTooLongError(streamError);
    if (streamErrorType && LIMIT_REFUSALS.has(streamErrorType)) throw new LimitRefusalError(streamError ?? streamErrorType, streamErrorType);
    if (streamError) throw new ProbeError(streamError);
    const message: Record<string, unknown> = { role: "assistant", content: content || null };
    if (calls.size > 0) {
      message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
      if (reasoning.length) message.reasoning_details = reasoning;
    }
    return { message, finishReason, creditsCharged, balance, free, spendable };
  }

  // -- web search --------------------------------------------------------

  async webSearch(query: string, opts: { count?: number; signal?: AbortSignal } = {}) {
    const url = new URL(`${this.gatewayUrl}/v1/web/search`);
    url.searchParams.set("q", query);
    if (opts.count) url.searchParams.set("count", String(opts.count));
    const res = await gatewayFetch(url, { headers: this.headers(), ...(opts.signal ? { signal: opts.signal } : {}) });
    if (res.status === 401) throw new ProbeError(await authFailure(res, "web search"));
    if (res.status === 503) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.error === MAINTENANCE && typeof body.message === "string") throw new MaintenanceError(body.message);
      throw new ProbeError("Web search isn't enabled on this gateway (no search key configured).");
    }
    if (res.status === 402) throw new PaywallError(await res.json() as Record<string, unknown>);
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ProbeError(typeof body.message === "string" ? body.message : "Too many searches — wait a moment and try again.");
    }
    if (!res.ok) {
      const peeked = await peek(res);
      const block = detectEdgeBlock(res.status, res.headers, peeked.body);
      if (block) throw new EdgeBlockedError(block, "web search");
      const body = (await peeked.res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ProbeError(typeof body.message === "string" ? body.message : `web search failed: ${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
    const charged = count(data.credits_charged);
    const balance = count(data.balance);
    return {
      results: Array.isArray(data.results) ? data.results : [],
      ...(charged !== undefined && charged >= 0 ? { creditsCharged: charged } : {}),
      ...(balance !== undefined ? { balance } : {}),
      cached: data.cached === true,
    };
  }

  // -- sponsor / ad network ----------------------------------------------

  async sponsorConfig(signal?: AbortSignal) {
    try {
      const res = await gatewayFetch(`${this.gatewayUrl}/v1/sponsor/config?direct=1`, {
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      const publisherId = typeof body.publisher_id === "string" ? body.publisher_id.trim() : "";
      if (!publisherId) return null;
      return {
        publisherId,
        ...(typeof body.category === "string" ? { category: body.category } : {}),
        ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
        ...(typeof body.dwell_ms === "number" ? { dwellMs: body.dwell_ms } : {}),
        raw: body,
      };
    } catch {
      return null;
    }
  }

  async directSponsor(formats: readonly string[], cols: number, signal?: AbortSignal) {
    try {
      const res = await gatewayFetch(`${this.gatewayUrl}/v1/sponsor/direct`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
        body: JSON.stringify({ formats, cols }),
      });
      if (res.status === 404) return { supported: false, lines: [] };
      if (!res.ok) return { supported: true, lines: [], failed: true };
      const body = (await res.json()) as Record<string, unknown>;
      const fallbacks = parseFallbackLines(body);
      const measure = parseMeasure(body);
      return {
        supported: true,
        lines: parseDirectLines(body),
        ...(fallbacks.length > 0 ? { fallbacks } : {}),
        ...(measure !== undefined ? { measure } : {}),
        raw: body,
      };
    } catch {
      return { supported: true, lines: [], failed: true };
    }
  }

  async reportImpression(report: Record<string, unknown>, signal?: AbortSignal) {
    try {
      const res = await gatewayFetch(`${this.gatewayUrl}/v1/sponsor/impression`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
        body: JSON.stringify(report),
      });
      if (!res.ok) return 0;
      const body = (await res.json()) as Record<string, unknown>;
      return typeof body.credited === "number" ? body.credited : 0;
    } catch {
      return 0;
    }
  }

  async reportDirectImpressions(impressions: Array<Record<string, unknown>>, signal?: AbortSignal) {
    if (impressions.length === 0) return 0;
    try {
      const res = await gatewayFetch(`${this.gatewayUrl}/v1/sponsor/direct/impression`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
        body: JSON.stringify({ impressions }),
      });
      if (!res.ok) return 0;
      const body = (await res.json()) as Record<string, unknown>;
      return typeof body.credited === "number" ? body.credited : 0;
    } catch {
      return 0;
    }
  }

  async reportSponsorViews(measure: string, places: Array<Record<string, unknown>>, signal?: AbortSignal) {
    if (places.length === 0) return 0;
    try {
      const res = await gatewayFetch(`${this.gatewayUrl}/v1/sponsor/direct/views`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
        body: JSON.stringify({ measure, places }),
      });
      if (!res.ok) return 0;
      const body = (await res.json()) as Record<string, unknown>;
      return typeof body.counted === "number" ? body.counted : 0;
    } catch {
      return 0;
    }
  }

  async reportAffiliateImpressions(impressions: Array<Record<string, unknown>>, signal?: AbortSignal) {
    if (impressions.length === 0) return 0;
    try {
      const res = await gatewayFetch(`${this.gatewayUrl}/v1/sponsor/affiliate/impression`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
        body: JSON.stringify({ impressions }),
      });
      if (!res.ok) return 0;
      const body = (await res.json()) as Record<string, unknown>;
      return typeof body.counted === "number" ? body.counted : 0;
    } catch {
      return 0;
    }
  }
}

// ---------------------------------------------------------------- CLI

function usage(): string {
  return `Clixad gateway wire probe (clixad@0.0.1-beta.50 reconstruction)

Usage: bun run scripts/provider-probing/clixad/probe-clixad.ts <command> [args]

Commands:
  health                        GET /healthz (no credentials)
  models                        GET /v1/models (no credentials)
  login-dev                     POST /dev/users — CREATES A REAL ACCOUNT on the live service.
                                Use --email with a throwaway address.
  login-device                  interactive GitHub device flow (polls until complete / timeout)
  handoff                       POST /v1/auth/handoff → one-time ad-wall code
  wallet [--premium]            GET /v1/wallet
  wallet-raw [--premium]        GET /v1/wallet (full raw JSON)
  settings --get                GET /v1/account/settings
  settings --set k=v ...        PUT /v1/account/settings (model, name, instructions, sponsor_line, effort.<model>)
  streak                        POST /v1/streak/claim
  feedback <rating> [--turn N] [--model ID] [--prompt "…"] [--response "…"]
                                POST /v1/feedback
  referrals                     GET /v1/referrals
  redeem <code>                 POST /v1/redeem
  packs                         GET /v1/billing/packs
  checkout <pack> --consent     POST /v1/billing/checkout
  ask "<prompt>" [--model ID] [--effort LEVEL] [--tools] [--stream]
                                POST /v1/chat/completions (or SSE with --stream)
  search "<query>" [--count N]  GET /v1/web/search?q=&count=
  sponsor-config                 GET /v1/sponsor/config?direct=1
  sponsor-direct [--formats JSON] [--cols N]
                                POST /v1/sponsor/direct
  sponsor-impression <id> [--format F] [--ad-id X] [--billable true|false] [--credit N] [--from-cache true|false]
                                POST /v1/sponsor/impression
  sponsor-direct-impression [--formats JSON] [--visible-ms N]
                                POST /v1/sponsor/direct/impression
  sponsor-views <measure> [--format F] [--visible-ms N]
                                POST /v1/sponsor/direct/views
  sponsor-affiliate [--formats JSON]
                                POST /v1/sponsor/affiliate/impression
  raw get <path>                generic GET against gateway
  raw post <path> '<json>'      generic POST against gateway (no auth unless --auth)

Credentials:
  --creds <path>    account export file (required for authed commands; token used as bearer)
  --label <name>    select the account by label
  --index <n>       select the account by zero-based index
  --email <addr>    email for login-dev / feedback (default: authState.userId? none)
  --invite <code>   invite code for gated signup

Environment (optional):
  CLIXAD_GATEWAY_URL    gateway base (default https://clixad.onrender.com)
  CLIXAD_DASHBOARD_URL  dashboard base (default https://app.clixad.io)
`;
}

function parseJsonArg(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProbeError(`${label} must be valid JSON: ${raw}`);
  }
}

/** Writes a captured login to an account file (outside the repo). */
function writeAccountFile(path: string, account: Record<string, unknown>): void {
  const payload = {
    exportedAt: new Date().toISOString(),
    accounts: [account],
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

/** Opens a URL in the platform default browser (detached, silent). */
function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      creds: { type: "string" },
      label: { type: "string" },
      index: { type: "string" },
      email: { type: "string" },
      invite: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      tools: { type: "boolean", default: false },
      stream: { type: "boolean", default: false },
      premium: { type: "boolean", default: false },
      count: { type: "string" },
      turn: { type: "string" },
      prompt: { type: "string" },
      response: { type: "string" },
      rating: { type: "string" },
      code: { type: "string" },
      pack: { type: "string" },
      consent: { type: "boolean", default: false },
      get: { type: "boolean", default: false },
      set: { type: "string" },
      formats: { type: "string" },
      cols: { type: "string" },
      visibleMs: { type: "string" },
      format: { type: "string" },
      adId: { type: "string" },
      billable: { type: "string" },
      credit: { type: "string" },
      fromCache: { type: "boolean", default: false },
      measure: { type: "string" },
      impressionId: { type: "string" },
      auth: { type: "boolean", default: false },
      out: { type: "string" },
      session: { type: "string" },
      noOpen: { type: "boolean", default: false },
      pollSeconds: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage());
    return;
  }

  const cmd = positionals[0]!;
  const args = positionals.slice(1);

  // Every authed command needs an account. Resolve it once here.
  const credsPath = values.creds;
  const pickOpts: { providerId?: string; label?: string; index?: number } = { providerId: "clixad" };
  if (values.label !== undefined) pickOpts.label = values.label;
  if (values.index !== undefined) pickOpts.index = Number(values.index);
  const account = credsPath !== undefined ? pickAccount(readAccountsFile(credsPath), pickOpts) : undefined;
  const token = account !== undefined ? requireAccountToken(account) : "";

  const client = new GatewayClient({ token, gatewayUrl: GATEWAY_URL });

  switch (cmd) {
    case "health": {
      const r = await client.healthz();
      process.stdout.write(JSON.stringify({ status: r.status, body: r.body.slice(0, 1000) }, null, 2) + "\n");
      return;
    }
    case "models": {
      const models = await client.models();
      const out = {
        count: models.length,
        models,
        capabilities: client.seen,
        premiumUnlockUsd: client.unlockUsd,
        searchCredits: client.searchCredits,
        latest: client.latest,
        retired: client.retired,
        taskShape: client.shape,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }
    case "login-dev": {
      const email = values.email ?? values.prompt;
      const out = await client.signupDev(email, values.invite);
      const outToken = typeof out.token === "string" ? out.token : "";
      if (values.out && outToken) {
        writeAccountFile(values.out, {
          providerId: "clixad",
          label: values.label ?? "clixad-dev",
          credentialKind: "bearer",
          accessToken: outToken,
          userId: out.userId,
          email: out.email,
          authState: { defaultModel: out.default_model, created: true },
        });
      }
      // Tokens are masked: shape the output with a masked access token only.
      const printed = { ...out };
      if (outToken) {
        printed.token = maskSecret(outToken, 8);
        printed.tokenMasked = true;
      }
      process.stdout.write(JSON.stringify({ ...printed, warning: "REAL account created on the live service. Do not commit this token." }, null, 2) + "\n");
      if (values.out) process.stdout.write(`\n[account written to ${values.out}]\n`);
      return;
    }
    case "login-device": {
      const start = await client.deviceStart();
      if (!start) {
        process.stdout.write("Gateway has no GitHub device flow (501). Use `login-dev` instead.\n");
        return;
      }
      process.stdout.write(JSON.stringify({
        open: start.verification_uri,
        code: start.user_code,
        expiresInSeconds: start.expires_in,
        intervalSeconds: start.interval,
        session: String(start.session ?? "").slice(0, 8) + "…",
      }, null, 2) + "\n");
      const deadline = Date.now() + (typeof start.expires_in === "number" ? start.expires_in : 600) * 1000;
      let interval = Math.max(typeof start.interval === "number" ? start.interval : 5, 1);
      while (Date.now() < deadline) {
        await sleep(interval * 1000);
        const poll = await client.devicePoll(String(start.session ?? ""), values.invite);
        if (poll.status === "pending") {
          if (typeof poll.interval === "number") interval = poll.interval;
          process.stdout.write(".");
          continue;
        }
        if (poll.status === "unavailable") {
          process.stdout.write(`\nunavailable: ${String(poll.error)}\n`);
          return;
        }
        if (poll.status === "closed") {
          process.stdout.write(`\nclosed: ${String(poll.message)} (${String(poll.waitlistUrl)})\n`);
          return;
        }
        if (poll.status === "complete") {
          const complete = poll as Record<string, unknown>;
          const token = typeof complete.token === "string" ? complete.token : "";
          if (values.out && token) {
            writeAccountFile(values.out, {
              providerId: "clixad",
              label: values.label ?? "clixad-device",
              credentialKind: "bearer",
              accessToken: token,
              userId: complete.userId,
              email: complete.email,
              login: complete.login,
              authState: { defaultModel: complete.default_model, created: complete.created },
            });
          }
          const printed = { ...complete };
          if (token) {
            printed.token = maskSecret(token, 8);
            printed.tokenMasked = true;
          }
          process.stdout.write("\n" + JSON.stringify(printed, null, 2) + "\n");
          if (values.out) process.stdout.write(`\n[account written to ${values.out}]\n`);
          return;
        }
        process.stdout.write(`\nfailed: ${String(poll.error ?? poll.status)}\n`);
        return;
      }
      process.stdout.write("\ntimeout\n");
      return;
    }
    case "device-start": {
      const start = await client.deviceStart();
      if (!start) {
        process.stdout.write("Gateway has no GitHub device flow (501). Use `login-dev` instead.\n");
        return;
      }
      process.stdout.write(JSON.stringify({
        open: start.verification_uri,
        code: start.user_code,
        expiresInSeconds: start.expires_in,
        intervalSeconds: start.interval,
        session: start.session,
      }, null, 2) + "\n");
      return;
    }
    case "device-poll": {
      const session = values.session ?? args[0];
      if (!session) throw new ProbeError("usage: probe-clixad.ts device-poll <session>");
      const poll = await client.devicePoll(session, values.invite);
      if (poll.status === "complete") {
        const complete = poll as Record<string, unknown>;
        const token = typeof complete.token === "string" ? complete.token : "";
        if (values.out && token) {
          writeAccountFile(values.out, {
            providerId: "clixad",
            label: values.label ?? "clixad-device",
            credentialKind: "bearer",
            accessToken: token,
            userId: complete.userId,
            email: complete.email,
            login: complete.login,
            authState: { defaultModel: complete.default_model, created: complete.created },
          });
        }
        const printed = { ...complete };
        if (token) {
          printed.token = maskSecret(token, 8);
          printed.tokenMasked = true;
        }
        process.stdout.write(JSON.stringify(printed, null, 2) + "\n");
        if (values.out) process.stdout.write(`\n[account written to ${values.out}]\n`);
      } else {
        process.stdout.write(JSON.stringify(poll, null, 2) + "\n");
      }
      return;
    }
    case "handoff": {
      const code = await client.handoffCode();
      process.stdout.write(JSON.stringify({
        code: code ?? null,
        adWallUrl: code ? `${DASHBOARD_URL.replace(/\/+$/, "")}/?c=${encodeURIComponent(code)}` : DASHBOARD_URL,
      }, null, 2) + "\n");
      return;
    }
    case "earn": {
      const beforeRes = await client.wallet().catch(() => null);
      const before = typeof beforeRes?.balance === "number" ? beforeRes.balance : 0;
      const code = await client.handoffCode();
      const base = DASHBOARD_URL.replace(/\/+$/, "");
      const url = code ? `${base}/?c=${encodeURIComponent(code)}` : base;
      if (!values.noOpen) openBrowser(url);
      process.stdout.write(JSON.stringify({
        adWall: base,
        url,
        autoSignedIn: Boolean(code),
        balanceBefore: before,
      }, null, 2) + "\n");
      if (!code) process.stdout.write("(couldn't sign you in automatically — paste your token there)\n");
      const pollSeconds = values.pollSeconds !== undefined ? Number(values.pollSeconds) : 15;
      const deadline = Date.now() + pollSeconds * 1000;
      while (Date.now() < deadline) {
        await sleep(3000);
        const w = await client.wallet().catch(() => null);
        if (w && typeof w.balance === "number" && w.balance !== before) {
          process.stdout.write(JSON.stringify({
            status: "balance changed",
            delta: w.balance - before,
            balance: w.balance,
          }, null, 2) + "\n");
          return;
        }
      }
      process.stdout.write(JSON.stringify({
        status: "no change during poll",
        pollSeconds,
        balance: before,
      }, null, 2) + "\n");
      return;
    }
    case "wallet":
    case "wallet-raw": {
      const w = await client.wallet(undefined, { premium: values.premium });
      process.stdout.write(JSON.stringify(w, null, 2) + "\n");
      return;
    }
    case "settings": {
      if (values.get) {
        process.stdout.write(JSON.stringify(await client.getSettings(), null, 2) + "\n");
        return;
      }
      const change: Record<string, unknown> = {};
      if (values.set) {
        for (const pair of values.set.split(",")) {
          const eq = pair.indexOf("=");
          if (eq === -1) throw new ProbeError(`--set expects k=v, got "${pair}"`);
          const key = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim();
          if (key.startsWith("effort.")) {
            change.efforts ??= {};
            (change.efforts as Record<string, string>)[key.slice(7)] = value;
          } else if (value === "true") {
            change[key] = true;
          } else if (value === "false") {
            change[key] = false;
          } else {
            change[key] = value;
          }
        }
      }
      if (Object.keys(change).length === 0) throw new ProbeError("settings --set needs k=v pairs (e.g. --set name=Rover,model=gemini-2.5-flash-lite)");
      process.stdout.write(JSON.stringify(await client.saveSettings(change), null, 2) + "\n");
      return;
    }
    case "streak": {
      process.stdout.write(JSON.stringify(await client.claimStreak(), null, 2) + "\n");
      return;
    }
    case "feedback": {
      const rating = values.rating ?? args[0];
      if (!rating) throw new ProbeError("usage: probe-clixad.ts feedback <rating>");
      const result = await client.feedback({
        session_id: `probe-${Date.now()}`,
        turn: values.turn !== undefined ? Number(values.turn) : 1,
        rating: Number(rating),
        model: values.model ?? "unknown",
        prompt: values.prompt ?? "",
        response: values.response ?? "",
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    case "referrals": {
      process.stdout.write(JSON.stringify(await client.referral(), null, 2) + "\n");
      return;
    }
    case "redeem": {
      const code = values.code ?? args[0];
      if (!code) throw new ProbeError("usage: probe-clixad.ts redeem <code>");
      process.stdout.write(JSON.stringify(await client.redeem(code), null, 2) + "\n");
      return;
    }
    case "packs": {
      process.stdout.write(JSON.stringify(await client.creditPacks(), null, 2) + "\n");
      return;
    }
    case "checkout": {
      const pack = values.pack ?? args[0];
      if (!pack) throw new ProbeError("usage: probe-clixad.ts checkout <pack> --consent");
      if (!values.consent) throw new ProbeError("checkout requires --consent (the §356(5) BGB digital-content waiver)");
      process.stdout.write(JSON.stringify(await client.checkout(pack, true), null, 2) + "\n");
      return;
    }
    case "ask": {
      const prompt = values.prompt ?? args.join(" ");
      if (!prompt) throw new ProbeError('usage: probe-clixad.ts ask "<prompt>"');
      const messages = [{ role: "user", content: prompt }];
      const model = values.model ?? "gemini-2.5-flash-lite";
      const tools = values.tools ? [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }] : undefined;
      const chatOpts = {
        ...(values.effort !== undefined ? { effort: values.effort } : {}),
        ...(tools !== undefined ? { tools } : {}),
      };
      if (values.stream) {
        const turn = await client.chatStream(messages, model, { ...chatOpts, onDelta: (d) => process.stdout.write(d) });
        process.stdout.write("\n" + JSON.stringify({
          finishReason: turn.finishReason,
          creditsCharged: turn.creditsCharged,
          balance: turn.balance,
          free: turn.free,
          spendable: turn.spendable,
        }, null, 2) + "\n");
      } else {
        const turn = await client.chat(messages, model, chatOpts);
        process.stdout.write(JSON.stringify(turn, null, 2) + "\n");
      }
      return;
    }
    case "search": {
      const query = values.prompt ?? args.join(" ");
      if (!query) throw new ProbeError('usage: probe-clixad.ts search "<query>"');
      const count = values.count !== undefined ? Number(values.count) : 5;
      process.stdout.write(JSON.stringify(await client.webSearch(query, { count }), null, 2) + "\n");
      return;
    }
    case "sponsor-config": {
      process.stdout.write(JSON.stringify(await client.sponsorConfig(), null, 2) + "\n");
      return;
    }
    case "sponsor-direct": {
      const formats = values.formats !== undefined
        ? (parseJsonArg(values.formats, "formats") as string[])
        : ["sidebar_card", "status_bar"];
      const cols = values.cols !== undefined ? Number(values.cols) : 80;
      process.stdout.write(JSON.stringify(await client.directSponsor(formats, cols), null, 2) + "\n");
      return;
    }
    case "sponsor-impression": {
      const id = values.impressionId ?? args[0];
      if (!id) throw new ProbeError("usage: probe-clixad.ts sponsor-impression <impression_id>");
      const credited = await client.reportImpression({
        impression_id: id,
        ...(values.format ? { format: values.format } : {}),
        ...(values.adId ? { ad_id: values.adId } : {}),
        billable: values.billable !== "false" && values.billable !== "0",
        from_cache: values.fromCache,
        credit: values.credit !== undefined ? Number(values.credit) : 1,
      });
      process.stdout.write(JSON.stringify({ credited }, null, 2) + "\n");
      return;
    }
    case "sponsor-direct-impression": {
      const formats = values.formats !== undefined
        ? (parseJsonArg(values.formats, "formats") as string[])
        : ["sidebar_card"];
      const visibleMs = values.visibleMs !== undefined ? Number(values.visibleMs) : undefined;
      const impressions = formats.map((f) => ({
        format: f,
        serve_token: `probe-${f}`,
        ...(visibleMs !== undefined ? { visible_ms: visibleMs } : {}),
      }));
      const credited = await client.reportDirectImpressions(impressions);
      process.stdout.write(JSON.stringify({ credited }, null, 2) + "\n");
      return;
    }
    case "sponsor-views": {
      const measure = values.measure ?? args[0];
      if (!measure) throw new ProbeError("usage: probe-clixad.ts sponsor-views <measure>");
      const format = values.format ?? "sidebar_card";
      const visibleMs = values.visibleMs !== undefined ? Number(values.visibleMs) : 1000;
      const counted = await client.reportSponsorViews(measure, [{ format, visible_ms: visibleMs }]);
      process.stdout.write(JSON.stringify({ counted }, null, 2) + "\n");
      return;
    }
    case "sponsor-affiliate": {
      const formats = values.formats !== undefined
        ? (parseJsonArg(values.formats, "formats") as string[])
        : ["sidebar_card"];
      const impressions = formats.map((f) => ({ format: f, serve_token: `probe-${f}` }));
      const counted = await client.reportAffiliateImpressions(impressions);
      process.stdout.write(JSON.stringify({ counted }, null, 2) + "\n");
      return;
    }
    case "raw": {
      const method = (args[0] ?? "get").toLowerCase();
      const path = args[1];
      if (!path) throw new ProbeError("usage: probe-clixad.ts raw get <path> | raw post <path> '<json>'");
      const body = method === "post" ? parseJsonArg(args[2] ?? "{}", "body") : undefined;
      const res = await client.request(method.toUpperCase(), path, { auth: values.auth, body });
      const text = await res.text().catch(() => "");
      const headerMap: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headerMap[key] = value;
      });
      process.stdout.write(JSON.stringify({
        status: res.status,
        headers: headerMap,
        body: safeDetail(text) || text.slice(0, 2000),
      }, null, 2) + "\n");
      return;
    }
    default:
      process.stdout.write(usage());
      process.exitCode = 1;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[probe error] ${message}`);
  if (process.env.CLIXAD_PROBE_STACK === "1" && err instanceof Error) console.error(err.stack);
  process.exitCode = 1;
});
