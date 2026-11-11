// SSRF guard: DNS resolution allowlists and destination validation for outbound fetch.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { GatewayError } from "../protocol/gateway-error";
import type { SsrfPolicy } from "../config/network";
import { BoundedLruMap } from "../transport/routing/bounded-lru";
import {
  cidrContainsAddress,
  ipv4ToNumberStrict,
  ipv6GroupsToBytes,
  normalizeIpv6Groups,
} from "./util/ip";

const DNS_CACHE_TTL_MS = 60_000;
const DNS_CACHE_MAX = 64;
// Capacity-bounded: `set` re-inserts the host (moving it to the tail) and
// evicts the least-recently-used entry when over the cap — the same
// insertion-order eviction the hand-rolled loop performed, since every write
// here re-inserts.
const dnsCache = new BoundedLruMap<string, { addrs: string[]; at: number }>(DNS_CACHE_MAX);

/** Bounds cache memory: evicts oldest entries once size exceeds the cap, not just expired ones. */
function cacheDnsResult(hostname: string, addrs: string[], now: number): void {
  dnsCache.delete(hostname);
  dnsCache.set(hostname, { addrs, at: now });
}


export interface ValidatedDestination {
  readonly hostname: string;
  readonly resolvedAddress: string;
  readonly port: number;
}

type DnsLookup = (
  hostname: string,
  options: { all: true },
) => Promise<readonly { address: string; family: number }[]>;

function ipv6Bytes(address: string): Uint8Array {
  const bytes = ipv6GroupsToBytes(normalizeIpv6Groups(address, { allowDottedQuad: true }) ?? []);
  if (bytes === undefined) throw new Error("invalid IPv6");
  return bytes;
}

function cidrContains(address: string, cidr: string): boolean {
  return cidrContainsAddress(address, cidr, {
    requirePrefix: true,
    unwrapMapped: false,
    allowDottedQuad: true,
  });
}

function unsafeAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const n = ipv4ToNumberStrict(address);
    return [
      [0, 8],
      [0x0a000000, 8],
      [0x64400000, 10],
      [0x7f000000, 8],
      [0xa9fe0000, 16],
      [0xac100000, 12],
      [0xc0a80000, 16],
      [0xc0000000, 24],
      [0xc6120000, 15],
      [0xc6336400, 24],
      [0xcb007100, 24],
      [0xe0000000, 4],
    ].some(([base, prefix]) => n >>> (32 - prefix!) === base! >>> (32 - prefix!));
  }
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  const first = (bytes[0]! << 8) | bytes[1]!;
  const first32 = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  // first === 0 also covers the IPv4-mapped (`::ffff:0:0/96`) and
  // IPv4-compatible (deprecated) ranges, including `::ffff:127.0.0.1`.
  // 2002::/16 (6to4) and 64:ff9b::/96 (NAT64) embed an IPv4 address in the
  // tail bits and translate it at a gateway — treat the embedded range as
  // unsafe by checking its translated IPv4 bytes. Compare the 16-bit leading
  // group (`first`), not the full 32-bit `first32`.
  if (first === 0x2002) return unsafeAddress(embeddedIpv4(bytes, 2));
  if (first === 0x0064 && bytes[2] === 0xff && bytes[3] === 0x9b)
    return unsafeAddress(embeddedIpv4(bytes, 12));
  return (
    first === 0 ||
    first === 1 ||
    first32 === 0x20010db8 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    bytes[0] === 0xff
  );
}

/** Extracts the 4-byte IPv4 embedded at `byteOffset` of an IPv6 address. */
function embeddedIpv4(bytes: Uint8Array, byteOffset: number): string {
  return [
    bytes[byteOffset]!,
    bytes[byteOffset + 1]!,
    bytes[byteOffset + 2]!,
    bytes[byteOffset + 3]!,
  ].join(".");
}

export function isAddressAllowed(address: string, policy: SsrfPolicy): boolean {
  if (isIP(address) === 0) return false;
  if (policy.allowedNetworks?.some((cidr) => cidrContains(address, cidr))) return true;
  return policy.allowPrivate === true || !unsafeAddress(address);
}
export function validateResolvedAddresses(
  addresses: readonly string[],
  policy: SsrfPolicy,
): string {
  if (addresses.length === 0 || addresses.some((address) => !isAddressAllowed(address, policy))) {
    throw new GatewayError("invalid_request", 400, "The upstream address this route resolves to is not allowed (request {requestId}). Point the provider at a permitted host. All roads blocked — time to find a new route 🗺️");
  }
  return addresses[0]!;
}

export async function resolveAllAddresses(hostname: string): Promise<string[]>;
export async function resolveAllAddresses(
  hostname: string,
  signal: AbortSignal,
  lookupFn?: DnsLookup,
): Promise<string[]>;
export async function resolveAllAddresses(
  hostname: string,
  signal: AbortSignal = new AbortController().signal,
  lookupFn: DnsLookup = lookup,
): Promise<string[]> {
  if (signal.aborted) throw abortErrorForSignal(signal);
  if (isIP(hostname)) return [hostname];
  const cached = dnsCache.get(hostname);
  if (cached) {
    if (Date.now() - cached.at < DNS_CACHE_TTL_MS) return cached.addrs;
    // Stale: a cached answer past the TTL must not pin a hostname to addresses
    // the resolver may have already re-pointed (provider failover, DNS rebinding
    // rotation). Drop it and fall through to a fresh lookup.
    dnsCache.delete(hostname);
  }
  try {
    // `dns.lookup` follows the OS resolver, including hosts entries and a VPN
    // stub that replaces resolv.conf at runtime. `resolve4`/`resolve6` query
    // c-ares directly, so a tunnel resolver that refuses or drops those
    // queries fails direct egress even while the OS can still answer.
    // AAAA-only resolvers can stall, so the OS lookup itself has a deadline.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let rows: readonly { address: string; family: number }[];
    try {
      rows = await Promise.race([
        lookupFn(hostname, { all: true }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("DNS lookup timed out")), 5_000);
          onAbort = () => reject(abortErrorForSignal(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
    const addresses = [...new Set(rows.filter((row) => row.family === 4).map((row) => row.address))];
    const selected = addresses.length > 0 ? addresses : [...new Set(rows.map((row) => row.address))];
    if (selected.length === 0) throw new Error("no DNS answers");
    cacheDnsResult(hostname, selected, Date.now());
    return selected;
  } catch (error) {
    if (signal.aborted) throw abortErrorForSignal(signal);
    // The hostname belongs to the provider's configuration, not to the
    // caller's request: a resolver that cannot answer is a network failure,
    // and reporting it as the caller's 400 `invalid_request` blamed the
    // request for an upstream host that does not resolve.
    throw new GatewayError(
      "transport_unavailable",
      502,
      "upstream DNS resolution failed (request {requestId}). The connection ghosted us — come back in a moment 👻",
      { cause: String(error) },
      "network",
    );
  }
}

function abortErrorForSignal(signal: AbortSignal): GatewayError {
  const reason = signal.reason;
  if (reason instanceof GatewayError) return reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError")
    return new GatewayError("deadline_exceeded", 504, "request deadline exceeded (request {requestId}). Some things just take longer 🐢", {}, "cartethyia");
  return new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
}

export async function resolveAndValidateOnce(
  hostname: string,
  policy: SsrfPolicy,
  signal: AbortSignal,
  port = 443,
): Promise<ValidatedDestination> {
  const addresses = await resolveAllAddresses(hostname, signal);
  const resolvedAddress = validateResolvedAddresses(addresses, policy);
  return { hostname, resolvedAddress, port };
}
