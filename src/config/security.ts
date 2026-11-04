/**
 * Security resolvers: the application encryption key and the abuse-protection
 * ceiling.
 */

import { CONFIG_SPEC, readInt, readRequired } from "./spec";

const ENCRYPTION_KEY_LENGTH = 32;

/**
 * Per-IP request ceiling for the unauthenticated abuse-protection layer.
 * Defaults to 540 requests per window so an unset env does not mean unlimited;
 * operators tune it via `IP_RATE_MAX_PER_WINDOW`.
 */
export function resolveIpRateLimit(): number {
  return readInt("IP_RATE_MAX_PER_WINDOW", CONFIG_SPEC.IP_RATE_MAX_PER_WINDOW);
}

/** Reads the application encryption key without caching it. */
export function requireEncryptionKeyEnv(): string {
  return readRequired("CARTETHYIA_ENCRYPTION_KEY", CONFIG_SPEC.CARTETHYIA_ENCRYPTION_KEY);
}

/** Decodes and validates a base64 or hexadecimal 256-bit encryption key. */
export function decodeEncryptionKey(raw: string): Buffer {
  const candidate = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(candidate)
    ? Buffer.from(candidate, "hex")
    : Buffer.from(candidate, "base64");
  if (buf.length !== ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `CARTETHYIA_ENCRYPTION_KEY must decode to exactly ${ENCRYPTION_KEY_LENGTH} bytes (got ${buf.length}); ` +
        "provide a base64 or hex encoded 256-bit key",
    );
  }
  return buf;
}
