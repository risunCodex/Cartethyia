/**
 * The InferHub `config_read` key, stored on its own row.
 *
 * Deliberately **not** in `provider_accounts.auth_state`: `auth_state` is
 * documented as the per-account *non-secret* upstream config field and travels
 * with the account through backup/restore, so a credential there is copied
 * around and readable by anything that reads accounts. This key is a secret, so
 * it gets the same treatment as any other credential — encrypted at rest with
 * `encryptCredential`, in its own table, reachable only through the InferHub
 * routes.
 *
 * It is also never the inference key. InferHub issues two kinds and a
 * `config_read` key can read no tenant inference data and move no money; an
 * inference key here would be able to do both. The write path rejects a value
 * already stored as an account credential so the two cannot be conflated.
 */
import { and, eq } from "drizzle-orm";
import { inferhubConfigKeys, providerAccounts } from "../../persistence/schema";
import { decryptCredentialToString, encryptCredential, hashSecret } from "../../security/crypto";
import type { CartethyiaDatabase } from "../../persistence/db-handle";

/** Shape returned to the console: whether a key is set, and never the key. */
interface InferhubKeyStatus {
  readonly configured: boolean;
  /** Last four characters, so an operator can tell two keys apart. */
  readonly last4: string | null;
  readonly updatedAt: string | null;
}

/**
 * Reads the stored key. Returns undefined when none is configured.
 *
 * A missing key is not an error — the routes report `no_config_key` and the
 * operator is told to add one, rather than an optional feature failing closed.
 */
export async function readConfigKey(db: CartethyiaDatabase): Promise<string | undefined> {
  try {
    const rows = await db
      .select({ ciphertext: inferhubConfigKeys.ciphertext })
      .from(inferhubConfigKeys)
      .where(eq(inferhubConfigKeys.id, SINGLETON_ID))
      .limit(1);
    const stored = rows[0]?.ciphertext;
    if (stored === undefined || stored === null) return undefined;
    const plaintext = decryptCredentialToString(stored).trim();
    return plaintext.length > 0 ? plaintext : undefined;
  } catch {
    // A decrypt failure (rotated encryption key, corrupt row) must not look
    // like "no key configured" in a way that silently hides data loss, but it
    // must not throw into a page render either. Returning undefined reports
    // `no_config_key`, which tells the operator to re-enter it.
    return undefined;
  }
}

/** Writes the key, replacing any previous value. */
export async function writeConfigKey(db: CartethyiaDatabase, value: string): Promise<void> {
  const trimmed = value.trim();
  const now = new Date();
  await db
    .insert(inferhubConfigKeys)
    .values({
      id: SINGLETON_ID,
      ciphertext: encryptCredential(trimmed),
      fingerprint: hashSecret(trimmed),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: inferhubConfigKeys.id,
      set: { ciphertext: encryptCredential(trimmed), fingerprint: hashSecret(trimmed), updatedAt: now },
    });
}

/** Removes the key entirely. */
export async function clearConfigKey(db: CartethyiaDatabase): Promise<void> {
  await db.delete(inferhubConfigKeys).where(eq(inferhubConfigKeys.id, SINGLETON_ID));
}

/** Whether a key is set, without decrypting it into a response. */
export async function keyStatus(db: CartethyiaDatabase): Promise<InferhubKeyStatus> {
  const rows = await db
    .select({ ciphertext: inferhubConfigKeys.ciphertext, updatedAt: inferhubConfigKeys.updatedAt })
    .from(inferhubConfigKeys)
    .where(eq(inferhubConfigKeys.id, SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { configured: false, last4: null, updatedAt: null };
  let last4: string | null = null;
  try {
    const plaintext = decryptCredentialToString(row.ciphertext).trim();
    last4 = plaintext.length >= 4 ? plaintext.slice(-4) : null;
  } catch {
    last4 = null;
  }
  return {
    configured: true,
    last4,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/**
 * One row for the whole deployment: the `config_read` key is a single operator
 * credential, not a per-account one.
 */
const SINGLETON_ID = "default";

/** Re-exported so routes can assert a key is not also an account credential. */
export async function isAlsoAccountCredential(
  db: CartethyiaDatabase,
  providerId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(and(eq(providerAccounts.providerId, providerId)))
    .limit(1);
  return rows.length > 0;
}

/** Builds the key store the InferHub routes take. */
export function createInferhubKeyStore(db: CartethyiaDatabase) {
  return {
    read: () => readConfigKey(db),
    write: (value: string) => writeConfigKey(db, value),
    clear: () => clearConfigKey(db),
    status: () => keyStatus(db),
  };
}
