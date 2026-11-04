/**
 * Qoder gRPC probe helper — one client factory for both gRPC probes.
 *
 * Absorbs the duplicated proto materialization + package loading + request
 * construction that used to live in `grpc/qoder-grpc-meta.ts` and
 * `grpc/qoder-grpc-modelname.ts`. Strict TS: no `any` — the dynamically loaded
 * service is narrowed to a minimal structural interface.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { CHAT_PROTO_SOURCE } from "../../../../src/providers/integrations/qoder/chat-proto";
import { qoderGrpcHost, type QoderRealm } from "../../../../src/providers/integrations/qoder/qoder-realm";

/** The wire shape of one gRPC chat chunk (fields the probes read). */
export interface GrpcChatChunk {
  readonly model?: string;
  readonly extras?: Record<string, unknown>;
  readonly usage?: Record<string, unknown>;
  readonly choices?: readonly {
    readonly delta?: { readonly content?: string; readonly reasoning_content?: string };
  }[];
}

/** Minimal structural type for the dynamically loaded ChatService. */
interface ChatServiceLike {
  ChatCompletionStream(
    request: unknown,
    metadata?: grpc.Metadata,
  ): grpc.ClientDuplexStream<unknown, GrpcChatChunk>;
  close(): void;
}

let protoPathCache: string | undefined;

/** Materializes the embedded proto to a temp file (proto loader needs a path). */
function materializeChatProto(): string {
  if (protoPathCache !== undefined) return protoPathCache;
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-qoder-grpc-"));
  const path = join(dir, "chat.proto");
  writeFileSync(path, CHAT_PROTO_SOURCE);
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  protoPathCache = path;
  return path;
}

/** Opens a ChatService client for one realm. */
export function createChatService(realm: QoderRealm): { readonly service: ChatServiceLike; readonly host: string } {
  const protoPath = materializeChatProto();
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    model: { chat: { ChatService: new (address: string, credentials: grpc.ChannelCredentials) => ChatServiceLike } };
  };
  const host = qoderGrpcHost(realm);
  return { service: new proto.model.chat.ChatService(`${host}:443`, grpc.credentials.createSsl()), host };
}

export interface GrpcProbeResult {
  readonly answer: string;
  readonly reasoning: string;
  readonly firstModel: string | undefined;
  readonly extras: Record<string, unknown>;
  readonly usage: Record<string, unknown> | undefined;
  readonly initialMeta: Record<string, string[]>;
  readonly trailers: Record<string, string[]>;
  readonly chunks: number;
}

export interface GrpcProbeOptions {
  readonly timeoutMs?: number;
  onChunk?(chunk: GrpcChatChunk): void;
}

/** Mutable working bag used while collecting the stream (final result is readonly). */
interface GrpcProbeResultMutable {
  answer: string;
  reasoning: string;
  firstModel: string | undefined;
  extras: Record<string, unknown>;
  usage: Record<string, unknown> | undefined;
  initialMeta: Record<string, string[]>;
  trailers: Record<string, string[]>;
  chunks: number;
}

/**
 * Runs one gRPC chat stream to completion, collecting the data the meta probe
 * reports: initial metadata, trailers, chunk model echo, usage, extras, and
 * answer/reasoning text. `onChunk` runs per chunk when supplied (used by the
 * echo-only/quiet mode).
 */
export function probeChatStream(
  realm: QoderRealm,
  request: unknown,
  metadata: grpc.Metadata,
  opts: GrpcProbeOptions = {},
): Promise<GrpcProbeResult> {
  const { service } = createChatService(realm);
  const result: GrpcProbeResultMutable = {
    answer: "",
    reasoning: "",
    firstModel: undefined,
    extras: {},
    usage: undefined,
    initialMeta: {},
    trailers: {},
    chunks: 0,
  };
  const stream = service.ChatCompletionStream(request, metadata);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        stream.cancel();
      } catch {
        // stream may already be gone
      }
    }, opts.timeoutMs ?? 60_000);
    stream.on("metadata", (m: grpc.Metadata) => {
      result.initialMeta = Object.fromEntries(
        Object.entries(m.getMap()).map(([k, v]) => [k, Array.isArray(v) ? v : [String(v)]]),
      );
    });
    stream.on("status", (s: grpc.StatusObject) => {
      result.trailers = Object.fromEntries(
        Object.entries(s.metadata.getMap()).map(([k, v]) => [k, Array.isArray(v) ? v : [String(v)]]),
      );
    });
    stream.on("data", (chunk: GrpcChatChunk) => {
      result.chunks += 1;
      if (chunk.model !== undefined && result.firstModel === undefined) result.firstModel = chunk.model;
      if (chunk.extras && typeof chunk.extras === "object") Object.assign(result.extras, chunk.extras);
      if (chunk.usage) result.usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) result.answer += delta.content;
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          result.reasoning += delta.reasoning_content;
        }
      }
      opts.onChunk?.(chunk);
    });
    stream.on("end", () => {
      clearTimeout(timer);
      service.close();
      resolve(result);
    });
    stream.on("error", () => {
      clearTimeout(timer);
      service.close();
      resolve(result);
    });
  });
}
