/**
 * Kiro account label resolution.
 *
 * The console labels a Kiro account from the sign-in token when it can, and
 * falls back to a per-family label when the token is opaque (the social access
 * token is not a JWT). These tests pin that contract: JWT identity fields are
 * extracted in the specified order, opaque/non-JWT credentials yield no label,
 * and the family fallbacks are stable.
 */
import { describe, expect, test } from "bun:test";
import {
  kiroAccountLabel,
  kiroDefaultLabel,
} from "../../src/providers/integrations/kiro/kiro-oauth";

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.`;
}

describe("kiroAccountLabel", () => {
  test("extracts email first", () => {
    expect(
      kiroAccountLabel(makeJwt({ email: "user@example.com", sub: "s-1" })),
    ).toBe("user@example.com");
  });

  test("falls back to preferred_username", () => {
    expect(
      kiroAccountLabel(makeJwt({ preferred_username: "dev", email: "" })),
    ).toBe("dev");
  });

  test("falls back to upn", () => {
    expect(
      kiroAccountLabel(makeJwt({ upn: "org-user@corp.example", email: " " })),
    ).toBe("org-user@corp.example");
  });

  test("falls back to sub", () => {
    expect(kiroAccountLabel(makeJwt({ sub: "s-2" }))).toBe("s-2");
  });

  test("returns undefined when the payload has no identity", () => {
    expect(kiroAccountLabel(makeJwt({ iss: "https://issuer", exp: 123 }))).toBeUndefined();
  });

  test("returns undefined for an opaque token", () => {
    expect(kiroAccountLabel("not.a.jwt")).toBeUndefined();
  });

  test("returns undefined for no token", () => {
    expect(kiroAccountLabel(undefined)).toBeUndefined();
  });
});

describe("kiroDefaultLabel", () => {
  test("names each sign-in family", () => {
    expect(kiroDefaultLabel("google")).toBe("Google account");
    expect(kiroDefaultLabel("github")).toBe("GitHub account");
    expect(kiroDefaultLabel("builder-id")).toBe("AWS Builder ID");
    expect(kiroDefaultLabel("idc")).toBe("IAM Identity Center");
    expect(kiroDefaultLabel("external_idp")).toBe("Enterprise IdP");
    expect(kiroDefaultLabel("imported")).toBe("Imported Kiro session");
    expect(kiroDefaultLabel("api_key")).toBe("Kiro API key");
  });
});
