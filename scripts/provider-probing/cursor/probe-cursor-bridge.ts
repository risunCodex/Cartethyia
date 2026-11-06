/**
 * Cursor bridge probe — drives the official `cursor-sdk-bridge` (standalone
 * binary, sdk.v1 protocol) the same way the gateway adapter should: spawn →
 * handshake → Ping/GetVersion → ListModels → CreateAgent → Send (stream) →
 * GetUsage → Shutdown. Uses the official proto contract from the bridge
 * archive (D:\tmp\binaries\cursor-sdk-bridge-win32\proto\sdk\v1\).
 *
 * Usage:
 *   bun run scripts/provider-probing/cursor/probe-cursor-bridge.ts \
 *     --creds C:\Users\Aria\Desktop\cursor-accounts-<ts>.json \
 *     [--bridge <path-to-cursor-sdk-bridge.exe>] [--workspace <dir>] \
 *     [--model composer-2] [--message "reply with OK only"] \
 *     [--cloud] [--usage] [--no-send]
 *
 * Tokens are never printed — only masked prefixes.
 */
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import protobuf from "protobufjs";
import {
  maskSecret,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";

const args = parseArgs({
  options: {
    creds: { type: "string" },
    token: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    bridge: { type: "string", default: "D:\\tmp\\binaries\\cursor-sdk-bridge-win32\\bin\\cursor-sdk-bridge.exe" },
    workspace: { type: "string", default: "D:\\tmp" },
    model: { type: "string", default: "composer-2" },
    message: { type: "string", default: "reply with OK only" },
    cloud: { type: "boolean", default: false },
    usage: { type: "boolean", default: false },
    "no-send": { type: "boolean", default: false },
    timeout: { type: "string", default: "60000" },
  },
});

const PROTO_DIR = "D:/tmp/binaries/cursor-sdk-bridge-win32/proto";

async function loadSdkRoot(): Promise<protobuf.Root> {
  const root = new protobuf.Root();
  root.resolvePath = (_origin: string, target: string) => {
    if (target.startsWith("sdk/v1/")) return `${PROTO_DIR}/${target}`;
    return target;
  };
  await root.load(`${PROTO_DIR}/sdk/v1/sdk_agent_service.proto`);
  await root.load(`${PROTO_DIR}/sdk/v1/sdk_cursor_service.proto`);
  await root.load(`${PROTO_DIR}/sdk/v1/sdk_bridge_control_service.proto`);
  return root;
}

class BridgeSession {
  readonly root: protobuf.Root;
  baseUrl = "";
  authToken = "";
  private child: ReturnType<typeof spawn> | undefined;
  private stderrBuf = "";
  private ready = false;

  constructor(root: protobuf.Root) {
    this.root = root;
  }

  spawn(binary: string, workspace: string, apiKey: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, ["--workspace", workspace], {
        env: {
          ...process.env,
          CURSOR_API_KEY: apiKey,
          CURSOR_SDK_CLIENT_LANGUAGE: "probe",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.child = child;
      const deadline = Date.now() + 30_000;
      child.stderr.on("data", (d: Buffer) => {
        this.stderrBuf += d.toString("utf8");
        const idx = this.stderrBuf.indexOf("cursor-sdk-bridge ready ");
        if (idx >= 0 && !this.ready) {
          const jsonStart = idx + "cursor-sdk-bridge ready ".length;
          const nl = this.stderrBuf.indexOf("\n", jsonStart);
          try {
            const info = JSON.parse(this.stderrBuf.slice(jsonStart, nl >= 0 ? nl : undefined)) as Record<string, unknown>;
            this.baseUrl = String(info["url"] ?? "");
            const tokenFile = String(info["authTokenFile"] ?? "");
            this.authToken = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
            this.ready = true;
            resolve();
          } catch { /* keep scanning */ }
        }
        if (!this.ready && Date.now() > deadline) {
          reject(new Error(`bridge not ready in 30s: ${this.stderrBuf.slice(0, 800)}`));
        }
      });
      child.on("exit", (code) => {
        if (!this.ready) reject(new Error(`bridge exited before ready (${code}): ${this.stderrBuf.slice(0, 800)}`));
      });
    });
  }

  /** One unary RPC with protobuf body; returns decoded message or raw error. */
  async unary<T extends Record<string, unknown>>(
    service: string,
    method: string,
    reqType: string,
    resType: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; decoded?: T; error?: string }> {
    const req = this.root.lookupType(reqType);
    const res = this.root.lookupType(resType);
    const payload = req.encode(req.fromObject(body)).finish();
    const response = await fetch(`${this.baseUrl}/sdk.v1.${service}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.authToken}`,
        "content-type": "application/proto",
        accept: "application/proto",
        "connect-protocol-version": "1",
      },
      body: payload as unknown as BodyInit,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      return { ok: false, status: response.status, error: new TextDecoder().decode(bytes).slice(0, 600) };
    }
    try {
      const decoded = res.decode(bytes) as unknown as T;
      return { ok: true, status: response.status, decoded };
    } catch (e) {
      return { ok: false, status: response.status, error: `decode failed: ${(e as Error).message}` };
    }
  }

  /** Server-streaming Send: framed connect+proto request, framed response stream. */
  async send(
    agentId: string,
    apiKey: string,
    text: string,
    opts: { enableDeltas?: boolean; enableSteps?: boolean } = {},
  ): Promise<{ events: Array<Record<string, unknown>>; error?: string }> {
    const reqType = this.root.lookupType("sdk.v1.SendRequest");
    const resType = this.root.lookupType("sdk.v1.RunStreamMessage");
    const body = {
      agentId,
      message: { text },
      options: {
        api_key: apiKey,
        enable_deltas: opts.enableDeltas ?? false,
        enable_steps: opts.enableSteps ?? false,
      },
    };
    const payload = reqType.encode(reqType.fromObject(body)).finish();
    // Connect server-streaming request framing: 1-byte flags + 4-byte length.
    const framed = new Uint8Array(5 + payload.length);
    framed[0] = 0;
    framed[1] = (payload.length >> 24) & 0xff;
    framed[2] = (payload.length >> 16) & 0xff;
    framed[3] = (payload.length >> 8) & 0xff;
    framed[4] = payload.length & 0xff;
    framed.set(payload, 5);

    const events: Array<Record<string, unknown>> = [];
    try {
      const response = await fetch(`${this.baseUrl}/sdk.v1.SdkAgentService/Send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.authToken}`,
          "content-type": "application/connect+proto",
          accept: "application/connect+proto",
          "connect-protocol-version": "1",
        },
        body: framed as unknown as BodyInit,
      });
      if (!response.ok) {
        const text = await response.text();
        return { events, error: `HTTP ${response.status}: ${text.slice(0, 400)}` };
      }
      if (!response.body) return { events, error: "no body" };
      const reader = response.body.getReader();
      let chunks: Buffer[] = [];
      let frameCount = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        const all = Buffer.concat(chunks);
        let consumed = 0;
        for (const frame of streamFramesLocal(new Uint8Array(all))) {
          consumed += 5 + frame.payload.byteLength;
          frameCount++;
          const bodyBytes = frame.flags & 1 ? gunzip(frame.payload) : frame.payload;
          if (frame.flags & 2) {
            // EndStreamResponse: JSON, maybe error
            const end = new TextDecoder().decode(bodyBytes).trim();
            if (end && end.startsWith("{")) {
              try {
                const parsed = JSON.parse(end) as { error?: unknown };
                if (parsed.error) events.push({ __endError: parsed.error });
              } catch { /* ignore */ }
            }
            continue;
          }
          try {
            const msg = resType.decode(bodyBytes) as unknown as Record<string, unknown>;
            events.push(msg);
          } catch { events.push({ __undecodable: true }); }
        }
        if (consumed) chunks.splice(0, consumed);
      }
      return { events };
    } catch (e) {
      return { events, error: (e as Error).message };
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.unary("SdkBridgeControlService", "Shutdown", "sdk.v1.ShutdownRequest", "sdk.v1.ShutdownResponse", { grace_seconds: 0 });
    } catch { /* already exiting */ }
    await new Promise((r) => setTimeout(r, 1500));
    this.child?.kill();
  }
}

// Minimal local framing helpers (same wire as the adapter's framing module).
function streamFramesLocal(buffer: Uint8Array): Generator<{ flags: number; payload: Uint8Array }, void, void> {
  return (function* () {
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const flags = buffer[offset] ?? 0;
      const len = (((buffer[offset + 1] ?? 0) << 24) | ((buffer[offset + 2] ?? 0) << 16) | ((buffer[offset + 3] ?? 0) << 8) | (buffer[offset + 4] ?? 0)) >>> 0;
      const start = offset + 5;
      if (start + len > buffer.length) break;
      yield { flags, payload: buffer.subarray(start, start + len) };
      offset = start + len;
    }
  })();
}

function gunzip(data: Uint8Array): Uint8Array {
  const { gunzipSync } = require("node:zlib") as typeof import("node:zlib");
  return gunzipSync(data);
}

function describeEvent(ev: Record<string, unknown>): string {
  if (ev["__endError"]) return `END_ERROR ${JSON.stringify(ev["__endError"]).slice(0, 200)}`;
  if (ev["__undecodable"]) return "(undecodable)";
  const sdk = (ev["sdk_message"] ?? {}) as Record<string, unknown>;
  if (typeof sdk["type"] === "string") {
    return `sdk_message type=${sdk["type"]} msg=${JSON.stringify(sdk["message"]).slice(0, 200)}`;
  }
  const result = (ev["result"] ?? {}) as Record<string, unknown>;
  if (Object.keys(result).length) {
    const rr = (result["result"] ?? {}) as Record<string, unknown>;
    return `RESULT status=${result["status"]} result="${String(rr["result"] ?? "").slice(0, 80)}" usage=${JSON.stringify(rr["usage"])}`;
  }
  if (ev["done"]) return "DONE";
  const upd = (ev["interaction_update"] ?? {}) as Record<string, unknown>;
  if (Object.keys(upd).length) return `interaction_update type=${upd["type"]} update=${JSON.stringify(upd["update"]).slice(0, 150)}`;
  const step = (ev["step"] ?? {}) as Record<string, unknown>;
  if (Object.keys(step).length) return `step type=${step["type"]}`;
  if (ev["offset"] !== undefined) return `(keepalive/empty envelope, offset=${ev["offset"]})`;
  return "(empty envelope)";
}

async function main(): Promise<void> {
  const v = args.values;
  const token = v.token?.trim() ?? "";
  let apiKey = token;
  if (!apiKey) {
    if (!v.creds) throw new Error("pass --token <jwt> or --creds <accounts.json>");
    const accounts = readAccountsFile(v.creds!);
    const account = pickAccount(accounts, {
      providerId: "cursor",
      ...(v.label !== undefined ? { label: v.label } : {}),
      ...(v.index !== undefined ? { index: Number(v.index) } : {}),
    });
    apiKey = requireAccountToken(account);
  }
  console.log(`token prefix: ${maskSecret(apiKey)}`);
  console.log(`bridge: ${v.bridge}`);

  const root = await loadSdkRoot();
  const bridge = new BridgeSession(root);
  await bridge.spawn(v.bridge!, v.workspace!, apiKey);
  console.log(`bridge url: ${bridge.baseUrl}`);

  // Ping + GetVersion
  const ping = await bridge.unary("SdkBridgeControlService", "Ping", "sdk.v1.PingRequest", "sdk.v1.PingResponse", {});
  console.log(`\nPing: ${ping.ok ? JSON.stringify(ping.decoded) : ping.error}`);
  const ver = await bridge.unary("SdkBridgeControlService", "GetVersion", "sdk.v1.GetVersionRequest", "sdk.v1.GetVersionResponse", {});
  if (ver.ok) {
    const d = ver.decoded as { bridgeVersion?: string; protocolVersion?: string; capabilities?: string[] };
    console.log(`GetVersion: bridge=${d.bridgeVersion} protocol=${d.protocolVersion} caps=${(d.capabilities ?? []).join(",")}`);
  } else {
    console.log(`GetVersion FAIL: ${ver.error}`);
  }

  // ListModels (catalog — hard-requires api_key option)
  console.log("\n=== ListModels ===");
  const models = await bridge.unary("SdkCursorService", "ListModels", "sdk.v1.ListModelsRequest", "sdk.v1.ListModelsResponse", {
    options: { api_key: apiKey },
  });
  if (models.ok) {
    const items = ((models.decoded as { items?: Array<{ id?: string; displayName?: string }> }).items ?? []);
    console.log(`${items.length} models`);
    for (const m of items.slice(0, 30)) console.log(`  ${m.id}${m.displayName ? ` (${m.displayName})` : ""}`);
  } else {
    console.log(`ListModels FAIL: ${models.error}`);
  }

  // Me
  console.log("\n=== Me ===");
  const me = await bridge.unary("SdkCursorService", "Me", "sdk.v1.MeRequest", "sdk.v1.MeResponse", {
    options: { api_key: apiKey },
  });
  if (me.ok) {
    const u = (me.decoded as { user?: Record<string, unknown> }).user ?? {};
    console.log(`user: email=${u["userEmail"] ?? ""} keyName=${u["apiKeyName"] ?? ""}`);
  } else {
    console.log(`Me FAIL: ${me.error}`);
  }

  // CreateAgent
  console.log("\n=== CreateAgent ===");
  const agentOpts: Record<string, unknown> = {
    api_key: apiKey,
    model: { id: v.model },
  };
  if (v.cloud) {
    agentOpts["cloud"] = { env: { type: 1 }, repos: [{ url: "https://github.com/cursor/sdk-bridge" }] };
  } else {
    agentOpts["local"] = { cwd: [v.workspace] };
  }
  const create = await bridge.unary("SdkAgentService", "CreateAgent", "sdk.v1.CreateAgentRequest", "sdk.v1.CreateAgentResponse", {
    options: agentOpts,
  });
  if (!create.ok) {
    console.log(`CreateAgent FAIL: ${create.error}`);
    await bridge.shutdown();
    return;
  }
  const agentId = (create.decoded as { agentId?: string }).agentId ?? "";
  console.log(`agentId: ${agentId}  model: ${JSON.stringify((create.decoded as { model?: unknown }).model)}`);

  // GetUsage (cloud only) — before/after send
  if (v.usage) {
    console.log("\n=== GetUsage (pre) ===");
    const usage = await bridge.unary("SdkAgentService", "GetUsage", "sdk.v1.GetUsageRequest", "sdk.v1.GetUsageResponse", {
      agentId,
    });
    if (usage.ok) console.log(`usage: ${JSON.stringify(usage.decoded)}`);
    else console.log(`GetUsage FAIL: ${usage.error}`);
  }

  // Send
  if (!v["no-send"]) {
    console.log(`\n=== Send (model=${v.model}, cloud=${v.cloud}) ===`);
    const { events, error } = await bridge.send(agentId, apiKey, v.message!, { enableDeltas: true, enableSteps: true });
    if (error) console.log(`Send FAIL: ${error}`);
    console.log(`${events.length} frames`);
    for (const ev of events) console.log(`  ${describeEvent(ev)}`);
    const result = events.find((e) => e["result"]);
    if (result) {
      const rr = (result["result"] as Record<string, unknown>)?.["result"] as Record<string, unknown> | undefined;
      console.log(`\nFinal: "${String(rr?.["result"] ?? "")}"`);
      console.log(`Usage: ${JSON.stringify(rr?.["usage"])}`);
    }
  }

  if (v.usage) {
    console.log("\n=== GetUsage (post) ===");
    const usage = await bridge.unary("SdkAgentService", "GetUsage", "sdk.v1.GetUsageRequest", "sdk.v1.GetUsageResponse", {
      agentId,
    });
    if (usage.ok) console.log(`usage: ${JSON.stringify(usage.decoded)}`);
    else console.log(`GetUsage FAIL: ${usage.error}`);
  }

  await bridge.shutdown();
  console.log("\nshutdown complete");
}

await main();
