/**
 * F-20: `statelessResponses` is a declared route fact, not adapter code.
 *
 * The Grok Build proxy does not persist responses: a `previous_response_id`
 * (even a real `response.id` of an earlier turn) answers 404. The adapter
 * used to delete the linkage fields in its own prePayload; the codec now
 * owns the strip once, declaratively, and a stateful route preserves the
 * fields verbatim.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import { canonicalToResponsesPayload } from "../../../src/protocol/request/responses";

function requestWithConversation(): CanonicalRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "responses",
    conversation: {
      previous_response_id: "resp_abc",
      conversation_id: "conv_1",
    },
  };
}

describe("F-20: statelessResponses strips the linkage fields once", () => {
  test("a stateful route preserves previous_response_id and conversation", () => {
    const payload = canonicalToResponsesPayload(requestWithConversation());
    expect(payload["previous_response_id"]).toBe("resp_abc");
    expect(payload["conversation"]).toBe("conv_1");
  });

  test("a stateless route strips both, declaratively", () => {
    const payload = canonicalToResponsesPayload(requestWithConversation(), {
      statelessResponses: true,
    });
    expect(payload["previous_response_id"]).toBeUndefined();
    expect(payload["conversation"]).toBeUndefined();
  });

  test("a stateless route without linkage is unchanged", () => {
    const request = requestWithConversation();
    const { conversation: _omit, ...plain } = request;
    void _omit;
    expect(
      canonicalToResponsesPayload(plain, { statelessResponses: true }),
    ).toEqual(canonicalToResponsesPayload(plain));
  });
});
