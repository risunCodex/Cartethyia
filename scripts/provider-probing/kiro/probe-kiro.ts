/**
 * Live Kiro wire probe: management (models) + runtime (generation).
 *
 * Reads exported accounts from a JSON file (same shape the console writes),
 * never prints tokens, and shows only status + first bytes of each upstream
 * response. Two surfaces:
 *
 *   - management: `GET https://management.{region}.kiro.dev/List-Available-Models`
 *     (`KiroControlPlaneBearerService.ListAvailableModels`) — the 1.4.62
 *     model-catalog surface.
 *   - runtime: `POST https://runtime.{region}.kiro.dev/generateAssistantResponse`
 *     (`KiroRuntimeService.GenerateAssistantResponse`) — the generation surface,
 *     answered as an AWS EventStream frame sequence. The probe decodes the
 *     stream with the adapter's own decoder so the event types / token
 *     accounting seen here are the ones the gateway will see.
 *
 * Usage:
 *   bun run scripts/provider-probing/kiro/probe-kiro.ts \
 *     --creds "C:\path\to\kiro-accounts-<ts>.json"
 *
 *   # List models only:
 *   bun run scripts/provider-probing/kiro/probe-kiro.ts --creds <file> --models
 *
 *   # Probe a specific model (default: auto):
 *   bun run scripts/provider-probing/kiro/probe-kiro.ts --creds <file> --model auto
 *
 *   # Save the model list to a file:
 *   bun run scripts/provider-probing/kiro/probe-kiro.ts --creds <file> --models --out models.json
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  maskSecret,
  maskUuid,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
  type ExportedAccount,
} from "../lib/accounts";
import { formatProbe, probeGet } from "../lib/http";
import { decodeEventStreamMessages } from "../../../src/providers/integrations/kiro/aws-event-stream";
import { KiroStreamDecoder } from "../../../src/providers/integrations/kiro/kiro-stream";
import { buildKiroWireRequest } from "../../../src/providers/integrations/kiro/kiro-request";

const VERSION = "1.4.62";
const SDK = "1.0.44";

/** authMethod → TokenType header, mirroring the 1.4.62 client (`qje` map). */
const TOKEN_TYPE: Record<string, string> = {
  api_key: "API_KEY",
  external_idp: "EXTERNAL_IDP",
  idc: "SSO_OIDC",
};

/** Family default profile ARNs, mirroring the bundle (`J8a` map). */
const DEFAULT_PROFILE_ARNS: Record<string, string> = {
  "builder-id": "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
  social: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
};

interface KiroAuth {
  readonly accessToken: string;
  readonly authMethod: string;
  readonly region: string;
  readonly machineId: string;
  readonly profileArn: string;
}

function authFromAccount(account: ExportedAccount): KiroAuth {
  const authState = account.authState as Record<string, unknown> | null | undefined;
  const authMethod = typeof authState?.authMethod === "string" ? authState.authMethod : "api_key";
  const region = typeof authState?.region === "string" ? authState.region : "us-east-1";
  const machineId =
    typeof authState?.machineId === "string" && authState.machineId.length > 0
      ? authState.machineId
      : randomUUID();
  // A stored profileArn wins; otherwise use the family default (the management
  // surface answers 400 "Invalid profileArn." when the field is absent or
  // malformed). Verified live: Builder-ID default ARN works against
  // ListAvailableModels.
  const storedProfileArn = typeof authState?.profileArn === "string" ? authState.profileArn.trim() : "";
  const profileArn =
    storedProfileArn.length > 0
      ? storedProfileArn
      : DEFAULT_PROFILE_ARNS[authMethod] ?? DEFAULT_PROFILE_ARNS.social!;
  return {
    accessToken: requireAccountToken(account),
    authMethod,
    region,
    machineId,
    profileArn,
  };
}

function baseHeaders(auth: KiroAuth): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.accessToken}`,
    connection: "close",
    "amz-sdk-request": "attempt=1; max=1",
    "amz-sdk-invocation-id": randomUUID(),
    "x-kiro-machineid": auth.machineId,
    "user-agent": `aws-sdk-js/${SDK} ua/2.1 os/win32#10.0.22631 md/nodejs#24.18.0 KiroIDE-${VERSION}-${auth.machineId}`,
    "x-amz-user-agent": `aws-sdk-js/${SDK} KiroIDE-${VERSION}-${auth.machineId}`,
  };
  const tokenType = TOKEN_TYPE[auth.authMethod];
  if (tokenType !== undefined) headers["TokenType"] = tokenType;
  return headers;
}

/**
 * Management (control-plane) headers — exactly the `BY` client shape.
 *
 * The client sends a Smithy `x-amz-user-agent` (token-pair form) and addresses
 * the operation with `x-amz-target` + `application/x-amz-json-1.0`. It does
 * NOT send the runtime-only `x-amzn-kiro-agent-mode` header here, nor does it
 * need `accept: application/json` (awsJson serialization ignores it).
 */
function managementHeaders(auth: KiroAuth, operation: string): Record<string, string> {
  return {
    ...baseHeaders(auth),
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": `KiroControlPlaneBearerService.${operation}`,
  };
}

/**
 * Runtime (generation) headers — exactly the `KiroRuntimeService` client shape.
 *
 * For a request the client additionally sends `x-amzn-kiro-agent-mode`,
 * `x-amzn-codewhisperer-optout`, `x-amzn-kiro-profile-arn` (when a profile is
 * resolved), and `accept: application/vnd.amazon.eventstream`.
 */
function runtimeHeaders(auth: KiroAuth): Record<string, string> {
  const headers: Record<string, string> = {
    ...baseHeaders(auth),
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": "KiroRuntimeService.GenerateAssistantResponse",
    accept: "application/vnd.amazon.eventstream",
    "x-amzn-kiro-agent-mode": "vibe",
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-request": "attempt=1; max=3",
  };
  if (auth.profileArn.length > 0) headers["x-amzn-kiro-profile-arn"] = auth.profileArn;
  return headers;
}

async function listModels(auth: KiroAuth, opts: { readonly out?: string } = {}): Promise<readonly string[] | null> {
  const query = new URLSearchParams({ origin: "AI_EDITOR" });
  if (auth.profileArn.length > 0) query.set("profileArn", auth.profileArn);
  const url = `https://management.${auth.region}.kiro.dev/List-Available-Models?${query.toString()}`;
  const res = await probeGet(url, managementHeaders(auth, "ListAvailableModels"), { bodyCap: 200_000 });
  console.log(formatProbe("management/List-Available-Models", res));
  try {
    const parsed = JSON.parse(res.body) as { models?: Array<Record<string, unknown>>; nextToken?: unknown; defaultModel?: unknown; error?: unknown };
    const models = parsed.models;
    if (opts.out !== undefined && Array.isArray(models)) {
      writeFileSync(opts.out, `${JSON.stringify(models, null, 2)}\n`, "utf8");
      console.log(`  wrote ${opts.out} (${models.length} models)`);
    }
    if (Array.isArray(models)) {
      const ids: string[] = [];
      for (const m of models) {
        const id = String(m.modelId ?? m.id ?? "?");
        if (id !== "?") ids.push(id);
        const limits = m.tokenLimits as Record<string, unknown> | undefined;
        const ctx = limits?.maxInputTokens !== undefined ? ` ctx=${String(limits.maxInputTokens)}` : "";
        const out = limits?.maxOutputTokens !== undefined ? ` out=${String(limits.maxOutputTokens)}` : "";
        console.log(`  - ${id}${ctx}${out} provider=${String(m.modelProvider ?? "?")}`);
      }
      console.log(`  defaultModel=${JSON.stringify(parsed.defaultModel ?? null)}`);
      return ids.length > 0 ? ids : null;
    } else if (parsed.error !== undefined) {
      console.log(`  error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
      return null;
    } else {
      console.log(`  (unexpected shape: ${res.head.slice(0, 160)})`);
      return null;
    }
  } catch {
    // Body is not JSON; the head already shows what came back.
    return null;
  }
}

async function probeGeneration(auth: KiroAuth, model: string): Promise<void> {
  const url = `https://runtime.${auth.region}.kiro.dev/generateAssistantResponse`;
  const built = buildKiroWireRequest(
    {
      model,
      stream: true,
      source_surface: "chat",
      messages: [{ role: "user", content: [{ kind: "text", text: "ping" }] }],
      generation_controls: {},
    },
    { conversationId: randomUUID(), modelId: model, profileArn: auth.profileArn },
  );
  if (!built.ok) {
    console.log(`[runtime (${model})] body build failed: ${JSON.stringify(built.error.problems)}`);
    return;
  }
  const body = JSON.stringify({ ...built.value.payload, agentMode: "vibe" });
  const headers: Record<string, string> = runtimeHeaders(auth);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
    console.log(`[runtime (${model})] status=${response.status}`);
    if (!response.ok) {
      const text = await response.text();
      console.log(`  (error body) ${text.slice(0, 600)}`);
      return;
    }
    if (!response.body) {
      console.log("  (empty body)");
      return;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/vnd.amazon.eventstream")) {
      const text = await response.text();
      console.log(`  content-type=${contentType}`);
      console.log(`  (non-eventstream body) ${text.slice(0, 600)}`);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new KiroStreamDecoder();
    let pending = new Uint8Array(0);
    let frames = 0;
    let text = "";
    let reasoning = "";
    let stopReason: string | undefined;
    let failure: string | undefined;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value && value.byteLength > 0) {
          const next = new Uint8Array(pending.length + value.byteLength);
          next.set(pending);
          next.set(value, pending.length);
          pending = next;
        }
        const decoded = decodeEventStreamMessages(pending);
        if (decoded.failure) {
          failure = decoded.failure.detail;
          break;
        }
        if (decoded.consumed < pending.length) pending = pending.slice(decoded.consumed);
        else pending = new Uint8Array(0);
        for (const message of decoded.messages) {
          frames += 1;
          const eventType = message.headers[":event-type"] ?? message.headers[":message-type"] ?? "?";
          const outcome = decoder.decode(message);
          if (outcome.failure) failure = outcome.failure.message;
          if (outcome.stopReason) stopReason = outcome.stopReason;
          if (outcome.providerStopReason) stopReason = outcome.providerStopReason;
          for (const delta of outcome.deltas) {
            if (delta.kind === "text") text += delta.text;
            else if (delta.kind === "reasoning") reasoning += delta.text;
          }
          process.stdout.write(`    [${eventType}]`);
        }
        if (done) break;
      }
      process.stdout.write("\n");
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    for (const delta of decoder.flush()) {
      if (delta.kind === "text") text += delta.text;
      else if (delta.kind === "reasoning") reasoning += delta.text;
    }
    if (reasoning.length > 0) console.log(`  reasoning: ${reasoning.slice(0, 500)}`);
    console.log(`  text: ${text.slice(0, 1200) || "(no text)"}`);
    console.log(`  frames: ${frames} stop=${stopReason ?? "?"} failure=${failure ?? "none"}`);
  } catch (error) {
    console.log(`  ERROR ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "auto" },
    all: { type: "boolean", default: false },
    models: { type: "boolean", default: false },
    out: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    timeout: { type: "string", default: "30000" },
  },
});

const credsPath = values.creds;
if (credsPath === undefined) throw new Error("--creds <path> is required");

const accounts = readAccountsFile(credsPath);
const account = pickAccount(accounts, {
  providerId: "kiro",
  ...(values.label !== undefined ? { label: values.label } : {}),
  ...(values.index !== undefined ? { index: Number(values.index) } : {}),
});
const auth = authFromAccount(account);

console.log(
  `account=${account.label ?? "?"} (${account.providerId ?? "?"}/${account.credentialKind ?? "?"}) ` +
    `token=${maskSecret(auth.accessToken)} region=${auth.region} authMethod=${auth.authMethod} ` +
    `machineId=${maskUuid(auth.machineId)}`,
);

if (values.models) {
  try {
    await listModels(auth, { ...(values.out !== undefined ? { out: values.out } : {}) });
  } catch (error) {
    console.log(`[models] ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(0);
}

let models: readonly string[];
if (values.all) {
  const live = await listModels(auth).catch(() => null);
  models = live && live.length > 0 ? live : ["auto"];
  if (live === null || live.length === 0) {
    console.log("[--all] live model list unavailable — falling back to [auto]");
  }
} else {
  models = [values.model as string];
}
for (const model of models) {
  try {
    await probeGeneration(auth, model);
  } catch (error) {
    console.log(`[model ${model}] ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}
