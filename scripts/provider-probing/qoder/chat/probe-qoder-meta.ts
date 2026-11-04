/**
 * Qoder per-model probe with strategy metadata.
 *
 * Sends a real IDE-surface chat request for each model key (or virtual id) and
 * reports:
 *   - HTTP status and the upstream's model echo (first chunk `model`)
 *   - visible answer text and reasoning length
 *   - strategy metadata when the request routed through a strategy router:
 *     `provider_model`, `from_model`, `supply_model`, `model_level`,
 *     `router_strategy_name`, `target`, and the final usage totals
 *
 * Tokens are never printed. Account credentials come from an exported accounts
 * file (see `qoder-export-accounts.ts`).
 *
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder-meta.ts \
 *     --creds D:\tmp\scratch\qoder-accounts.json \
 *     --model auto --model fast --model lite --model smodel
 */
import { parseArgs } from "node:util";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../../lib/accounts";
import {
  buildQoderIdeRequest,
  isQoderPat,
  resolveQoderAuth,
  qoderEnvelopeToFrames,
} from "../../../../src/providers/integrations/qoder/qoder";
import {
  QODER_VERSION,
  machineOs,
  machineHostname,
} from "../lib/shared";
import {
  QODER_INTL_MODEL_CONFIGS,
} from "../../../../src/providers/integrations/qoder/qoder-catalog";
import { qoderIdeChatUrl } from "../../../../src/providers/integrations/qoder/qoder-realm";
import { decodeQoderSseEvents } from "../../../../src/providers/integrations/qoder/qoder-sse";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    model: { type: "string", multiple: true, default: ["auto"] },
    prompt: { type: "string", default: "Halo, perkenalkan dirimu singkat." },
    maxTokens: { type: "string", default: "512" },
    realm: { type: "string", default: "intl" },
  },
});

const accounts = readAccountsFile(args.values.creds!);
const account = pickAccount(accounts);
const rawToken = requireAccountToken(account);
const userId = account.authState?.userId ?? "";
const machineId = account.authState?.machineId ?? "";
const maxTokens = Number.parseInt(args.values.maxTokens ?? "512", 10) || 512;
const realm = (args.values.realm ?? "intl") as "intl" | "cn";

/** Resolve the bearer actually used on the business/IDE surface (PAT → job token). */
async function resolveBearer(): Promise<string> {
  if (!isQoderPat(rawToken)) return rawToken;
  const auth = await resolveQoderAuth({
    secret: rawToken,
    authState: { userId, machineId, realm },
    signal: AbortSignal.timeout(15_000),
    fetcher: fetch,
    realm,
  });
  return auth.securityOauthToken;
}

const bearer = await resolveBearer();
const auth = {
  userId,
  userName: account.label ?? "",
  userType: "personal_standard",
  securityOauthToken: bearer,
  refreshToken: "",
  machineId,
};

const KEY = "provider_model|from_model|supply_model|supply_account|supply_region|model_level|router_strategy_name|router_strategy_type|scheduler_times|target|target_id";

function extractMetadata(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const raw = rec["raw_usage"] ?? rec["rawUsage"] ?? null;
  const candidates =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? [(raw as Record<string, unknown>)["data"] ?? raw, raw, rec]
      : [rec];
  for (const src of candidates) {
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    const s = src as Record<string, unknown>;
    for (const k of KEY.split("|")) {
      if (s[k] !== undefined) out[k] = s[k];
    }
  }
  return out;
}

async function probeModel(modelKey: string): Promise<void> {
  const cfg = QODER_INTL_MODEL_CONFIGS[modelKey];
  if (!cfg) {
    console.log(`\n=== ${modelKey} ===\nNO_ROSTER_CONFIG (not in intl roster)`);
    return;
  }
  const request = {
    model: `qoder/${modelKey}`,
    messages: [{ role: "user", content: [{ kind: "text", text: args.values.prompt }] }],
    generation_controls: { max_tokens: maxTokens, "extension:include_usage": true },
    stream: true,
    source_surface: "chat",
    tools: [],
    tool_choice: undefined,
  } as Record<string, unknown>;

  const body = buildQoderIdeRequest(modelKey, request as never, cfg, auth, realm);
  const res = await fetch(qoderIdeChatUrl(realm), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Request-ID": crypto.randomUUID(),
      "X-Session-ID": crypto.randomUUID(),
      "Cosy-Version": QODER_VERSION,
      "Cosy-ClientType": "5",
      "Cosy-MachineOS": machineOs(),
      "Cosy-MachineHostname": machineHostname(),
    },
    body: JSON.stringify(body),
  });

  console.log(`\n=== ${modelKey} | HTTP ${res.status} ===`);
  if (!res.ok) {
    const errorBody = await res.text();
    console.log(errorBody.slice(0, 300));
    return;
  }
  if (!res.body) {
    console.log("EMPTY_BODY");
    return;
  }

  let firstModel: string | undefined;
  let answer = "";
  let reasoning = "";
  const metadata: Record<string, unknown> = {};
  let usage: Record<string, unknown> | undefined;
  let frames = 0;

  for await (const sse of decodeQoderSseEvents(res.body, new AbortController().signal)) {
    let framesArray: Array<{ event: string | null; data: string }>;
    try {
      framesArray = qoderEnvelopeToFrames(sse.data);
    } catch {
      continue;
    }
    for (const frame of framesArray) {
      const payload = frame.data.trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      let json: { model?: string; body?: unknown; usage?: unknown; choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> } | null = null;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      frames++;
      if (firstModel === undefined && typeof json?.model === "string") firstModel = json.model;
      const delta = json?.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string") answer += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (json?.usage && typeof json.usage === "object") usage = json.usage as Record<string, unknown>;
      const rec = json?.body ?? json;
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        Object.assign(metadata, extractMetadata(rec as Record<string, unknown>));
      }
    }
  }

  console.log("FRAMES", frames);
  console.log("MODEL_ECHO", JSON.stringify(firstModel ?? null));
  console.log("REASONING_LEN", reasoning.length);
  console.log("ANSWER", JSON.stringify(answer.trim().slice(0, 300)));
  console.log("USAGE", JSON.stringify(usage ?? null));
  const metaKeys = Object.keys(metadata);
  if (metaKeys.length === 0) {
    console.log("METADATA (none)");
  } else {
    console.log("METADATA", JSON.stringify(metadata, null, 2));
  }
}

for (const model of args.values.model ?? ["auto"]) {
  await probeModel(model);
}
