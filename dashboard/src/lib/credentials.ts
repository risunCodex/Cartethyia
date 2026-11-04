/**
 * Auto-detects credential kind (api_key, JWT, or OAuth), extracts the actual
 * secret value, and — for multi-credential pastes — splits a batch paste
 * (JSON array, newline-delimited JSON exports, or newline-delimited plain
 * tokens) into individually named entries. Mirrors the paste-detection and
 * bulk-import UX from the reference dashboard so users never have to
 * manually pick a credential kind or add accounts one at a time.
 */

const CREDENTIAL_FIELD_PRIORITY = [
  "access",
  "accessToken",
  "access_token",
  "sessionToken",
  "session_token",
  "token",
  "apiKey",
  "api_key",
  "key",
  "credential",
  "pat",
  "secret",
] as const;

/**
 * Refresh-token fields are the only reliable signal that a pasted credential
 * can be renewed. Expiry/id-token fields also occur on access-only JWT exports,
 * which must stay static and must not enter an OAuth refresh endpoint.
 */
/**
 * Refresh-token fields.
 *
 * A refresh field is the unambiguous OAuth signal: nothing API-key-shaped
 * carries one. Token fields alone are NOT sufficient — `{ access_token: "at" }`
 * is how several providers export a plain key, so treating a lone token as
 * OAuth turned a static export into a "refreshable" one that could never
 * refresh.
 */
const OAUTH_REFRESH_FIELDS = ["refresh", "refreshToken", "refresh_token"] as const;

/**
 * Fields whose presence identifies one record as a Cartethyia account export
 * row (`ProviderAccountExport`). Such a row carries its credential under
 * `accessToken` and its kind under `credentialKind`; without this, an exported
 * row is read as an opaque blob and loses its credential during re-import.
 */
const EXPORT_ROW_FIELDS = ["credentialKind", "providerId", "accessToken"] as const;

/**
 * Wrapper keys a batch export nests its rows under. Cartethyia's own export
 * uses `accounts`; the batch-import shape shared by the reference dashboards
 * uses the same key, so one unwrap serves both.
 */
const ACCOUNTS_WRAPPER_KEYS = ["accounts", "items", "connections"] as const;

/** Fields consulted (in order) to auto-name an account from a parsed JSON credential. */
const IDENTITY_FIELD_PRIORITY = [
  "email",
  "name",
  "accountId",
  "account_id",
  "id",
  "login",
  "username",
] as const;

export interface ExtractedCredential {
  readonly value: string;
  readonly extracted: boolean;
  readonly source?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

/** Resolves `obj.data` to a record, parsing it as JSON first when it's a string. */
function nestedRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = obj.data;
  if (typeof data === "string") {
    try {
      return asRecord(JSON.parse(data));
    } catch {
      return undefined;
    }
  }
  return asRecord(data);
}

function extractFromObject(obj: Record<string, unknown>): ExtractedCredential | undefined {
  for (const field of CREDENTIAL_FIELD_PRIORITY) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return { value: value.trim(), extracted: true, source: field };
    }
  }
  const nested = nestedRecord(obj);
  if (!nested) return undefined;
  for (const field of CREDENTIAL_FIELD_PRIORITY) {
    const value = nested[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return { value: value.trim(), extracted: true, source: `data.${field}` };
    }
  }
  return undefined;
}

/** Best-effort "who owns this credential" (email/name/accountId/...), checked top-level and in `data`. */
function identityFromObject(obj: Record<string, unknown>): string | undefined {
  for (const field of IDENTITY_FIELD_PRIORITY) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const nested = nestedRecord(obj);
  if (!nested) return undefined;
  for (const field of IDENTITY_FIELD_PRIORITY) {
    const value = nested[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function oauthShapeFromObject(obj: Record<string, unknown>): boolean {
  const present = (record: Record<string, unknown>, fields: readonly string[]) =>
    fields.some(
      (field) => typeof record[field] === "string" || typeof record[field] === "number",
    );
  const hasShape = (record: Record<string, unknown>) =>
    present(record, OAUTH_REFRESH_FIELDS);
  if (hasShape(obj)) return true;
  const nested = nestedRecord(obj);
  return nested ? hasShape(nested) : false;
}
function decodeJwtPayload(raw: string): Record<string, unknown> | undefined {
  const segments = raw.trim().split(".");
  if (segments.length !== 3) return undefined;
  try {
    const encoded = (segments[1] as string).replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), "=");
    const parsed: unknown = JSON.parse(atob(padded));
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

/** Returns the JWT `exp` claim as an ISO timestamp for account-card display. */
export function jwtExpiresAt(raw: string): string | undefined {
  const exp = decodeJwtPayload(raw)?.["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  const date = new Date(exp * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}


function parseKeyValueLines(text: string): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  let matches = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key === undefined || value === undefined) continue;
    result[key] = value.trim();
    matches += 1;
  }
  return matches > 0 ? result : undefined;
}

function parsedJson(trimmed: string): unknown {
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Extracts the actual secret value from a pasted JSON export or key:value block. */
export function extractCredentialFromPaste(raw: string): ExtractedCredential {
  const trimmed = raw.trim();
  const json = asRecord(parsedJson(trimmed));
  if (json) {
    const extracted = extractFromObject(json);
    if (extracted) return extracted;
  }
  const rows = parseKeyValueLines(trimmed);
  const extracted = rows && extractFromObject(rows);
  return extracted ?? { value: trimmed, extracted: false };
}

export type DetectedCredentialKind = "api_key" | "oauth" | "jwt";

/**
 * Providers whose credential is accepted by more than one channel.
 *
 * CodeBuddy and WorkBuddy issue interchangeable tokens: one works in the
 * other. But a token used outside the channel it was issued for carries a
 * higher ban risk — the account is seen as active on a surface it never
 * authenticated against. The gateway cannot tell which channel a token came
 * from, so it warns and lets the operator decide instead of silently
 * accepting what looks like a valid credential.
 *
 * Ids are already normalized to match the compacted haystack below.
 */
const CROSS_CHANNEL_PROVIDERS = [
  { id: "codebuddy", counterpart: "WorkBuddy" },
  { id: "workbuddy", counterpart: "CodeBuddy" },
] as const;

export interface CrossChannelWarning {
  /** The provider this credential was recognised as. */
  readonly provider: string;
  /** The other channel that also accepts this token. */
  readonly counterpart: string;
}

/**
 * Recognises a credential whose token is interchangeable between two channels.
 *
 * Matching is deliberately loose on casing and separators (`code-buddy`,
 * `code_buddy`) because provider ids and pasted exports are not canonical, and
 * a missed match here means the warning that protects the account never shows.
 * The provider id is what the dialog is opened for, so it is checked first;
 * the raw paste is checked too because a token often names its own issuer.
 */
export function detectCrossChannelCredential(
  providerId: string,
  raw: string,
): CrossChannelWarning | undefined {
  // Loose on casing and separators: `code-buddy`, `code_buddy`, `CodeBuddy`
  // are all one provider here. A missed match means the warning that protects
  // the account never shows, which is worse than warning once too often.
  const compact = `${providerId} ${raw}`.toLowerCase().replace(/[^a-z]/g, "");
  for (const entry of CROSS_CHANNEL_PROVIDERS) {
    if (compact.includes(entry.id)) return { provider: entry.id, counterpart: entry.counterpart };
  }
  return undefined;
}

/**
 * Auto-detects OAuth exports, JWTs, or opaque API keys. Refresh-token fields
 * win over JWT detection because a refreshable export is an OAuth credential.
 */
export function detectCredentialKind(raw: string): DetectedCredentialKind {
  const trimmed = raw.trim();
  const json = asRecord(parsedJson(trimmed)) ?? parseKeyValueLines(trimmed);
  if (json && oauthShapeFromObject(json)) return "oauth";
  const extracted = json ? extractFromObject(json)?.value : undefined;
  return decodeJwtPayload(extracted ?? trimmed) === undefined ? "api_key" : "jwt";
}

export interface ParsedCredentialEntry {
  /** The value to submit as `secret` — the whole JSON blob for OAuth, the extracted key otherwise. */
  readonly value: string;
  readonly kind: DetectedCredentialKind;
  /** Auto-detected owner (email/name/accountId/...), used to auto-name the account. */
  readonly identity?: string;
}

/**
 * Unified browser cookie/session detection:
 * Detects whether an array of objects represents a set of cookies belonging to a single
 * session/origin rather than a batch of individual accounts:
 * - Cookie-Editor flat export: [{ name: "...", value: "...", domain: "..." }, ...]
 * - SessionBox / Storage Viewer format: [{ domain: "...", cookies: [...] }]
 */
function isCookieArrayExport(items: readonly Record<string, unknown>[]): boolean {
  if (items.length === 0) return false;

  // Pattern 1: SessionBox container export with nested cookies array
  const hasNestedCookies = items.some(
    (item) => Array.isArray(item["cookies"]) && (typeof item["domain"] === "string" || typeof item["originalUrl"] === "string"),
  );
  if (hasNestedCookies) return true;

  // Pattern 2: Flat cookie export from Cookie-Editor / EditThisCookie
  // Every item has `name` and `value`, and commonly `domain`, `path`, or `expirationDate`
  const allAreCookies = items.every(
    (item) =>
      typeof item["name"] === "string" &&
      typeof item["value"] === "string" &&
      (item["domain"] !== undefined || item["path"] !== undefined || item["expirationDate"] !== undefined),
  );
  if (allAreCookies) return true;

  return false;
}

/**
 * Extracts identity and OAuth character from a cookie export bundle.
 */
function entryFromCookieBundle(
  rawJsonStr: string,
  items: readonly Record<string, unknown>[],
): ParsedCredentialEntry {
  let identity: string | undefined;
  let isOAuth = false;

  const inspectCookie = (name: string, val: string) => {
    const n = name.toLowerCase();
    if (n === "userid" || n === "uid" || n === "accountid" || n === "cuserid") {
      if (!identity) identity = val.replace(/^"|"$/g, "").trim();
    }
    if (n.includes("token") || n.includes("ph") || n.includes("auth") || n.includes("session")) {
      isOAuth = true;
    }
  };

  for (const item of items) {
    if (Array.isArray(item["cookies"])) {
      for (const c of item["cookies"]) {
        if (c && typeof c === "object") {
          const rec = c as Record<string, unknown>;
          if (typeof rec["name"] === "string" && typeof rec["value"] === "string") {
            inspectCookie(rec["name"], rec["value"]);
          }
        }
      }
    } else if (typeof item["name"] === "string" && typeof item["value"] === "string") {
      inspectCookie(item["name"], item["value"]);
    }
  }

  return {
    value: rawJsonStr,
    kind: isOAuth ? "oauth" : "api_key",
    ...(identity ? { identity } : {}),
  };
}

function entryFromObject(obj: Record<string, unknown>): ParsedCredentialEntry {
  const exportKind = obj["credentialKind"];
  if (
    typeof exportKind === "string" &&
    typeof obj["accessToken"] === "string" &&
    EXPORT_ROW_FIELDS.every((field) => field in obj)
  ) {
    const label =
      typeof obj["label"] === "string" && obj["label"].trim().length > 0
        ? obj["label"].trim()
        : undefined;
    const accessToken = obj["accessToken"];
    // The row's own refresh token is what makes it refreshable. Sending only
    // the access token drops it, and a JWT access token is then stored as a
    // static credential that can never be refreshed. A row labelled `oauth`
    // that carries no refresh field is therefore still stored as the bare
    // access token: labelling it `oauth` would promise a refresh that has no
    // token to run.
    const isOAuthRow = exportKind === "oauth" && oauthShapeFromObject(obj);
    return {
      value: isOAuthRow ? JSON.stringify(obj) : accessToken,
      // An exported row's persisted credential kind is authoritative. An
      // `api_key` export stays an API key even when its string happens to look
      // like a refresh-shaped JSON wrapper.
      kind: isOAuthRow ? "oauth" : "api_key",
      ...(label ? { identity: label } : {}),
    };
  }
  const extracted = extractFromObject(obj);
  const kind: DetectedCredentialKind = oauthShapeFromObject(obj)
    ? "oauth"
    : detectCredentialKind(extracted?.value ?? JSON.stringify(obj));
  const value = kind === "oauth" ? JSON.stringify(obj) : (extracted?.value ?? JSON.stringify(obj));
  const identity = identityFromObject(obj);
  return identity ? { value, kind, identity } : { value, kind };
}

/**
 * Rows a batch export nests under a wrapper key, or `undefined` when the blob
 * is not a wrapper. Cartethyia's own export is `{ exportedAt, accounts: [...] }`
 * and the reference batch-import shape is `{ accounts: [...] }`, so without
 * this an export re-import became one opaque entry.
 */
function wrapperRows(obj: Record<string, unknown>): readonly Record<string, unknown>[] | undefined {
  for (const key of ACCOUNTS_WRAPPER_KEYS) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    const rows = value
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined);
    if (rows.length > 0) return rows;
  }
  return undefined;
}

/**
 * Splits a pasted blob into one or more credential entries:
 * - a unified cookie bundle (Cookie-Editor, SessionBox, EditThisCookie) → exactly ONE entry preserving the whole JSON bundle
 * - a JSON array of accounts → one entry per account
 * - a single JSON object, or a multi-line `key: value` block → one entry
 * - newline-delimited JSON objects, or newline-delimited plain tokens → one entry per line
 */
export function parseCredentialBatch(raw: string): ParsedCredentialEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const wholeBlob = parsedJson(trimmed);
  if (Array.isArray(wholeBlob)) {
    const objects = wholeBlob
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined);

    if (objects.length > 0) {
      // Global Unified Check: Is this a single cookie session bundle exported as an array?
      if (isCookieArrayExport(objects)) {
        return [entryFromCookieBundle(trimmed, objects)];
      }

      return objects.map(entryFromObject);
    }
  } else {
    const obj = asRecord(wholeBlob);
    if (obj) {
      const rows = wrapperRows(obj);
      if (rows) return rows.map(entryFromObject);
      return [entryFromObject(obj)];
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  if (lines.length === 1) {
    // A single `key: value` line is a structured credential, not an opaque
    // token. `parseSingleLine` cannot parse `apiKey: sk-...` as JSON, so it
    // would store the line's literal text as the secret — the operator would
    // get an account whose stored credential was the string `"apiKey: sk-..."`,
    // and the real key would be gone. The multi-line path consults
    // `parseKeyValueLines` first; the single-line path has to agree with it.
    const asKeyValue = parseKeyValueLines(lines[0] as string);
    // Any parseable `key: value` line is structured, not an opaque token —
    // including one whose only field is a refresh token. Falling through to
    // `parseSingleLine` there would store the literal line text as the secret.
    if (asKeyValue) return [entryFromObject(asKeyValue)];
    return parseSingleLine(lines[0] as string);
  }

  // A `key: value` block is ONE structured credential, not a batch — and that
  // holds even when some of its lines do not parse as `key: value`. A comment
  // header, an indented continuation, or a repeated key all defeat a
  // `keys.length === lines.length` guard, which would drop the whole block into
  // the per-line path. There, `parseSingleLine` cannot parse `apiKey: sk-...` as
  // JSON, so it stores the LINE'S LITERAL TEXT as the secret: the operator gets
  // an account whose stored credential is the string `"apiKey: sk-..."`, and the
  // real key is discarded or demoted to a sibling entry.
  //
  // The single-credential path (`extractCredentialFromPaste`) resolves these
  // inputs correctly by consulting `parseKeyValueLines` first. Matching it here
  // is what makes the two exported parsers agree.
  const asKeyValue = parseKeyValueLines(trimmed);
  if (asKeyValue) {
    // A block that names a credential field is one credential, however many of
    // its other lines failed to parse.
    if (extractFromObject(asKeyValue)) return [entryFromObject(asKeyValue)];
    // No credential field, but every line was `key: value` — still one
    // structured blob rather than one entry per field.
    if (Object.keys(asKeyValue).length === lines.length) return [entryFromObject(asKeyValue)];
  }

  return lines.flatMap(parseSingleLine);
}

function parseSingleLine(line: string): ParsedCredentialEntry[] {
  const obj = asRecord(parsedJson(line));
  if (obj) {
    const rows = wrapperRows(obj);
    if (rows) return rows.map(entryFromObject);
    return [entryFromObject(obj)];
  }
  const named = parseNamedCredentialLine(line);
  if (named.length > 0) return named;
  return [{ value: line, kind: detectCredentialKind(line) }];
}

/**
 * Parses a `name|credential` line — one line that names the account and
 * carries its credential after a pipe, e.g.
 * `onlybougieclan|pt-cJ25RalKyYVxpqQXLK5sDDkJ_01a15663`.
 *
 * The left side becomes the account label (`identity`), the right side the
 * credential value. Split on the FIRST pipe only, so a credential that itself
 * contains a `|` survives whole; a missing name or credential returns nothing,
 * and the line falls through to the plain-token path.
 */
function parseNamedCredentialLine(line: string): ParsedCredentialEntry[] {
  const pipe = line.indexOf("|");
  if (pipe <= 0) return [];
  const name = line.slice(0, pipe).trim();
  const cred = line.slice(pipe + 1).trim();
  if (!name || !cred) return [];
  return [{ value: cred, kind: detectCredentialKind(cred), identity: name }];
}

/**
 * Assigns a unique, human-meaningful name to each entry: the auto-detected
 * identity when present, else `${providerId}-N` — colliding with existing
 * names (or with each other) gets a ` (2)`, ` (3)`, ... suffix.
 */
export function assignAccountNames(
  entries: readonly ParsedCredentialEntry[],
  providerId: string,
  existingNames: readonly string[],
): string[] {
  const used = new Set(existingNames);
  let nextSequence = 1;
  return entries.map((entry) => {
    let base = entry.identity;
    if (!base) {
      while (used.has(`${providerId}-${nextSequence}`)) nextSequence += 1;
      base = `${providerId}-${nextSequence}`;
      nextSequence += 1;
    }
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name);
    return name;
  });
}

/**
 * Merges multiple credential files into ONE paste block the shared parser can
 * read back as the same entries.
 *
 * A naive concatenation breaks when two files each contain a whole JSON array
 * (`["a","b"]` + `["c"]` is not parseable as one document). Each file is
 * therefore normalised to line-oriented form — the shape `parseCredentialBatch`
 * already understands:
 *
 * - a JSON **array** of account records → one JSON object per line (NDJSON);
 * - a **wrapper** object (`{ accounts: [...] }`, `{ items: [...] }`, …) → one
 *   JSON object per row;
 * - a single credential object → kept whole;
 * - a **cookie/session bundle** (Cookie-Editor / SessionBox / EditThisCookie)
 *   → kept whole, because it is exactly one account and splitting it would turn
 *   one bundle into N junk entries;
 * - a non-JSON file → kept as its own lines, but a single `key: value` block
 *   stays whole so the shared parser still reads it as one structured
 *   credential rather than one entry per field.
 *
 * The caller shows the returned `entries` in the same batch preview and submits
 * the returned `text` through the existing path — no second import flow.
 */
export function mergeCredentialFiles(
  files: readonly { readonly name: string; readonly text: string }[],
): { readonly text: string; readonly entries: readonly ParsedCredentialEntry[] } {
  const parts: string[] = [];
  for (const file of files) {
    const trimmed = file.text.trim();
    if (!trimmed) continue;

    const whole = parsedJson(trimmed);
    if (Array.isArray(whole)) {
      const records = whole.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined);
      if (records.length > 0 && isCookieArrayExport(records)) {
        parts.push(trimmed);
        continue;
      }
      for (const item of whole) {
        const rec = asRecord(item);
        parts.push(rec !== undefined ? JSON.stringify(rec) : String(item));
      }
      continue;
    }

    const obj = asRecord(whole);
    if (obj) {
      const rows = wrapperRows(obj);
      if (rows !== undefined) {
        for (const row of rows) parts.push(JSON.stringify(row));
        continue;
      }
      parts.push(trimmed);
      continue;
    }

    // Non-JSON. One structured blob (a `key: value` block or a single token)
    // must stay whole; many lines are already one credential per line.
    const parsed = parseCredentialBatch(trimmed);
    if (parsed.length <= 1) {
      parts.push(trimmed);
    } else {
      parts.push(
        ...trimmed
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );
    }
  }

  const text = parts.join("\n");
  return { text, entries: parseCredentialBatch(text) };
}

/**
 * Splits a paste into requests the server accepts.
 *
 * A single batch request is bounded (100 accounts) so one paste cannot open an
 * unbounded transaction — but an operator importing thousands has a paste far
 * larger than that cap, and sending it as one request would be rejected
 * outright. Chunking here keeps every request inside the cap while still being
 * a bounded number of round-trips instead of one per account.
 */
export const MAX_ACCOUNTS_PER_BATCH_REQUEST = 50;

export function chunkCredentials<T>(
  items: readonly T[],
  size: number = MAX_ACCOUNTS_PER_BATCH_REQUEST,
): T[][] {
  if (size < 1) throw new RangeError("chunk size must be at least 1");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
