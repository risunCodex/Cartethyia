// Parsing a proxy list pasted from a file.
//
// Every provider hands out its proxy list in a different shape, and the shape
// is not something an operator should have to convert by hand before this
// gateway will accept it. Three forms cover what actually arrives:
//
//   - a JSON array of pool objects (the shape `POST /network/pools` takes);
//   - one bare URI per line — `http://user:pass@1.2.3.4:8080`;
//   - one `host:port:user:password` row per line, which is what resellers send.
//
// A line that parses to nothing is reported rather than silently dropped: a
// list of 200 where 40 were skipped looks like a successful import and leaves
// the operator short 40 nodes with no reason.
//
// Secrets are handled as little as possible — they are parsed into a
// credential and handed straight to the store, never logged.

import { POOL_KINDS, POOL_STATUSES } from "./contracts";

/** One row that parsed, ready to become a pool. */
interface ParsedProxyRow {
  readonly kind: (typeof POOL_KINDS)[number];
  readonly endpoint: string;
  readonly credential: string | null;
  readonly label: string | null;
}

/** One row that did not parse, with the reason. */
interface SkippedProxyRow {
  readonly line: number;
  readonly reason: string;
}

interface ParsedProxyFile {
  readonly rows: readonly ParsedProxyRow[];
  readonly skipped: readonly SkippedProxyRow[];
}

/** Schemes this gateway can dispatch through, mapped to a pool kind. */
const SCHEME_KINDS: Readonly<Record<string, (typeof POOL_KINDS)[number]>> = {
  http: "http",
  https: "http",
  socks5: "socks5",
  socks5h: "socks5",
  socks4: "socks5",
};

/** Kept as a name rather than a literal, because two callers compare against it. */
const DEFAULT_KIND: (typeof POOL_KINDS)[number] = "http";

function isPoolKind(value: unknown): value is (typeof POOL_KINDS)[number] {
  return typeof value === "string" && (POOL_KINDS as readonly string[]).includes(value);
}

function isPoolStatus(value: unknown): value is (typeof POOL_STATUSES)[number] {
  return typeof value === "string" && (POOL_STATUSES as readonly string[]).includes(value);
}

/**
 * The endpoint scheme, lowercased, or `null` when the line carries none.
 *
 * A line without a scheme is still valid — `host:port` is the most common
 * reseller form — so "no scheme" means "assume http", not "unparseable".
 */
function schemeOf(text: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text.trim());
  const scheme = match?.[1];
  return scheme ? scheme.toLowerCase() : null;
}

/** Splits `host:port:user:password`, where the password may itself contain `:`. */
function splitColonRow(text: string): {
  readonly host: string;
  readonly port: string;
  readonly user: string | null;
  readonly password: string | null;
} | null {
  // The password is last and may contain colons, so it is everything after the
  // third separator rather than a fourth field.
  const parts: readonly string[] = text.trim().split(":");
  if (parts.length < 2) return null;
  const host = (parts[0] ?? "").trim();
  const port = (parts[1] ?? "").trim();
  if (!host || !port || !/^\d+$/.test(port)) return null;
  const user = parts.length > 2 ? (parts[2] ?? "").trim() : "";
  const password = parts.length > 3 ? parts.slice(3).join(":").trim() : "";
  return {
    host,
    port,
    user: user !== "" ? user : null,
    password: password !== "" ? password : null,
  };
}

/** One bare-URI line, e.g. `http://user:pass@1.2.3.4:8080`. */
function parseUriLine(text: string): ParsedProxyRow | null {
  const scheme = schemeOf(text);
  if (scheme === null) return null;
  const kind = SCHEME_KINDS[scheme] ?? DEFAULT_KIND;
  const withoutScheme = text.trim().slice(scheme.length + 3);
  const at = withoutScheme.lastIndexOf("@");
  const authority = at >= 0 ? withoutScheme.slice(at + 1) : withoutScheme;
  const userinfo = at >= 0 ? withoutScheme.slice(0, at) : null;
  if (!authority) return null;
  const credential = userinfo
    ? decodeURIComponent(userinfo)
    : null;
  const hasPort = /:\d+$/.test(authority);
  const endpoint = hasPort ? authority : `${authority}`;
  if (!endpoint) return null;
  return { kind, endpoint: `${scheme}://${endpoint}`, credential, label: null };
}

/** One `host:port[:user[:password]]` line. */
function parseColonLine(text: string): ParsedProxyRow | null {
  const row = splitColonRow(text);
  if (!row) return null;
  const credential =
    row.user !== null ? (row.password !== null ? `${row.user}:${row.password}` : row.user) : null;
  // The store requires a full URL, and a reseller row carries no scheme.
  // `http://` is the safe reading: it is the default for a bare row, and an
  // operator who means socks writes the scheme.
  return {
    kind: DEFAULT_KIND,
    endpoint: `http://${row.host}:${row.port}`,
    credential,
    label: null,
  };
}

/**
 * Parses one line.
 *
 * Blank lines and `#` comments are skipped without being reported: they are
 * structure, not failed rows, and listing them as skipped would bury the rows
 * that actually failed.
 */
function parseLine(text: string): ParsedProxyRow | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  return parseUriLine(trimmed) ?? parseColonLine(trimmed);
}

/** Parses a JSON array of pool objects. */
function parseJsonArray(value: unknown): ParsedProxyFile | null {
  if (!Array.isArray(value)) return null;
  const rows: ParsedProxyRow[] = [];
  const skipped: SkippedProxyRow[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      skipped.push({ line: index + 1, reason: "not an object" });
      return;
    }
    const record = entry as Record<string, unknown>;
    const endpoint = typeof record["endpoint"] === "string" ? record["endpoint"].trim() : "";
    if (!endpoint) {
      skipped.push({ line: index + 1, reason: "no endpoint" });
      return;
    }
    rows.push({
      kind: isPoolKind(record["kind"]) ? record["kind"] : DEFAULT_KIND,
      endpoint,
      credential: typeof record["credential"] === "string" ? record["credential"] : null,
      label: typeof record["label"] === "string" ? record["label"] : null,
    });
  });
  return { rows, skipped };
}

/**
 * Parses a pasted proxy list.
 *
 * JSON is tried first, because a whole file that happens to be valid JSON is
 * unambiguous; anything else is treated as line-oriented text.
 */
export function parseProxyFile(content: string): ParsedProxyFile {
  const trimmed = content.trim();
  if (trimmed === "") return { rows: [], skipped: [] };
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const result = parseJsonArray(parsed);
        if (result) return result;
      }
      // A single object is one pool, which is a legitimate one-line file.
      const single = parseJsonArray([parsed]);
      if (single && single.rows.length > 0) return single;
    } catch {
      // Falls through to the line parser: a file that is *nearly* JSON is more
      // likely a text list than a corrupt one.
    }
  }
  const rows: ParsedProxyRow[] = [];
  const skipped: SkippedProxyRow[] = [];;
  trimmed.split(/\r?\n/).forEach((line, index) => {
    const parsed = parseLine(line);
    if (parsed) rows.push(parsed);
    else if (line.trim() !== "" && !line.trim().startsWith("#")) {
      skipped.push({ line: index + 1, reason: "not a proxy URI or host:port row" });
    }
  });
  return { rows, skipped };
}

export { isPoolKind, isPoolStatus };
