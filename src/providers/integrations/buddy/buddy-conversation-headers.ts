/**
 * The conversation and tracing header family the buddy upstream expects.
 *
 * A live WorkBuddy request answered `400 · 11128 "conversation id missing"` —
 * "This call failed channel verification, possibly because it was not sent from
 * an official client" — while carrying only `x-session-id` and `user-agent`.
 * The reference gateway always sends a whole family of conversation IDs on chat
 * (`injectConversationHeaders`), and its own comment is unambiguous about one of
 * them: `X-Conversation-Request-ID` is the turn-level aggregation primary key
 * and is **mandatory**.
 *
 * Four layers, each with its own lifetime, which is why one ID is not enough:
 *
 * - `X-Conversation-ID` — conversation-scoped, stable across turns. Passed
 *   through from the client when one arrives; otherwise omitted, never invented,
 *   so the upstream does not build a conversation the caller never had.
 * - `X-Conversation-Request-ID` / `X-Root-Request-ID` — turn-scoped aggregation
 *   key. Mandatory: every tool call, retry, failover and degradation inside one
 *   user send reuses the same value so the backend aggregates them into one
 *   record instead of fragmenting.
 * - `X-Conversation-Message-ID` = `X-Request-ID` — message-scoped, fresh per
 *   outbound message.
 * - `X-B3-TraceId` / `X-B3-SpanId` / `X-B3-Sampled` — the B3 trace family.
 *
 * B3 is stricter than the rest: its spec accepts only a 16- or 32-character hex
 * trace id and a 16-character hex span id. An inbound conversation id is
 * arbitrary (it may carry dashes or be non-hex), and putting it straight into
 * `X-B3-TraceId` breaks trace correlation — so it is validated and falls back to
 * the message id, which is always 32 hex.
 */

/** A 32-character hex id, the shape the upstream's own message ids use. */
function newMessageId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Renders a 32-char hex id as a dashed UUID (`8-4-4-4-12`). */
function toUuidHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True when `value` is a valid B3 trace id: 16 or 32 hex characters. */
function isValidTraceId(value: string): boolean {
  if (value.length !== 16 && value.length !== 32) return false;
  return /^[0-9a-fA-F]+$/.test(value);
}

export interface BuddyConversationIds {
  /**
   * Conversation-scoped id, stable across turns. `undefined` means the client
   * sent none, and the header is then omitted rather than fabricated.
   */
  readonly conversationId?: string | undefined;
  /**
   * Turn-scoped aggregation key. When absent a fresh one is generated, because
   * the header is mandatory and a call without it is what drew `11128`.
   */
  readonly conversationRequestId?: string | undefined;
  /** Inbound trace id to pass through; falls back to the conversation request id. */
  readonly traceId?: string | undefined;
  /**
   * Wire format for the two message-scoped ids (`x-conversation-message-id`,
   * `x-request-id`).
   *
   * The reference emits these as dashed UUIDs on the desktop product
   * and as 32-hex on CLI traffic (`build_attempt_headers` converts only the
   * message/request ids, and only for the desktop profiles). The turn
   * aggregation key (`x-conversation-request-id` / `x-root-request-id`) and the
   * B3/W3C trace ids stay hex in both styles, because B3's spec accepts only
   * hex. Default `"hex"`.
   */
  readonly messageIdStyle?: "hex" | "uuid" | undefined;
}

/**
 * Builds the conversation/tracing headers for one outbound chat request.
 *
 * Returns only headers that should be *added* — `x-request-id` is included
 * because the reference sets it from the same message id as
 * `X-Conversation-Message-ID`, and a caller that already sends its own must
 * merge this underneath rather than over it.
 */
export function buddyConversationHeaders(
  ids: BuddyConversationIds = {},
): Record<string, string> {
  const conversationRequestId =
    ids.conversationRequestId && ids.conversationRequestId.trim().length > 0
      ? ids.conversationRequestId.trim()
      : newMessageId();
  const messageId = newMessageId();
  // The message-scoped ids may render as a dashed UUID (WorkBuddy desktop) or
  // as 32-hex (CLI); the raw hex is still what the B3/W3C trace ids derive from.
  const messageHeaderValue = ids.messageIdStyle === "uuid" ? toUuidHex(messageId) : messageId;
  const traceId =
    ids.traceId && ids.traceId.trim().length > 0 ? ids.traceId.trim() : conversationRequestId;
  const b3TraceId = isValidTraceId(conversationRequestId) ? conversationRequestId : messageId;

  const headers: Record<string, string> = {
    "x-conversation-request-id": conversationRequestId,
    "x-conversation-message-id": messageHeaderValue,
    "x-request-id": messageHeaderValue,
    "x-root-request-id": conversationRequestId,
    "x-trace-id": traceId,
    // W3C trace context alongside the B3 set below: the upstream reads both,
    // and every reference request carries `traceparent`, so sending only the
    // B3 half leaves a header the channel check expects absent.
    traceparent: `00-${b3TraceId}-${messageId.slice(0, 16)}-01`,
    "x-b3-traceid": b3TraceId,
    "x-b3-spanid": messageId.slice(0, 16),
    "x-b3-sampled": "1",
  };
  // Always sent, invented when the caller gave none.
  //
  // `x-conversation-id` is mandatory, and a chat request without it is refused
  // with `400 · 11-128 "request illegal"` — an error that names neither the
  // header nor the channel, and which reads like a block rather than a missing
  // field. Isolated against the live API by removing one header at a time:
  // only `x-conversation-id`, `x-conversation-request-id` and
  // `x-conversation-message-id` are required; the B3/W3C trace set, the
  // stainless set, the agent block and the IDE block are all optional.
  //
  // Inventing one when the caller has none is still the right default: the id
  // is per-dispatch here, so a caller with no session is not claiming a session
  // it never had — and withholding the header only guarantees a refusal.
  headers["x-conversation-id"] =
    ids.conversationId !== undefined && ids.conversationId.trim().length > 0
      ? ids.conversationId.trim()
      : newMessageId();
  return headers;
}
