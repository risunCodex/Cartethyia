import type { CanonicalEvent } from "../../protocol/canonical-model";

export interface ReasoningSummaryIdentity {
  readonly itemId?: string;
  readonly outputIndex?: number;
  readonly summaryIndex?: number;
}

/** Returns the source identity of one reasoning-summary delta, if present. */
export function reasoningSummaryIdentity(
  event: CanonicalEvent,
): ReasoningSummaryIdentity | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "reasoning") return undefined;
  if (
    event.item_id === undefined &&
    event.output_index === undefined &&
    event.content.summary_index === undefined
  )
    return undefined;
  return {
    ...(event.item_id === undefined ? {} : { itemId: event.item_id }),
    ...(event.output_index === undefined ? {} : { outputIndex: event.output_index }),
    ...(event.content.summary_index === undefined
      ? {}
      : { summaryIndex: event.content.summary_index }),
  };
}

/** Whether two deltas belong to distinct source summary parts/items. */
export function reasoningSummaryHasBoundary(
  previous: ReasoningSummaryIdentity | undefined,
  current: ReasoningSummaryIdentity | undefined,
): boolean {
  if (previous === undefined || current === undefined) return false;
  return (
    (previous.itemId !== undefined &&
      current.itemId !== undefined &&
      previous.itemId !== current.itemId) ||
    (previous.outputIndex !== undefined &&
      current.outputIndex !== undefined &&
      previous.outputIndex !== current.outputIndex) ||
    previous.summaryIndex !== current.summaryIndex
  );
}

/**
 * Separates distinct summary parts without splitting a word.
 *
 * A boundary between two source items is not a boundary between two
 * sentences. Copilot streams one thought as many items, and the token that
 * ends one item is the first half of a word the next item finishes. Inserting
 * a break there painted `Gil` in the thinking pane and `iran` in the answer.
 *
 * A capital by itself is not a boundary: a sentence can continue in the next
 * item, and inserting a paragraph there makes a captured chat look split. A
 * sentence terminator or an explicit Markdown block marker is stronger
 * evidence; otherwise a capitalized continuation gets only a space.
 */
export function reasoningSummarySeparator(
  previous: ReasoningSummaryIdentity | undefined,
  current: ReasoningSummaryIdentity | undefined,
  previousText: string | undefined,
  currentText: string,
): string {
  if (!reasoningSummaryHasBoundary(previous, current)) return "";
  if (/\s$/.test(previousText ?? "") || /^\s/.test(currentText)) return "";
  if (/^[*#\-]/.test(currentText)) return "\n\n";
  const previousEndedSentence = /[.!?][)"'\]]*$/.test(previousText ?? "");
  if (previousEndedSentence && /^[A-ZÀ-ÖØ-Þ]/.test(currentText)) return "\n\n";
  if (/^[A-ZÀ-ÖØ-Þ]/.test(currentText)) return " ";
  if (previousEndedSentence) return " ";
  return "";
}
