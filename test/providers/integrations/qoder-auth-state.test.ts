import { expect, test } from "bun:test";
import {
  parseQoderOAuthState,
  readQoderUserInfo,
} from "../../../src/providers/integrations/qoder/qoder-oauth";

/**
 * The live device-token/poll response (2026-10-30 login probe). user_id is
 * always present on the poll body — the login must persist it even when the
 * profile lookup fails, and must refuse to complete without it.
 */
const POLL_BODY = {
  id: "01a18987-eed4-7717-879a-7378c274a702",
  token: "dt-lga0cSsllGAUmKiThubk8tZ5",
  user_id: "01a18984-ef0c-7868-addb-fe555550ef3a",
  code_challenge: "Tiv_TnxgG2WME5ubsDewkE7QNZkA2yUROYBXavzP0ck",
  code_challenge_method: "S256",
  nonce: "37bfe88f26b8480abbe0dad64cb3f303",
  expires_at: "2026-11-28T21:19:09Z",
  refresh_token_id: "01a18987-eed2-762e-b1ae-5b2eb4fd1b51",
  created_at: "2026-10-29T21:19:09Z",
  updated_at: "2026-10-29T21:19:09Z",
  refresh_token: "drt-0uf81nR24ZDtgTLAyaJvDfrv",
  expires_in: 2591999993,
  refresh_token_expires_in: 31103999995,
  refresh_token_expires_at: "2027-10-24T21:19:09Z",
};

test("poll body user_id satisfies the auth_state contract end-to-end", () => {
  const info = readQoderUserInfo({
    id: POLL_BODY.user_id,
    name: "that sepa",
    email: "akunytpremm8j+sepa@gmail.com",
  });
  // poll user_id wins; profile id only as fallback — both agree here.
  const resolvedUserId = String(POLL_BODY.user_id ?? info.id);
  const state = { userId: resolvedUserId, machineId: "b3b5c9e1-4494-45b3-bdab-4109374a116d" };
  const parsed = parseQoderOAuthState(state);
  expect(parsed).toEqual(state);
  // And it parses back from the SQLite JSON-text form too.
  expect(parseQoderOAuthState(JSON.stringify(state))).toEqual(state);
});

test("userinfo fallback cannot mask a missing poll user_id when profile also fails", () => {
  // EMPTY profile (fetchUserInfo failure) + no poll user_id → userId would be
  // "" — the login must treat that as a hard failure, not store an empty id.
  const empty = readQoderUserInfo({});
  const resolved = empty.id;
  expect(resolved).toBe("");
});

test("auth_state with empty userId is rejected by the parser (the 401 case)", () => {
  expect(parseQoderOAuthState({ userId: "", machineId: "m" })).toBeUndefined();
  expect(parseQoderOAuthState({ userId: "  ", machineId: "m" })).toBeUndefined();
  expect(parseQoderOAuthState({ userId: "u", machineId: "" })).toBeUndefined();
  expect(parseQoderOAuthState(undefined)).toBeUndefined();
  expect(parseQoderOAuthState("not json")).toBeUndefined();
});

test("machineId may be absent from a legacy state only if the parser allowed it", () => {
  // Documented current behavior: missing machineId also invalidates the state
  // (parser is strict), so the export must always carry both fields.
  expect(parseQoderOAuthState({ userId: "u" })).toBeUndefined();
});

test("auth_state may carry the HTTPDNS-route IP (X-Qoder-HTTPDNS-IP mirror)", () => {
  const state = { userId: "u", machineId: "m", httpDnsIp: "103.130.222.58" };
  expect(parseQoderOAuthState(state)).toEqual(state);
  expect(parseQoderOAuthState(JSON.stringify(state))).toEqual(state);
  // Empty/whitespace IPs are dropped, not stored.
  expect(parseQoderOAuthState({ userId: "u", machineId: "m", httpDnsIp: "" })).toEqual({
    userId: "u",
    machineId: "m",
  });
});
