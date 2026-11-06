/**
 * Gemini `generateContent` response decoder: candidate/parts extraction,
 * function-call parsing, usage mapping, and stop-reason mapping.
 *
 * The SSE event framing lives here too: Gemini and Antigravity both stream
 * `data:` chunks carrying one Gemini payload, and both must reject a corrupt
 * line rather than read it as a short success. They differ only in what
 * `[DONE]` means (Gemini skips it, Antigravity stops) and in the label used
 * for an error payload, so those are the two inputs.
 */
import type { CanonicalStopReason } from "../canonical-model";
import { GatewayError } from "../gateway-error";
import {
  classifyUpstreamError,
  extractUpstreamMessage,
  upstreamErrorIdentifier,
} from "../../transport/failure-policy";
import { isRecord } from "../codecs";

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function geminiCandidate(body: Record<string, unknown>): {
  readonly response: Record<string, unknown>;
  readonly candidate: Record<string, unknown>;
  readonly parts: readonly Record<string, unknown>[];
} {
  const response = isRecord(body["response"]) ? (body["response"] as Record<string, unknown>) : body;
  const candidates = response["candidates"];
  const candidate = Array.isArray(candidates) && isRecord(candidates[0]) ? (candidates[0] as Record<string, unknown>) : {};
  const content = isRecord(candidate["content"]) ? (candidate["content"] as Record<string, unknown>) : {};
  const parts = Array.isArray(content["parts"]) ? (content["parts"] as unknown[]).filter(isRecord) : [];
  return { response, candidate, parts };
}

export function responseParts(parts: readonly Record<string, unknown>[]): {
  readonly text: string;
  readonly calls: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[];
  readonly thought: string;
  readonly thoughtSignature: string;
} {
  const text: string[] = [];
  const thought: string[] = [];
  let thoughtSignature = "";
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  let callIndex = 0;
  for (const part of parts) {
    if (typeof part["text"] === "string") {
      if (part["thought"] === true) {
        thought.push(part["text"] as string);
        if (thoughtSignature.length === 0 && typeof part["thoughtSignature"] === "string") {
          thoughtSignature = part["thoughtSignature"] as string;
        }
      } else text.push(part["text"] as string);
    }
    if (isRecord(part["functionCall"]) && typeof (part["functionCall"] as Record<string, unknown>)["name"] === "string") {
      const fc = part["functionCall"] as Record<string, unknown>;
      calls.push({
        id: typeof fc["id"] === "string" ? (fc["id"] as string) : `call_${callIndex++}`,
        name: fc["name"] as string,
        args: isRecord(fc["args"]) ? (fc["args"] as Record<string, unknown>) : {},
      });
    }
  }
  return { text: text.join(""), calls, thought: thought.join(""), thoughtSignature };
}

export function mapGeminiUsage(body: Record<string, unknown>): Record<string, unknown> {
  const usage = isRecord(body["usageMetadata"]) ? (body["usageMetadata"] as Record<string, unknown>) : {};
  const prompt = nullableNumber(usage["promptTokenCount"]) ?? 0;
  const candidates = nullableNumber(usage["candidatesTokenCount"]) ?? 0;
  // Reasoning is billed output that Gemini reports in its own counter:
  // `candidatesTokenCount` excludes `thoughtsTokenCount`, so dropping it here
  // silently under-reported every thinking model's completion tokens. It is
  // surfaced through `output_tokens_details` because that is the slot
  // `normalizeUsage` reads for reasoning — keeping it separate from the
  // candidate count it is added into, so downstream can still split them.
  const thoughts = nullableNumber(usage["thoughtsTokenCount"]) ?? 0;
  const output = candidates + thoughts;
  const cached = nullableNumber(usage["cachedContentTokenCount"]) ?? 0;
  return {
    input_tokens: prompt,
    output_tokens: output,
    total_tokens: nullableNumber(usage["totalTokenCount"]) ?? prompt + output,
    cached_tokens: cached,
    ...(thoughts > 0
      ? { output_tokens_details: { reasoning_tokens: thoughts } }
      : {}),
  };
}

export function toCanonicalStopReason(candidate: Record<string, unknown>, calls: number): CanonicalStopReason {
  if (calls > 0) return "tool_use";
  if (candidate["finishReason"] === "MAX_TOKENS") return "length";
  return "stop";
}

/**
 * Decodes one SSE `data:` payload from a Gemini-family stream.
 *
 * Returns `undefined` for a line the caller should ignore: an empty payload or
 * a non-object. Throws `GatewayError("platform_unavailable", 502)` for a line
 * that cannot be trusted — a malformed JSON body or an upstream error
 * envelope. A corrupt line is a corrupt stream, never a short success, and the
 * fault is the upstream's: labelling it `invalid_request` told the client its
 * own request was malformed.
 *
 * The caller handles `[DONE]` itself, because the two Gemini-family streams
 * disagree about it: Gemini skips the marker and keeps reading, Antigravity
 * stops. Folding that into a return value would have to encode "stop the loop"
 * as data, so it stays at the call site where the loop lives.
 *
 * `errorLabel` is the fallback message for an error envelope with no string
 * `message`; each caller keeps its own so an operator can tell which upstream
 * produced the failure.
 */
export function decodeGeminiStreamEvent(
  rawData: string,
  errorLabel: string,
): Record<string, unknown> | undefined {
  const data = rawData.trim();
  if (!data) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error: unknown) {
    throw new GatewayError(
      "platform_unavailable",
      502,
      error instanceof Error ? `Malformed SSE event: ${error.message} (request {requestId}). The upstream sent something we can't read — retry 🌙` : `Malformed SSE event (request {requestId}). The upstream sent something we can't read — retry 🌙`,
      {},
      "upstream",
    );
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed["error"] !== undefined && parsed["error"] !== null) {
    const errorBody = isRecord(parsed["error"]) ? parsed["error"] : parsed;
    const identifier =
      upstreamErrorIdentifier(errorBody) ?? upstreamErrorIdentifier(parsed);
    const providerStatus = [
      errorBody["status"],
      errorBody["statusCode"],
      errorBody["code"],
    ].find(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 400 &&
        value < 600,
    );
    const classification = classifyUpstreamError(providerStatus, identifier);
    const message =
      extractUpstreamMessage(errorBody) ||
      extractUpstreamMessage(parsed) ||
      errorLabel;
    throw new GatewayError(
      classification.code,
      classification.status,
      message.slice(0, 500),
      {
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ...(identifier ? { providerCode: identifier } : {}),
        ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
        ...(classification.rateLimitScope
          ? { rateLimitScope: classification.rateLimitScope }
          : {}),
      },
      classification.origin,
    );
  }
  return parsed;
}
