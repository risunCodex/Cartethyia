/**
 * Qoder gRPC transport — `model.chat.ChatService/ChatCompletionStream`.
 *
 * This is the only proven surface for real 1M-token context: the HTTP IDE
 * surface caps at ~256 KiB (~60K tokens), while gRPC accepts bodies up to
 * ~8M chars (~1.9M tokens) — verified live 2026-11-04, see
 * `documentation/research/qoder/2026-11-04-qoder-grpc-1m-context.md`.
 *
 * gRPC only serves billed models: a free-tier row (`lite`) answers
 * `quota exceeded` (116) on this surface, so free-tier dispatch must use the
 * legacy COSY surface instead (see `qoder.ts` transport selection).
 *
 * The proto is vendored at `vendor/qoder/chat.proto` (from the unpacked
 * desktop client, version 1.1.81, `qoder-worker-runtime.mjs`).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason } from "../../../protocol/canonical-model";
import { usageFromProvider } from "../../provider-usage";
import type { QoderAuth, QoderRealm } from "./qoder-types";
import { qoderGrpcHost } from "./qoder-realm";
import { flattenCanonicalContent } from "./qoder-body";
// The proto is embedded as a generated TS source (see `chat-proto.ts`), so
// the gRPC surface works from source, dist, and the standalone binary alike —
// the proto loader only reads from a path, so the string is materialized once
// to a temp file per process.
import { CHAT_PROTO_SOURCE } from "./chat-proto";

const PROTO_PATH = materializeChatProto();

function materializeChatProto(): string {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-qoder-grpc-"));
  const path = join(dir, "chat.proto");
  writeFileSync(path, CHAT_PROTO_SOURCE);
  // Best-effort cleanup; a leftover temp file is harmless but avoid keeping it.
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  return path;
}

let packageDefinitionCache: ReturnType<typeof protoLoader.loadSync> | null = null;
let grpcClientCache: any = null;

function loadProtoDefinition() {
  if (packageDefinitionCache === null) {
    packageDefinitionCache = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
  }
  return packageDefinitionCache;
}

/** Loads (once) the gRPC service client. */
export function qoderGrpcClient(): any {
  if (grpcClientCache !== null) return grpcClientCache;
  const proto = grpc.loadPackageDefinition(loadProtoDefinition()) as Record<string, any>;
  const model = proto.model as Record<string, any> | undefined;
  grpcClientCache = model?.chat?.ChatService;
  if (grpcClientCache === undefined) {
    throw new Error("Qoder gRPC proto did not resolve model.chat.ChatService");
  }
  return grpcClientCache;
}

/** Stable per-account session id (mirrors qoderStableHash). */
function sessionIdFor(userId: string, modelId: string): string {
  return createHash("sha256").update(`qoder-session:${userId}:${modelId}`).digest("hex").slice(0, 32);
}

/** Maps one canonical message onto the proto `ChatMessage` shape. */
function mapMessage(message: CanonicalRequest["messages"][number]): Record<string, unknown> {
  const text = flattenCanonicalContent(message.content);
  const out: Record<string, unknown> = { role: message.role };
  if (text.length > 0) out.text_content = text;
  return out;
}

/** Builds the gRPC `ChatCompletionRequest` from a canonical request. */
export function buildQoderGrpcRequest(
  modelId: string,
  request: CanonicalRequest,
  userId: string,
  contextWindow = 1_000_000,
): Record<string, unknown> {
  const sessionId = sessionIdFor(userId, modelId);
  return {
    model: modelId,
    messages: request.messages.map(mapMessage),
    stream: { value: true },
    stream_options: { include_usage: { value: true } },
    max_tokens: { value: 65_536 },
    metadata: {
      context: {
        request_id: randomUUID(),
        session_id: sessionId,
        task_id: "common",
        request_set_id: randomUUID(),
        client_type: "5",
        source_session_id: "",
        context_length: String(contextWindow),
      },
      business: {
        product: "cli",
        type: "agent",
        version: "1.1.81",
        scene: "assistant",
      },
    },
  };
}

/** gRPC metadata headers mirroring the desktop client's identity headers. */
export function qoderGrpcMetadata(auth: QoderAuth): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${auth.securityOauthToken}`);
  metadata.set("x-request-id", randomUUID());
  metadata.set("x-session-id", sessionIdFor(auth.userId, ""));
  metadata.set("cosy-clienttype", "5");
  metadata.set("cosy-machineos", "aarch64_macos");
  metadata.set("cosy-machinetype", "5");
  metadata.set("cosy-machinetoken", auth.machineId);
  return metadata;
}

/** Maps a proto `finish_reason` to the canonical stop reason. */
function mapFinishReason(raw: string | undefined): CanonicalStopReason | undefined {
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "length";
    default:
      return undefined;
  }
}

/**
 * Streams one gRPC `ChatCompletionStream` call into canonical events.
 *
 * `signal` aborts the call; the gRPC status is mapped to a GatewayError when
 * the call fails before any chunk.
 */
export async function* qoderGrpcToCanonicalEvents(
  request: Record<string, unknown>,
  metadata: grpc.Metadata,
  realm: QoderRealm,
  signal: AbortSignal,
): AsyncGenerator<CanonicalEvent> {
  const ChatService = qoderGrpcClient();
  const host = qoderGrpcHost(realm);
  const client = new ChatService(`${host}:443`, grpc.credentials.createSsl());
  let sequence = 0;
  const nextSeq = () => {
    sequence += 1;
    return sequence;
  };
  try {
    const stream = client.ChatCompletionStream(request, metadata);
    let aborted = false;

    const abortHandler = () => {
      aborted = true;
      stream.cancel();
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    try {
      let echoedModel: string | undefined;
      for await (const chunk of stream) {
        if (aborted || signal.aborted) break;
        // The upstream names the model it actually ran in the chunk's `model`
        // field. Surface it once as `response_start` so probes and telemetry
        // can report the real echoed model (the gRPC surface has no HTTP body
        // for `readReportedModel` to inspect).
        if (echoedModel === undefined) {
          if (typeof chunk.model === "string" && chunk.model.trim().length > 0) {
            echoedModel = chunk.model.trim();
          }
          yield {
            type: "response_start",
            sequence_number: nextSeq(),
            ...(echoedModel === undefined ? {} : { model: echoedModel }),
          } satisfies CanonicalEvent as CanonicalEvent;
        }
        const choices = chunk.choices ?? [];
        for (const choice of choices) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: nextSeq(),
              content: { kind: "text", text: delta.content },
            };
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: nextSeq(),
              content: { kind: "reasoning", payload: delta.reasoning_content },
            };
          }
          if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
            const stop = mapFinishReason(choice.finish_reason);
            if (stop !== undefined) {
              yield {
                type: "terminal",
                sequence_number: nextSeq(),
                state: stop === "stop" ? "complete" : "failed",
                stop_reason: stop,
                provider_stop_reason: choice.finish_reason,
              };
            }
          }
        }
        if (chunk.usage) {
          const usage = usageFromProvider(chunk.usage);
          if (usage !== undefined) {
            yield { type: "usage", sequence_number: nextSeq(), usage };
          }
        }
      }
    } catch (err: any) {
      const status = err?.code;
      const details = err?.details ?? err?.message ?? "";
      if (typeof status === "number" && status !== 0) {
        if (status === 16) {
          throw new GatewayError(
            "authentication_failed",
            401,
            "Qoder gRPC rejected the credential (request {requestId}). Wrong key, right door — check the credential 🔑",
            {},
            "upstream",
          );
        }
        if (details.includes("413")) {
          throw new GatewayError(
            "context_length_exceeded",
            413,
            "The request exceeds the upstream context cap (request {requestId}). Trim the conversation and retry ✂️",
            {},
            "upstream",
          );
        }
        if (status === 13 && details.includes("quota")) {
          throw new GatewayError(
            "quota_exceeded",
            429,
            "Qoder quota exhausted on the gRPC surface (request {requestId})",
            {},
            "upstream",
          );
        }
        throw new GatewayError(
          "platform_unavailable",
          502,
          `Qoder gRPC stream failed (${details}) (request {requestId})`,
          {},
          "upstream",
        );
      }
      throw err;
    } finally {
      signal.removeEventListener("abort", abortHandler);
      stream.destroy();
    }
  } finally {
    client.close();
  }
}
