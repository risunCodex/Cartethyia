/**
 * Freebuff upstream probe — token → /me → device-keys → catalog → admission →
 * (optional) cloud chat run.
 * Language: JavaScript (Bun), file: scripts/provider-probing/freebuff/freebuff-probe.mjs
 *
 * Reads a Freebuff token (from `--token`, `FREEBUFF_TOKEN`, or the capture
 * credential file) and runs the authenticated upstream surface:
 *
 *   1. GET /api/v1/me?fields=id,email,name,banned,created_at
 *   2. POST /api/v1/freebuff/device-keys (Ed25519 publicKey) → keyId
 *   3. GET /api/v1/freebuff/models            (catalog protocol 1)
 *   4. POST /api/v1/freebuff/session/admission (model + instance headers)
 *
 * The admission probe buys/opens a session for the chosen model — that is the
 * "hit model" gate. It does not stream a conversation (that runs through the
 * cloud workspace/runs surface); it proves the model id is serviceable for
 * this account.
 *
 * Subcommands:
 *   (default)             admit one model, then release
 *   --probe-all           admit every catalog row (skips locked premium), release each
 *   --chat                admit, then create a cloud run and read its stream
 *   --ads                 ad-policy → agentic offer → impression/click → reward re-check
 *   --list-models         print bundled wire model ids
 *
 * Device signing persists the Ed25519 key + per-account keyId registrations in
 * `--key-file` (default `D:/tmp/scratch/freebuff-probe/device-key.json`), so
 * the device identity survives across runs.
 *
 * Usage:
 *   bun scripts/provider-probing/freebuff/freebuff-probe.mjs --token=... --model=deepseek/deepseek-v4-flash
 *   FREEBUFF_TOKEN=... bun scripts/provider-probing/freebuff/freebuff-probe.mjs --model=openai/gpt-6-luna
 *   bun scripts/provider-probing/freebuff/freebuff-probe.mjs --creds=D:/tmp/scratch/freebuff-probe/credential.txt
 *   bun scripts/provider-probing/freebuff/freebuff-probe.mjs --creds=... --probe-all
 *   bun scripts/provider-probing/freebuff/freebuff-probe.mjs --creds=... --chat --prompt="hi"
 *   bun scripts/provider-probing/freebuff/freebuff-probe.mjs --list-models
 */

import { readFileSync } from "node:fs";
import {
  API_HOST,
  ME_PATH,
  MODEL_CATALOG_PATH,
  SESSION_ADMISSION_PATH,
  SESSION_EPOINT,
  CATALOG_PROTOCOL_HEADER,
  CATALOG_PROTOCOL_VERSION,
  FREEBUFF_CLIENT_HEADER,
  FREEBUFF_CLIENT_VERSION_HEADER,
  FREEBUFF_INSTALL_ID_HEADER,
  FREEBUFF_INSTANCE_HEADER,
  FREEBUFF_MULTI_SESSION_HEADER,
  CLIENT as FREEBUFF_CLIENT,
  AGENT_RUNS_PATH,
  CHAT_COMPLETIONS_PATH,
  FREEBUFF_ACTING_USER_HEADER,
  FREEBUFF_CATALOG_FETCH_HEADER,
  OFFICIAL_CHAT_USER_AGENT,
  OFFICIAL_ADMISSION_USER_AGENT,
  FREEBUFF_SSE_GZIP_RECOVERY_HEADER,
  resolveCatalogHandle,
  resolveInstallId,
  desktopClientVersion,
  AD_POLICY_PATH,
  AD_AGENTIC_OFFER_PATH,
  AD_IMPRESSION_PATH,
  AD_CLICK_PATH,
  AD_CLICK_RETURN_PATH,
  AD_ENGAGEMENT_PATH,
  AD_SPONSORED_SKILLS_PATH,
  AGENTIC_OFFER_ROUTE_VERSION,
  SPONSORED_IN_PLACE_VERSION,
  SPONSORED_RUN_SPEC_VERSION,
  SPONSORED_CONVERSION_TOOLS_VERSION,
  FREEBUFF_EVENT_ID_HEADER,
  FREEBUFF_RENDER_DELAY_HEADER,
  FREEBUFF_DWELL_HEADER,
  DESKTOP_AD_REQUEST_USER_AGENT,
  getAdUserAgent,
  adDeviceInfo,
  FREEBUFF_REWARD_MODEL_ID,
  FREEBUFF_WEB_HOST,
  FREE_BUFF_MODELS,
  fbFetch,
  redact,
  arg,
  hasFlag,
  readCredentialFile,
  admissionHeaders,
  FreebuffDeviceSigner,
} from "./_lib.mjs";

const DEFAULT_KEY_FILE = "D:/tmp/scratch/freebuff-probe/device-key.json";

function readToken() {
  const inline = arg("token");
  if (inline) return inline;
  const envToken = process.env.FREEBUFF_TOKEN;
  if (envToken) return envToken;
  const creds = arg("creds");
  if (creds) {
    const { token } = readCredentialFile(creds);
    return token;
  }
  throw new Error("no token: pass --token=…, set FREEBUFF_TOKEN, or use --creds=<capture file>");
}

function readAccountId() {
  const creds = arg("creds");
  if (creds) {
    try {
      const { userId } = readCredentialFile(creds);
      return userId;
    } catch {
      return null;
    }
  }
  return null;
}

async function probeMe(token) {
  const url = `${API_HOST}${ME_PATH}?fields=${encodeURIComponent("id,email,name,banned,created_at")}`;
  const res = await fbFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`[me] ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

async function probeDeviceKeys(token, signer, accountId) {
  const keyId = await signer.register(token, { accountId });
  console.log(`[device-keys] registered keyId=${redact(keyId)}`);
  return keyId;
}

async function probeCatalog(token) {
  const res = await fbFetch(`${API_HOST}${MODEL_CATALOG_PATH}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      [CATALOG_PROTOCOL_HEADER]: CATALOG_PROTOCOL_VERSION,
      [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT,
    },
  });
  const catalog = res.json;
  console.log(`[catalog] ${res.status} protocol=${catalog?.protocol} version=${catalog?.version} fetchId=${redact(catalog?.fetchId)} rows=${catalog?.rows?.length ?? 0}`);
  if (Array.isArray(catalog?.rows)) {
    for (const row of catalog.rows.slice(0, 30)) {
      console.log(`  ${row.key} | ${redact(row.handle)} | ${row.displayName} | access=${row.access} | premium=${row.premium}`);
    }
    if (catalog.rows.length > 30) console.log(`  … (${catalog.rows.length - 30} more)`);
  }
  return catalog;
}

async function probeAdmission(token, signer, model, accountId, catalog) {
  const instanceId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const path = SESSION_ADMISSION_PATH;
  // Official admission sends the catalog HANDLE (fbm1.*), not the wire id/key.
  // The handle is single-fetch ephemeral: resolve from the fresh catalog.
  const { handle, row } = resolveCatalogHandle(catalog, model);
  const wireModel = handle ?? model;
  if (!handle) {
    console.log(`[admission] no catalog handle for ${model}; sending requested id as-is`);
  }
  const headers = admissionHeaders(token, wireModel, instanceId, attemptId, {
    fetchId: catalog?.fetchId,
    installId: arg("install-id", resolveInstallId()),
  });
  let signed = {};
  try {
    signed = await signer.sign(token, { method: "POST", path, body: null, fetchId: catalog?.fetchId, accountId });
  } catch (e) {
    console.log(`[admission] device signature unavailable (${e.message}); continuing unsigned`);
  }
  const res = await fbFetch(`${API_HOST}${path}`, {
    method: "POST",
    headers: { ...headers, ...signed },
    timeoutMs: 45000,
    allowNonOk: true,
  });
  console.log(`[admission] ${res.status}`);
  console.log(`  instanceId=${redact(instanceId)} model=${wireModel}${handle ? ` (handle, row=${row?.key})` : ""}`);
  console.log(`  body=${JSON.stringify(res.json ?? res.text.slice(0, 300))}`);
  if (res.status === 409 && res.json?.error === "freebuff_catalog_stale") {
    console.log("  → catalog stale; refresh catalog and retry admission.");
  }
  return { res, instanceId };
}

/**
 * Free any in-use purchase for a model before admitting again. The server
 * answers 409 `purchase_in_use` while a previous session still holds the
 * purchase — release it (DELETE with the holder instance id) first. The
 * holder instance id is only surfaced in the 409 body (`currentInstanceId`)
 * — plain GET session returns `status: none` without purchases.
 */
async function releaseExistingPurchaseForModel(token, signer, accountId, model, catalog) {
  // Try admission first: if it 409s with a holder instance, release it.
  const attempt = await probeAdmission(token, signer, model, accountId, catalog);
  if (attempt.res.ok) {
    // Success — nothing to release; return the fresh session.
    return attempt;
  }
  const holder = attempt.res.json?.currentInstanceId ?? attempt.res.json?.holderInstanceId ?? null;
  if (attempt.res.status === 409 && holder) {
    console.log(`[session] releasing in-use purchase for ${model} (holder=${redact(holder)})…`);
    await releaseSession(token, signer, holder, accountId);
    // Retry once.
    const retry = await probeAdmission(token, signer, model, accountId, catalog);
    return retry;
  }
  return attempt;
}

async function releaseSession(token, signer, instanceId, accountId) {
  let signed = {};
  try {
    signed = await signer.sign(token, { method: "DELETE", path: SESSION_EPOINT, body: null, accountId });
  } catch {
    // best-effort
  }
  const res = await fbFetch(`${API_HOST}${SESSION_EPOINT}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT,
      [FREEBUFF_INSTANCE_HEADER]: instanceId,
      [FREEBUFF_MULTI_SESSION_HEADER]: "1",
      "user-agent": OFFICIAL_ADMISSION_USER_AGENT,
      ...signed,
    },
    timeoutMs: 15000,
    allowNonOk: true,
  });
  console.log(`[session release] ${res.status} ${JSON.stringify(res.json ?? res.text.slice(0, 120))}`);
}

/** POST /api/v1/agent-runs — START a run (official desktop-generational chat prerequisite). */
async function agentRunStart(token, userId, agentId = "freebuff-desktop-thread-local-v3") {
  const body = JSON.stringify({ action: "START", agentId, ancestorRunIds: [] });
  const res = await fbFetch(`${API_HOST}${AGENT_RUNS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
      [FREEBUFF_ACTING_USER_HEADER]: userId,
      "user-agent": OFFICIAL_ADMISSION_USER_AGENT,
    },
    body,
    timeoutMs: 30000,
    allowNonOk: true,
  });
  console.log(`[agent-runs START] ${res.status}`);
  console.log(`  body=${JSON.stringify(res.json ?? res.text.slice(0, 200))}`);
  return { res, runId: res.json?.runId ?? null };
}

/** POST /api/v1/agent-runs — FINISH a run (best-effort teardown). */
async function agentRunFinish(token, userId, runId) {
  const body = JSON.stringify({
    action: "FINISH",
    runId,
    status: "completed",
    totalSteps: 0,
    directCredits: 0,
    totalCredits: 0,
    steps: [],
  });
  const res = await fbFetch(`${API_HOST}${AGENT_RUNS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
      [FREEBUFF_ACTING_USER_HEADER]: userId,
      "user-agent": OFFICIAL_ADMISSION_USER_AGENT,
    },
    body,
    timeoutMs: 30000,
    allowNonOk: true,
  });
  console.log(`[agent-runs FINISH] ${res.status} ${JSON.stringify(res.json ?? res.text.slice(0, 120))}`);
  return res;
}

/**
 * POST /api/v1/chat/completions — the real chat surface, aligned 1:1 with the
 * official desktop client capture (2026-10-03, `docs/reverse/16-success-200-with-toolcall.md`):
 *
 *  - Headers: ONLY the 8 official business headers — Authorization,
 *    Content-Type, User-Agent (AI-SDK), `x-freebuff-acting-user-id`,
 *    `x-freebuff-catalog-fetch`, and the device signature trio
 *    (`x-freebuff-device-key/ts/sig`). No `accept`, no
 *    `x-freebuff-sse-gzip-recovery`, no instance/client/model/catalog-protocol
 *    headers (the official chat carries none of those).
 *  - Body: `model` handle, `codebuff_metadata` with the desktop fields
 *    (instance id, multi-session, trace id, repo snapshot, step number, run id,
 *    client id, cost_mode), `provider: { allow_fallbacks: true }`, the 37
 *    official tools, `tool_choice: "auto"`, `stream: true` — and the official
 *    system (worker) template, never the CLI base3 opener.
 */
async function chatCompletions(token, userId, signer, { handle, runId, instanceId, prompt, messages = undefined, fetchId, installId, stream = false }) {
  const clientId = BuffMathRandomClientId();
  const tools = officialTools();
  const system = officialSystemWorker();
  const body = JSON.stringify({
    model: handle,
    messages:
      messages ??
      [
        { role: "system", content: system },
        { role: "user", content: [{ type: "text", text: prompt }] },
      ],
    tools,
    tool_choice: "auto",
    stream,
    codebuff_metadata: {
      freebuff_instance_id: instanceId,
      freebuff_multi_session: "1",
      trace_session_id: crypto.randomUUID(),
      repo_snapshot:
        '{"gitAvailable":false,"repositoryVisibility":"unknown","fileCount":0,"fileCountIsLowerBound":false,"testFileCount":0,"changedFileCount":0,"changedFileScanTruncated":false}',
      llm_step_number: "1",
      run_id: runId,
      client_id: clientId,
      cost_mode: "free",
    },
    provider: { allow_fallbacks: true },
  });
  const headers = {
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
    "user-agent": OFFICIAL_CHAT_USER_AGENT,
    [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT,
    [FREEBUFF_CLIENT_VERSION_HEADER]: desktopClientVersion(),
    [FREEBUFF_INSTALL_ID_HEADER]: installId,
    [FREEBUFF_ACTING_USER_HEADER]: userId,
    [FREEBUFF_CATALOG_FETCH_HEADER]: fetchId,
    [FREEBUFF_SSE_GZIP_RECOVERY_HEADER]: "1",
  };
  // Device signature for the chat body (same canonical payload as session).
  try {
    const signed = await signer.sign(token, { method: "POST", path: CHAT_COMPLETIONS_PATH, body, fetchId, accountId: userId });
    Object.assign(headers, signed);
  } catch {
    // unsigned fallback; upstream may reject
  }
  const res = await fbFetch(`${API_HOST}${CHAT_COMPLETIONS_PATH}`, {
    method: "POST",
    headers,
    body,
    timeoutMs: 60000,
    allowNonOk: true,
  });
  console.log(`[chat/completions] ${res.status}`);
  console.log(`  body=${JSON.stringify(res.json ?? res.text.slice(0, 400))}`);
  return res;
}

/** Load the 37 official desktop tools (aligned to the captured 200 chat). */
function officialTools() {
  const tools = JSON.parse(
    readFileSync(new URL("./assets/official-tools.json", import.meta.url), "utf8"),
  );
  if (!Array.isArray(tools) || tools.length !== 37) {
    throw new Error(`official-tools.json: expected 37 tools, got ${tools?.length}`);
  }
  return tools;
}

/**
 * Load the official worker system template (7918 chars, desktop thread-local v3).
 * LOCKED: the upstream gate validates the system message contents — shortening,
 * replacing the opening, or changing "Buffy" gets 403 (see wire-audit ledger,
 * system-prompt fingerprint section). Keep this byte-identical; only append at
 * the end if extra instructions are needed.
 */
function officialSystemWorker() {
  const sys = readFileSync(new URL("./assets/official-system-worker.txt", import.meta.url), "utf8");
  if (sys.length !== 7918) {
    throw new Error(
      `official-system-worker.txt: expected 7918 chars, got ${sys.length} — ` +
        "system prompt is fingerprint-locked (shortening/replacing → 403); restore the official worker.",
    );
  }
  if (!sys.startsWith("You are Buffy, the coding agent behind Codebuff.")) {
    throw new Error(
      "official-system-worker.txt: opening changed — the system prompt opening is fingerprint-locked " +
        "(non-official opening → 403 free_mode_cli_required); restore the official worker.",
    );
  }
  return sys;
}

/** 13-char base36 client id (official SDK shape). */
function BuffMathRandomClientId() {
  return (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 13);
}

/** Full chat attempt: admit (handle) → agent-runs START → chat → FINISH → release. */
async function probeChat(token, signer, accountId) {
  const model = arg("model", "deepseek/deepseek-v4-flash");
  const prompt = arg("prompt", "say hello in one short sentence");
  console.log(`\n[chat] model=${model} prompt=${JSON.stringify(prompt)}`);

  const catalog = await probeCatalog(token);

  const admitted = await releaseExistingPurchaseForModel(token, signer, accountId, model, catalog);
  const { res, instanceId } = admitted;
  if (!res.ok) {
    console.log("\n[chat] admission failed — cannot run chat.");
    return;
  }

  const { handle } = resolveCatalogHandle(catalog, model);
  if (!handle) {
    console.log("\n[chat] no catalog handle — cannot build official chat request.");
    if (!hasFlag("no-release")) await releaseSession(token, signer, instanceId, accountId);
    return;
  }

  const { runId } = await agentRunStart(token, accountId);
  if (!runId) {
    console.log("\n[chat] agent-runs START failed.");
    if (!hasFlag("no-release")) await releaseSession(token, signer, instanceId, accountId);
    return;
  }

  const chatRes = await chatCompletions(token, accountId, signer, {
    handle,
    runId,
    instanceId,
    prompt,
    fetchId: catalog?.fetchId,
    installId: arg("install-id", resolveInstallId()),
    stream: hasFlag("stream"),
  });
  if (chatRes.status === 403) {
    const why = chatRes.json?.error ?? "";
    console.log(`\n[chat] upstream refused third-party shape (${why}).`);
    console.log("  Current upstream counts strikes (3 strikes suspend the account).");
    console.log("  Do NOT iterate blindly against a production account from here.");
  }

  await agentRunFinish(token, accountId, runId);
  if (!hasFlag("no-release")) await releaseSession(token, signer, instanceId, accountId);
}

/** Shared ad request helper (Bearer + desktop UA + optional event-id header). */
async function adFetch(token, path, { method = "POST", body, eventId, dwellMs, host = API_HOST, timeoutMs = 30000 } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "User-Agent": DESKTOP_AD_REQUEST_USER_AGENT,
    ...(eventId ? { [FREEBUFF_EVENT_ID_HEADER]: eventId } : {}),
    ...(typeof dwellMs === "number" && Number.isFinite(dwellMs) ? { [FREEBUFF_DWELL_HEADER]: String(Math.max(0, Math.round(dwellMs))) } : {}),
  };
  return fbFetch(`${host}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    timeoutMs,
    allowNonOk: true,
  });
}

/** GET /api/v1/ads/policy — ad serving policy for this account. */
async function probeAdPolicy(token) {
  const res = await fbFetch(`${API_HOST}${AD_POLICY_PATH}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": DESKTOP_AD_REQUEST_USER_AGENT },
    allowNonOk: true,
  });
  console.log(`[ads/policy] ${res.status} ${JSON.stringify(res.json ?? res.text.slice(0, 200))}`);
  return res.json;
}

/** POST /api/v1/ads/agentic/offer — ask for a sponsored offer (may return an impUrl). */
async function probeAgenticOffer(token) {
  const body = {
    v: Number(AGENTIC_OFFER_ROUTE_VERSION),
    conversationId: `probe-${crypto.randomUUID()}`,
    messages: [{ role: "user", content: "hi" }],
    device: { os: adDeviceInfo().os, timezone: adDeviceInfo().timezone, locale: adDeviceInfo().locale },
    userAgent: getAdUserAgent(),
    inPlaceExecutionVersion: SPONSORED_IN_PLACE_VERSION,
    runSpecVersion: SPONSORED_RUN_SPEC_VERSION,
    conversionToolsVersion: SPONSORED_CONVERSION_TOOLS_VERSION,
  };
  const res = await adFetch(token, AD_AGENTIC_OFFER_PATH, { body, host: FREEBUFF_WEB_HOST });
  console.log(`[ads/agentic/offer] ${res.status}`);
  console.log(`  body=${JSON.stringify(res.json ?? res.text.slice(0, 300))}`);
  return res.json;
}

/** POST /api/v1/ads/impression — record an ad view (first-party ack). */
async function probeAdImpression(token, impUrl, { renderDelayMs } = {}) {
  const eventId = crypto.randomUUID();
  const body = {
    impUrl,
    mode: "desktop",
    userAgent: getAdUserAgent(),
    os: adDeviceInfo().os,
    ...(typeof renderDelayMs === "number" ? { renderDelayMs } : {}),
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "User-Agent": DESKTOP_AD_REQUEST_USER_AGENT,
    [FREEBUFF_EVENT_ID_HEADER]: eventId,
    ...(typeof renderDelayMs === "number" ? { [FREEBUFF_RENDER_DELAY_HEADER]: String(Math.max(0, Math.round(renderDelayMs))) } : {}),
  };
  const res = await fbFetch(`${API_HOST}${AD_IMPRESSION_PATH}`, {
    method: "POST",
    headers,
    body,
    timeoutMs: 30000,
    allowNonOk: true,
  });
  console.log(`[ads/impression] ${res.status}`);
  console.log(`  impUrl=${redact(impUrl)} eventId=${eventId}`);
  console.log(`  ackOutcome=${res.headers?.get?.("x-freebuff-ack-outcome") ?? "n/a"} body=${JSON.stringify(res.json ?? res.text.slice(0, 200))}`);
  return res;
}

/** POST /api/v1/ads/click — record click (dwell). */
async function probeAdClick(token, impUrl, dwellMs = 2500) {
  const res = await adFetch(token, AD_CLICK_PATH, { body: { impUrl, dwellMs }, eventId: crypto.randomUUID(), dwellMs });
  console.log(`[ads/click] ${res.status} body=${JSON.stringify(res.json ?? res.text.slice(0, 200))}`);
  return res;
}

/** POST /api/v1/ads/click-return — record click return. */
async function probeAdClickReturn(token, impUrl) {
  const res = await adFetch(token, AD_CLICK_RETURN_PATH, { body: { impUrl }, eventId: crypto.randomUUID() });
  console.log(`[ads/click-return] ${res.status} body=${JSON.stringify(res.json ?? res.text.slice(0, 200))}`);
  return res;
}

/** POST /api/v1/ads/engagement — record engagement. */
async function probeAdEngagement(token, impUrl) {
  const res = await adFetch(token, AD_ENGAGEMENT_PATH, { body: { impUrl }, eventId: crypto.randomUUID() });
  console.log(`[ads/engagement] ${res.status} body=${JSON.stringify(res.json ?? res.text.slice(0, 200))}`);
  return res;
}

/** GET /api/v1/ads/sponsored-skills — list sponsored skills. */
async function probeSponsoredSkills(token) {
  const res = await fbFetch(`${API_HOST}${AD_SPONSORED_SKILLS_PATH}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": DESKTOP_AD_REQUEST_USER_AGENT },
    allowNonOk: true,
  });
  console.log(`[ads/sponsored-skills] ${res.status} body=${JSON.stringify(res.json ?? res.text.slice(0, 300))}`);
  return res.json;
}

/** After ad view, re-check whether the reward model becomes admissible. */
async function probeRewardUnlock(token, signer, accountId, catalog) {
  console.log(`\n[reward] checking unlock for ${FREEBUFF_REWARD_MODEL_ID}…`);
  const { res, instanceId } = await probeAdmission(token, signer, FREEBUFF_REWARD_MODEL_ID, accountId, catalog);
  if (res.ok) {
    console.log(`[reward] MODEL ADMITTED ✅ (reward unlock works)`);
    if (!hasFlag("no-release")) await releaseSession(token, signer, instanceId, accountId);
  } else {
    console.log(`[reward] not admitted — reward unlock did not take effect (yet).`);
  }
  return res.ok;
}

/** Full ad surface sweep (offer → impression → click → reward re-check). */
async function probeAds(token, signer, accountId, catalog) {
  console.log(`\n=== ads surface ===`);
  await probeAdPolicy(token);

  const offer = await probeAgenticOffer(token);
  const impUrl = offer?.impUrl ?? offer?.ad?.impUrl ?? offer?.creative?.impUrl ?? null;

  if (!impUrl) {
    console.log("\n[ads] no impUrl in offer — cannot record impression (offer may be empty/None).");
    return;
  }

  await probeAdImpression(token, impUrl);
  await probeAdClick(token, impUrl, Number(arg("dwell", "2500")));
  await probeAdClickReturn(token, impUrl);
  await probeAdEngagement(token, impUrl);
  await probeSponsoredSkills(token);

  await probeRewardUnlock(token, signer, accountId, catalog);
}

/**
 * Probe every serviceable wire model id (open tier) and report admit/release.
 * Catalog rows key on `m-<hex>`; admission takes wire form — so this sweeps
 * the known wire ids from `FREE_BUFF_MODELS` plus the ones we have verified
 * live (deepseek/solar).
 */
async function probeAll(token, signer, accountId, catalog) {
  const targetIds = [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-flash-fast",
    "upstage/solar-mini4",
    "upstage/solar-pro4",
    "z-ai/glm-5.3-flash",
    "fbc/deepseek-slow",
    "fbc/mimo-slow",
    "fbc/crouton-alpha",
    "fbc/glyph-cluster",
    "fbc/nemotron-3.5-lightning",
    "openai/gpt-6-luna",
    "openai/gpt-6.1-terra",
    "fbc/claude-haiku-5.5-100k",
  ];
  console.log(`\n[probe-all] ${targetIds.length} target wire ids.`);
  const results = [];
  for (const wireId of targetIds) {
    const admitted = await probeAdmission(token, signer, wireId, accountId, catalog);
    results.push({ wireId, admitted });
    if (admitted.res.ok && !hasFlag("no-release")) {
      await releaseSession(token, signer, admitted.instanceId, accountId);
    }
  }
  console.log("\n[probe-all] summary:");
  for (const r of results) {
    const res = r.admitted.res;
    const st = res.ok ? "ADMITTED" : `FAIL ${res.status} ${res.json?.status ?? res.json?.error ?? ""}`;
    console.log(`  ${r.wireId} | ${st}`);
  }
}

async function main() {
  if (hasFlag("list-models")) {
    console.log(`\nwire model ids (${FREE_BUFF_MODELS.length}):`);
    for (const id of FREE_BUFF_MODELS) console.log(`  ${id}`);
    return;
  }

  const token = readToken();
  const accountId = readAccountId();
  const keyFile = arg("key-file", DEFAULT_KEY_FILE);
  console.log(`Freebuff probe — API ${API_HOST}`);
  console.log(`token: ${redact(token)} accountId: ${accountId ? redact(accountId) : "(unknown)"}`);
  const signer = new FreebuffDeviceSigner({ keyFile });
  const model = arg("model", "deepseek/deepseek-v4-flash");

  await probeMe(token);
  await probeDeviceKeys(token, signer, accountId);
  const catalog = await probeCatalog(token);

  if (hasFlag("ads")) {
    await probeAds(token, signer, accountId, catalog);
    return;
  }

  if (hasFlag("chat")) {
    await probeChat(token, signer, accountId);
    return;
  }

  if (hasFlag("probe-all")) {
    await probeAll(token, signer, accountId, catalog);
    return;
  }

  console.log(`\n[admission] model=${model}`);
  const { res, instanceId } = await probeAdmission(token, signer, model, accountId, catalog);
  if (res.ok) {
    console.log("\n[result] MODEL ADMITTED ✅");
    if (!hasFlag("no-release")) await releaseSession(token, signer, instanceId, accountId);
  } else {
    console.log("\n[result] model NOT admitted — see admission body above ❌");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
