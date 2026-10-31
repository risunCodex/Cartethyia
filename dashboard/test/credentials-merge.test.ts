/**
 * Multi-file credential import merging.
 *
 * `mergeCredentialFiles` normalises several credential files into one paste
 * block the shared parser can read back as the same entries. The cases that
 * matter: several whole-JSON-array files must stay parseable (a naive
 * concatenation would break), wrapper exports (`{ accounts: [...] }`) must
 * unwrap, cookie bundles must stay whole (they are exactly one account), and a
 * non-JSON file must not be split into junk entries.
 */
import { expect, test } from "bun:test";
import { mergeCredentialFiles, parseCredentialBatch } from "../src/lib/credentials";

test("merges two JSON-array files into one parseable batch", () => {
  const merged = mergeCredentialFiles([
    { name: "a.json", text: JSON.stringify([{ apiKey: "sk-a-1" }, { apiKey: "sk-a-2" }]) },
    { name: "b.json", text: JSON.stringify([{ apiKey: "sk-b-1" }]) },
  ]);
  expect(merged.entries).toHaveLength(3);
  expect(merged.entries.map((entry) => entry.value)).toEqual([
    "sk-a-1",
    "sk-a-2",
    "sk-b-1",
  ]);
  // The merged text is re-parseable through the shared parser.
  expect(parseCredentialBatch(merged.text)).toHaveLength(3);
});

test("unwraps wrapper exports from several files", () => {
  const merged = mergeCredentialFiles([
    { name: "x.json", text: JSON.stringify({ accounts: [{ accessToken: "at-1", credentialKind: "api_key" }, { accessToken: "at-2", credentialKind: "api_key" }] }) },
    { name: "y.json", text: JSON.stringify({ items: [{ accessToken: "at-3", credentialKind: "api_key" }] }) },
  ]);
  expect(merged.entries).toHaveLength(3);
});

test("keeps a cookie bundle whole — split it would make N junk entries", () => {
  const bundle = JSON.stringify([
    { name: "sessionid", value: "abc", domain: ".example.com" },
    { name: "token", value: "t-123", domain: ".example.com" },
  ]);
  const merged = mergeCredentialFiles([{ name: "cookies.json", text: bundle }]);
  expect(merged.entries).toHaveLength(1);
  expect(merged.entries[0]?.value).toBe(bundle);
});

test("keeps a single structured object whole", () => {
  const obj = JSON.stringify({ access_token: "at-1", refresh_token: "rt-1" });
  const merged = mergeCredentialFiles([{ name: "one.json", text: obj }]);
  expect(merged.entries).toHaveLength(1);
  expect(merged.entries[0]?.kind).toBe("oauth");
});

test("a plain-text file with one token per line survives", () => {
  const merged = mergeCredentialFiles([
    { name: "keys.txt", text: "sk-line-1\nsk-line-2\nsk-line-3" },
  ]);
  expect(merged.entries).toHaveLength(3);
});

test("a single key:value block stays whole, not one entry per field", () => {
  const merged = mergeCredentialFiles([
    { name: "kv.txt", text: "apiKey: sk-kv-1\nregion: us-east" },
  ]);
  expect(merged.entries).toHaveLength(1);
  expect(merged.entries[0]?.value).toBe("sk-kv-1");
});

test("empty files contribute nothing", () => {
  const merged = mergeCredentialFiles([
    { name: "empty.json", text: "" },
    { name: "real.json", text: JSON.stringify([{ apiKey: "sk-only" }]) },
  ]);
  expect(merged.entries).toHaveLength(1);
});
