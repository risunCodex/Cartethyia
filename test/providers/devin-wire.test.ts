// Devin wire smoke test — validates the protobuf root, schema encode/decode,
// Connect framing, and credential encoding without touching the network.

import { describe, expect, test } from "bun:test";
import {
  DevinEnums,
  DevinMessageTypes,
  createDevinRoot,
  fromEnum,
} from "../../src/providers/integrations/devin/protocol/devin-proto";
import {
  CONNECT_COMPRESSED_FLAG,
  CONNECT_END_STREAM_FLAG,
  ConnectFrameDecoder,
  MAX_CONNECT_FRAME_PAYLOAD,
  decodeFrame,
  encodeFrame,
  parseTrailer,
} from "../../src/providers/integrations/devin/protocol/framing";
import {
  DEVIN_CLI_METADATA,
  DEVIN_DISCOVERY_METADATA,
  DEVIN_SUPPORTED_MODEL_DISPLAYS,
  encodeDevinCredential,
  devinCliMetadata,
  devinDiscoveryMetadata,
} from "../../src/providers/integrations/devin/devin-shared";

describe("Devin protobuf root", () => {
  test("root resolves all forward references", () => {
    expect(() => createDevinRoot().resolveAll()).not.toThrow();
    expect(DevinMessageTypes.GetChatMessageRequest).toBeDefined();
    expect(DevinMessageTypes.Metadata).toBeDefined();
    expect(DevinMessageTypes.ClientModelConfig).toBeDefined();
  });

  test("enum values match the wire", () => {
    expect(DevinEnums.ChatMessageSource.USER).toBe(1);
    expect(DevinEnums.ChatMessageSource.SYSTEM).toBe(2);
    expect(DevinEnums.ChatMessageSource.TOOL).toBe(4);
    expect(DevinEnums.ChatMessageRequestType.CASCADE).toBe(5);
    expect(DevinEnums.ConversationalPlannerMode.DEFAULT).toBe(1);
    expect(DevinEnums.StopReason.MAX_TOKENS).toBe(3);
    expect(DevinEnums.StopReason.FUNCTION_CALL).toBe(10);
    expect(DevinEnums.CacheControlType.EPHEMERAL).toBe(1);
    expect(DevinEnums.DisplayOption.MODEL_ROUTER).toBe(3);
    expect(DevinEnums.TeamsTier.DEVIN_PRO).toBe(16);
    expect(fromEnum(DevinEnums.StopReason, 3)).toBe("MAX_TOKENS");
  });

  test("Metadata round-trips with field numbers 1/3/21/28/30", () => {
    const payload = {
      ideName: "devin-cli",
      extensionVersion: "3000.11.205",
      apiKey: "devin-session-token$a.b.c",
      locale: "en",
      os: "windows",
      ideVersion: "3000.11.205",
      extensionName: "chisel",
      ideType: "chisel",
      userJwt: "jwt-value",
      supportedModelDisplays: [3, 4, 6, 7, 8],
    };
    const bytes = DevinMessageTypes.Metadata.encode(payload).finish();
    const decoded = DevinMessageTypes.Metadata.decode(bytes) as unknown as Record<string, unknown>;
    expect(decoded.ideName).toBe("devin-cli");
    expect(decoded.apiKey).toBe("devin-session-token$a.b.c");
    expect(decoded.userJwt).toBe("jwt-value");
    expect(decoded.ideType).toBe("chisel");
    expect(Array.from(decoded.supportedModelDisplays as number[])).toEqual([3, 4, 6, 7, 8]);
  });

  test("GetChatMessageRequest round-trips nested messages", () => {
    const payload = {
      metadata: { apiKey: "sk-ws-test", ideName: "devin-cli" },
      prompt: "system",
      chatMessagePrompts: [
        { messageId: "m1", source: 1, prompt: "hello" },
        { messageId: "m2", source: 4, prompt: "result", toolCallId: "call-1" },
      ],
      requestType: 5,
      plannerMode: 1,
      chatModelUid: "swe-2-flash-medium",
      cascadeId: "cascade-1",
      executionId: "exec-1",
      configuration: {
        numCompletions: 1,
        maxTokens: 64000,
        maxNewlines: 400,
        temperature: 1,
        topK: 40,
        topP: Math.fround(0.95),
      },
      tools: [{ name: "read", description: "read a file", jsonSchemaString: "{}" }],
      toolChoice: { optionName: "auto" },
      systemPromptCacheOptions: { type: 1 },
    };
    const bytes = DevinMessageTypes.GetChatMessageRequest.encode(payload).finish();
    const decoded = DevinMessageTypes.GetChatMessageRequest.decode(bytes) as unknown as Record<string, unknown>;
    expect((decoded.metadata as Record<string, unknown>).apiKey).toBe("sk-ws-test");
    expect(decoded.chatModelUid).toBe("swe-2-flash-medium");
    expect((decoded.chatMessagePrompts as unknown[]).length).toBe(2);
    expect((decoded.toolChoice as Record<string, unknown>).optionName).toBe("auto");
    expect((decoded.configuration as Record<string, unknown>).topP).toBe(Math.fround(0.95));
  });

  test("GetChatMessageResponse round-trips delta fields", () => {
    const payload = {
      messageId: "msg-1",
      deltaText: "hello",
      stopReason: 3,
      deltaThinking: "think",
      deltaSignature: "sig",
      deltaToolCalls: [{ id: "call-1", name: "read", argumentsJson: '{"path":"a"}' }],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
      creditCost: 5,
      actualModelUid: "swe-2-flash-medium",
    };
    const bytes = DevinMessageTypes.GetChatMessageResponse.encode(payload).finish();
    const decoded = DevinMessageTypes.GetChatMessageResponse.decode(bytes) as unknown as Record<string, unknown>;
    expect(decoded.deltaText).toBe("hello");
    expect(decoded.stopReason).toBe(3);
    expect(decoded.creditCost).toBe(5);
    expect((decoded.deltaToolCalls as unknown[]).length).toBe(1);
  });

  test("ExchangePKCEAuthorizationCode round-trips", () => {
    const bytes = DevinMessageTypes.ExchangePKCEAuthorizationCodeRequest.encode({
      authorizationCode: "4/0Axxx",
      codeVerifier: "verifier-xyz",
    }).finish();
    const decoded = DevinMessageTypes.ExchangePKCEAuthorizationCodeRequest.decode(bytes) as unknown as Record<string, unknown>;
    expect(decoded.authorizationCode).toBe("4/0Axxx");
    expect(decoded.codeVerifier).toBe("verifier-xyz");
  });
});

describe("Devin Connect framing", () => {
  test("uncompressed frame round-trips", () => {
    const payload = Buffer.from("hello");
    const frame = encodeFrame(payload, false);
    expect(frame[0]).toBe(0);
    expect(frame.readUInt32BE(1)).toBe(5);
    const decoded = decodeFrame(frame);
    expect(Buffer.from(decoded.payload).toString()).toBe("hello");
    expect(decoded.compressed).toBe(false);
  });

  test("large payload is compressed with flag 0x01", () => {
    const payload = Buffer.alloc(2048, 0x41);
    const frame = encodeFrame(payload, true);
    expect(frame[0]! & CONNECT_COMPRESSED_FLAG).toBe(CONNECT_COMPRESSED_FLAG);
    const decoded = decodeFrame(frame);
    expect(decoded.compressed).toBe(true);
  });

  test("end-stream flag survives decode", () => {
    const header = Buffer.alloc(5);
    header[0] = CONNECT_END_STREAM_FLAG;
    header.writeUInt32BE(2, 1);
    const frame = Buffer.concat([header, Buffer.from("{}")]);
    const decoded = decodeFrame(frame);
    expect(decoded.flags & CONNECT_END_STREAM_FLAG).toBe(CONNECT_END_STREAM_FLAG);
    expect(parseTrailer(decoded.payload)).toEqual({});
  });

  test("trailer error envelope parses", () => {
    const text = JSON.stringify({ error: { code: "invalid_argument", message: "bad request" } });
    expect(parseTrailer(Buffer.from(text))).toEqual({ error: { code: "invalid_argument", message: "bad request" } });
  });

  test("frame cap rejects oversized length prefix without buffering", () => {
    const header = Buffer.alloc(5);
    header[0] = 0;
    header.writeUInt32BE(MAX_CONNECT_FRAME_PAYLOAD + 1, 1);
    expect(() => new ConnectFrameDecoder().push(header)).toThrow();
  });

  test("incremental decoder handles split frames", () => {
    const frame = encodeFrame(Buffer.from("split"), false);
    const decoder = new ConnectFrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    const frames = decoder.push(frame.subarray(3));
    expect(frames.length).toBe(1);
    expect(Buffer.from(frames[0]!.payload).toString()).toBe("split");
    expect(decoder.hasPartial).toBe(false);
  });
});

describe("Devin credential encoding", () => {
  test("bare JWT gets devin-session-token$ prefix", () => {
    expect(encodeDevinCredential("header.payload.signature")).toBe("devin-session-token$header.payload.signature");
  });

  test("sk-ws key goes out verbatim", () => {
    expect(encodeDevinCredential("sk-ws-01-legacy")).toBe("sk-ws-01-legacy");
  });

  test("already-prefixed token is not double-prefixed", () => {
    expect(encodeDevinCredential("devin-session-token$a.b.c")).toBe("devin-session-token$a.b.c");
  });

  test("CLI metadata identity", () => {
    expect(DEVIN_CLI_METADATA.ideName).toBe("devin-cli");
    expect(DEVIN_CLI_METADATA.ideType).toBe("chisel");
    expect(DEVIN_CLI_METADATA.ideVersion).toBe("3000.11.205");
    expect(devinCliMetadata("sk-ws-test", "jwt").userJwt).toBe("jwt");
    expect(devinCliMetadata("a.b.c").apiKey).toBe("devin-session-token$a.b.c");
  });

  test("discovery metadata identity + display slots", () => {
    expect(DEVIN_DISCOVERY_METADATA.ideName).toBe("chisel");
    expect(DEVIN_DISCOVERY_METADATA.ideVersion).toBe("0.0.0-dev");
    expect(DEVIN_SUPPORTED_MODEL_DISPLAYS).toEqual([3, 4, 6, 7, 8]);
    const metadata = devinDiscoveryMetadata("sk-ws-test") as Record<string, unknown>;
    expect(metadata.supportedModelDisplays).toEqual([3, 4, 6, 7, 8]);
    expect(metadata.apiKey).toBe("sk-ws-test");
  });
});
