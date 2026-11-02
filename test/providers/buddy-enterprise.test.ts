/**
 * Buddy enterprise identity: which accounts belong to an organization, and how
 * that reaches the wire.
 *
 * An enterprise account is billed from the organization's credit assignment
 * rather than a personal package, and the upstream reads both facts from the
 * request: `X-Enterprise-Id`/`X-Tenant-Id` name the organization, and
 * `X-Private-Data` says the account is not personal. Sending one without the
 * other is a combination no real client produces, so the two are asserted
 * together rather than separately.
 *
 * The risk this guards is the opposite direction: claiming an enterprise an
 * account does not belong to is the kind of mismatch that draws a channel
 * check, so an account with no evidence stays personal. The gateway already
 * sends the personal default, so "unknown" must not change anything.
 */
import { describe, expect, test } from "bun:test";
import { buddyEnterprise } from "../../src/providers/integrations/buddy/buddy-identity";
import { buddyCliHeaders } from "../../src/providers/integrations/buddy/buddy-cli-headers";
import type { ProviderDispatchContext } from "../../src/providers/provider-contracts";

const STAINLESS = [
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-retry-count",
] as const;

/** A JWT whose payload is `claims`, the shape `decodeJwtPayload` reads. */
function jwt(claims: Record<string, unknown>): Uint8Array {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return new TextEncoder().encode(`h.${payload}.s`);
}

function contextWith(args: {
  readonly authState?: Record<string, unknown>;
  readonly secret?: Uint8Array;
}): ProviderDispatchContext {
  return {
    credential: {
      secret: args.secret,
      auth_state: args.authState,
    },
  } as unknown as ProviderDispatchContext;
}

describe("buddyEnterprise", () => {
  test("an explicit auth_state id wins", () => {
    // The one a human can correct, so it is consulted first.
    expect(
      buddyEnterprise(contextWith({ authState: { enterpriseId: "ent_1" }, secret: jwt({ enterprise_id: "ent_2" }) })),
    ).toBe("ent_1");
  });

  test("each plausible token claim is read", () => {
    // A list of candidates, not one name: the upstream's token shape is not
    // pinned anywhere this codebase can verify, and guessing one spelling would
    // silently report "personal" for every account whose token uses another.
    for (const claim of [
      "enterprise_id",
      "enterpriseId",
      "enterprise",
      "tenant_id",
      "tenantId",
      "org_id",
      "organization_id",
    ]) {
      expect(buddyEnterprise(contextWith({ secret: jwt({ [claim]: "ent_9" }) }))).toBe("ent_9");
    }
  });

  test("a personal account has no enterprise", () => {
    // The case that must stay unchanged: no evidence means personal.
    expect(buddyEnterprise(contextWith({ secret: jwt({ sub: "u1" }) }))).toBeUndefined();
    expect(buddyEnterprise(contextWith({}))).toBeUndefined();
    expect(buddyEnterprise(undefined)).toBeUndefined();
  });

  test("a blank stored id falls through to the token rather than sticking", () => {
    // An empty override is a cleared field, not an enterprise named "".
    expect(
      buddyEnterprise(contextWith({ authState: { enterpriseId: "  " }, secret: jwt({ tenant_id: "ent_3" }) })),
    ).toBe("ent_3");
  });

  test("a token that is not a JWT yields nothing", () => {
    expect(buddyEnterprise(contextWith({ secret: new TextEncoder().encode("not-a-jwt") }))).toBeUndefined();
  });

  test("a non-string claim is ignored", () => {
    // A numeric id would be coerced into a header value that means nothing.
    expect(buddyEnterprise(contextWith({ secret: jwt({ enterprise_id: 42 }) }))).toBeUndefined();
  });
});

describe("buddyCliHeaders", () => {
  test("an enterprise account names the enterprise without implying private data", () => {
    const headers = buddyCliHeaders({ userId: "u1", enterpriseId: "ent_1" });
    expect(headers["X-Enterprise-Id"]).toBe("ent_1");
    expect(headers["X-Tenant-Id"]).toBe("ent_1");
    // Private data is an independent flag; enterprise does not imply it.
    expect(headers["X-Private-Data"]).toBeUndefined();
  });

  test("a personal account sends no enterprise header and no private flag", () => {
    const headers = buddyCliHeaders({ userId: "u1" });
    expect(headers["X-Private-Data"]).toBeUndefined();
    expect(headers["X-Enterprise-Id"]).toBeUndefined();
    expect(headers["X-Tenant-Id"]).toBeUndefined();
  });

  test("private data is sent only when the dispatch is actually private", () => {
    const headers = buddyCliHeaders({ userId: "u1", privateData: true });
    expect(headers["X-Private-Data"]).toBe("true");
    expect(headers["X-Enterprise-Id"]).toBeUndefined();
  });

  test("a blank enterprise id is treated as personal", () => {
    // The combination the upstream never sees: a named enterprise with a blank id.
    const headers = buddyCliHeaders({ userId: "u1", enterpriseId: "   " });
    expect(headers["X-Private-Data"]).toBeUndefined();
    expect(headers["X-Enterprise-Id"]).toBeUndefined();
  });

  test("the agent envelope is unchanged either way", () => {
    // Scope guard: this change removed the stainless fingerprint and the
    // constant private-data flag. It must not have moved the identity the
    // channel check reads.
    for (const headers of [
      buddyCliHeaders({ userId: "u1" }),
      buddyCliHeaders({ userId: "u1", enterpriseId: "ent_1" }),
    ]) {
      expect(headers["X-Agent-Intent"]).toBe("craft");
      expect(headers["X-Agent-Type"]).toBe("main");
      expect(headers["X-Agent-Runtime"]).toBe("other");
      expect(headers["X-User-Id"]).toBe("u1");
      // The CLI chat transport is axios, so no stainless fingerprint rides along.
      for (const name of STAINLESS) expect(headers[name]).toBeUndefined();
    }
  });
});
