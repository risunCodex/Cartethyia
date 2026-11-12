/**
 * The three conversation headers that a chat request cannot omit.
 *
 * `x-conversation-id` used to be sent only when the caller supplied one. That
 * was wrong: it is mandatory, and a chat request without it is refused with
 * `400 · 11-128 "request illegal"` — an error that names neither the header nor
 * the channel, so it reads like a block rather than a missing field. It was
 * also invisible in testing, because a request that carries a session id
 * (every real client does) never hits it.
 *
 * Isolated against the live API by removing one header at a time. Only these
 * three are required; the B3/W3C trace set, the stainless set, the agent block
 * and the IDE block all still answer 200 when dropped:
 *
 *   x-conversation-id            required
 *   x-conversation-request-id    required
 *   x-conversation-message-id    required
 *   everything else              optional
 *
 * The requirement is turn-shaped, not id-shaped: an empty `x-conversation-id`
 * is still refused, so the fix is to send one, not to send the caller's.
 */
import { describe, expect, test } from "bun:test";
import { buddyConversationHeaders } from "../../src/providers/integrations/buddy/headers";

const REQUIRED = [
  "x-conversation-id",
  "x-conversation-request-id",
  "x-conversation-message-id",
] as const;

describe("buddy conversation headers", () => {
  test("all three required headers are present with no caller ids", () => {
    // The regression: with no conversationId supplied, none of these went out.
    const headers = buddyConversationHeaders();
    for (const name of REQUIRED) {
      expect(headers[name]).toBeTruthy();
    }
  });

  test("they are present when the caller supplies a conversation id too", () => {
    const headers = buddyConversationHeaders({ conversationId: "conv-from-caller" });
    for (const name of REQUIRED) {
      expect(headers[name]).toBeTruthy();
    }
    // A caller's own id is honoured rather than replaced.
    expect(headers["x-conversation-id"]).toBe("conv-from-caller");
  });

  test("a blank caller id does not blank the header", () => {
    // An empty value is refused by the upstream just like an absent one, so a
    // whitespace id must fall back instead of being forwarded.
    const headers = buddyConversationHeaders({ conversationId: "   " });
    expect(headers["x-conversation-id"]?.trim().length).toBeGreaterThan(0);
  });

  test("the request id stays conversation-scoped and the message id per message", () => {
    const headers = buddyConversationHeaders();
    expect(headers["x-root-request-id"]).toBe(headers["x-conversation-request-id"]);
    expect(headers["x-request-id"]).toBe(headers["x-conversation-message-id"]);
    // Turn-scoped and message-scoped are different by construction.
    expect(headers["x-conversation-request-id"]).not.toBe(headers["x-conversation-message-id"]);
  });

  test("the uuid style dashes the message ids but keeps the turn key and B3 hex", () => {
    // WorkBuddy desktop emits dashed-UUID message/request ids; the turn
    // aggregation key and the B3/W3C trace ids stay 32/16 hex.
    const headers = buddyConversationHeaders({ messageIdStyle: "uuid" });
    expect(headers["x-conversation-message-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(headers["x-request-id"]).toBe(headers["x-conversation-message-id"]);
    expect(headers["x-conversation-request-id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["x-root-request-id"]).toBe(headers["x-conversation-request-id"]);
    expect(headers["x-b3-traceid"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["x-b3-spanid"]).toMatch(/^[0-9a-f]{16}$/);
    expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  test("b3 trace ids stay hex even when the caller id is not", () => {
    // The upstream correlates on B3; an inbound id with dashes would break it.
    const headers = buddyConversationHeaders({ conversationId: "not-a-hex-id-with-dashes" });
    expect(headers["x-b3-traceid"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["x-b3-spanid"]).toMatch(/^[0-9a-f]{16}$/);
  });
});
