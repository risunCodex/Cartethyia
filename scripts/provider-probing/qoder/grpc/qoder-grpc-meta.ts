/**
 * Qoder gRPC per-model probe with server metadata capture (absorbed the
 * former `qoder-grpc-modelname.ts` echo mode).
 *
 * Two modes:
 *   - default (full): per model key prints chunk count, model echo, reasoning
 *     length, trimmed answer, usage, extras, and gRPC initial metadata +
 *     trailers (collection lives in `lib/grpc.ts`).
 *   - --echo-only: quiet mode that prints just `model key → firstModel` per
 *     key (the former modelname probe), with a notice when no chunks arrive.
 *
 *   bun run scripts/provider-probing/qoder/grpc/qoder-grpc-meta.ts \
 *     --creds <accounts.json> [--label "Akun Ytprem"] \
 *     --model dmodel --model ultimate [--echo-only] \
 *     [--realm intl|cn] [--timeout-ms 60000]
 */
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { loadProbeAccount, QODER_VERSION, machineOs, machineHostname } from "../lib/shared";
import { probeChatStream } from "../lib/grpc";
import { maskSecret, maskUuid } from "../../lib/accounts";
import { qoderGrpcHost, type QoderRealm } from "../../../../src/providers/integrations/qoder/qoder-realm";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    label: { type: "string" },
    model: { type: "string", multiple: true, default: ["dmodel"] },
    prompt: { type: "string", default: "Halo, perkenalkan dirimu singkat." },
    realm: { type: "string", default: "intl" },
    echoOnly: { type: "boolean", default: false },
    timeoutMs: { type: "string", default: "60000" },
    "timeout-ms": { type: "string" },
  },
});

const TIMEOUT_MS = Number(args.values.timeoutMs ?? args.values["timeout-ms"] ?? "60000");
const echoOnly = args.values.echoOnly;
const creds = args.values.creds;
if (creds === undefined) throw new Error("--creds <path> is required");
const { account, token, userId } = loadProbeAccount({
  creds,
  ...(args.values.label !== undefined ? { label: args.values.label } : {}),
});
const realmArg = args.values.realm ?? "intl";
const realm: QoderRealm = realmArg === "cn" ? "cn" : "intl";
const host = qoderGrpcHost(realm);
const prompt = args.values.prompt;

console.log(`account=${account.label ?? "(no label)"} userId=${maskUuid(userId)} token=${maskSecret(token)}`);

async function probeModel(modelKey: string): Promise<void> {
  const sessionId = createHash("sha256").update(`qoder-session:${userId}:${modelKey}`).digest("hex").slice(0, 32);

  const request = {
    model: modelKey,
    messages: [{ role: "user", text_content: prompt }],
    stream: { value: true },
    stream_options: { include_usage: { value: true } },
    max_tokens: { value: 512 },
    metadata: {
      context: {
        request_id: randomUUID(),
        session_id: sessionId,
        task_id: "common",
        request_set_id: randomUUID(),
        client_type: "5",
        source_session_id: "",
        context_length: "1000000",
      },
      business: { product: "cli", type: "agent", version: QODER_VERSION, scene: "assistant" },
    },
  };

  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${token}`);
  metadata.set("x-request-id", randomUUID());
  metadata.set("x-session-id", sessionId);
  // Worker mirror (`Qyl` in qoder-worker-runtime.obf.mjs): gRPC metadata sends
  // cosy-version/clienttype/machineos/machinehostname — NOT machinetype/token
  // (those are HTTP-only identity headers).
  metadata.set("cosy-version", QODER_VERSION);
  metadata.set("cosy-clienttype", "5");
  metadata.set("cosy-machineos", machineOs());
  const hostname = machineHostname();
  if (hostname.length > 0) metadata.set("cosy-machinehostname", hostname);

  if (echoOnly) {
    let firstEcho: string | undefined;
    const result = await probeChatStream(realm, request, metadata, {
      timeoutMs: TIMEOUT_MS,
      onChunk(chunk) {
        if (firstEcho === undefined && chunk.model !== undefined) firstEcho = chunk.model;
      },
    });
    console.log(`${modelKey.padEnd(10)} -> ${firstEcho ?? "(no echo)"}`);
    if (result.chunks === 0) {
      console.log(`  [notice] no chunks received for ${modelKey} (stream error or empty response)`);
    }
    return;
  }

  const result = await probeChatStream(realm, request, metadata, { timeoutMs: TIMEOUT_MS });

  console.log(`\n=== ${modelKey} (gRPC ${host}) ===`);
  if (result.chunks === 0) {
    console.log("  [notice] no chunks received (stream error or empty response)");
  }
  console.log("  CHUNKS", result.chunks);
  console.log("  MODEL_ECHO", JSON.stringify(result.firstModel ?? null));
  console.log("  REASONING_LEN", result.reasoning.length);
  console.log("  ANSWER", JSON.stringify(result.answer.trim().slice(0, 300)));
  console.log("  USAGE", JSON.stringify(result.usage ?? null));
  console.log("  EXTRAS", JSON.stringify(result.extras));
  console.log("  METADATA(initial)", JSON.stringify(result.initialMeta, null, 2));
  console.log("  METADATA(trailers)", JSON.stringify(result.trailers, null, 2));
}

for (const modelKey of args.values.model ?? ["dmodel"]) {
  await probeModel(modelKey);
}
