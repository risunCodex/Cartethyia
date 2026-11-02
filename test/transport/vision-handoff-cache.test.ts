/**
 * The vision-handoff description cache: bounded, TTL'd, keyed by a hash of
 * the active image set. Repeated attachments skip a second vision call.
 */
import { expect, test } from "bun:test";
import {
  clearCachedVisionDescriptions,
  getCachedVisionDescription,
  hashImagePart,
  setCachedVisionDescription,
} from "../../src/transport/vision-handoff-cache";

test("hashImagePart is deterministic and distinct per payload", () => {
  const a1 = hashImagePart({ kind: "image", payload: "https://example.com/a.png" });
  const a2 = hashImagePart({ kind: "image", payload: "https://example.com/a.png" });
  const b = hashImagePart({ kind: "image", payload: "https://example.com/b.png" });
  expect(a1).toBe(a2);
  expect(a1).not.toBe(b);
});

test("set/get round-trips a description", () => {
  clearCachedVisionDescriptions();
  const hash = hashImagePart({ kind: "image", payload: "data:image/png;base64,AAAA" });
  expect(getCachedVisionDescription(hash)).toBeUndefined();
  setCachedVisionDescription(hash, "a red circle");
  expect(getCachedVisionDescription(hash)).toBe("a red circle");
  clearCachedVisionDescriptions();
  expect(getCachedVisionDescription(hash)).toBeUndefined();
});

test("cache is bounded: inserting past the cap evicts the oldest", () => {
  clearCachedVisionDescriptions();
  for (let i = 0; i < 600; i += 1) {
    setCachedVisionDescription(`hash-${i}`, `desc-${i}`);
  }
  // The first-inserted entries must have been evicted; recent ones remain.
  expect(getCachedVisionDescription("hash-0")).toBeUndefined();
  expect(getCachedVisionDescription("hash-599")).toBe("desc-599");
  clearCachedVisionDescriptions();
});
