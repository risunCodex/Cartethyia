/**
 * Which account a re-login replaces.
 *
 * The failure this pins: a provider that resolves no account label falls back to
 * the refresh token for its identity. When the flow also mirrors the access
 * token into the refresh field (Cursor's device/API-key grant does exactly
 * that), two *different* logins can hash the same way or, worse, an unchanged
 * value makes a genuinely new account land on the old row — the operator adds a
 * second account and watches the first one disappear.
 *
 * The identity has to be something the upstream says is *the account*, not
 * something that merely happens to be present.
 */
import { describe, expect, test } from "bun:test";
import { oauthIdentityFingerprint } from "../../src/console/providers/oauth/routes";

type FingerprintInput = Parameters<typeof oauthIdentityFingerprint>[0];

function result(overrides: Partial<FingerprintInput> = {}): FingerprintInput {
  const {
    providerId = "cursor",
    label = "",
    access = "access-token",
    refresh = "refresh-token",
    expiresAt = new Date(0),
  } = overrides;
  return {
    providerId,
    label,
    access,
    refresh,
    expiresAt,
    ...(overrides.auth_state === undefined ? {} : { auth_state: overrides.auth_state }),
    ...(overrides.accountLabel === undefined ? {} : { accountLabel: overrides.accountLabel }),
  };
}

describe("oauth re-login identity", () => {
  test("a labelled account is identified by its label, not its tokens", () => {
    const first = result({ label: "dev@example.com", access: "a1", refresh: "r1" });
    const same = result({ label: "dev@example.com", access: "a2", refresh: "r2" });
    const other = result({ label: "other@example.com", access: "a1", refresh: "r1" });
    expect(oauthIdentityFingerprint({ ...first, providerId: "cursor" })).toBe(oauthIdentityFingerprint({ ...same, providerId: "cursor" }));
    expect(oauthIdentityFingerprint({ ...first, providerId: "cursor" })).not.toBe(oauthIdentityFingerprint({ ...other, providerId: "cursor" }));
  });

  test("two logins with no label and identical refresh tokens are one account", () => {
    // The documented fallback: an exact replay of the same refresh grant is the
    // same account and must be replaced, not appended.
    const a = result({ label: "", refresh: "same-refresh", access: "a1" });
    const b = result({ label: "", refresh: "same-refresh", access: "a2" });
    expect(oauthIdentityFingerprint({ ...a, providerId: "cursor" })).toBe(oauthIdentityFingerprint({ ...b, providerId: "cursor" }));
  });

  test("two logins with no label and different refresh tokens are different accounts", () => {
    const a = result({ label: "", refresh: "refresh-a" });
    const b = result({ label: "", refresh: "refresh-b" });
    expect(oauthIdentityFingerprint({ ...a, providerId: "cursor" })).not.toBe(oauthIdentityFingerprint({ ...b, providerId: "cursor" }));
  });

  test("a flow that mirrors the access token into refresh does not merge distinct accounts", () => {
    // The Cursor bug: `refresh` defaults to `access`. Two separate logins mint
    // two different access tokens, so they must stay two rows — the identity
    // cannot come from a value that changes on every grant.
    const a = result({ label: "", access: "jwt-a", refresh: "jwt-a" });
    const b = result({ label: "", access: "jwt-b", refresh: "jwt-b" });
    expect(oauthIdentityFingerprint({ ...a, providerId: "cursor" })).not.toBe(oauthIdentityFingerprint({ ...b, providerId: "cursor" }));
  });

  test("structured accountName distinguishes accounts that share a display label", () => {
    // The clixad bug: one email (or one linked GitHub login) fronts several
    // accounts, so the display label collides and a second account replaced the
    // first. The provider's unique per-account id, reported as accountName, is
    // the identity — two accounts must stay two rows.
    const base = { providerId: "clixad", label: "shared@example.com", access: "a", refresh: "a", expiresAt: new Date(0) };
    const a = { ...base, accountName: "u1" };
    const b = { ...base, accountName: "u2" };
    expect(oauthIdentityFingerprint(a)).not.toBe(oauthIdentityFingerprint(b));
    // A re-login of the same account coalesces even as its tokens rotate.
    const a2 = { ...base, accountName: "u1", access: "a2", refresh: "a2" };
    expect(oauthIdentityFingerprint(a)).toBe(oauthIdentityFingerprint(a2));
  });

  test("an unresolved label that falls back to the provider id is not an identity", () => {
    // The Cursor bug, reproduced: the flow resolves no email, so `label` is
    // filled with the provider id. Every login then hashes to the same value,
    // the second one matches the first row, and adding an account replaces the
    // account that was already there.
    const first = result({ label: "cursor", access: "jwt-a", refresh: "jwt-a" });
    const second = result({ label: "cursor", access: "jwt-b", refresh: "jwt-b" });
    expect(oauthIdentityFingerprint({ ...first, providerId: "cursor" })).not.toBe(oauthIdentityFingerprint({ ...second, providerId: "cursor" }));
  });
});
