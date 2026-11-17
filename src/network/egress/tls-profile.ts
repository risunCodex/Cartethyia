/**
 * TLS client-profile registry — "ClientHello/custom" egress support.
 *
 * The runtime's own TLS (Bun/BoringSSL) has a fixed ClientHello shape. When
 * an upstream meters per transport fingerprint, the egress layer must be able
 * to dial with a *chosen* TLS profile instead of the runtime default.
 *
 * Node's `tls`/`https` stack (OpenSSL) honors `ciphers`, `ciphersuites`,
 * `ALPNProtocols`, and `minVersion`/`maxVersion`, and Bun's Node-compat layer
 * forwards those options into its own handshake. So a profile is real: it is
 * the set of OpenSSL options that reproduce a target client's ClientHello.
 *
 * Profiles are pure data + one helper. They never open sockets; the dial
 * paths (`egress/fetch.ts`, `pool/resolver.ts`) apply them.
 */

/**
 * One re-playable TLS fingerprint.
 *
 * `ciphers` names the TLS 1.2 suite list in OpenSSL order (the order the
 * ClientHello advertises); `ciphersuites` names the TLS 1.3 suites in order.
 * `alpn` is the ALPN list in preference order. When a field is absent the
 * dial path leaves the runtime default in place for that knob.
 */
export interface TlsProfileConfig {
  /** Stable id used to look the profile up. */
  readonly id: string;
  /** Human description; not sent on the wire. */
  readonly label: string;
  /** OpenSSL TLS 1.2 cipher list, client order. */
  readonly ciphers?: string;
  /** OpenSSL TLS 1.3 cipher-suites list, client order. */
  readonly ciphersuites?: string;
  /** ALPN protocols in preference order. */
  readonly alpn?: readonly string[];
  /** OpenSSL/Node TLS version floor (`"TLSv1.2"` / `"TLSv1.3"`). */
  readonly minVersion?: string;
  /** OpenSSL/Node TLS version ceiling (`"TLSv1.3"`). */
  readonly maxVersion?: string;
}

/** Profile selector accepted by egress options. `"default"` = runtime default. */
export type TlsProfile = "default" | string;

/** Built-in profiles by id. Empty while no provider needs a named fingerprint. */
export const TLS_PROFILES: Readonly<Record<string, TlsProfileConfig>> = {};

/** Resolves a selector to a concrete profile; `"default"`/unknown → `undefined`. */
export function tlsProfileOf(profile: TlsProfile): TlsProfileConfig | undefined {
  if (profile === undefined || profile === "default") return undefined;
  return TLS_PROFILES[profile];
}

export interface NodeTlsOptions {
  ciphers?: string;
  ciphersuites?: string;
  ALPNProtocols?: readonly string[];
  minVersion?: string;
  maxVersion?: string;
}

/**
 * Maps a profile to the `tls`/`https` option set. `alpn` is included by
 * default; pass `includeAlpn: false` for transports that fix their own ALPN
 * (HTTP/2 bidi always negotiates `h2`).
 */
export function nodeTlsOptions(
  profile: TlsProfileConfig,
  includeAlpn = true,
): NodeTlsOptions {
  const out: NodeTlsOptions = {};
  if (profile.ciphers !== undefined) out.ciphers = profile.ciphers;
  if (profile.ciphersuites !== undefined) out.ciphersuites = profile.ciphersuites;
  if (includeAlpn && profile.alpn !== undefined && profile.alpn.length > 0) {
    out.ALPNProtocols = [...profile.alpn];
  }
  if (profile.minVersion !== undefined) out.minVersion = profile.minVersion;
  if (profile.maxVersion !== undefined) out.maxVersion = profile.maxVersion;
  return out;
}
