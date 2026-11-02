/**
 * Auth-method pill mapping for account rows.
 *
 * The pill labels a connected account by the family that signed it in
 * (Social / OIDC / Enterprise IdP / API key / Imported), so multiple Kiro
 * accounts stop looking identical. This is pure mapping — it is the exact
 * function the row renders.
 */
import { describe, expect, test } from "bun:test";
import { authMethodPill } from "../src/features/provider-detail/sections/account-auth-method";

describe("authMethodPill", () => {
  test("labels social families as Social (accent)", () => {
    expect(authMethodPill("google")).toEqual({ label: "Social", tone: "accent" });
    expect(authMethodPill("github")).toEqual({ label: "Social", tone: "accent" });
  });

  test("labels OIDC families as OIDC", () => {
    expect(authMethodPill("builder-id")).toEqual({ label: "OIDC", tone: "default" });
    expect(authMethodPill("idc")).toEqual({ label: "OIDC", tone: "default" });
  });

  test("labels enterprise / api_key / imported distinctly", () => {
    expect(authMethodPill("external_idp")).toEqual({ label: "Enterprise IdP", tone: "default" });
    expect(authMethodPill("api_key")).toEqual({ label: "API key", tone: "default" });
    expect(authMethodPill("imported")).toEqual({ label: "Imported", tone: "default" });
  });

  test("returns null for unknown or missing auth methods", () => {
    expect(authMethodPill(undefined)).toBeNull();
    expect(authMethodPill("weird")).toBeNull();
  });
});
