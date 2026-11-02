// Console authentication, sessions, lockouts, first-boot setup, and audit.
import type { ConsoleSession, ConsoleUser } from "../../persistence/schema";

import { isRecord } from "../../protocol/codecs";

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

export function sessionRecord(value: unknown): ConsoleSession | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const userId = value.userId;
  const sessionToken = value.sessionToken;
  const ipAddress = value.ipAddress;
  const userAgent = value.userAgent;
  if (
    typeof id !== "string" ||
    typeof userId !== "string" ||
    typeof sessionToken !== "string"
  ) {
    return undefined;
  }
  const expiresAt = asDate(value.expiresAt);
  const createdAt = asDate(value.createdAt);
  if (!expiresAt || !createdAt) return undefined;
  // Construct the result explicitly field-by-field so the output shape is
  // exactly what was validated — arbitrary extra keys on a driver row must
  // not survive into the typed session.
  return {
    id,
    userId,
    sessionToken,
    ...(ipAddress === null || typeof ipAddress === "string" ? { ipAddress } : { ipAddress: null }),
    ...(userAgent === null || typeof userAgent === "string" ? { userAgent } : { userAgent: null }),
    expiresAt,
    createdAt,
  };
}

export function userRecord(value: unknown): ConsoleUser | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const username = value.username;
  const passwordHash = value.passwordHash;
  const isActive = value.isActive;
  if (
    typeof id !== "string" ||
    typeof username !== "string" ||
    typeof passwordHash !== "string" ||
    typeof isActive !== "boolean"
  ) {
    return undefined;
  }
  // Timestamps are coerced through `asDate` because SQLite hands them back as
  // text; a login path that rejects non-Date values must still work there.
  const createdAt = asDate(value.createdAt);
  const updatedAt = asDate(value.updatedAt);
  if (!createdAt || !updatedAt) return undefined;
  const tenantId = value.tenantId;
  const email = value.email;
  const displayName = value.displayName;
  const isFirstBoot = value.isFirstBoot;
  const isPlatformAdmin = value.isPlatformAdmin;
  // Construct the result explicitly field-by-field so the output shape is
  // exactly what was validated — arbitrary extra keys on a driver row must
  // not survive into the typed user.
  return {
    id,
    tenantId: typeof tenantId === "string" ? tenantId : "",
    username,
    email: typeof email === "string" ? email : null,
    passwordHash,
    displayName: typeof displayName === "string" ? displayName : null,
    isActive,
    isPlatformAdmin: isPlatformAdmin === true,
    isFirstBoot: isFirstBoot === true,
    createdAt,
    updatedAt,
  };
}

function mutationAffectedRows(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["rowCount", "rowsAffected", "changes"] as const) {
    const count = value[key];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  }
  return undefined;
}

/** Awaitable Drizzle mutation builder that may expose `.returning()`. */
interface ReturningBuilder extends PromiseLike<unknown> {
  returning?: (...columns: unknown[]) => PromiseLike<unknown[]>;
}

export async function returningRows(
  builder: ReturningBuilder,
): Promise<{ rows: unknown[]; supported: boolean; affectedRows?: number }> {
  if (typeof builder.returning === "function") {
    return { rows: await builder.returning(), supported: true };
  }
  const result = await builder;
  const affectedRows = mutationAffectedRows(result);
  return affectedRows === undefined
    ? { rows: [], supported: false }
    : { rows: [], supported: false, affectedRows };
}

export function assertMutationApplied(
  result: { rows: unknown[]; supported: boolean; affectedRows?: number },
  operation: string,
): void {
  const applied = result.supported ? result.rows.length > 0 : result.affectedRows === 1;
  if (!applied) throw new Error(`${operation} was not persisted`);
}
