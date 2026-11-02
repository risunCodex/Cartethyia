/**
 * Decode a captured Kiro GenerateAssistantResponse EventStream body and print a
 * structured summary of every frame: event types plus the non-text payloads
 * (metadata/stopReason, contextUsage, metering, reasoning).
 *
 * Usage:
 *   bun run scripts/provider-probing/kiro/kiro-decode-gar.ts \
 *     D:/tmp/scratch/kiro-gar-response.bin
 */
import { readFileSync } from "node:fs";
import { decodeEventStreamMessages } from "../../../src/providers/integrations/kiro/aws-event-stream";
import { KiroStreamDecoder } from "../../../src/providers/integrations/kiro/kiro-stream";

const path = process.argv[2];
if (!path) {
  console.error("usage: kiro-decode-gar.ts <captured-eventstream.bin>");
  process.exit(1);
}

const data = readFileSync(path);

const decoder = new KiroStreamDecoder();
let pending: Uint8Array = data;
let frames = 0;
const eventCounts = new Map<string, number>();
const summaryEvents: unknown[] = [];
let fullText = "";
let reasoning = "";
let stopReason: string | undefined;

for (;;) {
  const decoded = decodeEventStreamMessages(pending);
  if (decoded.failure) {
    console.error("decode failure:", decoded.failure.detail);
    break;
  }
  pending = decoded.consumed < pending.length ? pending.slice(decoded.consumed) : new Uint8Array(0);
  for (const message of decoded.messages) {
    frames += 1;
    const eventType = String(message.headers[":event-type"] ?? message.headers[":message-type"] ?? "?");
    eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);

    // Raw payload for non-text events (summary-shaped frames). The decoder
    // already returns the payload as a decoded UTF-8 string.
    const payloadText = ((message as { payload?: string | null }).payload ?? "").trim();
    if (eventType !== "assistantResponseEvent" && payloadText.length > 0) {
      summaryEvents.push({ event: eventType, payload: payloadText.slice(0, 600) });
    }

    const outcome = decoder.decode(message);
    if (outcome.failure) summaryEvents.push({ event: eventType, error: outcome.failure.message });
    if (outcome.stopReason) stopReason = outcome.stopReason;
    if (outcome.providerStopReason) stopReason = outcome.providerStopReason;
    for (const delta of outcome.deltas) {
      if (delta.kind === "text") fullText += delta.text;
      else if (delta.kind === "reasoning") reasoning += delta.text;
    }
  }
  if (pending.length === 0) break;
}

console.log(
  JSON.stringify(
    {
      frames,
      eventCounts: Object.fromEntries(eventCounts),
      stopReason,
      reasoningLength: reasoning.length,
      fullTextLength: fullText.length,
      fullTextHead: fullText.slice(0, 300),
      reasoningHead: reasoning.slice(0, 300),
      summaryEvents,
    },
    null,
    2,
  ),
);
