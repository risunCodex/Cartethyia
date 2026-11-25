/**
 * Peer-address classification for routes that must only be reachable from the
 * machine running the gateway.
 *
 * Kept out of the transport layer so the console composition root can use it
 * without importing `src/transport/` — the same reason the console declares its
 * collaborators structurally instead of importing their owners.
 */

/**
 * Whether the peer is loopback. Accepts the IPv4-mapped IPv6 spelling Bun uses
 * on Windows (`::ffff:127.0.0.1`) and the whole `127.0.0.0/8` block, so the
 * check matches however the socket reports a local caller.
 */
export function isLoopbackPeer(peer: string | null): boolean {
  if (peer === null || peer.length === 0) return false;
  const normalized = peer.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  return bare === "127.0.0.1" || bare.startsWith("127.");
}
