/**
 * A declared input modality must win over the codec's rich-content grant.
 *
 * `buildCapabilityProfile` used to compute `image: inputMods.includes("image") || codecEncodesRichContent`,
 * which made the grant an *override*: every row on a canonical-codec provider
 * claimed image support even when the catalog declared `["text"]`. A
 * canonical-codec provider with no bespoke wire is that case — the grant
 * fired, and an image was forwarded to an upstream that rejects it. The catalog's own `is_vl: false`
 * never mattered.
 *
 * `defineModel` always seeds `"text"`, so a non-empty array is an explicit
 * declaration and its contents are authoritative; an empty array is a row that
 * carried no modality metadata, which is the pass-through case the grant
 * exists to protect. Both directions are pinned here.
 */
import { describe, expect, test } from "bun:test";
import {
  buildCapabilityProfile,
} from "../../src/transport/routing/route-catalog-helpers";

/** A canonical-codec provider with no bespoke wire. */
const OPENAI = "openai";
/** A bespoke-wire provider, for which the grant never fires at all. */
const KIRO = "kiro";

describe("buildCapabilityProfile input modalities", () => {
  test("a declared text-only row is not image-capable", () => {
    const profile = buildCapabilityProfile({
      modalities: { input: ["text"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      providerId: OPENAI,
    });
    expect(profile.image).toBe(false);
    expect(profile.document).toBe(false);
    expect(profile.audio).toBe(false);
  });

  test("a declared image row is image-capable", () => {
    const profile = buildCapabilityProfile({
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      providerId: OPENAI,
    });
    expect(profile.image).toBe(true);
  });

  test("a declared document row keeps document and drops the rest", () => {
    const profile = buildCapabilityProfile({
      modalities: { input: ["text", "document"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      providerId: OPENAI,
    });
    expect(profile.document).toBe(true);
    expect(profile.image).toBe(false);
    expect(profile.audio).toBe(false);
  });

  test("a row with no modality metadata keeps the codec grant", () => {
    // Discovered and legacy rows: absent metadata must not degrade a caller's
    // attachment to text on the strength of a guess.
    const profile = buildCapabilityProfile({
      modalities: { input: [], output: [] },
      reasoning: false,
      toolCall: false,
      providerId: OPENAI,
    });
    expect(profile.image).toBe(true);
    expect(profile.document).toBe(true);
    expect(profile.audio).toBe(true);
  });

  test("a bespoke-wire provider declares no codec modalities either way", () => {
    const declared = buildCapabilityProfile({
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      providerId: KIRO,
    });
    const undeclared = buildCapabilityProfile({
      modalities: { input: [], output: [] },
      reasoning: false,
      toolCall: false,
      providerId: KIRO,
    });
    expect(declared.bespokeWire).toBe(true);
    expect(undeclared.bespokeWire).toBe(true);
    expect(undeclared.image).toBe(false);
    expect(declared.image).toBe(true);
  });
});

/**
 * Capability-profile memo: the rebuild must see the *current* modalities.
 *
 * The memo key is `providerId/modelId` **plus the serialized modalities**, so
 * an operator editing a row's modalities (text-only → vision) produces a new
 * key and a fresh profile on the next snapshot rebuild. Before the key carried
 * modalities, the rebuild answered from the stale pre-edit profile until the
 * entry aged out of the LRU — routing stripped images from a model that had
 * just gained image support.
 *
 * The cache itself is a `BoundedLruMap` at the same 4096-entry cap; the size
 * test pins that the bound holds under insertions beyond it.
 */
import {
  capabilityProfileCacheSize,
} from "../../src/transport/routing/route-catalog-helpers";

describe("capability profile memo", () => {
  const row = (modalities: unknown) => ({
    modalities,
    reasoning: false,
    toolCall: false,
    providerId: "openai",
    modelId: "memo-model",
  });

  test("a rebuild with changed modalities yields the new profile", () => {
    // Same provider/model, different modalities → different cache key, so the
    // second build cannot answer from the first's entry.
    const before = buildCapabilityProfile(row({ input: ["text"], output: ["text"] }));
    expect(before.image).toBe(false);

    const after = buildCapabilityProfile(row({ input: ["text", "image"], output: ["text"] }));
    expect(after.image).toBe(true);
  });

  test("metadata-less rows and declared rows do not collide", () => {
    // `null` (never had metadata) and `{input: [], output: []}` (declared
    // empty) both take the codec grant, but they are distinct keys — a
    // metadata-less row that later gains a declaration must build its own.
    const undeclared = buildCapabilityProfile(row(null));
    const declaredEmpty = buildCapabilityProfile(row({ input: [], output: [] }));
    expect(undeclared.image).toBe(true);
    expect(declaredEmpty.image).toBe(true);
  });

  test("the memo never exceeds its capacity", () => {
    const before = capabilityProfileCacheSize();
    // Insert well past the 4096 cap with distinct keys; the live size must
    // stay bounded. (Insertions reuse the same build path as production.)
    for (let i = 0; i < 5000; i += 1) {
      buildCapabilityProfile({
        reasoning: false,
        toolCall: false,
        providerId: "openai",
        // Distinct modalities per build so each call is a distinct memo key.
        modalities: { input: ["text", `v${i}`], output: ["text"] },
      });
    }
    const after = capabilityProfileCacheSize();
    expect(after).toBeLessThanOrEqual(4096);
    expect(after).toBeGreaterThanOrEqual(before); // only grows toward the cap
  });
});
