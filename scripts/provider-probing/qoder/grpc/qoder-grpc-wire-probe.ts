/**
 * Dev-only: live Qoder gRPC probe with a tool declaration — using the exact
 * wire shapes from `buildQoderGrpcRequest` (the gateway's builder). The goal
 * is to isolate which part of the tools-bearing payload the upstream rejects
 * (400 stream / empty-handed), by running a matrix of variants against a real
 * account credential.
 *
 * Accounts are read from the Lite SQLite and decrypted in-process; tokens are
 * never printed.
 */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { decryptCredentialToString } from "../../../../src/security/crypto";
import { CHAT_PROTO_SOURCE } from "../../../../src/providers/integrations/qoder/chat-proto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as protoLoader from "@grpc/proto-loader";

const DB_PATH = process.argv[2] ?? "C:/Users/Aria/AppData/Roaming/cartethyia/cartethyia.sqlite";
const HOST = "api1.qoder.sh";
const MODEL = "qfmodel"; // Qwen3.8-Flash billed roster key

interface AccRow {
  label: string | null;
  credential_ciphertext: Uint8Array | null;
  auth_state: unknown;
}

function pickAccounts(): Array<{ token: string; userId: string; machineId: string; label: string }> {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .query(
      `SELECT label, credential_ciphertext, auth_state
         FROM provider_accounts
        WHERE provider_id = 'qoder' AND status = 'active'
          AND credential_ciphertext IS NOT NULL
        ORDER BY created_at ASC`,
    )
    .all() as AccRow[];
  db.close();
  const out: Array<{ token: string; userId: string; machineId: string; label: string }> = [];
  for (const row of rows) {
    const secret = decryptCredentialToString(row.credential_ciphertext!);
    const authState =
      typeof row.auth_state === "string"
        ? (JSON.parse(row.auth_state) as Record<string, unknown>)
        : ((row.auth_state as Record<string, unknown> | null) ?? {});
    const userId = typeof authState["userId"] === "string" ? (authState["userId"] as string) : "";
    const machineId =
      typeof authState["machineId"] === "string" && (authState["machineId"] as string).length > 0
        ? (authState["machineId"] as string)
        : randomUUID();
    out.push({ token: secret, userId, machineId, label: row.label ?? "" });
  }
  return out;
}

function materializeProto(): string {
  const dir = mkdtempSync(join(tmpdir(), "qoder-grpc-probe-"));
  const path = join(dir, "chat.proto");
  writeFileSync(path, CHAT_PROTO_SOURCE);
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  return path;
}

function makeClient() {
  const protoPath = materializeProto();
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    model: { chat: { ChatService: new (address: string, credentials: grpc.ChannelCredentials) => { ChatCompletionStream(req: unknown, md: grpc.Metadata): grpc.ClientDuplexStream<unknown, unknown>; close(): void } } };
  };
  return new proto.model.chat.ChatService(`${HOST}:443`, grpc.credentials.createSsl());
}

function toProtoStruct(obj: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toProtoValue(v);
  return { fields };
}

function toProtoValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: 0 };
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(toProtoValue) } };
  if (typeof value === "object") {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) fields[k] = toProtoValue(v);
    return { structValue: { fields } };
  }
  return { stringValue: String(value) };
}

function toProtoTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    const fn = (tool["function"] ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {
      type: typeof tool["type"] === "string" ? (tool["type"] as string) : "function",
      function: {
        name: typeof fn["name"] === "string" ? (fn["name"] as string) : "",
        parameters: toProtoStruct((fn["parameters"] as Record<string, unknown> | undefined) ?? { type: "object", properties: {} }),
      },
    };
    const description = out["function"] as Record<string, unknown>;
    if (typeof fn["description"] === "string" && (fn["description"] as string).length > 0) {
      description["description"] = { value: fn["description"] };
    }
    if (typeof fn["strict"] === "boolean") {
      description["strict"] = { value: fn["strict"] };
    }
    return out;
  });
}

const TOOL: Record<string, unknown> = {
  type: "function",
  function: {
    name: "kalkulator",
    description: "Menghitung hasil operasi aritmatika sederhana.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "Ekspresi aritmatika" } },
      required: ["expression"],
    },
  },
};

interface Case {
  name: string;
  build: () => Record<string, unknown>;
}

function runStream(client: { ChatCompletionStream(req: unknown, md: grpc.Metadata): grpc.ClientDuplexStream<unknown, unknown> }, request: unknown, md: grpc.Metadata, timeoutMs = 30000): Promise<{ status: grpc.StatusObject | null; chunks: number; firstContent: string; finishReason: string }> {
  return new Promise((resolve) => {
    const stream = client.ChatCompletionStream(request, md);
    let status: grpc.StatusObject | null = null;
    let chunks = 0;
    let firstContent = "";
    let finishReason = "";
    const timer = setTimeout(() => {
      try {
        stream.cancel();
      } catch {
        // ignore
      }
    }, timeoutMs);
    stream.on("status", (s: grpc.StatusObject) => {
      status = s;
    });
    stream.on("data", (chunk: Record<string, unknown>) => {
      chunks += 1;
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === "string" && firstContent === "") {
        firstContent = delta.content.slice(0, 120);
      }
      if (choices?.[0]?.finish_reason && typeof choices[0].finish_reason === "string") {
        finishReason = choices[0].finish_reason as string;
      }
    });
    stream.on("end", () => {
      clearTimeout(timer);
      resolve({ status, chunks, firstContent, finishReason });
    });
    stream.on("error", (err: unknown) => {
      clearTimeout(timer);
      if (status === null) {
        const e = err as { code?: number; details?: string };
        status = { code: e.code ?? 0, details: e.details ?? String(err), metadata: new grpc.Metadata() };
      }
      resolve({ status, chunks, firstContent, finishReason });
    });
  });
}

async function main(): Promise<void> {
  const accounts = pickAccounts();
  console.log(`accounts=${accounts.length}`);

  // First pass: find the first account whose baseline (no-tools) gRPC call
  // succeeds — that account's token is valid on this surface.
  let account: { token: string; userId: string; machineId: string; label: string } | undefined;
  let sessionId = "";
  for (const candidate of accounts) {
    const sid = createHash("sha256").update(`qoder-session:${candidate.userId}:${MODEL}`).digest("hex").slice(0, 32);
    const request = {
      model: MODEL,
      messages: [{ role: "user", text_content: "Halo, balas singkat." }],
      stream: true,
      stream_options: { include_usage: { value: true } },
      max_tokens: { value: 512 },
      metadata: {
        context: {
          request_id: randomUUID(),
          session_id: sid,
          task_id: "common",
          request_set_id: randomUUID(),
          client_type: "5",
          source_session_id: "",
          context_length: "1000000",
        },
        business: { product: "cli", type: "agent", version: "1.1.81", scene: "assistant" },
      },
    };
    const md = new grpc.Metadata();
    md.set("authorization", `Bearer ${candidate.token}`);
    md.set("x-request-id", randomUUID());
    md.set("x-session-id", sid);
    md.set("cosy-clienttype", "5");
    md.set("cosy-machineos", "aarch64_macos");
    md.set("cosy-machinetype", "5");
    md.set("cosy-machinetoken", candidate.machineId);
    const client = makeClient();
    const result = await runStream(client, request, md, 20000);
    client.close();
    const ok = result.chunks > 0 && (result.status?.code ?? 0) === 0;
    console.log(`  baseline ${candidate.label}: code=${result.status?.code ?? 0} chunks=${result.chunks} ${ok ? "VALID ✅" : "skip"}`);
    if (ok) {
      account = candidate;
      sessionId = sid;
      break;
    }
  }

  if (account === undefined) {
    console.log("\nNO VALID ACCOUNT FOUND — cannot run tools matrix");
    return;
  }

  console.log(`\nUSING ACCOUNT: ${account.label} (userId=${account.userId.slice(0, 4)}…)`);

  const baseMeta = () => {
    const md = new grpc.Metadata();
    md.set("authorization", `Bearer ${account!.token}`);
    md.set("x-request-id", randomUUID());
    md.set("x-session-id", sessionId);
    md.set("cosy-clienttype", "5");
    md.set("cosy-machineos", "aarch64_macos");
    md.set("cosy-machinetype", "5");
    md.set("cosy-machinetoken", account!.machineId);
    return md;
  };

  const cases: Case[] = [
    {
      name: "baseline (no tools)",
      build: () => ({
        model: MODEL,
        messages: [{ role: "user", text_content: "Halo, balas singkat." }],
        stream: true,
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
          business: { product: "cli", type: "agent", version: "1.1.81", scene: "assistant" },
        },
      }),
    },
    {
      name: "tools full (gateway shape)",
      build: () => ({
        model: MODEL,
        messages: [{ role: "user", text_content: "Hitung 17 * 23 pakai tool." }],
        stream: true,
        stream_options: { include_usage: { value: true } },
        max_tokens: { value: 512 },
        tools: toProtoTools([TOOL]),
        parallel_tool_calls: { value: true },
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
          business: { product: "cli", type: "agent", version: "1.1.81", scene: "assistant" },
        },
      }),
    },
    {
      name: "tools no parallel_tool_calls",
      build: () => ({
        model: MODEL,
        messages: [{ role: "user", text_content: "Hitung 17 * 23 pakai tool." }],
        stream: true,
        stream_options: { include_usage: { value: true } },
        max_tokens: { value: 512 },
        tools: toProtoTools([TOOL]),
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
          business: { product: "cli", type: "agent", version: "1.1.81", scene: "assistant" },
        },
      }),
    },
    {
      name: "tools raw params (not struct)",
      build: () => ({
        model: MODEL,
        messages: [{ role: "user", text_content: "Hitung 17 * 23 pakai tool." }],
        stream: true,
        stream_options: { include_usage: { value: true } },
        max_tokens: { value: 512 },
        tools: [
          {
            type: "function",
            function: {
              name: "kalkulator",
              description: { value: "Menghitung hasil operasi aritmatika sederhana." },
              parameters: ((TOOL["function"] as Record<string, unknown>)["parameters"] as Record<string, unknown>), // raw JSON, NOT struct-wrapped
            },
          },
        ],
        parallel_tool_calls: { value: true },
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
          business: { product: "cli", type: "agent", version: "1.1.81", scene: "assistant" },
        },
      }),
    },
    {
      name: "tools + tool_choice stringValue",
      build: () => ({
        model: MODEL,
        messages: [{ role: "user", text_content: "Hitung 17 * 23 pakai tool." }],
        stream: true,
        stream_options: { include_usage: { value: true } },
        max_tokens: { value: 512 },
        tools: toProtoTools([TOOL]),
        parallel_tool_calls: { value: true },
        tool_choice: { stringValue: "auto" },
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
          business: { product: "cli", type: "agent", version: "1.1.81", scene: "assistant" },
        },
      }),
    },
  ];

  const client = makeClient();
  for (const c of cases) {
    const request = c.build();
    const result = await runStream(client, request, baseMeta());
    const code = result.status?.code ?? 0;
    const details = result.status?.details ?? "";
    console.log(`\n=== ${c.name} ===`);
    console.log(`  status_code=${code}`);
    console.log(`  status_details=${details.slice(0, 300)}`);
    console.log(`  chunks=${result.chunks}`);
    if (result.firstContent) console.log(`  firstContent=${JSON.stringify(result.firstContent)}`);
    if (result.finishReason) console.log(`  finishReason=${result.finishReason}`);
    const ok = result.chunks > 0 && code === 0;
    console.log(`  ${ok ? "OK ✅" : "FAIL ❌"}`);
    if (ok && c.name !== "baseline (no tools)") {
      console.log("  >>> TOOLS ACCEPTED BY UPSTREAM <<<");
    }
  }
  client.close();
  console.log("\nDONE");
}

await main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
