import { createHash } from "node:crypto";

const MASK = 0xffffffffffffffffn;
const PRIME1 = 0x9e3779b185ebca87n;
const PRIME2 = 0xc2b2ae3d27d4eb4fn;
const PRIME3 = 0x165667b19e3779f9n;
const PRIME4 = 0x85ebca77c2b2ae63n;
const PRIME5 = 0x27d4eb2f165667c5n;
const CCH_SEED = 0x4d659218e32a3268n;
const PLACEHOLDER = "cch=00000";
/** Serialized anchor: the billing text opens the first system block. */
const MARKER = '"system":[{"type":"text","text":"x-anthropic-billing-header:';
/** Bounded placeholder search distance from the marker end, in bytes. */
const MARKER_WINDOW = 150;
const encoder = new TextEncoder();

function round(acc: bigint, input: bigint): bigint {
  let value = (acc + input * PRIME2) & MASK;
  value = ((value << 31n) | (value >> 33n)) & MASK;
  return (value * PRIME1) & MASK;
}

function mergeRound(acc: bigint, value: bigint): bigint {
  let result = acc ^ round(0n, value);
  return (result * PRIME1 + PRIME4) & MASK;
}

function read32(view: DataView, offset: number): bigint {
  // BigInt wrap: getUint32 yields a number, and the caller multiplies by a bigint.
  return BigInt(view.getUint32(offset, true));
}

function read64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

function xxHash64(bytes: Uint8Array, seed: bigint): bigint {
  // Every read below is guarded by the loop bounds, so the DataView's own
  // RangeError can never fire; one view per hash replaces per-byte BigInt work.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let hash: bigint;
  if (bytes.length >= 32) {
    let v1 = (seed + PRIME1 + PRIME2) & MASK;
    let v2 = (seed + PRIME2) & MASK;
    let v3 = seed & MASK;
    let v4 = (seed - PRIME1) & MASK;
    while (offset <= bytes.length - 32) {
      v1 = round(v1, read64(view, offset));
      v2 = round(v2, read64(view, offset + 8));
      v3 = round(v3, read64(view, offset + 16));
      v4 = round(v4, read64(view, offset + 24));
      offset += 32;
    }
    hash =
      (((v1 << 1n) | (v1 >> 63n)) +
        ((v2 << 7n) | (v2 >> 57n)) +
        ((v3 << 12n) | (v3 >> 52n)) +
        ((v4 << 18n) | (v4 >> 46n))) &
      MASK;
    hash = mergeRound(hash, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else hash = (seed + PRIME5) & MASK;
  hash = (hash + BigInt(bytes.length)) & MASK;
  while (offset <= bytes.length - 8) {
    const value = round(0n, read64(view, offset));
    hash ^= value;
    hash = (((hash << 27n) | (hash >> 37n)) * PRIME1 + PRIME4) & MASK;
    offset += 8;
  }
  if (offset <= bytes.length - 4) {
    hash ^= (read32(view, offset) * PRIME1) & MASK;
    hash = (((hash << 23n) | (hash >> 41n)) * PRIME2 + PRIME3) & MASK;
    offset += 4;
  }
  while (offset < bytes.length) {
    hash ^= (BigInt(bytes[offset] ?? 0) * PRIME5) & MASK;
    hash = (((hash << 11n) | (hash >> 53n)) * PRIME1) & MASK;
    offset += 1;
  }
  hash ^= hash >> 33n;
  hash = (hash * PRIME2) & MASK;
  hash ^= hash >> 29n;
  hash = (hash * PRIME3) & MASK;
  return (hash ^ (hash >> 32n)) & MASK;
}

/** Computes Claude Code's five-hex-digit CCH from the exact outgoing body bytes. */
export function computeClaudeCch(body: Uint8Array): string {
  return (xxHash64(body, CCH_SEED) & 0xfffffn).toString(16).padStart(5, "0");
}

/** Harness identity instruction, sent on OAuth dispatch. */
export const CLAUDE_CODE_SYSTEM_INSTRUCTION =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Builds the billing header text with the captured version suffix:
 * `cc_version={ver}.{sha256("59cf53e54c78" + chars + ver)[0:3]}` where
 * chars are the 5th/8th/21st chars of the first user text (or "0" when
 * absent). `cc_entrypoint=cli` matches the harness UA `(external, cli)`;
 * an older snapshot used `claude-desktop`, which is unverified from local
 * evidence, so cli is kept with this note.
 */
export function createClaudeBillingText(userText: string, version: string): string {
  const chars = [4, 7, 20].map((index) => userText[index] ?? "0").join("");
  const suffix = createHash("sha256")
    .update(`59cf53e54c78${chars}${version}`)
    .digest("hex")
    .slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=cli; cch=00000;`;
}

/**
 * Patches the five-hex-digit CCH into a string request body and returns the
 * patched string, or undefined when no billing block exists. The CCH is
 * computed over the encoded placeholder-bearing bytes — the exact bytes that
 * will be sent — before the digits are spliced in, so the hash input is
 * unchanged.
 */
export function patchClaudeCchBody(body: string): string | undefined {
  const markerIndex = body.indexOf(MARKER);
  if (markerIndex < 0) return undefined;
  const start = markerIndex + MARKER.length;
  const relative = body
    .slice(start, start + MARKER_WINDOW + PLACEHOLDER.length)
    .indexOf(PLACEHOLDER);
  if (relative < 0) return undefined;
  const placeholderIndex = start + relative;
  // The assembled marker-to-placeholder span is ASCII, so char distance equals
  // byte distance there; a crafted non-ASCII span keeps the byte window of the
  // scan this replaced: too far means unanchored.
  if (encoder.encode(body.slice(start, placeholderIndex)).length > MARKER_WINDOW)
    return undefined;
  const cch = computeClaudeCch(encoder.encode(body));
  return (
    body.slice(0, placeholderIndex + 4) + cch + body.slice(placeholderIndex + PLACEHOLDER.length)
  );
}
