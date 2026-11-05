/**
 * Qoder prompt-cache hit probe — does the upstream REPORT cache hits?
 *
 * The gRPC `Usage` proto carries `prompt_tokens_details.cached_tokens` /
 * `cacheable_tokens`, but we have never verified the upstream actually fills
 * them. This probe answers that empirically:
 *
 *   - Calls use a STABLE session id (the same `qoderSessionId` the gateway
 *     computes), so upstream byte-identical prefix caching can engage.
 *   - It fires 4 calls in one run:
 *       A1: [P]                 (fresh — cached should be 0 if reported)
 *       A2: [P]                 (byte-identical repeat — full hit if reported)
 *       A3: [P, R1]             (prefix P repeated — partial hit if reported)
 *       A4: [P, R1, R2]         (prefix P+R1 repeated — partial hit if reported)
 *   - Prints each call's full `usage` (prompt_tokens, completion_tokens,
 *     prompt_tokens_details, completion_tokens_details), plus `extras` and
 *     trailers, and a verdict: upstream reports cache hits vs. silent (0).
 *
 * If the verdict is "silent", the gateway should apply the shared session-cache
 * estimator (`src/providers/integrations/shared/session-cache.ts`) the same way
 * `trae-cache.ts` / `kiro-cache.ts` do (next version — do not hotfix).
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/direct-cache-hit.ts \
 *     --creds <qoder-accounts-*.json> --model dfmodel \
 *     [--prompt "Halo" | --prompt-file <path>] [--realm intl|cn] \
 *     [--calls 4] [--timeout-ms 300000]
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { probeChatStream } from "../lib/grpc";
import type { QoderRealm } from "../../../../src/providers/integrations/qoder/qoder-realm";
import { qoderSessionId } from "../../../../src/providers/integrations/qoder/qoder-auth";
import { machineOs, machineHostname } from "../lib/shared";

const DEFAULT_PROMPT =
  "Tolong jelaskan dalam satu paragraf: apa perbedaan antara HTTP dan WebSocket?";

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "dfmodel" },
    prompt: { type: "string", default: DEFAULT_PROMPT },
    "prompt-file": { type: "string" },
    realm: { type: "string", default: "intl" },
    calls: { type: "string", default: "4" },
    "timeout-ms": { type: "string", default: "300000" },
  },
});

const creds = values.creds;
if (!creds) throw new Error("--creds <path> is required");
const calls = Number(values.calls);
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(calls) || calls < 2 || calls > 8) throw new Error("--calls must be 2..8");
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");

const raw = JSON.parse(readFileSync(creds, "utf8"));
const account = (Array.isArray(raw) ? raw : raw.accounts ?? [])[0];
const token = account.accessToken ?? account.token ?? "";
if (typeof token !== "string" || token.length === 0) throw new Error("no accessToken");
const userId: string = account.authState?.userId ?? "";
const machineId: string = account.authState?.machineId ?? randomUUID();

// The gateway's session id key: userId falling back to machineId for v1
// exchanges. Keep the run's key STABLE across calls so upstream caching can
// engage (a fresh machineId per call would defeat the probe).
const sessionKey = userId !== "" ? userId : machineId;
const sessionId = qoderSessionId(sessionKey, values.model!);

const VERSION = "1.1.83";
const realm: QoderRealm = values.realm === "cn" ? "cn" : "intl";
const promptText = values["prompt-file"] !== undefined
  ? readFileSync(values["prompt-file"], "utf8")
  : values.prompt!;

console.log(`account=${account.label ?? "?"} token=${token.slice(0, 4)}…${token.slice(-4)}`);
console.log(`sessionKey=${sessionKey === userId ? "userId" : "machineId"} sessionId=${sessionId.slice(0, 16)}… (stable)`);
console.log(`model=${values.model} realm=${realm} calls=${calls} promptChars=${promptText.length}`);

// --- per-call request builder (identical shape to the gateway's gRPC) ----
function buildRequest(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    model: values.model,
    messages,
    stream: { value: true },
    stream_options: { include_usage: { value: true } },
    max_tokens: { value: 128 },
    tools: [],
    metadata: {
      context: {
        request_id: randomUUID(),
        session_id: sessionId,
        task_id: "common",
        request_set_id: randomUUID(),
        client_type: "5",
        source_session_id: "",
        context_length: "8000000",
      },
      business: { product: "cli", type: "agent", version: VERSION, scene: "assistant" },
    },
  };
}

function buildMetadata(): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${token}`);
  metadata.set("x-request-id", randomUUID());
  metadata.set("x-session-id", sessionId);
  metadata.set("cosy-version", VERSION);
  metadata.set("cosy-clienttype", "5");
  metadata.set("cosy-machineos", machineOs());
  const hostname = machineHostname();
  if (hostname.length > 0) metadata.set("cosy-machinehostname", hostname);
  return metadata;
}

// --- call sequence: growing prefixes, all sharing the same first message ----
const R1 = "Terima kasih. Sekarang jelaskan perbedaan TCP vs UDP.";
const R2 = "Dan kapan saya harus memakai HTTP/2?";
const sequences: Array<{ label: string; messages: Array<Record<string, unknown>> }> = [];
if (calls >= 1) sequences.push({ label: "A1 fresh        [P]", messages: [{ role: "user", text_content: promptText }] });
if (calls >= 2) sequences.push({ label: "A2 identical     [P]", messages: [{ role: "user", text_content: promptText }] });
if (calls >= 3) sequences.push({ label: "A3 prefix-hit  [P,R1]", messages: [{ role: "user", text_content: promptText }, { role: "user", text_content: R1 }] });
if (calls >= 4) sequences.push({ label: "A4 prefix-hit [P,R1,R2]", messages: [{ role: "user", text_content: promptText }, { role: "user", text_content: R1 }, { role: "user", text_content: R2 }] });

let sawAnyCached = false;
for (const { label, messages } of sequences) {
  const res = await probeChatStream(realm, buildRequest(messages), buildMetadata(), { timeoutMs });
  const usage = res.usage ?? {};
  const ptd = (usage["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  const ctd = (usage["completion_tokens_details"] ?? {}) as Record<string, unknown>;
  const cached = typeof ptd["cached_tokens"] === "number" ? ptd["cached_tokens"] : "—";
  const cacheable = typeof ptd["cacheable_tokens"] === "number" ? ptd["cacheable_tokens"] : "—";
  if (typeof cached === "number" && cached > 0) sawAnyCached = true;
  console.log(`\n=== ${label} ===`);
  console.log(`  chunks=${res.chunks} model=${res.firstModel ?? "?"}`);
  console.log(`  prompt_tokens=${usage["prompt_tokens"] ?? "—"} completion_tokens=${usage["completion_tokens"] ?? "—"} total=${usage["total_tokens"] ?? "—"}`);
  console.log(`  prompt_tokens_details.cached_tokens=${cached} cacheable_tokens=${cacheable}`);
  console.log(`  completion_tokens_details.reasoning_tokens=${typeof ctd["reasoning_tokens"] === "number" ? ctd["reasoning_tokens"] : "—"}`);
  console.log(`  extras=${Object.keys(res.extras).length > 0 ? JSON.stringify(res.extras) : "(empty)"}`);
  console.log(`  trailers=${Object.keys(res.trailers).length > 0 ? JSON.stringify(res.trailers) : "(empty)"}`);
  console.log(`  answerChars=${res.answer.length} reasoningChars=${res.reasoning.length}`);
}

console.log(`\n=== VERDICT ===`);
if (sawAnyCached) {
  console.log("Upstream REPORTS cache hits (cached_tokens > 0 seen). No local estimation needed.");
} else {
  console.log("Upstream does NOT report cache hits (cached_tokens stayed 0 across repeat calls).");
  console.log("Apply the shared session-cache estimator (like trae/kiro) — next version, not hotfix.");
}
