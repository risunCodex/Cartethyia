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
