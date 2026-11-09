/** The reasoning-shaped part this reads. Structural, so any reasoning part —
 *  including a `ContentPart` narrowed to `kind: "reasoning"` — is accepted. */
interface ReasoningTextSource {
  readonly payload?: unknown;
  readonly summary?: string;
  readonly opaque?: boolean;
}

/**
 * The one reader for visible reasoning text.
 *
 * A reasoning part carries two distinct fields: `payload` (the readable
 * reasoning stream — Responses `reasoning_text`, Chat `reasoning_content`) and
 * `summary` (Responses `reasoning_summary_text`, a digest of the same thought).
 * Two call sites used to read them in opposite orders, so a part that populates
 * both rendered different text per surface — and a part that populated both
 * with the *same* string was emitted twice by surfaces that read each field.
 *
 * Precedence is `payload` → `summary`: `payload` is the stream, `summary` is a
 * digest of it, and when only one is present it is the one to show. Opaque
 * parts (redacted thinking, encrypted reasoning) have no readable text at all.
 */
export function reasoningTextOf(part: ReasoningTextSource): string | undefined {
  if (part.opaque === true) return undefined;
  const payload = part.payload;
  if (typeof payload === "string" && payload.length > 0) return payload;
  const summary = part.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  return undefined;
}

/**
 * The one reader for reasoning text replayed to upstream providers.
 *
 * Request builders echo the previous turn's reasoning back to a provider, and
 * they deliberately prefer `summary` (the digest) ahead of `payload` (the
 * stream) — the opposite of `reasoningTextOf`, which is for display. Returning
 * `undefined` when neither field is a string lets each call site keep its exact
 * fallback ("" for the chat/messages/gemini builders, the raw payload for
 * Qoder's echo), so upstream-visible bytes do not change. Opaque parts are not
 * special-cased here: the replay readers never consulted `opaque` either.
 */
export function reasoningTextForReplay(part: ReasoningTextSource): string | undefined {
  const summary = part.summary;
  if (typeof summary === "string") return summary;
  const payload = part.payload;
  if (typeof payload === "string") return payload;
  return undefined;
}
