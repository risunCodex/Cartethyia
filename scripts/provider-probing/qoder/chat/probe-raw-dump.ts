/**
 * Raw SSE dump for Qoder probe debugging — prints every SSE event
 * and data payload verbatim (truncated). Scratch tool; do not run against
 * production credentials.
 */
import { loadProbeAccount } from "../lib/shared";
import { createValidatedFetch } from "../../../../src/network/egress/fetch";
import { buildQoderRequest, callQoder } from "../../../../src/providers/integrations/qoder/qoder-chat";
import { decodeQoderSseEvents } from "../../../../src/providers/integrations/qoder/qoder-sse";
import { QODER_INTL_MODEL_CONFIGS } from "../../../../src/providers/integrations/qoder/qoder-catalog";

const CREDS = process.argv[2] ?? "C:/Users/Aria/Desktop/qoder-accounts-2026-11-12T03-42-24-773Z.json";
const MODEL = process.argv[3] ?? "dfmodel";
const HOST = process.argv[4] ?? "api2";
const PROMPT = "Halo, perkenalkan dirimu singkat.";

const url = HOST.startsWith("http")
  ? `${HOST.replace(/\/+$/, "")}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=*`
  : `https://${HOST}.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=*`;

const { auth } = loadProbeAccount({ creds: CREDS });
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
let n = 0;
for await (const sse of decodeQoderSseEvents(response.body, ac.signal)) {
  n++;
  let frame = sse.data;
  if (frame.length > 2000) frame = `${frame.slice(0, 2000)}…[truncated]`;
  console.log(`--- SSE #${n} event=${sse.event ?? "(null)"} len=${sse.data.length}`);
  console.log(frame);
  if (n >= 12) {
    console.log("(stopped after 12 frames)");
    break;
  }
}
console.log(`total frames shown: ${n}`);
clearTimeout(timer);
