import { describe, expect, test } from "bun:test";
import {
  QODER_APP_TLS_PROFILE,
  nodeTlsOptions,
  tlsProfileOf,
} from "../../src/network/egress/tls-profile";
import { createProfileAgent } from "../../src/network/egress/fetch";

describe("TLS profiles (ClientHello/custom support)", () => {
  test("qoder-app profile mirrors the captured desktop ClientHello suite order", () => {
    const p = QODER_APP_TLS_PROFILE;
    expect(tlsProfileOf("qoder-app")).toBe(p);
    // From `hijack/conn.log` (2026-11-11): the app's COSY chat ClientHello
    // advertises exactly these 18 suites in this order.
    expect(p.ciphers).toBe(
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
    );
    expect(p.ciphersuites).toBe(
      "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256",
    );
    // COSY chat ALPN: http/1.1 only (no h2 on the legacy surface).
    expect(p.alpn).toEqual(["http/1.1"]);
    expect(p.minVersion).toBe("TLSv1.2");
    expect(p.maxVersion).toBe("TLSv1.3");
  });

  test("tlsProfileOf maps default/unknown to undefined", () => {
    expect(tlsProfileOf("default")).toBeUndefined();
    expect(tlsProfileOf(undefined as never)).toBeUndefined();
    expect(tlsProfileOf("no-such-profile")).toBeUndefined();
  });

  test("nodeTlsOptions maps profile knobs to Node TLS options", () => {
    const opts = nodeTlsOptions(QODER_APP_TLS_PROFILE);
    expect(opts.ciphers).toBe(QODER_APP_TLS_PROFILE.ciphers);
    expect(opts.ciphersuites).toBe(QODER_APP_TLS_PROFILE.ciphersuites);
    expect(opts.ALPNProtocols).toEqual(["http/1.1"]);
    expect(opts.minVersion).toBe("TLSv1.2");
    expect(opts.maxVersion).toBe("TLSv1.3");
    // Bidi transports fix ALPN themselves (h2); omit it when asked.
    const noAlpn = nodeTlsOptions(QODER_APP_TLS_PROFILE, false);
    expect(noAlpn.ALPNProtocols).toBeUndefined();
  });

  test("createProfileAgent builds an https agent carrying the profile's TLS options", () => {
    const agent = createProfileAgent(QODER_APP_TLS_PROFILE);
    expect(agent).toBeDefined();
    const opts = agent.options as unknown as Record<string, unknown>;
    expect(opts["ciphers"]).toBe(QODER_APP_TLS_PROFILE.ciphers);
    expect(opts["ciphersuites"]).toBe(QODER_APP_TLS_PROFILE.ciphersuites);
    expect(opts["minVersion"]).toBe("TLSv1.2");
    expect(opts["maxVersion"]).toBe("TLSv1.3");
    // The agent's ALPN list holds the profile's preferred protocols.
    const alpn = opts["ALPNProtocols"] as unknown as Buffer[] | string[] | undefined;
    if (Array.isArray(alpn) && alpn.length > 0) {
      const first = alpn[0] as unknown;
      const asString = typeof first === "string" ? first : Buffer.from(first as Buffer).toString();
      expect(asString).toBe("http/1.1");
    }
  });
});
