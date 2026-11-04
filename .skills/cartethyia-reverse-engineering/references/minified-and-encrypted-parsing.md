# Parsing minified bundles and encrypted content

Companion to `unpacking-and-wire-capture.md`. These recipes cover what to do
once a blob is recovered but the interesting content is minified JS, packed
data, or encrypted payloads. Techniques here were proven while unpacking
Antigravity IDE 2.6.0 (Google VS Code fork, Inno Setup 6.4) and on earlier
vendors (Kiro, Cursor, CodeBuddy, OpenCode, Grok).

## 1. Minified JS bundles

- **Minified JS is readable after formatting.** Hashed/minified bundles
  (Rolldown/esbuild/webpack) are NOT byte-encrypted; string literals survive.
  Reformatted with `scripts/provider-probing/lib/beautify.ts` (tolerant of
  byte-corrupted / truncated input, never throws).
- **Do not read linearly.** Search for behavior markers instead:
  - endpoints: `baseURL`, `/inference`, `/chat/completions`, `/v1/`,
    `/v2/`, host literals (`...googleapis.com`, `accounts.google.com`);
  - header builders: `Authorization`, `Bearer`, `User-Agent`, `X-Request-ID`,
    custom Cosy-/X-* headers;
  - auth/OAuth: `client_id`, `client_secret`, `access_token`, `refresh_token`,
    `redirect_uri`, `oauth2`;
  - operation names, error strings, env-var names (they survive minification).
- **In a big concatenated blob** (e.g. an Inno-decompressed 950MB payload):
  1. Scan for a unique string that pins the asset (e.g. `workbench.desktop.main.js`,
     `"nameShort":`, `package.json` fields, extension paths like
     `extensions/antigravity`).
  2. Carve the JSON/JS by balanced delimiters with **string-literal awareness**
     (track `"` and `\` escapes; only `{`/`}` outside strings count) — see §3.
  3. Verify the carve by matching known-good metadata (e.g. `ideVersion`,
     appId) against other recovered artifacts (product.json vs setup header).

## 2. Encrypted or packed content

- **Inno Setup encryption.** Detect the `EncryptionUsed` header flag; file
  chunks may be ARC4 (MD5 before 5.3.9, SHA1 from 5.3.9). Password salt =
  8 bytes prefixed with the literal `PasswordCheckHash`; the stored hash is a
  SHA1/MD5/CRC32 of salt+password. `innoextract --password` handles it when
  the password is known.
- **General detection.** Look for crypto headers/magic: PEM blocks, GPG
  armor, custom magic before the payload, near-zero entropy (high-per-byte
  Shannon entropy or zlib-depth) vs. plaintext. A quick compressed-vs-plain
  test: try zlib/LZMA at candidate offsets.
- **Packed/obfuscated sections.** XOR-encoded data often appears as high-
  entropy runs adjacent to readable strings; try common single-byte XOR keys,
  vendor defaults, or platform-specific keys only after checking for a plain
  key string in the same binary.
- **If encryption defeats static analysis, stop guessing.** The reliable
  path is capturing the client's own outbound traffic (see §4 in
  `unpacking-and-wire-capture.md`) or reading the client's protocol
  definitions (proto/catalog/package.json) instead of decrypting.

## 3. Carving JSON from a concatenated blob (balanced-brace scanner)

A simple, effective carve:

```
scan from start offset for the first '{' (within a short window)
then walk bytes tracking:
  - string state: enter on '"', exit on unescaped '"' ('\'
    toggles escape)
  - depth: '{' +1, '}' -1
stop at depth 0 → that byte is the JSON end
```

Guard rails:
- Cap the max length (start ~10KB, raise to ~200KB for product.json-class
  files; VS Code `product.json` here was 44,752 bytes).
- Only accept if the head parses as JSON (`JSON.parse`) and the tail closes
  cleanly; otherwise widen the window.
- Validate semantics against known fields (e.g. a `product.json` should
  contain `"nameShort"`, `"applicationName"`, `"quality"`).

## 4. Evidence discipline

- Keep an evidence ledger: artifact, version, tool, offsets, observed result.
- Label every unverified assumption; do not promote a plausible parse to a
  fact.
- Never launch extracted executables to "discover" behavior — static
  inspection only, and redact credentials from any sample saved to the repo.
