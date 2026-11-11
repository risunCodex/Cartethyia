/**
 * TLS client-profile registry — "ClientHello/custom" egress support.
 *
 * The runtime's own TLS (Bun/BoringSSL) has a fixed ClientHello shape, which
 * is fine when the client we impersonate is itself Bun — Qoder's desktop
 * worker runs on Bun and its captured ClientHello (2026-11-11, `api2.qoder.sh`
 * hijack) matches Bun's default byte-for-byte. But when an upstream meters per
 * transport fingerprint, the egress layer must be able to dial with a *chosen*
 * TLS profile instead of the runtime default.
 *
 * Node's `tls`/`https` stack (OpenSSL) honors `ciphers`, `ciphersuites`,
 * `ALPNProtocols`, and `minVersion`/`maxVersion`, and Bun's Node-compat layer
 * forwards those options into its own handshake — verified live (2026-11-11):
 * an `https.Agent({ ALPNProtocols: ["h2"] })` changes the ALPN extension, and
 * `ciphers` changes the offered cipher list. So a profile is real: it is the
 * set of OpenSSL options that reproduce a target client's ClientHello.
 *
 * Profiles are pure data + one helper. They never open sockets; the dial
 * paths (`outbound-fetch.ts`, `pool/resolver.ts`) apply them.
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
  /** Stable id used to look the profile up (e.g. `"qoder-app"`). */
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

/**
 * The Qoder Desktop 0.5.7 chat fingerprint, from the live ClientHello capture
 * (`documentation/research/qoder/2026-11-11-qoder-desktop-0.5.7-chat-surface-evidence.md`
 * §9, `hijack/conn.log`): 18 suites in this exact order, ALPN `http/1.1`
 * only, TLS 1.2–1.3. This is the profile to dial with when an upstream expects
 * the Qoder desktop client's transport identity.
 */
export const QODER_APP_TLS_PROFILE: TlsProfileConfig = {
  id: "qoder-app",
  label: "Qoder Desktop 0.5.7 (Bun/1.4.x worker) COSY chat",
  // TLS 1.3 suites, client order (capture: 1301 1302 1303).
  ciphersuites:
    "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256",
  // TLS 1.2 suites, client order (capture: c02f c02b c030 c02c c027 cca9
  // cca8 c009 c013 c00a c014 009c 009d 002f 0035).
  ciphers:
    "ECDHE-RSA-AES128-GCM-SHA256:" +
    "ECDHE-ECDSA-AES128-GCM-SHA256:" +
    "ECDHE-RSA-AES256-GCM-SHA384:" +
    "ECDHE-ECDSA-AES256-GCM-SHA384:" +
    "ECDHE-RSA-AES128-CBC-SHA256:" +
    "ECDHE-ECDSA-CHACHA20-POLY1305:" +
    "ECDHE-RSA-CHACHA20-POLY1305:" +
    "ECDHE-ECDSA-AES128-CBC-SHA:" +
    "ECDHE-RSA-AES128-CBC-SHA:" +
    "ECDHE-ECDSA-AES256-CBC-SHA:" +
    "ECDHE-RSA-AES256-CBC-SHA:" +
    "AES128-GCM-SHA256:" +
    "AES256-GCM-SHA384:" +
    "AES128-CBC-SHA:" +
    "AES256-CBC-SHA",
  alpn: ["http/1.1"],
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.3",
};

/** Built-in profiles by id. */
export const TLS_PROFILES: Readonly<Record<string, TlsProfileConfig>> = {
  [QODER_APP_TLS_PROFILE.id]: QODER_APP_TLS_PROFILE,
};

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
