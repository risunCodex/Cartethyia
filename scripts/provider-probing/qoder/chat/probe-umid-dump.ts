/**
 * Temporary UMID-augmented probe: loads the app's umid-cache.json and
 * injects Cosy-MachineToken/Type/Code into the Qoder auth before one COSY
 * chat call. Token values are never printed. Scratch tool.
 */
import { readFileSync } from "node:fs";
import { loadProbeAccount } from "../lib/shared";
import { createValidatedFetch } from "../../../../src/network/egress/fetch";
import { buildQoderRequest, callQoder } from "../../../../src/providers/integrations/qoder/qoder-chat";
import { decodeQoderSseEvents } from "../../../../src/providers/integrations/qoder/qoder-sse";
import { QODER_INTL_MODEL_CONFIGS } from "../../../../src/providers/integrations/qoder/qoder-catalog";

const CREDS = process.argv[2] ?? "C:/Users/Aria/Desktop/qoder-accounts-2026-11-12T03-42-24-773Z.json";
const MODEL = process.argv[3] ?? "dfmodel";
const HOST = process.argv[4] ?? "api2";
const UMID_CACHE = process.argv[5] ?? "C:/Users/Aria/.qoder/umid-cache.json";
const PROMPT = "Halo, perkenalkan dirimu singkat.";

const url = HOST.startsWith("http")
  ? `${HOST.replace(/\/+$/, "")}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=*`
  : `https://${HOST}.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=*`;

const { auth } = loadProbeAccount({ creds: CREDS });
try {
  const umid = JSON.parse(readFileSync(UMID_CACHE, "utf8")) as {
    info?: { machineToken?: string; machineType?: string; machineCode?: string };
  };
  const info = umid.info ?? {};
  if (info.machineToken) auth.machineToken = info.machineToken;
  if (info.machineType) auth.machineType = info.machineType;
  if (info.machineCode) auth.machineCode = info.machineCode;
  console.log(`umid injected: token=${info.machineToken ? "yes" : "no"} type=${info.machineType ? "yes" : "no"} code=${info.machineCode ? "yes" : "no"}`);
} catch (e) {
  console.log(`umid load failed (${String(e)}); continuing without`);
}

const modelConfig = QODER_INTL_MODEL_CONFIGS[MODEL] ?? {
  id: MODEL,
  display_name: MODEL,
  max_input_tokens: 180_000,
  is_vl: true,
  is_reasoning: false,
};
const request = {
  model: MODEL,
  messages: [{ role: "user", content: [{ kind: "text", text: PROMPT }] }],
  generation_controls: {},
  stream: true,
  source_surface: "chat",
};

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 60_000);
const fetchFn = createValidatedFetch({ tlsProfile: "qoder-app" });

const body = buildQoderRequest(MODEL, request as never, modelConfig, auth, "intl");
const response = await callQoder(url, body, MODEL, auth, ac.signal, fetchFn as never, undefined, "app");
console.log(`status=${response.status} content-type=${response.headers.get("content-type")}`);
if (!response.body) {
  console.log("(empty body)");
  process.exit(0);
}
let frames = 0;
let terminal = false;
let text = "";
let raw: string | undefined;
for await (const sse of decodeQoderSseEvents(response.body, ac.signal)) {
  frames++;
  if (frames === 1 && raw === undefined && sse.data.length < 2000) raw = sse.data;
  if (sse.data === "[DONE]" || sse.data.includes("[DONE]")) { terminal = true; break; }
  try {
    const parsed = JSON.parse(sse.data) as Record<string, unknown>;
    const inner = typeof parsed["body"] === "string"
      ? (JSON.parse(parsed["body"] as string) as Record<string, unknown>)
      : parsed;
    const choices = (inner?.["choices"] as Array<Record<string, unknown>> | undefined) ?? [];
    for (const c of choices) {
      const d = c?.["delta"] as Record<string, unknown> | undefined;
      if (typeof d?.["content"] === "string") text += d["content"] as string;
    }
    if (inner?.["finish_reason"] != null && inner["finish_reason"] !== "") terminal = true;
  } catch { /* keep going */ }
}
console.log(`frames=${frames} terminal=${terminal}`);
console.log(`text=${text.slice(0, 400) || "(none)"}`);
if (raw) console.log(`raw1=${raw.slice(0, 500)}`);
clearTimeout(timer);
