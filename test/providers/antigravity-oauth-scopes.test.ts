/**
 * Antigravity OAuth grants must carry the full native-scope set.
 *
 * The `aicode` scope is what gates the Cloud Code Assist inference surface. A
 * grant with the other five scopes still reads `fetchAvailableModels` and the
 * quota summary, so the account looks healthy — but `streamGenerateContent`
 * refuses it (429 RESOURCE_EXHAUSTED / 403 license). The desktop client asks
 * all six scopes on the same OAuth client id, so a login missing one yields a
 * token that cannot serve a model call.
 */
import { describe, expect, test } from "bun:test";
import { ANTIGRAVITY_SCOPES } from "../../src/providers/integrations/antigravity/antigravity-oauth";

describe("Antigravity OAuth scopes", () => {
  test("the native six-scope set is requested, including aicode", () => {
    const scopes = ANTIGRAVITY_SCOPES.split(" ");
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
      "https://www.googleapis.com/auth/aicode",
    ]);
  });
});
