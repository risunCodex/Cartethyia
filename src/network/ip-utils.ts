// Shared IP parsing primitives: IPv4 → number, IPv6 → groups/bytes/BigInt,
// CIDR containment, and loopback detection.
//
// Consolidates the two independent copies that used to live in `ssrf.ts` and
// `security/ip-boundary.ts`. The two modules' semantics differ **on purpose**,
// so every shared entry point carries the divergence as an explicit opt-in
// rather than silently picking one behavior:
//
// - **Dotted-quad IPv6** (`::ffff:1.2.3.4`): the SSRF guard accepts it (the DNS
//   layer can hand it one); the client-identity layer deliberately fail-closes
//   its BigInt key path on a dotted tail so an unparseable spelling can never
//   mint a database uniqueness key.
// - **CIDR**: the SSRF guard requires an explicit `/prefix` (a bare address
//   matches nothing — fail-closed on an allowlist) and does not unwrap
//   IPv4-mapped spellings; the trusted-proxy boundary treats a bare address as
//   "this exact host" and unwraps mapped spellings, because Bun reports an
//   IPv4 loopback peer as `::ffff:127.0.0.1` on Windows.
import { isIP } from "node:net";

/**
 * IPv4 literal as a 32-bit unsigned number, or `undefined` when `address` is
 * not a plain dotted quad. Decimal octets only — the exotic spellings `Number`
 * accepts (`0x`, leading `+`, octal) are refused, because this value feeds
 * allowlist comparisons where a lenient parse would widen the match.
 */
export function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return undefined;
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

/**
 * Same parse as {@link ipv4ToNumber}, but a refusal is an error. The SSRF
 * guard's internal call sites only ever reach the parser with an `isIP`-validated
 * string, so a malformed octet there is an invariant breach, not input handling.
 */
export function ipv4ToNumberStrict(address: string): number {
  const value = ipv4ToNumber(address);
  if (value === undefined) throw new Error("invalid IPv4");
  return value;
}

/**
 * An IPv6 literal as exactly eight lowercase 16-bit hex groups, or `undefined`
 * when it is not one. Expands a `::` run (which must stand for at least one
 * group) and — with `allowDottedQuad` — converts a trailing dotted quad into
 * the two groups it represents.
 *
 * `allowDottedQuad` is the preserved SSRF/boundary divergence: the SSRF guard
 * passes `true` (DNS answers can arrive as `::ffff:1.2.3.4`), the client-identity
 * key path leaves the default (`false`) so a dotted spelling never reaches a
 * database uniqueness key. The zone id (`%eth0`) is stripped; it identifies an
 * interface, not an address.
 */
export function normalizeIpv6Groups(
  value: string,
  opts: { allowDottedQuad?: boolean } = {},
): string[] | undefined {
  const allowDottedQuad = opts.allowDottedQuad ?? false;
  const text = value.toLowerCase().trim().split("%", 1)[0] ?? "";
  if (text.length === 0) return undefined;
  const doubleIndex = text.indexOf("::");
  // More than one `::` is invalid, as is a `::` inside a group.
  if (doubleIndex !== text.lastIndexOf("::")) return undefined;

  const headText = doubleIndex >= 0 ? text.slice(0, doubleIndex) : text;
  const tailText = doubleIndex >= 0 ? text.slice(doubleIndex + 2) : "";
  const head = headText.length > 0 ? headText.split(":") : [];
  const tail = tailText.length > 0 ? tailText.split(":") : [];

  // A dotted quad is a single token that fills two groups.
  const expandDotted = (tokens: string[]): string[] | undefined => {
    const last = tokens[tokens.length - 1];
    if (last === undefined || !last.includes(".")) return tokens;
    if (!allowDottedQuad) return undefined;
    const quad = last.split(".");
    if (quad.length !== 4) return undefined;
    const octets = quad.map((part) => Number(part));
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    const [a, b, c, d] = octets;
    if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    return [...tokens.slice(0, -1), high, low];
  };

  const expandedHead = expandDotted(head);
  const expandedTail = expandDotted(tail);
  if (expandedHead === undefined || expandedTail === undefined) return undefined;

  let full: string[];
  if (doubleIndex >= 0) {
    const missing = 8 - expandedHead.length - expandedTail.length;
    // `::` must stand for at least one group, so exactly-8 without it is invalid.
    if (missing < 1) return undefined;
    full = [...expandedHead, ...Array.from({ length: missing }, () => "0"), ...expandedTail];
  } else {
    full = expandedHead;
  }
  if (full.length !== 8) return undefined;
  const normalized: string[] = [];
  for (const group of full) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    normalized.push(Number.parseInt(group, 16).toString(16));
  }
  return normalized;
}

/** The 16 bytes of an IPv6 literal, or `undefined` when it is not one. */
export function ipv6GroupsToBytes(groups: readonly string[]): Uint8Array | undefined {
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index]!;
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    const n = Number.parseInt(group, 16);
    bytes[index * 2] = n >>> 8;
    bytes[index * 2 + 1] = n & 255;
  }
  return bytes;
}

/** The 128-bit value of an IPv6 literal, or `undefined` when it is not one. */
export function ipv6GroupsToBigInt(groups: readonly string[]): bigint | undefined {
  if (groups.length !== 8) return undefined;
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

/** 128-bit value of an IPv6 literal; `allowDottedQuad` opts into the dotted tail. */
export function ipv6ToBigInt(address: string, opts: { allowDottedQuad?: boolean } = {}): bigint | undefined {
  const groups = normalizeIpv6Groups(address, opts);
  return groups === undefined ? undefined : ipv6GroupsToBigInt(groups);
}

/**
 * The 32-bit tail of an IPv4-mapped IPv6 address, or `undefined` when `value` is
 * not one. Accepts every spelling of the same address: `::ffff:1.2.3.4`,
 * `::ffff:102:304`, `0:0:0:0:0:ffff:102:304`, and `::ffff:0:102:304`.
 *
 * Works by normalizing to exactly eight 16-bit groups first. That is the only way
 * to compare spellings: a dotted tail is written as ONE colon-separated token but
 * occupies TWO group slots, so any check that counts `split(":")` entries gets the
 * position of the `ffff` marker wrong.
 */
function mappedIpv4Tail(value: string): string | undefined {
  const groups = normalizeIpv6Groups(value, { allowDottedQuad: true });
  if (groups === undefined) return undefined;
  // The first five groups (80 bits) must be zero, and the sixth must be `ffff`.
  for (let index = 0; index < 5; index += 1) {
    if (groups[index] !== "0") return undefined;
  }
  if (groups[5] !== "ffff") return undefined;
  const high = groups[6];
  const low = groups[7];
  if (high === undefined || low === undefined) return undefined;
  return `${high}:${low}`;
}

/**
 * Unwraps an IPv4-mapped IPv6 address to plain IPv4.
 *
 * Bun reports an IPv4 loopback peer as `::ffff:127.0.0.1` on Windows, and
 * `isIP` classifies it as IPv6 — so a parser that bails on a dotted quad never
 * matched `127.0.0.1/32`. Accepts both the dotted and the hex (`::ffff:7f00:1`)
 * spelling.
 */
export function unwrapMappedIpv4(address: string): string {
  const value = address.toLowerCase().split("%", 1)[0] ?? "";
  // Recognize the mapped range STRUCTURALLY, not by its compressed spelling. The
  // old `startsWith("::ffff:")` test missed any form that writes the leading zero
  // groups out — `0:0:0:0:0:ffff:7f00:1` is the same host as `::ffff:127.0.0.1`,
  // but it failed the prefix test, fell through to the generic IPv6 parse, and
  // was treated as an unrelated IPv6 address. The trust check then refused a peer
  // the allowlist covered, and `canonicalClientIpKey` minted a second key for one
  // host — which is stored on issued child keys for consistent usage reporting
  // and audit.
  //
  // A mapped address is `::ffff:<32 bits>`, i.e. the first 80 bits are zero and the
  // next 16 are `0xffff`. Matching that is the same test `isIP` uses internally.
  const tail = mappedIpv4Tail(value);
  if (tail === undefined) return address;
  // `mappedIpv4Tail` always returns two hex groups, so the dotted and hex
  // spellings have already converged by here.
  const groups = tail.split(":");
  if (groups.length !== 2) return address;
  const high = Number.parseInt(groups[0] ?? "", 16);
  const low = Number.parseInt(groups[1] ?? "", 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  )
    return address;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

export interface CidrContainsOptions {
  /**
   * `true` (SSRF guard): the CIDR must carry an explicit `/prefix` — a bare
   * address matches nothing, so a misconfigured allowlist entry fails closed.
   * `false` (trusted-proxy boundary): a bare address means "this exact host".
   */
  requirePrefix?: boolean;
  /**
   * `true` (trusted-proxy boundary): unwrap IPv4-mapped spellings on both the
   * subject and the network before comparing, so `::ffff:127.0.0.1` and
   * `127.0.0.1/32` describe the same host. `false` (SSRF guard): compare the
   * literal as written.
   */
  unwrapMapped?: boolean;
  /**
   * The SSRF guard's IPv6 parse accepts the dotted-quad spelling (`::ffff:1.2.3.4`,
   * which DNS answers can take); the boundary path refuses it. Defaults to
   * `false`; the SSRF call site passes `true`.
   */
  allowDottedQuad?: boolean;
}

/**
 * Whether `address` falls inside `cidr`. The blank-prefix refusal
 * (`"10.0.0.0/"` must NOT mean /0) is shared by both former implementations and
 * is preserved unconditionally: `Number("")` is 0 and /0 would admit every
 * address of the family — for the SSRF guard that includes the link-local
 * metadata endpoint the guard exists to refuse, and for the trusted-proxy
 * boundary it would believe any caller's `X-Forwarded-For`.
 */
export function cidrContainsAddress(
  address: string,
  cidr: string,
  opts: CidrContainsOptions = {},
): boolean {
  const requirePrefix = opts.requirePrefix ?? true;
  const unwrapMapped = opts.unwrapMapped ?? false;
  const allowDottedQuad = opts.allowDottedQuad ?? false;
  const [network, rawPrefix] = cidr.split("/");
  if (!network) return false;
  const prefixText = rawPrefix === undefined ? undefined : rawPrefix.trim();
  // Requiring a run of digits also refuses the exotic spellings `Number`
  // accepts for zero (`-0`, `+0`, `0x0`, `0b0`, `0o0`, `0.0`) — typos, not a
  // deliberate "match everything".
  if (prefixText !== undefined && !/^\d+$/.test(prefixText)) return false;
  if (requirePrefix && prefixText === undefined) return false;
  const subject = unwrapMapped ? unwrapMappedIpv4(address) : address;
  const base = unwrapMapped ? unwrapMappedIpv4(network) : network;
  const family = isIP(subject);
  if (family !== isIP(base)) return false;
  const maxPrefix = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return false;
  if (family === 4) {
    const value = ipv4ToNumber(subject);
    const networkValue = ipv4ToNumber(base);
    if (value === undefined || networkValue === undefined) return false;
    if (prefix === 0) return true;
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return ((value >>> 0) & mask) === ((networkValue >>> 0) & mask);
  }
  if (family !== 6) return false;
  const value = ipv6ToBigInt(subject, { allowDottedQuad });
  const networkValue = ipv6ToBigInt(base, { allowDottedQuad });
  if (value === undefined || networkValue === undefined) return false;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (networkValue >> shift);
}

/**
 * True when `address` is a loopback address.
 *
 * Structural, not a string-prefix test: `127.0.0.1`, `::1`, and the mapped
 * `::ffff:127.0.0.1` a Windows/Bun peer arrives as are all the same host, and
 * a prefix test would miss the mapped form — the exact shape that hid this
 * class of bug before.
 *
 * `transport/drain-endpoint.ts` keeps its own weaker `isLoopbackPeer` (a
 * `::ffff:` prefix strip that misses the `0:0:0:0:0:ffff:7f00:1` spelling);
 * unifying it widens the admin gate's acceptance set and is deferred — switch
 * it to this predicate as a deliberate, separately-landed behavior widening.
 */
export function isLoopbackAddress(address: string): boolean {
  const normalized = unwrapMappedIpv4(address.trim().split("%", 1)[0] ?? "");
  if (normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  const value = ipv4ToNumber(normalized);
  // 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1.
  return value !== undefined && ((value >>> 0) & 0xff000000) === (127 << 24);
}
