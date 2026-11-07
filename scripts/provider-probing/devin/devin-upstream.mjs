/**
 * Devin direct upstream probe — the live counterpart of the adapter tests.
 * Language: JavaScript (Bun), file: scripts/provider-probing/devin/devin-upstream.mjs
 *
 * Every call goes straight to `https://server.codeium.com` using the SHIPPED
 * wire modules (no gateway, no mock transport). Modes:
 *
 *   --mode=jwt        GetUserJwt (auth)
 *   --mode=models     GetCliModelConfigs (full catalog, decoded)
 *   --mode=status     GetUserStatus (plan/quota)
 *   --mode=chat       GetChatMessage (Connect frame stream, decoded frames)
 *   --mode=assign     AssignModel (router resolution)
 *   --mode=all        jwt → models → status → chat
 *   --mode=raw        dump raw response bytes for one RPC (--path=…)
 *
 * Credential: DEVIN_CRED or DEVIN_API_KEY (sk-ws-…, gsk-ws-…, or JWT).
 * A Google auth1 token is intentionally NOT accepted — use --mode=all to see
 * the exact 401 from the upstream.
 *
 * Usage:
 *   DEVIN_CRED=sk-ws-… bun scripts/provider-probing/devin/devin-upstream.mjs --mode=all
 *   DEVIN_CRED=… bun scripts/provider-probing/devin/devin-upstream.mjs --mode=chat --prompt="hello"
 *   DEVIN_CRED=… bun scripts/provider-probing/devin/devin-upstream.mjs --mode=raw --path=/exa.auth_pb.AuthService/GetUserJwt
 */

import { gzipSync } from "node:zlib";
import {
  arg,
  hasFlag,
  redact,
  requireCred,
  dump,
  callDevinUnary,
  DevinMessageTypes,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_USER_JWT_PATH,
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  DEVIN_GET_USER_STATUS_PATH,
  DEVIN_CHAT_MESSAGE_PATH,
  DEVIN_ASSIGN_MODEL_PATH,
  devinCliMetadata,
  devinDiscoveryMetadata,
  encodeFrame,
  ConnectFrameDecoder,
  gunzipSync,
} from "./_lib.mjs";

const mode = arg("mode", "all");
const baseUrl = arg("base-url", DEVIN_DEFAULT_BASE_URL);
const cred = requireCred();
const timeoutMs = Number(arg("timeout", "30000"));
const signal = () => AbortSignal.timeout(timeoutMs);

console.log(`host:    ${baseUrl}`);
console.log(`cred:    ${redact(cred)}`);
console.log(`mode:    ${mode}\n`);

function unary(name, path, reqType, resType, body) {
  return callDevinUnary(path, reqType, resType, body, { baseUrl, signal: signal() })
    .then((out) => ({ ok: true, out }))
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}

async function jwt() {
  const r = await unary("GetUserJwt", DEVIN_GET_USER_JWT_PATH, DevinMessageTypes.GetUserJwtRequest, DevinMessageTypes.GetUserJwtResponse, {
    metadata: devinCliMetadata(cred),
  });
  if (!r.ok) { console.log(`GetUserJwt: FAILED — ${r.error}`); return null; }
  console.log(`GetUserJwt: OK | userJwt=${r.out.userJwt ? "present" : "absent"} | customApiServerUrl=${r.out.customApiServerUrl ?? "-"}`);
  if (hasFlag("verbose")) dump("GetUserJwt response", { userJwt: r.out.userJwt ? redact(r.out.userJwt) : null, customApiServerUrl: r.out.customApiServerUrl });
  return r.out;
}

async function models() {
  const r = await unary("GetCliModelConfigs", DEVIN_GET_CLI_MODEL_CONFIGS_PATH, DevinMessageTypes.GetCliModelConfigsRequest, DevinMessageTypes.GetCliModelConfigsResponse, {
    metadata: devinDiscoveryMetadata(cred),
  });
  if (!r.ok) { console.log(`GetCliModelConfigs: FAILED — ${r.error}`); return null; }
  const configs = r.out.clientModelConfigs ?? [];
  console.log(`GetCliModelConfigs: OK | ${configs.length} configs | default=${r.out.defaultOverrideModelConfig?.modelUid ?? "-"}`);
  const visible = configs.filter((c) => !c.disabled);
  console.log(`  visible: ${visible.length}`);
  for (const c of visible.slice(0, Number(arg("limit", "40")))) {
    const ctx = c.modelInfo?.maxTokens ?? c.maxTokens ?? 0;
    const outLimit = c.modelInfo?.maxOutputTokens ?? 0;
    const flags = [
      c.modelInfo?.modelFeatures?.supportsThinking ? "thinking" : "",
      c.modelInfo?.modelFeatures?.supportsToolCalls ? "tools" : "",
      c.modelInfo?.modelFeatures?.supportsImages ? "vision" : "",
      c.modelInfo?.isModelRouter ? "router" : "",
    ].filter(Boolean).join(",");
    console.log(`  ${String(c.modelUid).padEnd(36)} | ${String(c.label ?? "").slice(0, 28).padEnd(28)} | ctx=${ctx} out=${outLimit} | disp=${c.modelInfo?.displayOption ?? 0} | ${flags}`);
  }
  if (visible.length > Number(arg("limit", "40"))) console.log(`  … (${visible.length - Number(arg("limit", "40"))} more; use --limit=0 for all)`);
  if (hasFlag("json")) dump("raw GetCliModelConfigs (trimmed)", configs.slice(0, 3));
  return r.out;
}

async function status() {
  const r = await unary("GetUserStatus", DEVIN_GET_USER_STATUS_PATH, DevinMessageTypes.GetUserStatusRequest, DevinMessageTypes.GetUserStatusResponse, {
    metadata: devinCliMetadata(cred),
  });
  if (!r.ok) { console.log(`GetUserStatus: FAILED — ${r.error}`); return null; }
  const plan = r.out.planInfo;
  const ps = r.out.userStatus?.planStatus;
  console.log(`GetUserStatus: OK | plan=${plan?.planName ?? "-"} | tier=${plan?.teamsTier ?? "-"} | email=${r.out.userStatus?.email ?? "-"}`);
  console.log(`  credits: prompt=${ps?.availablePromptCredits ?? "-"}/${plan?.monthlyPromptCredits ?? "-"} flow=${ps?.availableFlowCredits ?? "-"}/${plan?.monthlyFlowCredits ?? "-"}`);
  console.log(`  quota:   daily=${ps?.dailyQuotaRemainingPercent ?? "-"}% weekly=${ps?.weeklyQuotaRemainingPercent ?? "-"}%`);
  if (hasFlag("json")) dump("GetUserStatus raw", r.out);
  return r.out;
}

async function assign(userJwt) {
  const uid = arg("router-uid", "adaptive");
  const cascadeId = arg("cascade-id", crypto.randomUUID());
  const r = await unary("AssignModel", DEVIN_ASSIGN_MODEL_PATH, DevinMessageTypes.AssignModelRequest, DevinMessageTypes.AssignModelResponse, {
    metadata: devinCliMetadata(cred, userJwt),
    modelRouterUid: uid,
    cascadeId,
  });
  if (!r.ok) { console.log(`AssignModel(${uid}): FAILED — ${r.error}`); return null; }
  const a = r.out.assignment;
  console.log(`AssignModel(${uid}): OK | modelUid=${a?.modelUid ?? "-"} | jwt=${a?.assignmentJwt ? "present" : "absent"} | harness=${a?.harnessUids?.length ?? 0}`);
  return a;
}

async function chat(userJwt, assignment) {
  const prompt = arg("prompt", "Say OK.");
  const modelUid = arg("model", assignment?.modelUid || "swe-2-flash-medium");
  const request = {
    metadata: devinCliMetadata(cred, userJwt),
    prompt: "",
    chatMessagePrompts: [{ messageId: crypto.randomUUID(), source: 1, prompt }],
    requestType: 5,
    plannerMode: 1,
    systemPromptCacheOptions: { type: 1 },
    configuration: { numCompletions: 1, maxTokens: 4096, maxNewlines: 400, temperature: 1, topK: 40, topP: Math.fround(0.95) },
    cascadeId: arg("cascade-id", crypto.randomUUID()),
    executionId: crypto.randomUUID(),
    chatModelUid: modelUid,
    ...(assignment?.assignmentJwt ? { modelAssignmentJwt: assignment.assignmentJwt } : {}),
  };
  const body = Buffer.from(DevinMessageTypes.GetChatMessageRequest.encode(request).finish());
  const frame = encodeFrame(body, true);
  console.log(`GetChatMessage: POST ${baseUrl}${DEVIN_CHAT_MESSAGE_PATH} | model=${modelUid} | body=${body.length}B frame=${frame.length}B`);

  const res = await fetch(`${baseUrl}${DEVIN_CHAT_MESSAGE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      "connect-content-encoding": frame[0] === 1 ? "gzip" : "identity",
      "accept-encoding": "identity",
      "connect-accept-encoding": "gzip",
      "user-agent": "connect-go/1.18.1 (go1.26.3)",
    },
    body: new Uint8Array(frame),
    signal: signal(),
  });
  console.log(`  HTTP ${res.status} ${res.headers.get("content-type") ?? ""}`);
  if (!res.ok) {
    console.log(`  error body: ${(await res.text()).slice(0, 1000)}`);
    return null;
  }

  const decoder = new ConnectFrameDecoder();
  const reader = res.body.getReader();
  let text = "";
  let thinking = "";
  let toolCalls = 0;
  let frames = 0;
  let stopReason = null;
  let usage = null;
  let trailer = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const f of decoder.push(value)) {
      frames += 1;
      if (f.flags & 0x02) {
        // End-of-stream trailers may also carry the compressed flag.
        trailer = (f.compressed ? gunzipSync(f.payload) : Buffer.from(f.payload)).toString("utf8");
        continue;
      }
      const payload = f.compressed ? gunzipSync(f.payload) : f.payload;
      const decoded = DevinMessageTypes.GetChatMessageResponse.decode(payload);
      if (decoded.deltaText) text += decoded.deltaText;
      if (decoded.deltaThinking) thinking += decoded.deltaThinking;
      if (decoded.deltaToolCalls?.length) toolCalls += decoded.deltaToolCalls.length;
      if (decoded.stopReason !== undefined) stopReason = decoded.stopReason;
      if (decoded.usage) usage = decoded.usage;
    }
  }
  console.log(`  frames=${frames} | text=${JSON.stringify(text.slice(0, 300))} | thinking=${thinking.length} chars | toolCalls=${toolCalls}`);
  console.log(`  stopReason=${stopReason ?? "-"} | usage=${usage ? `in=${usage.inputTokens} out=${usage.outputTokens}` : "none"}`);
  console.log(`  trailer=${trailer ?? "(none)"}${decoder.hasPartial ? " | TRUNCATED" : ""}`);
  return { text, thinking, toolCalls, stopReason, usage, trailer };
}

async function raw() {
  // Git-Bash/MSYS rewrites a leading `/exa...` argument into
  // `C:/Program Files/Git/exa...`. Normalize back to the Connect path.
  let path = arg("path", DEVIN_GET_USER_JWT_PATH);
  const exa = path.indexOf("/exa.");
  if (exa > 0) path = path.slice(exa);
  const reqType = path.includes("GetCliModelConfigs") ? DevinMessageTypes.GetCliModelConfigsRequest
    : path.includes("GetUserStatus") ? DevinMessageTypes.GetUserStatusRequest
      : DevinMessageTypes.GetUserJwtRequest;
  const metadata = path.includes("GetCliModelConfigs") ? devinDiscoveryMetadata(cred) : devinCliMetadata(cred);
  const body = Buffer.from(reqType.encode({ metadata }).finish());
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
    body,
    signal: signal(),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`HTTP ${res.status} | ${buf.length} bytes`);
  console.log(`hex[0:256]: ${buf.subarray(0, 256).toString("hex")}`);
  console.log(`ascii[0:512]: ${buf.subarray(0, 512).toString("latin1")}`);
}

switch (mode) {
  case "jwt": await jwt(); break;
  case "models": await models(); break;
  case "status": await status(); break;
  case "assign": await assign(); break;
  case "chat": await chat(); break;
  case "raw": await raw(); break;
  case "all": {
    const j = await jwt();
    const m = await models();
    await status();
    if (m?.clientModelConfigs?.length) await chat(j?.userJwt, null);
    else console.log("\n[chat] skipped (no catalog — credential likely rejected)");
    break;
  }
  default:
    console.error(`unknown --mode=${mode} (jwt|models|status|assign|chat|raw|all)`);
    process.exit(1);
}
