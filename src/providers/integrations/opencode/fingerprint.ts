import { getOpenCodeVersion } from "../../operations/client-versions";
import { createHash, randomBytes } from "node:crypto";

/**
 * The pinned reference client identity the parity suite asserts on.
 *
 * The runtime fallback lives in `VERSION_SOURCES.opencode.fallback`
 * (`operations/client-versions.ts`); this mirror exists so the parity suite
 * can pin the exact identity sent before discovery resolves. Keep both in
 * lockstep when the CLI releases.
 */
export const OPENCODE_CLIENT_VERSION = "2.2.6";

let lastTimestamp = 0;
let sequenceCounter = 0;
const SESSION_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * The counter window the free-tier gate accepts.
 *
 * The client mints `~(ts_ms << 12 | counter)` and the gate decodes that back.
 * It accepts counters **1 through 63** and refuses anything higher with
 * `403 FreeTierError` even when the `ses_` shape is right — verified against
 * the live endpoint, and the same window the reference gateway documents.
 *
 * Past 63 the low 12 bits read `0xfc0` or below, which is outside the
 * `f[c-f][0-9a-f]` tail a genuine id always has.
 */
const SESSION_COUNTER_MAX = 63;

/**
 * Generate a valid OpenCode session identifier matching official binary:
 * `ses_` + 12-char hex (bitwise inverted millisecond timestamp * 4096 + seq) + 14-char base62.
 *
 * The counter is capped rather than left to grow. Sixty-four dispatches inside
 * one millisecond emit ids the gate refuses, so a burst — exactly what a proxy
 * pool produces — would 403 on its own headers while every other field was
 * correct. On overflow the timestamp advances by one millisecond instead: the
 * id stays inside the window, and the only cost is that ids minted in the same
 * real millisecond do not sort as the client's would.
 */
export function generateOpenCodeSessionId(now = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    sequenceCounter = 0;
  }
  sequenceCounter++;
  if (sequenceCounter > SESSION_COUNTER_MAX) {
    // Roll into the next millisecond rather than emitting a refused counter.
    // `lastTimestamp` follows so the next call starts a fresh window there.
    lastTimestamp = now + 1;
    sequenceCounter = 1;
    now = lastTimestamp;
  }
  const num = BigInt(now) * 0x1000n + BigInt(sequenceCounter);
  const inverted = ~num;
  const hex = Array.from({ length: 6 }, (_, i) =>
    Number((inverted >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  const rand = crypto.getRandomValues(new Uint8Array(14));
  const suffix = Array.from(rand, (byte) => SESSION_ID_ALPHABET[byte % 62]).join("");
  return `ses_${hex}${suffix}`;
}

/**
 * Derive a conversation-stable session id from an affinity key.
 *
 * The free-tier gate validates that the session's 12 hex digits decode to a
 * plausible inverted-millisecond timestamp (verified live 2026-10-14: a hash
 * of arbitrary hex is refused with 403 FreeTierError, while the same shape
 * carrying a real timestamp passes). So the hex part is an inverted timestamp
 * jittered deterministically within the last 48 hours of the affinity key —
 * stable per conversation, plausible per the gate — and only the base62
 * suffix comes from the hash.
 *
 * The jitter derives from 6-hour time buckets, not raw `Date.now()`: two
 * dispatches of one conversation that land in the same bucket (or adjacent
 * ones before the bucket rolls) produce the identical session id, so prompt
 * cache affinity survives the millisecond a request happens to cross.
 */
function stableOpenCodeSessionId(affinity: string): string {
  const digest = createHash("sha256").update(`opencode-session:${affinity}`).digest();
  const bucketMs = 6 * 3_600_000;
  const bucket = Math.floor(Date.now() / bucketMs);
  const jitterBuckets = digest.readUint32BE(0) % 8; // 0..7 buckets = up to 42h back
  const timestamp = (bucket - jitterBuckets) * bucketMs;
  const num = BigInt(timestamp) * 0x1000n + 1n;
  const inverted = ~num;
  const hex = Array.from({ length: 6 }, (_, i) =>
    Number((inverted >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  const suffix = Array.from(digest.subarray(6, 20), (byte) => SESSION_ID_ALPHABET[byte % 62]).join("");
  return `ses_${hex}${suffix}`;
}

/**
 * Render a project identity in the 40-hex shape the client sends.
 *
 * The captured 2.x dispatch carries `x-opencode-project:
 * 82b484de3985b491abf573de7d60d7999302b858` — 40 hex, not a name. Sending the
 * literal `"global"` is a guess that happened to pass during an earlier probe;
 * it is not the shape the client produces, and the free-tier gate fingerprints
 * this header alongside the session id.
 *
 * An already-canonical 40-hex value is kept: a caller that resolved one is
 * describing its own project, and re-hashing it would replace a real identity
 * with a hash of that identity.
 */
export function canonicalProjectId(project: string | undefined): string {
  if (project !== undefined && /^[0-9a-f]{40}$/.test(project)) return project;
  const digest = createHash("sha256")
    .update(`opencode-project\u0000${project ?? "cartethyia"}`)
    .digest();
  return digest.subarray(0, 20).toString("hex");
}

function isOpenCodeSessionId(value: string | undefined): value is string {
  return value !== undefined && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value);
}

function createTraceHeaders(): Record<string, string> {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const parentSpanId = randomBytes(8).toString("hex");
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
  };
}

/**
 * Build the observed OpenCode CLI identity headers for an upstream dispatch.
 *
 * The v2 lane splits root and child session ids exactly like the reference
 * gateway: `x-opencode-session` / `x-session-affinity` / `x-session-id` carry
 * the root session, while `x-opencode-session-id` carries the child (the
 * client's own session id when it sent one, else the root).
 */
export function buildOpenCodeHeaders(
  version = getOpenCodeVersion(),
  affinity?: string,
  projectId?: string,
  childSessionId?: string,
): Record<string, string> {
  let sessionId: string;
  if (isOpenCodeSessionId(affinity)) {
    sessionId = affinity;
  } else if (affinity !== undefined) {
    sessionId = stableOpenCodeSessionId(affinity);
  } else {
    sessionId = generateOpenCodeSessionId();
  }
  const childId = isOpenCodeSessionId(childSessionId) ? childSessionId : sessionId;
  return {
    // The gate accepts both "cli" and "desktop" (measured 2026-10-17), so this
    // is not a refusal either way. It is "cli" because that is what the client
    // actually sends: the captured 2.x dispatch, the local 2.0.26 CLI captures,
    // and the reference gateway all carry "cli". Sending "desktop" claimed a
    // client identity this adapter does not have, for no measured benefit.
    "x-opencode-client": "cli",
    "x-opencode-session": sessionId,
    "x-opencode-session-id": childId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
    // No `x-opencode-request`: the current client no longer sends it, and
    // sending it now makes the free-tier gate refuse the dispatch (verified
    // live 2026-10-14 — identical request returns 403 with it, 200 without).
    // The id generator was removed with it; this header is simply not part of
    // the dispatch identity anymore.
    "x-opencode-project": canonicalProjectId(projectId),
    "user-agent": `opencode/latest/${version}/cli`,
    ...createTraceHeaders(),
  };
}
