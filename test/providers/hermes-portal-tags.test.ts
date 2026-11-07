/**
 * Hermes' portal `tags` are a required field, not optional attribution.
 *
 * Measured against the live API — the endpoint rejects a request with no `user=`
 * tag and answers 400 `missing user tag`:
 *
 *   tags=[user=u1]   → 200      tags=[a=b]   → 400 missing user tag
 *   tags=[user=]     → 200      tags=[x]     → 400 missing user tag
 *   tags=[] / absent → 400      no user tag  → 400
 *
 * The value is not validated, so this is a shape requirement. What must not
 * drift is that it is present at all: `meituan/longcat-2.5:free` answers 200
 * with only `product=` and `client=`, which is why the omission went unnoticed —
 * `upstage/solar-mini4:free` rejects the same request outright.
 *
 * The client tag tracks the released Hermes tag, which is date-based. Hermes
 * publishes no semver, so a `v0.13.0` client string names a version that never
 * existed.
 */
import { describe, expect, test } from "bun:test";
import { getHermesVersion } from "../../src/providers/operations/client-versions";
import { HERMES_MODELS, HERMES_SPEC } from "../../src/providers/integrations/hermes";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const REQUEST: CanonicalRequest = {
  model: "upstage/solar-mini4:free",
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  generation_controls: {},
  stream: false,
  source_surface: "chat",
};

const TARGET: ProviderDispatchTarget = {
  provider_id: "hermes",
  model_id: "upstage/solar-mini4:free",
  wire_family: "chat",
  endpoint_path: "/v1/chat/completions",
  capabilities: {},
};

function tagsFor(payload: Record<string, unknown> = {}): readonly string[] {
  HERMES_SPEC.prePayload?.(payload, REQUEST, TARGET);
  const tags = payload["tags"];
  if (!Array.isArray(tags)) throw new Error("prePayload did not write tags");
  return tags as readonly string[];
}

describe("hermes portal tags", () => {
  test("a user tag is always present", () => {
    // The one requirement the endpoint actually enforces.
    expect(tagsFor().some((tag) => tag.startsWith("user="))).toBe(true);
  });

  test("the user tag is not a fabricated end-user identity", () => {
    // The value is unvalidated, so anything passes — which is exactly why a
    // made-up name would ship unnoticed. It names the client instead.
    const user = tagsFor().find((tag) => tag.startsWith("user="));
    expect(user).toBe("user=hermes-agent");
  });

  test("the client tag names a Hermes release that exists", () => {
    // Hermes DOES publish a semver: the GitHub release tag is `v0.22.2`. The
    // previous assertion pinned `v2026.9.24` — a date *tag*, not a release —
    // and justified it with a comment claiming Hermes had no semver, which the
    // releases endpoint contradicts.
    //
    // The expected value is read from the resolver rather than restated, so the
    // tag follows the release instead of rotting when it is bumped.
    const client = tagsFor().find((tag) => tag.startsWith("client="));
    expect(client).toBe(`client=hermes-client-v${getHermesVersion()}`);
    expect(getHermesVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the dispatch User-Agent names the Hermes client, not the gateway", () => {
    // Cloudflare in front of the origin answers a request with no `user-agent`
    // with 403 "Attention Required!" and any non-empty UA with 200, so the
    // header is not cosmetic — and it should identify Hermes, not the gateway.
    expect(HERMES_SPEC.extra_headers?.["user-agent"]).toBe(`hermes-agent/${getHermesVersion()}`);
    expect(HERMES_SPEC.extra_headers?.["user-agent"]).not.toContain("Cartethyia");
  });

  test("prePayload replaces tags rather than appending to them", () => {
    // A caller-supplied tag must not survive alongside the required set, or the
    // payload would carry two identities.
    const tags = tagsFor({ tags: ["user=someone-else"] });
    expect(tags.filter((tag) => tag.startsWith("user="))).toEqual(["user=hermes-agent"]);
  });

  test("the static roster is the live free set", () => {
    // `meituan/longcat-2.0:free` answered 404 "This model is no longer free",
    // so it is not here; its successor is.
    //
    // `stepfun/step-5-preview:free` is gone too: absent from the live catalog
    // and 404 "This model's free period has ended" when dispatched, so it was
    // a card that could only ever fail.
    //
    // `meituan/longcat-2.5-preview:free` was retired in favor of
    // `meituan/longcat-2.5:free`; `ornith/ornith-1.5-122b:free` was dropped.
    const ids = HERMES_MODELS.map((m) => m.modelId).sort();
    expect(ids).toEqual([
      "meituan/longcat-2.5:free",
      "reflection/beam-1.0-501b-a23b:free",
      "upstage/solar-mini4:free",
    ]);
  });

  test("vision matches what the live catalog declares", () => {
    // Read from `architecture.input_modalities` on a live read. This was wrong
    // for `meituan/longcat-2.5:free`, published without vision it has —
    // which strips images from a request the model accepts.
    const vision = new Set([
      "meituan/longcat-2.5:free",
    ]);
    for (const model of HERMES_MODELS) {
      expect(model.modalities.input.includes("image")).toBe(vision.has(model.modelId));
    }
  });
});
