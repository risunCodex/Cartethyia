/**
 * Credential-file helpers for provider probes.
 *
 * Every probe reads account exports from a JSON file passed on the command
 * line — never from environment variables, never hardcoded, never echoed.
 * This module also owns the masking helpers so a probe cannot accidentally
 * print a full token, refresh token, or user id.
 */
import { readFileSync } from "node:fs";

export interface AccountAuthState {
  readonly userId?: string;
  readonly machineId?: string;
}

export interface ExportedAccount {
  readonly id?: string;
  readonly providerId?: string;
  readonly label?: string;
  readonly credentialKind?: string;
  readonly status?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly authState?: AccountAuthState | null;
  readonly createdAt?: string;
}

export interface AccountsExport {
  readonly exportedAt?: string;
  readonly accounts?: readonly ExportedAccount[];
}

/** Reads the console account export file and returns its flat account list. */
export function readAccountsFile(path: string): readonly ExportedAccount[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (Array.isArray(parsed)) return parsed as readonly ExportedAccount[];
  if (typeof parsed === "object" && parsed !== null) {
    const accounts = (parsed as AccountsExport).accounts;
    if (Array.isArray(accounts)) return accounts as readonly ExportedAccount[];
  }
  throw new Error(`No account list found in ${path}`);
}

/**
 * Selects one account for a probe.
 *
 * Order of precedence: explicit label, explicit zero-based index, then the
 * first account whose providerId matches. A mismatch throws instead of
 * silently probing the wrong account.
 */
export function pickAccount(
  accounts: readonly ExportedAccount[],
  opts: { readonly providerId?: string; readonly label?: string; readonly index?: number } = {},
): ExportedAccount {
  if (opts.label !== undefined) {
    const found = accounts.find((a) => a.label === opts.label);
    if (found === undefined) throw new Error(`No account labeled "${opts.label}"`);
    return found;
  }
  if (opts.index !== undefined) {
    const account = accounts[opts.index];
    if (account === undefined) throw new Error(`No account at index ${opts.index}`);
    return account;
  }
  const provider = opts.providerId;
  const candidate =
    provider === undefined
      ? accounts[0]
      : accounts.find((a) => (a.providerId ?? "").toLowerCase() === provider.toLowerCase());
  if (candidate === undefined) {
    const why = provider === undefined ? "accounts file is empty" : `no ${provider} account`;
    throw new Error(`Cannot pick an account: ${why}`);
  }
  return candidate;
}

/** Returns the access token, failing loudly when the account has none. */
export function requireAccountToken(account: ExportedAccount): string {
  const token = account.accessToken?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error(`Account "${account.label ?? account.id ?? "?"}" has no accessToken`);
  }
  return token;
}

/** Masks a secret, keeping only a short prefix (e.g. `dt-…`). */
export function maskSecret(value: string, keepPrefix = 3): string {
  return value.length <= keepPrefix ? "…" : `${value.slice(0, keepPrefix)}…`;
}

/** Masks a UUID, keeping only its first segment. */
export function maskUuid(value: string): string {
  return value.slice(0, 8) + "…";
}
