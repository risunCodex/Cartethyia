/**
 * Antigravity envelope builders for the probe: reference (minimal), current
 * adapter, and legacy adapter (baseline `0482e934`).
 *
 * - `referenceMinimalEnvelope` — a small agent envelope for raw probing.
 * - `currentAdapterEnvelope`     — the Cartethyia adapter's exact production
 *   envelope (imported from `src/.../antigravity.ts`).
 * - `legacyAdapterEnvelope`      — the adapter as it was at the baseline
 *   commit (`0482e934`): no tool-schema normalization, no forced-tool
 *   restatement, `used_claude` derived only from the id substring, and the
 *   removed `googleSearch` tool injection retained.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import { buildGeminiPayload } from "../../../src/protocol/request/gemini";
import {
  applySkipThoughtSignatureBypass,
  antigravityWireModelId,
  getAntigravityModelWireProfile,
} from "../../../src/providers/integrations/antigravity/antigravity-protocol";
import { buildAntigravityEnvelope } from "../../../src/providers/integrations/antigravity/antigravity";
import { isRecord } from "../../../src/protocol/codecs";

/** Baseline copy of the adapter's identity system instruction. */
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

/** Baseline copy of the negative signed session id formula. */
function legacySignedSessionId(seed?: string): string {
  if (seed !== undefined && /^-?\d+$/.test(seed)) return seed;
  const text = seed !== undefined && seed.length > 0 ? seed : randomUUID();
  const head = BigInt(`0x${createHash("sha256").update(text).digest("hex").slice(0, 8)}`);
  const randomPart =
    BigInt(`0x${randomBytes(8).toString("hex")}`) % BigInt("9000000000000000000");
  const combined = (head & BigInt("0x7FFFFFFFFFFFFFFF")) | randomPart;
  return `-${combined.toString()}`;
}

/** Baseline thinking budget (copy of the adapter's original table). */
function legacyThinkingBudget(modelId: string): number | undefined {
  if (!modelId.includes("claude") && !modelId.includes("gemini-3")) return undefined;
  if (modelId.endsWith("-low")) return 1_000;
  if (modelId.endsWith("-medium")) return 4_000;
  if (modelId.endsWith("-high")) return 10_000;
  return modelId.includes("3.1-pro") ? 10_001 : 10_000;
}

/**
 * Rebuilds the adapter's baseline (`0482e934`) agent envelope for a single
 * user turn. This is intentionally a faithful port of that commit so the
 * probe can exercise the OLD wire shape against the live backend.
 */
export function legacyAdapterEnvelope(
  modelId: string,
  message: string,
  projectId: string | undefined,
): Record<string, unknown> {
  const wireModelId = antigravityWireModelId(modelId);
  const request: CanonicalRequest = {
    model: modelId,
    messages: [{ role: "user", content: [{ kind: "text", text: message }] }],
    tools: [],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
  const geminiPayload = buildGeminiPayload(request);
  const profile = getAntigravityModelWireProfile(wireModelId);

  const generationConfig = isRecord(geminiPayload["generationConfig"])
    ? (geminiPayload["generationConfig"] as Record<string, unknown>)
    : {};
  if (profile) generationConfig["maxOutputTokens"] = profile.maxOutputTokens;
  const budget = legacyThinkingBudget(modelId);
  if (budget !== undefined) {
    generationConfig["thinkingConfig"] = { includeThoughts: true, thinkingBudget: budget };
  }

  const agentId = randomUUID();
  const trajectoryId = randomUUID();
  const sessionId = legacySignedSessionId(message);
  const step = 2; // baseline increments from 1 → first turn is step 2

  const labels: Record<string, string> = {
    trajectory_id: trajectoryId,
    last_step_index: "1",
    used_claude: String(modelId.includes("claude")),
    used_claude_conservative: String(modelId.includes("claude")),
  };
  if (profile?.modelEnum) labels["model_enum"] = profile.modelEnum;

  const existingContents = Array.isArray(geminiPayload["contents"])
    ? (geminiPayload["contents"] as Record<string, unknown>[])
    : [];
  const injectIdentity =
    modelId.toLowerCase().includes("claude") || modelId.toLowerCase().includes("gemini-3");
  const existingInstruction = isRecord(geminiPayload["systemInstruction"])
    ? (geminiPayload["systemInstruction"] as Record<string, unknown>)
    : undefined;
  const existingParts = Array.isArray(existingInstruction?.["parts"])
    ? (existingInstruction?.["parts"] as Record<string, unknown>[])
    : [];
  const hasIdentity = existingParts.some(
    (part) => isRecord(part) && part["text"] === ANTIGRAVITY_SYSTEM_INSTRUCTION,
  );
  const systemInstruction =
    !injectIdentity || hasIdentity
      ? existingInstruction
      : { role: "user", parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...existingParts] };

  const requestPayload: Record<string, unknown> = {
    ...geminiPayload,
    contents: existingContents,
    ...(systemInstruction === undefined ? {} : { systemInstruction }),
    labels,
    sessionId,
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
  if (modelId.includes("claude") && !isRecord(requestPayload["toolConfig"])) {
    requestPayload["toolConfig"] = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  applySkipThoughtSignatureBypass(requestPayload, modelId);

  const envelope: Record<string, unknown> = {
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    model: wireModelId,
    userAgent: "antigravity",
    requestType: "agent",
    request: requestPayload,
  };
  if (projectId) envelope["project"] = projectId;
  return envelope;
}

/** Current adapter envelope (production shape). */
export function currentAdapterEnvelope(
  modelId: string,
  message: string,
  projectId: string | undefined,
): Record<string, unknown> {
  const request: CanonicalRequest = {
    model: modelId,
    messages: [{ role: "user", content: [{ kind: "text", text: message }] }],
    tools: [],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
  return buildAntigravityEnvelope(request, projectId, antigravityWireModelId(modelId), modelId, {}, message) as Record<string, unknown>;
}

/** Minimal agent envelope (raw probe shape). */
export function referenceMinimalEnvelope(modelId: string, message: string, projectId?: string): Record<string, unknown> {
  return {
    model: modelId,
    request: {
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: {},
    },
    requestId: `probe-${Date.now()}`,
    userAgent: "antigravity",
    requestType: "agent",
    ...(projectId ? { project: projectId } : {}),
  };
}

export type EnvelopeMode = "legacy" | "current" | "minimal";

export function buildEnvelope(
  mode: EnvelopeMode,
  modelId: string,
  message: string,
  projectId: string | undefined,
): Record<string, unknown> {
  switch (mode) {
    case "legacy":
      return legacyAdapterEnvelope(modelId, message, projectId);
    case "current":
      return currentAdapterEnvelope(modelId, message, projectId);
    case "minimal":
      return referenceMinimalEnvelope(modelId, message, projectId);
  }
}
