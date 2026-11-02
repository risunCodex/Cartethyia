/**
 * The IP boundary: whose address the gateway believes a request came from.
 *
 * This is the layer every per-client decision reads — abuse throttling, model
 * bans, the address shown to an operator, and the share page's masked list. Two
 * properties carry the risk, and both have a documented incident behind them:
 *
 * 1. **A forwarded header is believed only from a trusted peer.** `X-Forwarded-For`
 *    is caller-supplied, so trusting it unconditionally lets any client claim
 *    any address — which defeats every per-address limit and forges the operator's
 *    audit trail. `"disabled"` (the default) must ignore it entirely.
 * 2. **A mapped IPv4 peer must be recognised as its IPv4 self.** Bun reports an
 *    IPv4 loopback peer as `::ffff:127.0.0.1` on Windows and `isIP` classifies it
 *    as IPv6, so a `127.0.0.1/32` allowlist entry never matched. The trust check
 *    failed for the exact peer it was written for, forwarded headers were
 *    ignored, and every cloudflared request stored the loopback peer as the
 *    client address — one address for every caller in the deployment.
 *
 * `canonicalClientIpKey` is the third surface: it is the database uniqueness key,
 * so a host that reaches the gateway under two spellings must collapse to one
 * value or the same client occupies two rows.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalClientIpKey,
  isLoopbackAddress,
  isSuspectedProxyCollapse,
  isTrustedProxyPeer,
  resetProxyCollapseWarningForTests,
  resolveClientIdentity,
} from "../../src/security/ip-boundary";
import type { TrustedProxyBoundary } from "../../src/config/network";
import { log } from "../../src/observability/logger";

/** No proxy trust: the raw TCP peer is the client. */
const DISABLED: TrustedProxyBoundary = { mode: "disabled" };
/** Trust forwarded headers only from the loopback range. */
const LOOPBACK: TrustedProxyBoundary = { mode: "trusted", allowlist: ["127.0.0.1/32", "::1/128"] };
/** Trust forwarded headers from anywhere (a PaaS edge that cannot be allowlisted). */
const PLATFORM: TrustedProxyBoundary = { mode: "platform" };
/** A trusted boundary with no allowlist: nobody is trusted. */
const EMPTY_ALLOWLIST: TrustedProxyBoundary = { mode: "trusted" };
/** A `trusted`-mode boundary over the given CIDR/exact-address entries. */
function trusted(allowlist: readonly string[]): TrustedProxyBoundary {
  return { mode: "trusted", allowlist };
}

/** A request carrying the given headers. */
function request(headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.test/v1/chat/completions", { headers });
}

describe("isTrustedProxyPeer", () => {
  test("disabled mode trusts nobody, whatever the peer", () => {
    // The default. `resolveClientIdentity` falls back to the raw peer in this
    // mode, which is the only value a caller cannot forge.
    expect(isTrustedProxyPeer("127.0.0.1", DISABLED)).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.1", DISABLED)).toBe(false);
    expect(isTrustedProxyPeer("203.0.113.1", DISABLED)).toBe(false);
  });

  test("platform mode trusts any peer", () => {
    // The mode's whole meaning: the PaaS edge is the only way in, so there is no
    // allowlist to match against.
    expect(isTrustedProxyPeer("127.0.0.1", PLATFORM)).toBe(true);
    expect(isTrustedProxyPeer("203.0.113.1", PLATFORM)).toBe(true);
    expect(isTrustedProxyPeer("::1", PLATFORM)).toBe(true);
  });

  test("trusted mode matches the allowlist exactly", () => {
    expect(isTrustedProxyPeer("127.0.0.1", LOOPBACK)).toBe(true);
    expect(isTrustedProxyPeer("::1", LOOPBACK)).toBe(true);
    // A neighbouring address in the same /8 is not the allowlisted /32.
    expect(isTrustedProxyPeer("127.0.0.2", LOOPBACK)).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.1", LOOPBACK)).toBe(false);
  });

  test("a trusted boundary with no allowlist trusts nobody", () => {
    // `?? false` is the guard. A missing allowlist read as "trust everything"
    // would be the worst possible default for this mode.
    expect(isTrustedProxyPeer("127.0.0.1", EMPTY_ALLOWLIST)).toBe(false);
  });

  test("the mapped form of the loopback peer IS trusted", () => {
    // The documented incident: Bun reports an IPv4 loopback peer as
    // `::ffff:127.0.0.1` on Windows, `isIP` calls that IPv6, and the allowlist
    // entry is `127.0.0.1/32` — so without the unwrap, the exact peer the entry
    // was written for is refused and every cloudflared request stores the
    // loopback address as the client.
    expect(isTrustedProxyPeer("::ffff:127.0.0.1", LOOPBACK)).toBe(true);
    // The hex spelling of the same address.
    expect(isTrustedProxyPeer("::ffff:7f00:1", LOOPBACK)).toBe(true);
  });

  test("a mapped non-loopback address is still not trusted", () => {
    // The unwrap must not widen the allowlist: `::ffff:10.0.0.1` is 10.0.0.1.
    expect(isTrustedProxyPeer("::ffff:10.0.0.1", LOOPBACK)).toBe(false);
    expect(isTrustedProxyPeer("::ffff:7f00:2", LOOPBACK)).toBe(false);
  });

  test("a CIDR entry matches a whole range", () => {
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/8"] };
    expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.255.255.255", boundary)).toBe(true);
    expect(isTrustedProxyPeer("11.0.0.1", boundary)).toBe(false);
  });

  test("a bare address entry without a prefix is a single host", () => {
    // `prefixText === undefined ? 32 : …` — a missing prefix means the entry
    // names one host, not the whole space. Reading it as /0 would trust every
    // peer on the internet.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.1"] };
    expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.0.0.2", boundary)).toBe(false);
    // And for IPv6 the same rule means one address, not /0.
    const v6: TrustedProxyBoundary = { mode: "trusted", allowlist: ["::1"] };
    expect(isTrustedProxyPeer("::1", v6)).toBe(true);
    expect(isTrustedProxyPeer("::2", v6)).toBe(false);
  });

  test("a malformed allowlist entry is ignored rather than trusted", () => {
    // Each of these fails a guard and returns false, for both the allowlisted
    // network and an unrelated public peer.
    for (const entry of ["10.0.0.0/abc", "10.0.0.0/33", "10.0.0.0/-1", "garbage", "", "300.0.0.1"]) {
      const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: [entry] };
      expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(false);
      expect(isTrustedProxyPeer("1.1.1.1", boundary)).toBe(false);
    }
  });

  /**
   * Blank/exotic CIDR prefixes are refused — this defect is closed.
   *
   * `matchesCidr` (`src/security/ip-boundary.ts`) now delegates to
   * `cidrContainsAddress` with `requirePrefix: false` (`src/network/ip-utils.ts`):
   * a bare address still means "this exact host", while any prefix that is
   * present must be a trimmed run of digits. A blank or exotic zero spelling
   * (`""`, `" "`, `"-0"`, `"+0"`, `"0x0"`, `"0b0"`, `"0o0"`, `"0.0"`) is
   * refused outright for both families, so a truncated or mistyped entry can no
   * longer widen trust to every peer. The passing assertions below pin that
   * closed state.
   */
  test("an empty prefix length does not trust every peer", () => {
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/"] };
    expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(false);
    expect(isTrustedProxyPeer("1.1.1.1", boundary)).toBe(false);
    // The IPv6 spelling of the same coercion.
    const v6: TrustedProxyBoundary = { mode: "trusted", allowlist: ["fc00::/"] };
    expect(isTrustedProxyPeer("fc00::1", v6)).toBe(false);
  });

  test("the malformed entry trusts no peer at all", () => {
    // The complement of the closed blank-prefix defect above: the entry matches
    // nothing, so the boundary fails closed.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/"] };
    expect(isTrustedProxyPeer("10.0.0.1", boundary)).toBe(false);
    expect(isTrustedProxyPeer("1.1.1.1", boundary)).toBe(false);
    expect(isTrustedProxyPeer("203.0.113.9", boundary)).toBe(false);
    expect(isTrustedProxyPeer("::1", boundary)).toBe(false);
    const v6: TrustedProxyBoundary = { mode: "trusted", allowlist: ["fc00::/"] };
    expect(isTrustedProxyPeer("fc00::1", v6)).toBe(false);
    expect(isTrustedProxyPeer("1.1.1.1", v6)).toBe(false);
  });

  test("the forged-header consequence is closed", () => {
    // The end-to-end shape of the defect, and the assertion that matters most: a
    // public peer's own header must NOT become the stored client address. Before
    // the fix this returned "203.0.113.9" — a value the caller chose.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/"] };
    expect(
      resolveClientIdentity(
        request({ "cf-connecting-ip": "203.0.113.9" }),
        boundary,
        "198.51.100.7",
      ),
    ).toBe("198.51.100.7");
  });

  test("a bare address allowlist entry still means that exact host", () => {
    // The regression guard for the fix: the prefix check must not break the
    // documented bare-address form. A bare entry is an exact match, not a /32
    // written without its mask, so a neighbour in the same range is not trusted.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.5"] };
    expect(isTrustedProxyPeer("10.0.0.5", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.0.0.6", boundary)).toBe(false);
  });

  test("an explicit /0 still trusts every peer, as documented", () => {
    // The *explicit* zero prefix is a deliberate act, distinct from the empty
    // string that was being coerced into it.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["0.0.0.0/0"] };
    expect(isTrustedProxyPeer("1.1.1.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("203.0.113.9", boundary)).toBe(true);
  });

  test("a peer that is not an address at all is not trusted", () => {
    // A unix socket peer, an empty string, or a hostname. None of them can
    // match a CIDR, so the answer must be "no".
    for (const peer of ["", "localhost", "/var/run/sock", "not-an-ip"]) {
      expect(isTrustedProxyPeer(peer, LOOPBACK)).toBe(false);
    }
  });

  test("a scoped IPv6 peer (zone id) still matches", () => {
    // A link-local peer arrives with a `%eth0` suffix; the zone is stripped
    // before parsing.
    const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["fe80::/10"] };
    expect(isTrustedProxyPeer("fe80::1%eth0", boundary)).toBe(true);
  });
});

describe("resolveClientIdentity — the untrusted path", () => {
  test("disabled mode returns the raw peer and ignores every header", () => {
    // The header set is caller-supplied, so believing it here would let any
    // client claim any address — defeating per-address throttling and forging
    // the operator's audit trail. Every documented header is checked, not just
    // the first.
    for (const header of [
      "cf-connecting-ip",
      "true-client-ip",
      "x-forwarded-for",
      "x-real-ip",
    ]) {
      expect(resolveClientIdentity(request({ [header]: "203.0.113.9" }), DISABLED, "198.51.100.7")).toBe(
        "198.51.100.7",
      );
    }
  });

  test("an untrusted peer ignores the headers even in trusted mode", () => {
    // The trust decision is about the peer, not the mode: a request arriving
    // directly from a public address must not have its headers believed just
    // because the deployment configured an allowlist.
    expect(
      resolveClientIdentity(request({ "x-forwarded-for": "203.0.113.9" }), LOOPBACK, "198.51.100.7"),
    ).toBe("198.51.100.7");
  });

  test("a mapped peer is unwrapped on the untrusted path too", () => {
    // The fallback is what gets stored as the client address, so a mapped form
    // here would put `::ffff:…` in the database as a distinct client.
    expect(resolveClientIdentity(request(), DISABLED, "::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(resolveClientIdentity(request(), DISABLED, "::ffff:7f00:1")).toBe("127.0.0.1");
  });

  test("a plain IPv6 peer is returned unchanged", () => {
    expect(resolveClientIdentity(request(), DISABLED, "2001:db8::1")).toBe("2001:db8::1");
  });
});

describe("resolveClientIdentity — the trusted path", () => {
  test("a trusted peer's forwarded header is believed, in preference order", () => {
    // The documented order, and the reason for it: `CF-Connecting-IP` and
    // `True-Client-IP` are single-valued and overwritten by the edge, so they
    // cannot carry a caller-supplied value. `X-Forwarded-For` is a chain and is
    // only used when neither of the safe ones is present.
    expect(
      resolveClientIdentity(
        request({
          "cf-connecting-ip": "203.0.113.1",
          "true-client-ip": "203.0.113.2",
          "x-forwarded-for": "203.0.113.3",
          "x-real-ip": "203.0.113.4",
        }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.1");
    expect(
      resolveClientIdentity(
        request({ "true-client-ip": "203.0.113.2", "x-forwarded-for": "203.0.113.3" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.2");
    expect(
      resolveClientIdentity(
        request({ "x-forwarded-for": "203.0.113.3", "x-real-ip": "203.0.113.4" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.3");
    expect(
      resolveClientIdentity(request({ "x-real-ip": "203.0.113.4" }), LOOPBACK, "127.0.0.1"),
    ).toBe("203.0.113.4");
  });

  test("the forwarded chain is read from its LEFT end", () => {
    // The documented assumption: the edge *prepends* the address it observed
    // (cloudflared's behaviour), so the left end is the client and the right end
    // is the edge itself. Pinned because an edge that appends leaves the
    // caller's own value at the left end — the comment names that as a
    // deployment hazard rather than something this code can detect.
    expect(
      resolveClientIdentity(
        request({ "x-forwarded-for": "203.0.113.1, 198.51.100.2, 10.0.0.3" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.1");
  });

  test("a mapped address in a forwarded header is canonicalised", () => {
    // The comment: a proxy may itself forward a mapped form, and one host must
    // be one dimension value rather than two.
    expect(
      resolveClientIdentity(request({ "cf-connecting-ip": "::ffff:203.0.113.1" }), LOOPBACK, "127.0.0.1"),
    ).toBe("203.0.113.1");
  });

  test("empty header values fall through to the next candidate", () => {
    // A header present but blank is what an edge sends when it has nothing to
    // report; treating it as the client would store an empty address.
    expect(
      resolveClientIdentity(
        request({ "cf-connecting-ip": "", "x-forwarded-for": "203.0.113.3" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.3");
  });

  test("a header of only commas or whitespace falls through", () => {
    expect(
      resolveClientIdentity(
        request({ "cf-connecting-ip": " , , ", "x-forwarded-for": "203.0.113.3" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.3");
  });

  test("no forwarded header at all falls back to the peer", () => {
    expect(resolveClientIdentity(request(), LOOPBACK, "127.0.0.1")).toBe("127.0.0.1");
  });

  test("a mapped trusted peer with no header falls back to its IPv4 form", () => {
    expect(resolveClientIdentity(request(), LOOPBACK, "::ffff:127.0.0.1")).toBe("127.0.0.1");
  });

  test("surrounding whitespace in the header is trimmed", () => {
    // A hand-written config or an edge that pads the value would otherwise store
    // the padded string as a distinct client.
    expect(
      resolveClientIdentity(
        request({ "cf-connecting-ip": "  203.0.113.1  " }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.1");
  });

  test("platform mode believes the headers from any peer", () => {
    // The mode's meaning: the PaaS edge cannot be allowlisted, so every peer is
    // the edge.
    expect(
      resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.1" }), PLATFORM, "203.0.113.9"),
    ).toBe("203.0.113.1");
  });

  test("a caller-supplied header cannot smuggle a value past the left-end read", () => {
    // The threat the preference order mitigates: a caller sends its own
    // `x-forwarded-for`, the edge prepends the real address, and the left end is
    // the edge's value. Asserted so the ordering is not "simplified" to a
    // right-end read, which would select the caller's value.
    expect(
      resolveClientIdentity(
        request({ "x-forwarded-for": "203.0.113.1, 1.2.3.4" }),
        LOOPBACK,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.1");
  });

  test("a header value that is not an address is returned as-is", () => {
    // MEASURED: the resolver does not validate the header's value, it only
    // unwraps a mapped form. Pinned because it means a trusted-but-misconfigured
    // edge can store an arbitrary string as the client address — the value is
    // bounded by `canonicalClientIpKey` returning undefined, not by this
    // function.
    expect(
      resolveClientIdentity(request({ "cf-connecting-ip": "not-an-ip" }), LOOPBACK, "127.0.0.1"),
    ).toBe("not-an-ip");
  });
});

describe("isLoopbackAddress", () => {
  test("every spelling of the loopback host is recognised", () => {
    // Structural, not a prefix test: `::ffff:127.0.0.1` is the form a Bun peer
    // actually arrives as on Windows, and a `startsWith("127.")` check would
    // call it a public address — the miss that hid this whole class of bug.
    for (const address of [
      "127.0.0.1",
      "127.5.5.5",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::1%lo0",
    ]) {
      expect(isLoopbackAddress(address)).toBe(true);
    }
  });

  test("an address just outside the loopback block is not loopback", () => {
    // 127.0.0.0/8, not "starts with 127": both neighbours must be excluded, or
    // the arm would trust a peer that is not the local host.
    expect(isLoopbackAddress("126.255.255.255")).toBe(false);
    expect(isLoopbackAddress("128.0.0.1")).toBe(false);
  });

  test("a public or private address is not loopback", () => {
    for (const address of ["198.51.100.7", "10.0.0.1", "::ffff:10.0.0.1", "2001:db8::1"]) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });

  test("a value that is not an address is not loopback", () => {
    // Fail-closed: an unparseable peer must never gain trust from this check.
    for (const address of ["", "localhost", "not-an-ip", "/var/run/sock"]) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });
});

describe("isSuspectedProxyCollapse — the tunnel signature", () => {
  test("a loopback peer with forwarded headers is a collapse", () => {
    // The reported incident: cloudflared connects from 127.0.0.1 and forwards
    // the real client. Before the fix these headers were ignored and every
    // caller behind the tunnel was recorded as the loopback address.
    expect(
      isSuspectedProxyCollapse(
        request({ "cf-connecting-ip": "203.0.113.9" }),
        { mode: "trusted", allowlist: ["10.0.0.0/8"] },
        "127.0.0.1",
      ),
    ).toBe(true);
  });

  test("a public peer with forwarded headers is NOT a collapse", () => {
    // Any client can send `X-Forwarded-For`. Ignoring it from a public peer is
    // correct, not a defect — so this must not warn. Calling it a collapse
    // would spray warnings for ordinary internet traffic.
    expect(
      isSuspectedProxyCollapse(
        request({ "x-forwarded-for": "203.0.113.9" }),
        DISABLED,
        "198.51.100.7",
      ),
    ).toBe(false);
  });

  test("a trusted peer is never a collapse, whatever the headers", () => {
    // The resolver believes these headers, so there is nothing to warn about.
    expect(
      isSuspectedProxyCollapse(request({ "x-forwarded-for": "203.0.113.9" }), LOOPBACK, "127.0.0.1"),
    ).toBe(false);
  });

  test("an unconfigured boundary with a loopback peer is not a collapse", () => {
    // The fix: the headers are believed now, so the callers keep their own
    // addresses. Asserted here so the warning and the resolver cannot disagree
    // about the same request.
    expect(
      isSuspectedProxyCollapse(request({ "cf-connecting-ip": "203.0.113.9" }), DISABLED, "127.0.0.1"),
    ).toBe(false);
  });

  test("a blank forwarded header is not a collapse", () => {
    // An edge that sends the header empty has nothing to report; that is not the
    // signature of a tunnel hiding a client.
    expect(isSuspectedProxyCollapse(request({ "cf-connecting-ip": "  " }), DISABLED, "127.0.0.1")).toBe(
      false,
    );
  });

  test("the warning fires once, then stays quiet", () => {
    // The condition is unchanged on every later request, so repeating it would
    // be thousands of identical paragraphs a minute on a busy gateway. Spied
    // rather than assumed: `resolveClientIdentity` is the only caller, so the
    // count is driven through it, and the seam resets the guard so the
    // assertion is about once-only and not about which suite ran first.
    resetProxyCollapseWarningForTests();
    // Spied on `log.warn`, not `console.warn`: the warning goes through the
    // logger like every other runtime message, so a console spy would see
    // nothing and this would pass vacuously — asserting zero messages while
    // the warning still fires.
    const original = log.warn;
    const messages: string[] = [];
    (log as { warn: (message: string, ...args: unknown[]) => void }).warn = (
      message?: unknown,
    ) => {
      messages.push(String(message));
    };
    try {
      // A boundary that trusts a non-loopback range: the tunnel's headers are
      // ignored, which is the condition worth warning about.
      const boundary: TrustedProxyBoundary = { mode: "trusted", allowlist: ["10.0.0.0/8"] };
      const headers = { "cf-connecting-ip": "203.0.113.9" };
      for (let i = 0; i < 4; i += 1) {
        expect(resolveClientIdentity(request(headers), boundary, "127.0.0.1")).toBe("127.0.0.1");
      }
    } finally {
      (log as { warn: (message: string, ...args: unknown[]) => void }).warn = original;
    }
    expect(messages.length).toBe(1);
    // It names the fix, so the operator is not left with a diagnosis and no
    // remedy — a warning that says only "something is wrong" gets ignored.
    expect(messages[0]).toContain("TRUSTED_PROXY_CIDRS");
  });

  test("a public peer's headers never warn", () => {
    // Ordinary internet traffic carrying its own `X-Forwarded-For` is expected
    // and safe; warning on it would spray logs for every client.
    resetProxyCollapseWarningForTests();
    const original = console.warn;
    const messages: string[] = [];
    console.warn = (message?: unknown) => {
      messages.push(String(message));
    };
    try {
      for (let i = 0; i < 3; i += 1) {
        expect(
          resolveClientIdentity(request({ "x-forwarded-for": "203.0.113.9" }), DISABLED, "198.51.100.7"),
        ).toBe("198.51.100.7");
      }
    } finally {
      console.warn = original;
    }
    expect(messages.length).toBe(0);
  });

  test("a loopback peer with no forwarded header is not a collapse", () => {
    // A genuine local caller: one address, correctly.
    expect(isSuspectedProxyCollapse(request(), DISABLED, "127.0.0.1")).toBe(false);
  });

  test("every documented header triggers it", () => {
    for (const header of [
      "cf-connecting-ip",
      "true-client-ip",
      "x-forwarded-for",
      "x-real-ip",
    ]) {
      expect(
        isSuspectedProxyCollapse(
          request({ [header]: "203.0.113.9" }),
          { mode: "trusted", allowlist: ["10.0.0.0/8"] },
          "127.0.0.1",
        ),
      ).toBe(true);
    }
  });
});

describe("canonicalClientIpKey — the uniqueness key", () => {
  test("an IPv4 address is tagged and numeric", () => {
    // The tag is what keeps a v4 and a v6 value from colliding on the same
    // string, and the numeric form is what makes two spellings equal.
    expect(canonicalClientIpKey("1.2.3.4")).toBe("v4:16909060");
    expect(canonicalClientIpKey("0.0.0.0")).toBe("v4:0");
    expect(canonicalClientIpKey("255.255.255.255")).toBe("v4:4294967295");
  });

  test("a mapped IPv4 collapses onto its IPv4 key", () => {
    // The property the doc comment states: mapped IPv4 and alternate spellings
    // collapse to one canonical address, so one host is one row.
    expect(canonicalClientIpKey("::ffff:1.2.3.4")).toBe(canonicalClientIpKey("1.2.3.4"));
    expect(canonicalClientIpKey("::ffff:102:304")).toBe(canonicalClientIpKey("1.2.3.4"));
  });

  test("alternate IPv6 spellings collapse onto one key", () => {
    // A compressed and an expanded spelling of the same address must not occupy
    // two rows.
    expect(canonicalClientIpKey("2001:db8::1")).toBe(canonicalClientIpKey("2001:0db8:0000:0000:0000:0000:0000:0001"));
    expect(canonicalClientIpKey("::1")).toBe(canonicalClientIpKey("0:0:0:0:0:0:0:1"));
    expect(canonicalClientIpKey("2001:DB8::1")).toBe(canonicalClientIpKey("2001:db8::1"));
  });

  test("an IPv6 key is zero-padded to a fixed width", () => {
    // The padding is what makes the key sortable and length-stable; without it
    // `v6:1` and `v6:01` would be different keys for the same address.
    expect(canonicalClientIpKey("::1")).toBe(`v6:${"0".repeat(31)}1`);
    expect(canonicalClientIpKey("::1")).toHaveLength(3 + 32);
  });

  test("the family tags keep a v4 and a v6 key distinct", () => {
    // `::1` and `1` are not comparable addresses; the tag is what stops the
    // numeric forms from colliding.
    expect(canonicalClientIpKey("::1")).not.toBe(canonicalClientIpKey("0.0.0.1"));
  });

  test("a non-address returns undefined rather than a fabricated key", () => {
    // The caller uses the undefined to skip the row. A fallback key would put
    // every unparseable value in one bucket.
    for (const value of ["", "not-an-ip", "localhost", "1.2.3", "1.2.3.4.5", "300.1.1.1", "::gggg", "::1%eth0"]) {
      // A scoped address is stripped, so `::1%eth0` is the loopback and DOES
      // have a key — the rest are genuinely unparseable.
      if (value === "::1%eth0") continue;
      expect(canonicalClientIpKey(value)).toBeUndefined();
    }
  });

  test("a scoped IPv6 address collapses onto its unscoped key", () => {
    // A zone id is a local routing hint, not part of the address, so the same
    // host must not occupy two rows depending on which interface it arrived on.
    expect(canonicalClientIpKey("fe80::1%eth0")).toBe(canonicalClientIpKey("fe80::1"));
    expect(canonicalClientIpKey("fe80::1%eth0")).toBe(canonicalClientIpKey("fe80::1%wlan0"));
  });

  test("every accepted address produces a key, and distinct hosts produce distinct keys", () => {
    // A sweep so a parsing regression shows up as a missing key rather than as
    // two hosts silently sharing one.
    const addresses = ["1.1.1.1", "1.1.1.2", "10.0.0.1", "::1", "2001:db8::1", "fe80::1", "::ffff:8.8.8.8"];
    const keys = addresses.map((address) => canonicalClientIpKey(address));
    for (const key of keys) expect(typeof key).toBe("string");
    expect(new Set(keys).size).toBe(addresses.length);
  });
});

// ---------------------------------------------------------------------------
// Unit-level edge cases merged from the former test/unit/ip-boundary.test.ts.
// The two suites covered the same module with complementary depth; the
// non-overlapping cases live below so the boundary has one home.
// ---------------------------------------------------------------------------

describe("isTrustedProxyPeer: IPv4 CIDR edge cases", () => {
  test("rejects the neighbour address of an exact /32", () => {
    // The whole point of /32 is that only the loopback is the proxy.
    expect(isTrustedProxyPeer("127.0.0.2", trusted(["127.0.0.1/32"]))).toBe(false);
  });

  test("rejects the addresses immediately outside a /8", () => {
    // Off-by-one at the mask boundary is the classic CIDR bug: `9.x` and `11.x`
    // must not be swallowed by a `10.0.0.0/8` entry.
    const boundary = trusted(["10.0.0.0/8"]);
    expect(isTrustedProxyPeer("9.255.255.255", boundary)).toBe(false);
    expect(isTrustedProxyPeer("11.0.0.0", boundary)).toBe(false);
  });

  test("matches a /24 with the last octet unconstrained", () => {
    const boundary = trusted(["192.168.1.0/24"]);
    expect(isTrustedProxyPeer("192.168.1.0", boundary)).toBe(true);
    expect(isTrustedProxyPeer("192.168.1.255", boundary)).toBe(true);
    expect(isTrustedProxyPeer("192.168.2.0", boundary)).toBe(false);
  });

  test("matches a /31 pair and rejects the next block", () => {
    const boundary = trusted(["127.0.0.1/31"]);
    expect(isTrustedProxyPeer("127.0.0.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.0", boundary)).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.2", boundary)).toBe(false);
  });

  test("matches a /30 block and rejects the address just past it", () => {
    const boundary = trusted(["10.0.0.0/30"]);
    expect(isTrustedProxyPeer("10.0.0.3", boundary)).toBe(true);
    expect(isTrustedProxyPeer("10.0.0.4", boundary)).toBe(false);
  });

  test("a /32 entry matches only that address", () => {
    const boundary = trusted(["0.0.0.0/32"]);
    expect(isTrustedProxyPeer("0.0.0.0", boundary)).toBe(true);
    expect(isTrustedProxyPeer("0.0.0.1", boundary)).toBe(false);
  });

  test("accepts any entry in a multi-entry allowlist", () => {
    const boundary = trusted(["10.0.0.0/8", "127.0.0.1/32", "172.16.0.0/12"]);
    expect(isTrustedProxyPeer("10.1.2.3", boundary)).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("172.16.5.5", boundary)).toBe(true);
    expect(isTrustedProxyPeer("192.168.1.1", boundary)).toBe(false);
  });
});

describe("isTrustedProxyPeer: IPv6 CIDR matching", () => {
  test("matches a compressed /128", () => {
    expect(isTrustedProxyPeer("::1", trusted(["::1/128"]))).toBe(true);
    expect(isTrustedProxyPeer("::2", trusted(["::1/128"]))).toBe(false);
  });

  test("matches a fully expanded spelling of a compressed entry", () => {
    // Both spellings are one address; a mismatch here would let an attacker
    // pick the spelling that misses the allowlist.
    expect(isTrustedProxyPeer("0:0:0:0:0:0:0:1", trusted(["::1/128"]))).toBe(true);
    expect(isTrustedProxyPeer("::1", trusted(["0:0:0:0:0:0:0:1/128"]))).toBe(true);
  });

  test("treats a bare IPv6 address as a /128", () => {
    expect(isTrustedProxyPeer("::1", trusted(["::1"]))).toBe(true);
    expect(isTrustedProxyPeer("::2", trusted(["::1"]))).toBe(false);
    expect(isTrustedProxyPeer("::1", trusted(["::"]))).toBe(false);
  });

  test("matches a /10 link-local range at both ends", () => {
    const boundary = trusted(["fe80::/10"]);
    expect(isTrustedProxyPeer("fe80::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("febf::1", boundary)).toBe(true);
    // fec0::/10 is the next block up; a /10 must stop before it.
    expect(isTrustedProxyPeer("fec0::1", boundary)).toBe(false);
  });

  test("matches a /32 documentation prefix and rejects its neighbour", () => {
    const boundary = trusted(["2001:db8::/32"]);
    expect(isTrustedProxyPeer("2001:db8::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("2001:db8:1234::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("2001:db9::1", boundary)).toBe(false);
  });

  test("matches an entry written in a longer form than the peer", () => {
    // `2001:0db8:0000::/32` and `2001:db8::1` are the same prefix.
    expect(isTrustedProxyPeer("2001:db8::1", trusted(["2001:0db8:0000::/32"]))).toBe(true);
  });

  test("a ::/0 entry matches every IPv6 address but no IPv4 address", () => {
    const boundary = trusted(["::/0"]);
    expect(isTrustedProxyPeer("::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("2001:db8::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.1", boundary)).toBe(false);
    expect(isTrustedProxyPeer("8.8.8.8", boundary)).toBe(false);
  });

  test("matches a /127 pair", () => {
    const boundary = trusted(["::1/127"]);
    expect(isTrustedProxyPeer("::1", boundary)).toBe(true);
    expect(isTrustedProxyPeer("::3", boundary)).toBe(false);
  });
});

describe("isTrustedProxyPeer: IPv4-mapped edge cases", () => {
  test("mapped spellings agree with the plain IPv4 answer", () => {
    // Compared against the plain form rather than asserted in isolation, so a
    // change to the allowlist cannot make one spelling silently diverge.
    const plain = isTrustedProxyPeer("127.0.0.1", LOOPBACK);
    expect(isTrustedProxyPeer("::ffff:127.0.0.1", LOOPBACK)).toBe(plain);
    expect(isTrustedProxyPeer("::ffff:7f00:1", LOOPBACK)).toBe(plain);
    expect(isTrustedProxyPeer("::FFFF:127.0.0.1", LOOPBACK)).toBe(plain);
  });

  test("a mapped peer matches a wider IPv4 range", () => {
    expect(isTrustedProxyPeer("::ffff:10.1.2.3", trusted(["10.0.0.0/8"]))).toBe(true);
  });

  test("a mapped allowlist entry matches a plain IPv4 peer", () => {
    // The unwrap is applied to the entry too, so the operator may write either
    // spelling of the same proxy.
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["::ffff:127.0.0.1/32"]))).toBe(true);
    expect(isTrustedProxyPeer("10.1.2.3", trusted(["::ffff:10.0.0.0/8"]))).toBe(true);
  });

  test("a mapped entry matches a mapped peer in either spelling", () => {
    expect(isTrustedProxyPeer("::ffff:127.0.0.1", trusted(["::ffff:7f00:1/32"]))).toBe(true);
    expect(isTrustedProxyPeer("::ffff:7f00:1", trusted(["::ffff:127.0.0.1/32"]))).toBe(true);
  });

  test("an expanded mapped address is the same host as plain IPv4", () => {
    // The dotted and hex compressed forms unwrap; the expanded form
    // `0:0:0:0:0:ffff:7f00:1` must agree with the plain IPv4 answer for the
    // same host.
    const expanded = "0:0:0:0:0:ffff:7f00:1";
    expect(isTrustedProxyPeer(expanded, LOOPBACK)).toBe(
      isTrustedProxyPeer("127.0.0.1", LOOPBACK),
    );
  });

  test("an expanded mapped address canonicalizes to its IPv4 key", () => {
    // Const expanded form keys as `v6:…ffff7f000001` while the plain and
    // compressed forms key as `v4:2130706433`, so a caller who reaches the
    // share-issue endpoint through a runtime reporting the expanded form gets a
    // second active key for one host instead of being refused.
    expect(canonicalClientIpKey("0:0:0:0:0:ffff:7f00:1")).toBe(canonicalClientIpKey("127.0.0.1"));
  });
});

describe("isTrustedProxyPeer: malformed prefixes and zone ids", () => {
  test("a zone id on an IPv4 address is not an address", () => {
    // `%` is IPv6 scope syntax only; `isIP` rejects it on a v4 literal, so this
    // must fail closed rather than be trimmed into a match.
    expect(isTrustedProxyPeer("127.0.0.1%eth0", trusted(["0.0.0.0/0"]))).toBe(false);
    expect(canonicalClientIpKey("127.0.0.1%eth0")).toBeUndefined();
  });

  test("malformed and empty peers never match", () => {
    // Each of these is a string the boundary must reject outright rather than
    // coerce: a permissive parse of `1.2.3` or `010.0.0.1` would be a
    // different address than the operator wrote.
    const v4CatchAll = trusted(["0.0.0.0/0"]);
    for (const peer of ["", ":::", "1.2.3", "1.2.3.4.5", "010.0.0.1", "not-an-ip", " 127.0.0.1"]) {
      expect(isTrustedProxyPeer(peer, v4CatchAll)).toBe(false);
    }
    expect(isTrustedProxyPeer("not-an-ip", trusted(["::/0"]))).toBe(false);
  });

  test("a malformed CIDR entry never matches, and never widens the match", () => {
    expect(isTrustedProxyPeer("8.8.8.8", trusted(["10.0.0.0/"]))).toBe(false);
    expect(isTrustedProxyPeer("8.8.8.8", trusted(["127.0.0.1/"]))).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.1", trusted(["10.0.0.0/"]))).toBe(false);

    expect(isTrustedProxyPeer("127.0.0.1", trusted(["not-a-cidr"]))).toBe(false);
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["127.0.0.1:80"]))).toBe(false);
  });

  test("a trailing separator is ignored rather than treated as part of the address", () => {
    // `cidr.split("/")` keeps only the first two segments, so `127.0.0.1/32/32`
    // is read as `127.0.0.1/32`. Pinned so the behavior is a decision, not an
    // accident: it cannot widen the match beyond the address the operator wrote.
    expect(isTrustedProxyPeer("127.0.0.1", trusted(["127.0.0.1/32/32"]))).toBe(true);
  });

  test("a whitespace-suffixed prefix still parses as that prefix", () => {
    // The padding is trimmed before the digits are read, so a stray space does not
    // disable the entry.
    expect(isTrustedProxyPeer("10.0.0.1", trusted(["10.0.0.0/8 "]))).toBe(true);
    expect(isTrustedProxyPeer("10.128.0.1", trusted(["10.0.0.0/ 8"]))).toBe(true);
  });
});

describe("resolveClientIdentity: header-priority and defect pins", () => {
  test("an untrusted peer's spoofed chain is ignored in full", () => {
    const headers = { "x-forwarded-for": "1.2.3.4, 5.6.7.8", "cf-connecting-ip": "9.9.9.9" };
    expect(resolveClientIdentity(request(headers), DISABLED, "198.51.100.9")).toBe("198.51.100.9");
  });

  test("the single-valued edge headers outrank the forwarded chain", () => {
    // `CF-Connecting-IP` and `True-Client-IP` are overwritten by the edge, so
    // they cannot carry a caller-supplied value; the chain can.
    const headers = {
      "cf-connecting-ip": "203.0.113.7",
      "true-client-ip": "203.0.113.8",
      "x-forwarded-for": "1.1.1.1",
      "x-real-ip": "2.2.2.2",
    };
    expect(resolveClientIdentity(request(headers), LOOPBACK, "127.0.0.1")).toBe("203.0.113.7");
    const { "cf-connecting-ip": _cf, ...withoutCf } = headers;
    expect(resolveClientIdentity(request(withoutCf), LOOPBACK, "127.0.0.1")).toBe("203.0.113.8");
  });

  test("x-forwarded-for outranks x-real-ip", () => {
    const headers = { "x-forwarded-for": "203.0.113.9", "x-real-ip": "1.1.1.1" };
    expect(resolveClientIdentity(request(headers), LOOPBACK, "127.0.0.1")).toBe("203.0.113.9");
  });

  test("empty segments are dropped rather than returned as the identity", () => {
    // A leading comma is what an appending edge produces when the caller sent
    // no chain at all; returning the empty string would store "" as a client
    // address and collapse every such caller into one identity.
    expect(resolveClientIdentity(request({ "x-forwarded-for": " , 203.0.113.7" }), LOOPBACK, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
    expect(resolveClientIdentity(request({ "x-forwarded-for": " , " }), LOOPBACK, "127.0.0.1")).toBe("127.0.0.1");
  });

  test("an empty higher-priority header falls through to the next one", () => {
    const headers = { "cf-connecting-ip": "", "x-forwarded-for": "203.0.113.12" };
    expect(resolveClientIdentity(request(headers), LOOPBACK, "127.0.0.1")).toBe("203.0.113.12");
    const headers2 = { "x-forwarded-for": "", "x-real-ip": "203.0.113.11" };
    expect(resolveClientIdentity(request(headers2), LOOPBACK, "127.0.0.1")).toBe("203.0.113.11");
  });

  test("the selected value is not validated before it is stored", () => {
    // The edge is the trust boundary, so a trusted peer's value is taken as
    // given. Pinned so the contract is explicit: validation happens at
    // `canonicalClientIpKey`, which fails closed on these.
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "not-an-ip" }), LOOPBACK, "127.0.0.1")).toBe(
      "not-an-ip",
    );
    expect(canonicalClientIpKey("not-an-ip")).toBeUndefined();
  });

  test("a mapped forwarded address is stored in canonical IPv4 form", () => {
    // One host must be one stored value, whichever spelling the edge forwarded.
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "::ffff:203.0.113.7" }), LOOPBACK, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "::ffff:cb00:7107" }), LOOPBACK, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
  });

  test("an untrusted mapped peer is unwrapped for storage", () => {
    // The loopback Bun reports on Windows must not be stored as a v6 string, or
    // every directly-connected caller shares one identity.
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), DISABLED, "::ffff:198.51.100.9")).toBe(
      "198.51.100.9",
    );
    expect(resolveClientIdentity(request({}), DISABLED, "::ffff:c633:6409")).toBe("198.51.100.9");
  });

  test("disabled mode ignores the chain from a non-loopback peer", () => {
    // This is the shape `resolveTrustedProxyBoundary` produces for `disabled`:
    // the mode alone, with no allowlist. A public peer is not a tunnel, so its
    // headers stay untrusted and the peer is the client.
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), DISABLED, "198.51.100.7")).toBe(
      "198.51.100.7",
    );
    expect(resolveClientIdentity(request({ "x-forwarded-for": "203.0.113.7" }), DISABLED, "198.51.100.7")).toBe(
      "198.51.100.7",
    );
  });

  test("an unconfigured boundary trusts a loopback peer's headers", () => {
    // The tunnel fix. A loopback peer carrying forwarded headers is the shape of
    // cloudflared / an SSH forward / a local Caddy: the edge observed the real
    // client and its TCP peer is 127.0.0.1.
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), DISABLED, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
    expect(resolveClientIdentity(request({ "x-forwarded-for": "203.0.113.7" }), DISABLED, "127.0.0.1")).toBe(
      "203.0.113.7",
    );
    // The mapped form Bun reports on Windows, and the IPv6 loopback.
    expect(
      resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), DISABLED, "::ffff:127.0.0.1"),
    ).toBe("203.0.113.7");
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), DISABLED, "::1")).toBe(
      "203.0.113.7",
    );
    // The preference order still applies: `cf-connecting-ip` wins.
    expect(
      resolveClientIdentity(
        request({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" }),
        DISABLED,
        "127.0.0.1",
      ),
    ).toBe("203.0.113.7");
    // No forwarded header at all: the loopback peer is still the client.
    expect(resolveClientIdentity(request(), DISABLED, "127.0.0.1")).toBe("127.0.0.1");
  });

  test("disabled mode ignores the chain even when an allowlist is present", () => {
    // DEFECT pin: `resolveClientIdentity` gates on `isTrustedPeer`, not on
    // `isTrustedProxyPeer`. A boundary carrying both `disabled` and an allowlist
    // is refused by `isTrustedProxyPeer` and must also be refused here.
    const boundary: TrustedProxyBoundary = { mode: "disabled", allowlist: ["127.0.0.1/32"] };
    expect(isTrustedProxyPeer("127.0.0.1", boundary)).toBe(false);
    expect(resolveClientIdentity(request({ "cf-connecting-ip": "203.0.113.7" }), boundary, "127.0.0.1")).toBe(
      "127.0.0.1",
    );
  });
});

describe("canonicalClientIpKey: mapped collapse and fail-closed rejects", () => {
  test("gives one host one key across every IPv4-mapped spelling", () => {
    // The per-IP rule is enforced on this key, so two keys for one host is two
    // allowances for one host.
    const expected = "v4:2130706433";
    expect(canonicalClientIpKey("127.0.0.1")).toBe(expected);
    expect(canonicalClientIpKey("::ffff:127.0.0.1")).toBe(expected);
    expect(canonicalClientIpKey("::ffff:7f00:1")).toBe(expected);
    expect(canonicalClientIpKey("::FFFF:7F00:1")).toBe(expected);
  });

  test("a mapped key equals the plain IPv4 key for the same host", () => {
    expect(canonicalClientIpKey("::ffff:cb00:7107")).toBe(canonicalClientIpKey("203.0.113.7"));
    expect(canonicalClientIpKey("::ffff:192.168.0.1")).toBe(canonicalClientIpKey("192.168.0.1"));
  });

  test("one host gets one key across every mapped spelling, expanded forms included", () => {
    // The defect this pins: `unwrapMappedIpv4` tested `startsWith("::ffff:")`, so
    // any form that writes the leading zero groups out missed the prefix test, fell
    // through to `ipv6ToBigInt`, and was treated as an unrelated IPv6 address.
    const plain = canonicalClientIpKey("127.0.0.1");
    expect(plain).toBe("v4:2130706433");
    for (const spelling of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::FFFF:7F00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "0:0:0:0:0:ffff:127.0.0.1",
    ]) {
      expect(canonicalClientIpKey(spelling)).toBe(plain);
    }
  });

  test("an address that only LOOKS mapped is left as IPv6", () => {
    // MEASURED: `::ffff:0:7f00:1` expands to `0:0:0:0:ffff:0:7f00:1` — the sixth
    // group is `0`, not `ffff`, so this is NOT an IPv4-mapped address.
    expect(canonicalClientIpKey("::ffff:0:7f00:1")).toBe(
      "v6:0000000000000000ffff00007f000001",
    );
    expect(canonicalClientIpKey("::ffff:0:7f00:1")).not.toBe(canonicalClientIpKey("127.0.0.1"));
  });

  test("the same collapse holds for a non-loopback mapped host", () => {
    // The loopback is the case the helper was written for; this is the general
    // property, so the fix is not loopback-specific.
    const plain = canonicalClientIpKey("203.0.113.7");
    for (const spelling of [
      "::ffff:203.0.113.7",
      "::ffff:cb00:7107",
      "0:0:0:0:0:ffff:cb00:7107",
    ]) {
      expect(canonicalClientIpKey(spelling)).toBe(plain);
    }
  });

  test("rejects invalid input instead of coercing it", () => {
    // The share router turns `undefined` into a 400 rather than minting a key,
    // so a permissive parse here would silently authorize the request.
    for (const address of [
      "",
      "not-an-ip",
      "1.2.3",
      "1.2.3.4.5",
      "010.0.0.1",
      " 127.0.0.1",
      "127.0.0.1 ",
      ":::",
      "::ffff:",
      "::ffff:1.2.3",
      "::ffff:256.0.0.1",
      "::ffff:zzzz:1",
      "::ffff:12345:1",
      "127.0.0.1%eth0",
    ]) {
      expect(canonicalClientIpKey(address)).toBeUndefined();
    }
  });

  test("a hex group with trailing junk is refused, not coerced", () => {
    // This used to be lenient: `parseInt("7f00z", 16)` is 0x7f00, so a group with
    // trailing junk unwrapped and keyed as 127.0.0.1, and `+`/space were accepted by
    // the same path.
    expect(canonicalClientIpKey("::ffff:7f00z:1")).toBeUndefined();
    expect(canonicalClientIpKey("::ffff:7f00:+1")).toBeUndefined();
    expect(canonicalClientIpKey("::ffff:7f00: 1")).toBeUndefined();
    expect(canonicalClientIpKey("::ffff:1.2.3.4.5")).toBeUndefined();
  });
});
