/**
 * JWT inspection and verification for provider-issued OAuth tokens.
 *
 * Cartethyia receives provider access tokens directly from the issuer's token
 * endpoint over TLS, then sends them back to the same provider. That transport
 * path is the primary trust boundary, so signature verification is
 * defense-in-depth: when the provider's manifest declares a JWKS URL
 * (`providerJwtVerification`), signatures are verified; otherwise only
 * structural and registered claim validation runs. Opaque (non-JWT) tokens are
 * passed through untouched — they cannot be locally verified and are validated
 * by the issuer itself.
 *
 * Only asymmetric algorithms are accepted. `none` and HMAC (`HS*`) are
 * rejected so a token cannot downgrade to a shared-secret or unsigned form.
 */
import {
  compactVerify,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
} from "jose";
import type { JSONWebKeySet, RemoteJWKSet } from "jose";
import { TtlCache } from "../../persistence/ttl-cache";
import { resolveRedisClient } from "../../persistence/redis";

/**
 * Algorithms this module will verify.
 *
 * `jose` performs the cryptography, so the entry is now only the key type —
 * the digest, RSA-PSS padding and salt length were implementation details of
 * the hand-rolled `cryptoVerify` call this replaced. The allowlist itself is
 * unchanged: asymmetric only, so `none` and the HMAC (`HS*`) family can never
 * be negotiated down to.
 */
interface AlgorithmSpec {
  readonly kty: "RSA" | "EC";
}

const SUPPORTED_ALGORITHMS: Readonly<Record<string, AlgorithmSpec>> = Object.freeze({
  RS256: { kty: "RSA" },
  RS384: { kty: "RSA" },
  RS512: { kty: "RSA" },
  PS256: { kty: "RSA" },
  PS384: { kty: "RSA" },
  PS512: { kty: "RSA" },
  ES256: { kty: "EC" },
  ES384: { kty: "EC" },
  ES512: { kty: "EC" },
});

/** Fetch timeout for a JWKS document, matching jose's own default. */
const JWKS_FETCH_TIMEOUT_MS = 5_000;


interface ParsedJwt {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signature: string;
  readonly signedInput: string;
}

/**
 * Strictly parses a compact JWS. Returns `undefined` for anything that is not a
 * three-part token with JSON header/payload objects, a non-empty `alg`, and a
 * non-empty signature — so `alg: none` and structurally broken tokens are never
 * treated as JWTs.
 *
 * Header and payload decoding delegates to `jose`, which enforces the same
 * strictness the hand-rolled decoder did (compact three-part shape, base64url
 * decoding to a JSON *object* — never an array or a scalar) and is the same
 * decoder the verification path uses, so what is inspected is exactly what is
 * later verified.
 */
export function parseJwt(token: string): ParsedJwt | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const headerSegment = parts[0] ?? "";
  const payloadSegment = parts[1] ?? "";
  const signature = parts[2] ?? "";
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(token) as Record<string, unknown>;
    payload = decodeJwt(token) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof header.alg !== "string" || header.alg.length === 0) return undefined;
  if (header.alg === "none" || signature.length === 0) return undefined;
  return { header, payload, signature, signedInput: `${headerSegment}.${payloadSegment}` };
}

type JwtClaimFailure =
  | "expired"
  | "not_yet_valid"
  | "issued_in_future"
  | "malformed_claim"
  | "issuer_mismatch"
  | "audience_mismatch";

interface JwtClaimExpectations {
  /** Accepted `iss` value(s); when set, `iss` must match exactly. */
  readonly issuer?: string | readonly string[];
  /** Accepted `aud` value(s); when set, the token audience must intersect. */
  readonly audience?: string | readonly string[];
  /** Current time in epoch milliseconds; defaults to `Date.now()`. */
  readonly now?: number;
  /** Leeway applied to `exp`/`nbf`/`iat` comparisons. Default 60s. */
  readonly clockSkewSeconds?: number;
}

function numericDate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function expectedValues(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

/**
 * Validates registered JWT claims (`exp`, `nbf`, `iat`, and — when expected —
 * `iss`/`aud`) with clock-skew tolerance. Returns `undefined` when the token is
 * acceptable, otherwise the first failure. Claims that are absent are not
 * required; claims that are present but not finite numbers are rejected as
 * malformed.
 */
export function validateJwtClaims(
  payload: Record<string, unknown>,
  expectations: JwtClaimExpectations = {},
): JwtClaimFailure | undefined {
  const nowSeconds = (expectations.now ?? Date.now()) / 1000;
  const skew = expectations.clockSkewSeconds ?? 60;

  for (const claim of ["exp", "nbf", "iat"] as const) {
    if (payload[claim] === undefined) continue;
    if (numericDate(payload[claim]) === undefined) return "malformed_claim";
  }

  const exp = numericDate(payload["exp"]);
  if (exp !== undefined && nowSeconds > exp + skew) return "expired";
  const nbf = numericDate(payload["nbf"]);
  if (nbf !== undefined && nowSeconds < nbf - skew) return "not_yet_valid";
  const iat = numericDate(payload["iat"]);
  if (iat !== undefined && iat > nowSeconds + skew) return "issued_in_future";

  const expectedIssuers = expectedValues(expectations.issuer);
  if (expectedIssuers.length > 0) {
    const issuer = payload["iss"];
    if (typeof issuer !== "string" || !expectedIssuers.includes(issuer)) return "issuer_mismatch";
  }

  const expectedAudiences = expectedValues(expectations.audience);
  if (expectedAudiences.length > 0) {
    const rawAud = payload["aud"];
    const audiences = typeof rawAud === "string" ? [rawAud] : Array.isArray(rawAud) ? rawAud : [];
    const matches = audiences.some(
      (audience) => typeof audience === "string" && expectedAudiences.includes(audience),
    );
    if (!matches) return "audience_mismatch";
  }

  return undefined;
}

interface JwksVerifierOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
  readonly cacheTtlMs?: number;
  /** Minimum interval between forced refreshes when a `kid` is unknown. */
  readonly minRefreshIntervalMs?: number;
}

const DEFAULT_JWKS_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30_000;

/** Shared JWKS window, matching the local verifier cache so peers reuse fetched keys. */
const JWKS_SHARED_TTL_SECONDS = 300;
const JWKS_SHARED_KEY_PREFIX = "jwks:v1:";


/**
 * A JWKS document shared with peer instances, with the timestamp it was
 * fetched at. Redis-backed so a fleet does not each re-fetch the issuer.
 */
interface SharedJwks {
  readonly jwks: JSONWebKeySet;
  readonly uat: number;
}

async function readSharedJwksDocument(url: string): Promise<SharedJwks | undefined> {
  const redis = resolveRedisClient();
  if (!redis) return undefined;
  try {
    const hit = await redis.get(`${JWKS_SHARED_KEY_PREFIX}${url}`);
    if (hit === null) return undefined;
    const parsed = JSON.parse(hit) as unknown;
    if (parsed === null || typeof parsed !== "object") return undefined;
    const { uat, jwks } = parsed as { uat?: unknown; jwks?: unknown };
    if (typeof uat !== "number" || !Number.isFinite(uat)) return undefined;
    if (jwks === null || typeof jwks !== "object") return undefined;
    return { jwks: jwks as JSONWebKeySet, uat };
  } catch {
    return undefined;
  }
}

/** Publishes a fetched document for peer instances. Best-effort: never throws. */
async function writeSharedJwksDocument(url: string, jwks: JSONWebKeySet): Promise<void> {
  const redis = resolveRedisClient();
  if (!redis) return;
  try {
    await redis.set(
      `${JWKS_SHARED_KEY_PREFIX}${url}`,
      JSON.stringify({ uat: Date.now(), jwks } satisfies SharedJwks),
      "EX",
      JWKS_SHARED_TTL_SECONDS,
    );
  } catch {
    // Shared visibility only; each instance's own cache stays authoritative.
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Verifies compact-JWS signatures against a provider's JWKS endpoint.
 *
 * Key fetching, caching, in-flight deduplication, the minimum refresh interval
 * on an unknown `kid`, and `kid`-rotation pickup are all delegated to
 * `jose`'s `createRemoteJWKSet`. `jose` additionally honours each JWK's `use`
 * and `key_ops`, so an encryption key published alongside the signing keys
 * cannot be selected for verification.
 *
 * The algorithm is checked against `SUPPORTED_ALGORITHMS` *before* any key is
 * resolved, so the asymmetric-only allowlist (no `none`, no HMAC) holds
 * regardless of what the JWKS publishes.
 */
export class JwksVerifier {
  readonly #keys: RemoteJWKSet;
  /** Whether this instance has fetched from the issuer yet. */
  #fetched = false;

  constructor(options: JwksVerifierOptions) {
    const fetchFn = options.fetch ?? globalThis.fetch;
    const url = options.url;
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
    this.#keys = createRemoteJWKSet(new URL(url), {
      timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
      cacheMaxAge: cacheTtlMs,
      cooldownDuration: options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS,
      [customFetch]: async (target, init) => {
        // First resolution only: a peer's copy saves an issuer round-trip.
        // A later fetch is a rotation reload, which must reach the issuer
        // rather than re-read the set that just failed to match the `kid`.
        if (!this.#fetched) {
          const shared = await readSharedJwksDocument(url);
          if (shared !== undefined && Date.now() - shared.uat < cacheTtlMs) {
            this.#fetched = true;
            return jsonResponse(shared.jwks);
          }
        }
        const response = await fetchFn(target, init as RequestInit);
        if (response.ok) {
          try {
            const body = (await response.clone().json()) as unknown;
            if (body !== null && typeof body === "object" && Array.isArray((body as { keys?: unknown }).keys)) {
              void writeSharedJwksDocument(url, body as JSONWebKeySet);
            }
          } catch {
            // Publishing is best-effort.
          }
          return response;
        }
        return response;
      },
    });
  }

  /**
   * Verifies `token`'s signature and returns the parsed token on success.
   *
   * Returns `undefined` for anything unverifiable — a non-JWT, an algorithm
   * outside the allowlist, a JWKS fetch failure, or a bad signature. A JWKS
   * outage therefore fails closed rather than trusting an unverified token.
   */
  async verify(token: string): Promise<ParsedJwt | undefined> {
    const parsed = parseJwt(token);
    if (!parsed) return undefined;
    const algorithm = SUPPORTED_ALGORITHMS[parsed.header.alg as string];
    if (!algorithm) return undefined;
    try {
      // `compactVerify` checks the signature only. Registered claims stay the
      // responsibility of `validateJwtClaims`, whose failure vocabulary
      // ("expired", "issuer_mismatch", …) the console surfaces verbatim;
      // `jwtVerify` would replace it with its own, and requires `iss`/`aud`
      // that an OAuth access token need not carry.
      await compactVerify(token, this.#keys, {
        algorithms: [parsed.header.alg as string],
      });
      return parsed;
    } catch {
      return undefined;
    }
  }
}

/**
 * One verifier per URL, bounded and time-limited.
 *
 * An unbounded, never-evicted registry would pin every JWKS URL ever seen —
 * and its verifier's key cache — for the process lifetime. A TTL plus a hard
 * entry cap keeps a fleet of issuers from growing it without limit while still
 * sharing a verifier's key cache across calls.
 */
const JWKS_VERIFIER_TTL_MS = 5 * 60 * 1_000;
const JWKS_VERIFIER_MAX_ENTRIES = 64;
const jwksVerifiers = new TtlCache<JwksVerifier>({
  ttlMs: JWKS_VERIFIER_TTL_MS,
  maxEntries: JWKS_VERIFIER_MAX_ENTRIES,
});

/** Returns a process-wide verifier for `url` so its key cache is shared. */
export function jwksVerifierFor(
  url: string,
  fetchFn: typeof fetch = globalThis.fetch,
): JwksVerifier {
  const existing = jwksVerifiers.get(url);
  if (existing) return existing;
  const verifier = new JwksVerifier({ url, fetch: fetchFn });
  jwksVerifiers.set(url, verifier);
  return verifier;
}

interface IssuedTokenValidation {
  readonly jwksUrl?: string;
  readonly issuer?: string | readonly string[];
  readonly audience?: string | readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: number;
  readonly clockSkewSeconds?: number;
}

type IssuedTokenResult =
  | { readonly valid: true; readonly verified: boolean }
  | { readonly valid: false; readonly reason: JwtClaimFailure | "signature_invalid" };

/**
 * Validates a provider-issued access token before it is persisted.
 *
 * Opaque tokens are accepted (the issuer validates them). JWTs are checked for
 * registered claims; when `jwksUrl` is configured, the signature is verified
 * too. This never throws for network failures — a JWKS outage fails closed for
 * JWTs (rejected) rather than silently trusting an unverified token.
 */
export async function validateIssuedAccessToken(
  token: string,
  options: IssuedTokenValidation = {},
): Promise<IssuedTokenResult> {
  const parsed = parseJwt(token);
  if (!parsed) return { valid: true, verified: false };
  const failure = validateJwtClaims(parsed.payload, {
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.clockSkewSeconds === undefined ? {} : { clockSkewSeconds: options.clockSkewSeconds }),
  });
  if (failure) return { valid: false, reason: failure };
  if (options.jwksUrl === undefined) return { valid: true, verified: false };
  const verified = await jwksVerifierFor(
    options.jwksUrl,
    options.fetch ?? globalThis.fetch,
  ).verify(token);
  return verified ? { valid: true, verified: true } : { valid: false, reason: "signature_invalid" };
}
