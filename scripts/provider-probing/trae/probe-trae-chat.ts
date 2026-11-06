/**
 * Trae chat probe — hits the same chat surface the gateway adapter uses, with
 * the exact same headers and body shape, so the live wire (events, metadata,
 * usage) can be compared 1:1 against what `trae.ts` decodes.
 *
 * Surface: {core}/api/ide/v1/llm_raw_chat (POST, SSE).
 * Body mirrors `toTraeChatBody`: model_name, messages, stream: true, region,
 * ai_region, temperature, max_tokens, top_p, stop.
 *
 * Usage:
 *   bun run scripts/provider-probing/trae/probe-trae-chat.ts \
 *     --creds C:\Users\Aria\Desktop\trae-accounts-<ts>.json \
 *     --model deepseek-v4.1-flash
 *   bun run ... --creds <file> --model deepseek-v4.1-flash --message "ping" --no-stream
 *   bun run ... --creds <file> --label <account> --realm cn
 *
 * Tokens are never printed — only masked prefixes.
 */
import { parseArgs } from "node:util";
import {
  maskSecret,
  maskUuid,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { buildTraeHeaders } from "../../../src/providers/integrations/trae/trae-headers";
import {
  TRAE_AGENT_CHAT_PATH,
  TRAE_AGENT_FUNCTION,
  TRAE_CHAT_PATH,
  TRAE_GET_USER_INFO_PATH,
  TRAE_REGION_CORE_HOSTS,
  TRAE_REALMS,
  traeAccountCandidates,
  type TraeRealm,
} from "../../../src/providers/integrations/trae/trae-realm";
import {
  isTraeAgentEndpoint,
  parseTraeSse,
  toTraeAgentBody,
} from "../../../src/providers/integrations/trae/trae-protocol";
import { TRAE_INTL_MODELS, TRAE_CN_MODELS } from "../../../src/providers/integrations/trae/trae-catalog";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    label: { type: "string" },
    index: { type: "string" },
    realm: { type: "string" },
    model: { type: "string", default: "deepseek-v4.1-flash" },
    message: { type: "string", default: "ping" },
    "no-stream": { type: "boolean", default: false },
    maxTokens: { type: "string" },
    "version-code": { type: "string" },
    "cc-auth": { type: "boolean", default: false },
    host: { type: "string" },
    models: { type: "boolean", default: false },
    picker: { type: "boolean", default: false },
    userinfo: { type: "boolean", default: false },
    sweep: { type: "boolean", default: false },
    "sweep-chat": { type: "boolean", default: false },
    tools: { type: "boolean", default: false },
    agent: { type: "boolean", default: false },
    timeout: { type: "string", default: "30000" },
  },
});

function coreHost(region: string, realm: TraeRealm): string {
  const override = region !== "" ? TRAE_REGION_CORE_HOSTS[region] : undefined;
  return override ?? TRAE_REALMS[realm].core;
}

interface ChatOnceInput {
  readonly model: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly agent: boolean;
  readonly urlBase: string;
}

/** One chat call; returns a one-line verdict. Never prints tokens. */
async function probeChatOnce(input: ChatOnceInput): Promise<string> {
  const { model, body, headers, agent, urlBase } = input;
  const payload = agent ? toTraeAgentBody({ ...body, model_name: model, Request: {} } as never) : { ...body, model_name: model };
  const path = agent ? TRAE_AGENT_CHAT_PATH : TRAE_CHAT_PATH;
  const url = urlBase + path;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return `FAIL ${model} [http ${response.status}] ${text.slice(0, 160)}`;
    }
    const text = await response.text().catch(() => "");
    if (!text) return `FAIL ${model} [empty body]`;
    const sse = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    let providerModel = "";
    let sawOutput = false;
    let error: string | null = null;
    for await (const frame of parseTraeSse(sse)) {
      if (frame.event === "error") {
        const data = frame.data as { code?: unknown; message?: unknown; extra?: unknown };
        error = `code=${data.code} ${typeof data.message === "string" && data.message ? data.message : ""}${data.extra ? ` extra=${JSON.stringify(data.extra)}` : ""}`.trim();
        break;
      }
      if (frame.event === "timing_cost") {
        const data = frame.data as { provider_model_name?: unknown };
        if (typeof data.provider_model_name === "string") providerModel = data.provider_model_name;
      }
      if (frame.event === "output" || frame.event === "token_usage" || frame.event === "done") {
        sawOutput = true;
      }
      if (frame.event === "done") break;
    }
    if (error !== null) return `FAIL ${model} [${error}]`;
    if (!sawOutput) return `FAIL ${model} [no output frames]`;
    return `PASS ${model}${providerModel ? ` -> ${providerModel}` : ""}`;
  } catch (e) {
    return `FAIL ${model} [${e instanceof Error ? e.message : String(e)}]`;
  }
}

async function main(): Promise<void> {
  const v = args.values;
  const accounts = readAccountsFile(v.creds!);
  const account = pickAccount(accounts, {
    providerId: "trae",
    ...(v.label !== undefined ? { label: v.label } : {}),
    ...(v.index !== undefined ? { index: Number(v.index) } : {}),
  });
  const token = requireAccountToken(account);

  const realm: TraeRealm =
    v.realm === "cn"
      ? "cn"
      : v.realm === "intl"
        ? "intl"
        : account.providerId === "traecn"
          ? "cn"
          : "intl";
  const region = (account.authState?.region ?? "").trim().toLowerCase();
  const uid = String(account.authState?.userId ?? "").trim();
  // --picker: enumerate the agent picker's configs (batch_get_detail_param).
  if (v.picker === true) {
    const pickerUrl = coreHost(region, realm) + "/api/ide/v1/batch_get_detail_param";
    console.log(`\nPOST ${pickerUrl} (picker configs)`);
    const pickerHeaders = buildTraeHeaders({
      realm,
      token,
      uid,
      extra: { authorization: `Cloud-IDE-JWT ${token}` },
    });
    try {
      const response = await fetch(pickerUrl, {
        method: "POST",
        headers: pickerHeaders,
        body: JSON.stringify({ functions: [TRAE_AGENT_FUNCTION], Request: {} }),
        signal: AbortSignal.timeout(25_000),
      });
      const text = await response.text();
      console.log(`status=${response.status}${response.ok ? "" : " (not ok)"}`);
      if (!response.ok) {
        console.log(`body: ${text.slice(0, 600)}`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        console.log(`body: ${text.slice(0, 600)}`);
        return;
      }
      const root = parsed as { function_configs?: unknown };
      const configs = Array.isArray(root.function_configs) ? root.function_configs : [];
      for (const group of configs) {
        if (typeof group !== "object" || group === null) continue;
        const g = group as Record<string, unknown>;
        const list = Array.isArray(g["config_info_list"]) ? g["config_info_list"] : [];
        for (const entry of list) {
          if (typeof entry !== "object" || entry === null) continue;
          const e = entry as Record<string, unknown>;
          const name = String(e["config_name"] ?? "");
          if (!name) continue;
          const usage = String(e["usage"] ?? "");
          const src = String(e["config_source"] ?? "");
          const detail = Array.isArray(e["model_detail_list"]) ? e["model_detail_list"] : [];
          const modelNames = detail
            .map((d) => (typeof d === "object" && d !== null ? String((d as Record<string, unknown>)["model_name"] ?? "") : ""))
            .filter(Boolean)
            .join(",");
          console.log(`  - ${name} usage=${usage} source=${src}${modelNames ? ` models=${modelNames}` : ""}`);
        }
      }
      if (configs.length === 0) {
        console.log("  (no function_configs — full body keys: " + Object.keys(parsed as object).join(", ") + ")");
      }
    } catch (error) {
      console.log(`\nerror: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  // --userinfo: probe the account identity endpoint (GetUserInfo) to prove
  // the token is alive — 200 + identity means auth is fine and any chat error
  // is entitlement/region, not expiry. Headers mirror the OAuth adapter exactly
  // (x-cloudide-token + the OAuth UA), not the data-plane builder — this is
  // the business host's auth, and it is a different header from the chat one.
  if (v.userinfo === true) {
    const userInfoHeaders = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Trae/1.0.0 antigravity-cockpit-tools",
      "x-cloudide-token": token,
    };
    for (const host of traeAccountCandidates(realm)) {
      const url = `${host}${TRAE_GET_USER_INFO_PATH}`;
      console.log(`\nPOST ${url} (userinfo)`);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: userInfoHeaders,
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(25_000),
        });
        const text = await response.text();
        console.log(`status=${response.status}${response.ok ? "" : " (not ok)"}`);
        console.log(`body: ${text.slice(0, 800)}`);
        if (response.ok) break;
      } catch (error) {
        console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return;
  }

  // --sweep-chat: probe every chat-surface roster model (model_list).
  // (moved below — body/headers are declared later)


  const model = v.model!;
  const message = v.message!;
  const stream = !v["no-stream"];
  const maxTokens = v.maxTokens !== undefined ? Number(v.maxTokens) : undefined;

  console.log(`using account: ${account.label ?? account.id ?? "?"} (${realm})`);
  console.log(`region: ${region || "(none)"} uid: ${uid ? maskUuid(uid) : "(none)"}`);
  console.log(`token prefix: ${maskSecret(token)}`);

  // Shared chat header/body shape for the single-chat and sweep paths. The
  // canonical client does NOT send x-ide-token or store-country-code on the
  // chat/agent surface (commit b6786417, Trae 1.107.1 bundle) — drop both so
  // the probe matches the adapter's reference wire exactly.
  const headers = buildTraeHeaders({
    realm,
    token,
    uid,
    stream,
    ...(v["version-code"] !== undefined ? { versionCode: v["version-code"] } : {}),
    extra: {
      "x-ide-token": null,
      "store-country-code": null,
      ...(v["cc-auth"] === true ? { "x-cloudide-token": token } : {}),
    },
  });

  const body: Record<string, unknown> = {
    messages: [{ role: "user", content: [{ type: "text", text: message }] }],
    stream,
    region: TRAE_REALMS[realm].region,
    ai_region: TRAE_REALMS[realm].region,
    temperature: 0.7,
    top_p: 0.95,
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    // Tool declarations, same shape the adapter sends: `parameters` is a JSON
    // string (upstream types it as a Go string and rejects an object).
    ...(v.tools === true
      ? {
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get the weather for a city",
                parameters: JSON.stringify({
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                }),
              },
            },
          ],
        }
      : {}),
  };

  // --sweep-chat: probe every chat-surface roster model (model_list).
  if (v["sweep-chat"] === true) {
    const modelUrl = coreHost(region, realm) + "/api/ide/v1/model_list";
    const listHeaders = buildTraeHeaders({
      realm,
      token,
      uid,
      extra: { authorization: `Cloud-IDE-JWT ${token}` },
    });
    const listRes = await fetch(modelUrl, {
      method: "POST",
      headers: listHeaders,
      body: JSON.stringify({ type: "chat" }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!listRes.ok) {
      console.log(`model_list status=${listRes.status} (not ok)`);
      return;
    }
    const parsed = (await listRes.json()) as { model_configs?: unknown; models?: unknown; data?: unknown };
    const rows = Array.isArray(parsed.model_configs)
      ? parsed.model_configs
      : Array.isArray(parsed.models)
        ? parsed.models
        : Array.isArray(parsed.data)
          ? parsed.data
          : [];
    const names: string[] = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const name = String((row as Record<string, unknown>)["model_name"] ?? (row as Record<string, unknown>)["name"] ?? (row as Record<string, unknown>)["id"] ?? "");
      if (name) names.push(name);
    }
    console.log(`\n=== chat-surface sweep (${names.length} models) ===`);
    for (const name of names) {
      const outcome = await probeChatOnce({ model: name, body, headers, agent: false, urlBase: coreHost(region, realm) });
      console.log(outcome);
    }
    return;
  }

  // --sweep: probe every agent picker config (batch_get_detail_param, chat_completion only).
  if (v.sweep === true) {
    const pickerUrl = coreHost(region, realm) + "/api/ide/v1/batch_get_detail_param";
    const pickerHeaders = buildTraeHeaders({
      realm,
      token,
      uid,
      extra: { authorization: `Cloud-IDE-JWT ${token}` },
    });
    const pickerRes = await fetch(pickerUrl, {
      method: "POST",
      headers: pickerHeaders,
      body: JSON.stringify({ functions: [TRAE_AGENT_FUNCTION], Request: {} }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!pickerRes.ok) {
      console.log(`batch_get_detail_param status=${pickerRes.status} (not ok)`);
      return;
    }
    const pickerParsed = (await pickerRes.json()) as { function_configs?: unknown };
    const configs = Array.isArray(pickerParsed.function_configs) ? pickerParsed.function_configs : [];
    const names: string[] = [];
    for (const group of configs) {
      if (typeof group !== "object" || group === null) continue;
      const rawList = (group as Record<string, unknown>)["config_info_list"];
      const list = Array.isArray(rawList) ? (rawList as unknown[]) : [];
      for (const entry of list) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (String(e["usage"] ?? "") !== "chat_completion") continue;
        const name = String(e["config_name"] ?? "");
        if (name) names.push(name);
      }
    }
    console.log(`\n=== agent sweep (${names.length} picker configs) ===`);
    for (const name of names) {
      const outcome = await probeChatOnce({ model: name, body, headers, agent: true, urlBase: coreHost(region, realm) });
      console.log(outcome);
    }
    return;
  }

  // --models: list the live roster (POST /model_list, body {"type":"chat"}).
  if (v.models === true) {
    const modelUrl = coreHost(region, realm) + "/api/ide/v1/model_list";
    console.log(`\nPOST ${modelUrl} (model list)`);
    const modelHeaders = buildTraeHeaders({
      realm,
      token,
      uid,
      extra: { authorization: `Cloud-IDE-JWT ${token}` },
    });
    try {
      const response = await fetch(modelUrl, {
        method: "POST",
        headers: modelHeaders,
        body: JSON.stringify({ type: "chat" }),
        signal: AbortSignal.timeout(25_000),
      });
      const text = await response.text();
      console.log(`status=${response.status}${response.ok ? "" : " (not ok)"}`);
      if (!response.ok) {
        console.log(`body: ${text.slice(0, 600)}`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        console.log(`body: ${text.slice(0, 600)}`);
        return;
      }
      const rows = Array.isArray((parsed as { model_configs?: unknown }).model_configs)
        ? (parsed as { model_configs: unknown[] }).model_configs
        : Array.isArray((parsed as { models?: unknown }).models)
          ? (parsed as { models: unknown[] }).models
          : Array.isArray((parsed as { data?: unknown }).data)
            ? (parsed as { data: unknown[] }).data
            : [];
      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const r = row as Record<string, unknown>;
        const name = String(r["model_name"] ?? r["name"] ?? r["id"] ?? "");
        if (!name) continue;
        const flags: string[] = [];
        for (const k of ["status", "type", "vision", "reasoning", "free", "is_free", "upgrade_required", "catalog_only"]) {
          if (r[k] !== undefined && r[k] !== null) flags.push(`${k}=${String(r[k])}`);
        }
        console.log(`  - ${name}${flags.length ? ` (${flags.join(" ")})` : ""}`);
      }
      if (rows.length === 0) console.log("  (no rows parsed — full body keys: " + Object.keys(parsed as object).join(", ") + ")");
    } catch (error) {
      console.log(`\nerror: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  console.log(`model: ${model} stream: ${stream} message: ${JSON.stringify(message)}`);

  // The agent surface (intl catalog) needs the rewritten body and its own
  // endpoint; the chat surface takes the body verbatim. Models absent from the
  // static roster default to the chat surface — the live roster is the
  // authority and its chat-shaped rows are not in the static agent-only list.
  const roster = realm === "cn" ? TRAE_CN_MODELS : TRAE_INTL_MODELS;
  const row = roster.find((m) => m.modelId === model);
  const forceAgent = v.agent === true;
  const agentSurface = forceAgent || (row !== undefined && isTraeAgentEndpoint(row.endpointPath));
  const chatBody: Record<string, unknown> = { ...body, model_name: model };
  const agentBody: Record<string, unknown> = { ...chatBody, Request: {} };
  const payload = agentSurface ? toTraeAgentBody(agentBody as never) : chatBody;
  const path = agentSurface ? TRAE_AGENT_CHAT_PATH : TRAE_CHAT_PATH;
  console.log(`surface: ${agentSurface ? "agent" : "chat"}`);

  const url = (v.host ?? coreHost(region, realm)) + path;
  console.log(`\nPOST ${url}`);

  const timeoutMs = Number(v.timeout) || 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    console.log(`status=${response.status}${response.ok ? "" : " (not ok)"}`);
    console.log(`content-type: ${response.headers.get("content-type") ?? ""}`);
    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      console.log(`body: ${responseText.slice(0, 600)}`);
      return;
    }
    if (!responseText) {
      console.log("(empty body)");
      return;
    }

    // The body is an SSE stream of JSON frames; reuse the adapter's own parser
    // so the decoding is exactly what the gateway sees.
    const sse = new ReadableStream({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(responseText));
        streamController.close();
      },
    });

    let sawEvent = false;
    for await (const frame of parseTraeSse(sse)) {
      sawEvent = true;
      const data = frame.data ?? {};
      const pretty =
        typeof data === "object" && data !== null ? JSON.stringify(data) : String(data);
      console.log(`\n[event] ${frame.event}`);
      console.log(`  ${pretty.slice(0, 2000)}`);
      if (frame.event === "error") break;
      if (frame.event === "done") break;
    }
    if (!sawEvent) {
      console.log(`\n(no parseable events; raw head: ${responseText.slice(0, 300)})`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      console.log(`\ntimed out after ${timeoutMs}ms`);
    } else {
      console.log(`\nerror: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

await main();
