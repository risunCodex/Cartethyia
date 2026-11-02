/**
 * In-process cache of vision-handoff descriptions.
 *
 * The key is a deterministic hash of the *set* of image payloads the handoff
 * actually described (the last image-carrying user turn). Re-sending the same
 * attachment — the same image in a later turn, or the same conversation
 * replayed — skips a second vision call entirely. Bounded and TTL'd so it can
 * never grow without limit.
 *
 * The cache is keyed by the active image set rather than a single image
 * because one vision model call describes the whole set in a single block of
 * text; you cannot reliably split that block back into per-image descriptions.
 * A repeated single-image request still hits, as does any repeated set.
 */
import { createHash } from "node:crypto";

const CACHE_MAX_ENTRIES = 512;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  readonly description: string;
  readonly at: number;
}

const store = new Map<string, CacheEntry>();

/** Deterministic hash of one canonical image part's payload. */
export function hashImagePart(part: { kind: "image"; payload: unknown }): string {
  const payload =
    typeof part.payload === "string" ? part.payload : JSON.stringify(part.payload);
  return createHash("sha256").update(`image:${payload}`).digest("hex");
}

/** Look up a previously stored description for an active image set hash. */
export function getCachedVisionDescription(hash: string): string | undefined {
  const entry = store.get(hash);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    store.delete(hash);
    return undefined;
  }
  return entry.description;
}

/** Clear the vision-handoff description cache (test isolation). */
export function clearCachedVisionDescriptions(): void {
  store.clear();
}

/** Store the description produced for an active image set hash. */
export function setCachedVisionDescription(hash: string, description: string): void {
  store.set(hash, { description, at: Date.now() });
  // Evict the oldest (first-inserted) entry when over the cap.
  if (store.size > CACHE_MAX_ENTRIES) {
    const oldestKey = store.keys().next().value as string | undefined;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
}
