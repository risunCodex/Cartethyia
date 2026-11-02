// Pure network identity matching: CIDR/IP helpers and trusted-proxy client identity.

import { isIP } from "node:net";
import type { TrustedProxyBoundary } from "../config/network";
import { log } from "../observability/logger";
import {
  cidrContainsAddress,
  ipv4ToNumber,
  ipv6ToBigInt,
  isLoopbackAddress,
  unwrapMappedIpv4,
} from "../network/ip-utils";

export { isLoopbackAddress };

function matchesCidr(address: string, cidr: string): boolean {
  // `unwrapMapped: true`: a mapped peer and a plain-IPv4 allowlist entry
  // describe the same host (Bun reports the IPv4 loopback peer as
  // `::ffff:127.0.0.1` on Windows). `requirePrefix: false`: a bare address
  // (`"127.0.0.1"`) means "this exact host".
  return cidrContainsAddress(address, cidr, {
    requirePrefix: false,
    unwrapMapped: true,
  });
}

function isTrustedPeer(peer: string, boundary: TrustedProxyBoundary): boolean {
  // `platform` mode has no allowlist to match: the PaaS edge is the only way
  // in, which is what the mode asserts. See `TrustedProxyMode`.
  if (boundary.mode === "platform") return true;
  return boundary.allowlist?.some((entry) => matchesCidr(peer, entry)) ?? false;
}

/** Whether the TCP peer may vouch for forwarded headers (reverse-proxy trust). */
export function isTrustedProxyPeer(peer: string, boundary: TrustedProxyBoundary): boolean {
  return boundary.mode !== "disabled" && isTrustedPeer(peer, boundary);
}

/** Forwarded client-address headers, in the order they are believed. */
const CLIENT_IDENTITY_HEADERS = [
  "cf-connecting-ip",
  "true-client-ip",
  "x-forwarded-for",
  "x-real-ip",
] as const;

/**
 * True when `address` is a loopback address.
 */

/**
 * Whether a peer may vouch for forwarded headers *for client-address
 * resolution*.
 *
 * Wider than {@link isTrustedProxyPeer} by exactly one arm: an unconfigured
 * deployment (`mode: "disabled"`, no `TRUSTED_PROXY_CIDRS`) still trusts a
 * **loopback** peer. That arm is the fix for the tunnel collapse. A tunnel
 * (cloudflared, an SSH forward, a local Caddy/Nginx) is the ordinary reason a
 * request carries forwarded headers while its TCP peer is `127.0.0.1`, and
 * with nothing configured the old behavior ignored them — so every caller
 * behind the tunnel was recorded as the loopback address. Per-address abuse
 * throttling and model bans, both keyed on this value, then applied to all of
 * them together: one caller reaching the limit banned every other caller
 * behind the same tunnel.
 *
 * Deliberately NOT widened in {@link isTrustedProxyPeer} itself, because that
 * predicate also gates the console cookie's `secure` upgrade
 * (`securePolicyForRequest`) and the address source label in `request-context`.
 * Widening it there would change two decisions this change was not asked to
 * make. The one place the collapse is harmful is the client address, so that
 * is the one place the arm applies — and the difference is documented rather
 * than left as two predicates that silently disagree.
 *
 * An explicit `TRUSTED_PROXY_CIDRS` always overrides this: a configured
 * boundary is `trusted` or `platform`, and neither mode reaches the loopback
 * arm. An operator who names an allowlist that omits loopback has said the
 * tunnel is not trusted, and gets the warning instead.
 */
function isTrustedForClientAddress(peer: string, boundary: TrustedProxyBoundary): boolean {
  if (isTrustedProxyPeer(peer, boundary)) return true;
  // Only an *unconfigured* boundary takes the loopback arm — `disabled` with no
  // allowlist, which is exactly the shape `resolveTrustedProxyBoundary()` returns
  // when `TRUSTED_PROXY_CIDRS` is unset. A boundary that carries an allowlist is
  // a configured one whatever its mode says, and honoring the arm there would
  // contradict the operator's explicit `disabled`: `{ mode: "disabled",
  // allowlist: [...] }` must keep ignoring forwarded headers, which is what the
  // regression test for that shape pins.
  return (
    boundary.mode === "disabled" &&
    boundary.allowlist === undefined &&
    isLoopbackAddress(peer)
  );
}

/**
 * Whether this request looks like it arrived through a reverse proxy whose
 * forwarded headers the current boundary is going to ignore.
 *
 * The signature is a forwarded client-address header arriving from a peer whose
 * headers will not be believed. On its own that is normal and safe — any client
 * can send `X-Forwarded-For`, and ignoring it is correct. What makes it
 * dangerous is the peer being **loopback**: that is the shape of a tunnel, and
 * when the tunnel's headers are ignored every caller behind it collapses onto
 * one address.
 *
 * That collapse is not cosmetic. Per-address abuse throttling
 * (`IpAbuseProtectionService`) and model-abuse bans are keyed on this value, so
 * one caller reaching the limit bans every other caller behind the same
 * tunnel — the shared-fate failure that motivated this check. It is also
 * fail-open in the audit trail: the operator sees `127.0.0.1` for everyone.
 */
export function isSuspectedProxyCollapse(
  request: Request,
  boundary: TrustedProxyBoundary,
  peer: string,
): boolean {
  // Same predicate the resolver uses, so this cannot report a collapse that
  // the resolver has actually avoided.
  if (isTrustedForClientAddress(peer, boundary)) return false;
  if (!isLoopbackAddress(peer)) return false;
  return CLIENT_IDENTITY_HEADERS.some((name) => {
    const value = request.headers.get(name);
    return value !== null && value.trim().length > 0;
  });
}

/**
 * Warns once when a deployment is silently collapsing every caller onto one
 * address.
 *
 * Once, not per request: this path is on every `/v1/*` request, and a busy
 * gateway would otherwise emit the same paragraph thousands of times a minute.
 * The first occurrence is the one that names the fix; after that the condition
 * is unchanged and repeating it is noise.
 */
let collapseWarned = false;
/** Test seam: lets a suite assert the warning fires without process state. */
export function resetProxyCollapseWarningForTests(): void {
  collapseWarned = false;
}

function maybeWarnIgnoredForwardedHeaders(
  request: Request,
  boundary: TrustedProxyBoundary,
  peer: string,
): void {
  if (collapseWarned) return;
  if (!isSuspectedProxyCollapse(request, boundary, peer)) return;
  collapseWarned = true;
  // Via `log`, so this ships through the same transport as everything else and
  // is level-filtered. It was `console.warn` to keep the module importable
  // without the logger, but the logger pulls in only pino, the console log ring
  // and its own sanitizer — none of which import this module — so there is no
  // cycle and the boundary tests import it the same way production does.
  log.warn(
    `[ip-boundary] A forwarded client-address header arrived from a loopback peer ` +
      `(${unwrapMappedIpv4(peer)}) but the trusted-proxy boundary does not trust it, so ` +
      `the client address is the loopback peer for every caller. Every caller behind this ` +
      `tunnel then shares one address: per-IP abuse limits and model bans apply to all ` +
      `of them together, and the audit trail shows one address for everyone. ` +
      `Set TRUSTED_PROXY_CIDRS=127.0.0.1/32 (add ::1/128 for IPv6) to trust it explicitly.`,
  );
}

/**
 * trusts the raw TCP peer. `"trusted"` trusts proxy identity headers only when
 * the TCP peer itself matches `allowlist` (CIDR or exact address). `"platform"`
 * trusts them from any peer, for a PaaS edge that cannot be allowlisted.
 *
 * `CF-Connecting-IP` and `True-Client-IP` are preferred: both are single-valued
 * and overwritten by the edge, so they cannot carry a caller-supplied value.
 * The forwarded chain is read from its left end, which assumes the edge
 * *prepends* the address it observed — cloudflared's behavior, and the reason
 * the loopback allowlist works. An edge that instead *appends* leaves whatever
 * the caller sent at the left end, where it would be selected; a deployment
 * behind such an edge should send `CF-Connecting-IP`/`True-Client-IP` (both
 * overwritten) or a trusted-peer allowlist narrow enough that direct callers
 * cannot reach it. Which one Railway does is not established here.
 */
export function resolveClientIdentity(
  request: Request,
  boundary: TrustedProxyBoundary,
  peer: string,
): string {
  const fallback = unwrapMappedIpv4(peer);
  // `isTrustedForClientAddress`, not `isTrustedProxyPeer`: an unconfigured
  // deployment trusts a loopback peer here, so a tunnel's forwarded headers are
  // believed and its callers keep their own addresses. See that function for
  // why the arm is here and not in `isTrustedProxyPeer`.
  if (!isTrustedForClientAddress(peer, boundary)) {
    maybeWarnIgnoredForwardedHeaders(request, boundary, peer);
    return fallback;
  }
  // The trust gate is above. The check that used to stand here gated on
  // `isTrustedPeer`, which never consults `mode` unless it is `platform` — so a
  // boundary carrying both `disabled` and an allowlist honored forwarded headers
  // while `isTrustedProxyPeer` refused the same peer, and the module held two
  // contradictory answers to "is this peer trusted?" for one request. The
  // consequence was the spoofing property: a caller able to reach the port named
  // its own client address — the dimension the per-IP abuse limits are counted
  // on. `isTrustedForClientAddress` (above) is the single gate now: it defers to
  // `isTrustedProxyPeer`, so the `disabled` mode it names is honored, and it adds
  // only the loopback arm this function documents.
  for (const name of CLIENT_IDENTITY_HEADERS) {
    const values = (request.headers.get(name) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    // A proxy may itself forward a mapped form; store the canonical spelling
    // so one host is one dimension value rather than two.
    if (values[0]) return unwrapMappedIpv4(values[0]);
  }
  return fallback;
}

/**
 * Produces a stable, family-tagged identity key for database uniqueness.
 * Mapped IPv4 and alternate IPv6 spellings collapse to one canonical address.
 */
export function canonicalClientIpKey(address: string): string | undefined {
  const normalized = unwrapMappedIpv4(address);
  const family = isIP(normalized);
  if (family === 4) {
    const value = ipv4ToNumber(normalized);
    return value === undefined ? undefined : `v4:${value}`;
  }
  if (family === 6) {
    const value = ipv6ToBigInt(normalized);
    return value === undefined ? undefined : `v6:${value.toString(16).padStart(32, "0")}`;
  }
  return undefined;
}
