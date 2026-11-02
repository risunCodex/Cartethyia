/**
 * 32-bit FNV-1a hash.
 *
 * Single source for the two former inline copies (claude `hashBody`,
 * cursor `cursorAccountTag`). Fast, deterministic, sufficient for cache
 * identity / short display tags — not a cryptographic hash.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
