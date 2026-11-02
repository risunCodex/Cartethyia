// Parity test for the consolidated `src/network/ip-utils.ts`.
//
// Golden values were captured from the two implementations the module
// replaced: ssrf.ts (`ipv4Number` throws / `ipv6Bytes` accepts dotted quads /
// `cidrContains` requires a prefix, no mapped unwrap) and
// security/ip-boundary.ts (`ipv4ToNumber`+`ipv6ToBigInt` refuse dotted quads /
// `matchesCidr` bare = exact host, unwraps mapped spellings).

import { describe, expect, it } from "bun:test";
import {
  cidrContainsAddress,
  ipv4ToNumber,
  ipv4ToNumberStrict,
  ipv6GroupsToBigInt,
  ipv6GroupsToBytes,
  isLoopbackAddress,
  normalizeIpv6Groups,
  unwrapMappedIpv4,
} from "../../src/network/ip-utils";

/** ssrf.ts's former spelling: bytes, dotted quads allowed, throws. */
function legacySsrfIpv6Bytes(address: string): Uint8Array {
  const value = address.toLowerCase().split("%", 1)[0]!;
  if (value.includes(".")) {
    const split = value.lastIndexOf(":");
    if (split < 0) throw new Error("invalid IPv6");
    const n = ipv4ToNumberStrict(value.slice(split + 1));
    return legacySsrfIpv6Bytes(
      `${value.slice(0, split)}:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`,
    );
  }
  const bytes = ipv6GroupsToBytes(normalizeIpv6Groups(value, { allowDottedQuad: true }) ?? []);
  if (bytes === undefined) throw new Error("invalid IPv6");
  return bytes;
}

/** ip-boundary.ts's former spelling: BigInt, dotted quads refused, undefined. */
function legacyBoundaryIpv6ToBigInt(address: string): bigint | undefined {
  const groups = normalizeIpv6Groups(address);
  return groups === undefined ? undefined : ipv6GroupsToBigInt(groups);
}

describe("ipv4ToNumber / ipv4ToNumberStrict", () => {
  it("parses plain dotted quads", () => {
    expect(ipv4ToNumber("0.0.0.0")).toBe(0);
    expect(ipv4ToNumber("1.2.3.4")).toBe(0x01020304);
    expect(ipv4ToNumber("10.0.0.1")).toBe(0x0a000001);
    expect(ipv4ToNumber("127.0.0.1")).toBe(0x7f000001);
    expect(ipv4ToNumber("192.168.1.254")).toBe(0xc0a801fe);
    expect(ipv4ToNumber("255.255.255.255")).toBe(0xffffffff);
    expect(ipv4ToNumber("255.255.255.255")).toBe(4294967295);
  });

  it("refuses non-quad and out-of-range shapes", () => {
    for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "-1.2.3.4", "1.2.3.04x", "1..2.3", "a.b.c.d"]) {
      expect(ipv4ToNumber(bad)).toBeUndefined();
      expect(() => ipv4ToNumberStrict(bad)).toThrow("invalid IPv4");
    }
  });

  it("refuses the exotic Number spellings", () => {
    for (const bad of ["0x1.2.3.4", "+1.2.3.4", "1.2.3.4 "]) {
      expect(ipv4ToNumber(bad)).toBeUndefined();
    }
  });
});

describe("normalizeIpv6Groups", () => {
  it("expands :: runs and normalizes case/leading zeros", () => {
    expect(normalizeIpv6Groups("2001:DB8::1")).toEqual([
      "2001", "db8", "0", "0", "0", "0", "0", "1",
    ]);
    expect(normalizeIpv6Groups("::")).toEqual([
      "0", "0", "0", "0", "0", "0", "0", "0",
    ]);
    expect(normalizeIpv6Groups("::1")).toEqual([
      "0", "0", "0", "0", "0", "0", "0", "1",
    ]);
    expect(normalizeIpv6Groups("1:2:3:4:5:6:7:8")).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8",
    ]);
    expect(normalizeIpv6Groups("0:0:0:0:0:ffff:7f00:1")).toEqual([
      "0", "0", "0", "0", "0", "ffff", "7f00", "1",
    ]);
    expect(normalizeIpv6Groups("::ffff:0:102:304")).toEqual([
      "0", "0", "0", "0", "ffff", "0", "102", "304",
    ]);
  });

  it("strips zone ids", () => {
    expect(normalizeIpv6Groups("fe80::1%eth0")).toEqual([
      "fe80", "0", "0", "0", "0", "0", "0", "1",
    ]);
  });

  it("refuses invalid shapes", () => {
    for (const bad of [
      "", ":::", "1::2::3", "12345::1", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8::",
      "::1:2:3:4:5:6:7:8", "g::1", "1:2:3:4:5:6:7", "::0:ffff:1.2.3.4.5",
    ]) {
      expect(normalizeIpv6Groups(bad)).toBeUndefined();
    }
  });

  it("dotted-quad handling is opt-in", () => {
    // SSRF spelling: accepted and converted to two groups.
    expect(normalizeIpv6Groups("::ffff:1.2.3.4", { allowDottedQuad: true })).toEqual([
      "0", "0", "0", "0", "0", "ffff", "102", "304",
    ]);
    expect(normalizeIpv6Groups("::1.2.3.4", { allowDottedQuad: true })).toEqual([
      "0", "0", "0", "0", "0", "0", "102", "304",
    ]);
    // Boundary spelling: deliberately fail-closed (pinned by ip-boundary tests).
    expect(normalizeIpv6Groups("::ffff:1.2.3.4")).toBeUndefined();
    expect(normalizeIpv6Groups("::1.2.3.4")).toBeUndefined();
    expect(normalizeIpv6Groups("::ffff:1.2.3.999", { allowDottedQuad: true })).toBeUndefined();
  });
});

describe("ipv6GroupsToBytes / ipv6GroupsToBigInt — ssrf vs boundary parity", () => {
  // ~40 spellings: every form both former parsers saw.
  const spellings = [
    "::", "::1", "1::", "1:2:3:4:5:6:7:8", "0:0:0:0:0:0:0:1",
    "2001:db8::1", "2001:0db8:0000::0001", "fe80::", "fe80::1%eth0",
    "::ffff:0:0", "0:0:0:0:0:ffff:0:0", "0:0:0:0:0:ffff:7f00:1",
    "::ffff:127.0.0.1", "0:0:0:0:0:ffff:c0a8:1fe", "::ffff:192.168.1.254",
    "::ffff:102:304", "::ffff:0:102:304", "::1.2.3.4", "::ffff:1.2.3.4",
    "64:ff9b::7f00:1", "2002:7f00:1::", "abcd::abcd", "::a:b",
  ] as const;

  it("bytes match the former ssrf parser exactly", () => {
    for (const spelling of spellings) {
      const bytes = ipv6GroupsToBytes(
        normalizeIpv6Groups(spelling, { allowDottedQuad: true }) ?? [],
      );
      expect(Array.from(bytes ?? [])).toEqual(Array.from(legacySsrfIpv6Bytes(spelling)));
    }
  });

  it("BigInt matches the former boundary parser exactly (dotted refused)", () => {
    for (const spelling of spellings) {
      const groups = normalizeIpv6Groups(spelling);
      if (groups === undefined) {
        expect(legacyBoundaryIpv6ToBigInt(spelling)).toBeUndefined();
        continue;
      }
      expect(ipv6GroupsToBigInt(groups)).toBe(legacyBoundaryIpv6ToBigInt(spelling));
    }
  });

  it("golden byte/BigInt vectors", () => {
    const loopbackBytes = ipv6GroupsToBytes(normalizeIpv6Groups("::1") ?? []);
    expect(Array.from(loopbackBytes ?? [])).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const mapped = ipv6GroupsToBytes(
      normalizeIpv6Groups("::ffff:127.0.0.1", { allowDottedQuad: true }) ?? [],
    );
    expect(Array.from(mapped ?? [])).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1,
    ]);
    expect(ipv6GroupsToBigInt(normalizeIpv6Groups("::1") ?? [])).toBe(1n);
    expect(ipv6GroupsToBigInt(normalizeIpv6Groups("2001:db8::1") ?? [])).toBe(
      BigInt("0x20010db8000000000000000000000001"),
    );
  });
});

describe("cidrContainsAddress", () => {
  // ssrf spelling: requirePrefix, no mapped unwrap.
  const ssrfContains = (addr: string, cidr: string) =>
    cidrContainsAddress(addr, cidr, {
      requirePrefix: true,
      unwrapMapped: false,
      allowDottedQuad: true,
    });
  // boundary spelling: bare = exact host, mapped unwrap.
  const boundaryContains = (addr: string, cidr: string) =>
    cidrContainsAddress(addr, cidr, { requirePrefix: false, unwrapMapped: true });

  it("ipv4 prefix math (ssrf mode)", () => {
    expect(ssrfContains("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ssrfContains("11.0.0.1", "10.0.0.0/8")).toBe(false);
    expect(ssrfContains("192.168.1.254", "192.168.1.0/24")).toBe(true);
    expect(ssrfContains("192.168.2.1", "192.168.1.0/24")).toBe(false);
    expect(ssrfContains("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });

  it("bare address and blank prefix (boundary mode vs ssrf mode)", () => {
    // boundary: bare = exact host.
    expect(boundaryContains("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(boundaryContains("127.0.0.2", "127.0.0.1")).toBe(false);
    // ssrf: bare address matches nothing (fail-closed allowlist).
    expect(ssrfContains("127.0.0.1", "127.0.0.1")).toBe(false);
    // blank prefix refused in BOTH modes (never a /0).
    expect(ssrfContains("10.0.0.1", "10.0.0.0/")).toBe(false);
    expect(boundaryContains("10.0.0.1", "10.0.0.0/")).toBe(false);
    // exotic zero spellings refused in both modes.
    for (const zero of ["-0", "+0", "0x0", "0b0", "0o0", "0.0"]) {
      expect(ssrfContains("10.0.0.1", `10.0.0.0/${zero}`)).toBe(false);
      expect(boundaryContains("10.0.0.1", `10.0.0.0/${zero}`)).toBe(false);
    }
  });

  it("mapped-unwrap difference between the two modes", () => {
    // boundary unwraps mapped spellings on both sides.
    expect(boundaryContains("::ffff:127.0.0.1", "127.0.0.1/32")).toBe(true);
    expect(boundaryContains("0:0:0:0:0:ffff:7f00:1", "127.0.0.1/32")).toBe(true);
    expect(boundaryContains("::ffff:127.0.0.1", "127.0.0.1")).toBe(true);
    expect(boundaryContains("::ffff:127.0.0.1", "127.0.0.0/8")).toBe(true);
    // ssrf compares the literal as written: a mapped subject is IPv6 and never
    // matches an IPv4 CIDR.
    expect(ssrfContains("::ffff:127.0.0.1", "127.0.0.1/32")).toBe(false);
    expect(ssrfContains("::ffff:127.0.0.1", "::/0")).toBe(true);
    // ssrf's IPv6 parse DOES accept the dotted-quad spelling (legacy ssrf
    // behavior via ipv6Bytes).
    expect(ssrfContains("::ffff:1.2.3.4", "::ffff:102:304/128")).toBe(true);
    expect(ssrfContains("::ffff:1.2.3.4", "::1/128")).toBe(false);
  });

  it("ipv6 prefix math", () => {
    expect(ssrfContains("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ssrfContains("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ssrfContains("::1", "::1/128")).toBe(true);
    expect(ssrfContains("::2", "::1/128")).toBe(false);
    expect(boundaryContains("fe80::1", "fe80::/10")).toBe(true);
    expect(ssrfContains("2001:db8::1", "2001:db8::1")).toBe(false); // requires prefix
    expect(ssrfContains("2001:db8::1", "2001:db8::/129")).toBe(false);
    expect(ssrfContains("10.0.0.1", "10.0.0.0/33")).toBe(false);
  });

  it("family mismatch is false", () => {
    expect(ssrfContains("10.0.0.1", "2001:db8::/32")).toBe(false);
    expect(ssrfContains("::1", "10.0.0.0/8")).toBe(false);
    expect(ssrfContains("not-an-ip", "10.0.0.0/8")).toBe(false);
  });
});

describe("isLoopbackAddress / unwrapMappedIpv4", () => {
  it("accepts every spelling of loopback", () => {
    for (const address of [
      "127.0.0.1", "127.255.255.254", "127.0.0.0",
      "::1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "::ffff:7f00:1",
    ]) {
      expect(isLoopbackAddress(address)).toBe(true);
    }
  });

  it("refuses non-loopback", () => {
    for (const address of ["126.255.255.255", "128.0.0.1", "::2", "fe80::1", "10.0.0.1", ""]) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });

  it("unwrapMappedIpv4 converges mapped spellings", () => {
    expect(unwrapMappedIpv4("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(unwrapMappedIpv4("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(unwrapMappedIpv4("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
    expect(unwrapMappedIpv4("::ffff:c0a8:1fe")).toBe("192.168.1.254");
    // Non-mapped addresses pass through unchanged.
    expect(unwrapMappedIpv4("::1")).toBe("::1");
    expect(unwrapMappedIpv4("2001:db8::1")).toBe("2001:db8::1");
    expect(unwrapMappedIpv4("10.1.2.3")).toBe("10.1.2.3");
  });
});
