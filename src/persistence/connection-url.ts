/**
 * Resolves and validates an explicitly configured connection string.
 *
 * Postgres and Redis both read one URL variable, and both sit behind platforms
 * that may publish the connection under a different name or as discrete
 * host/user/password parts. The rules are identical, so they live here once:
 *
 * - An empty value counts as absent. A `${{ Service.VAR }}` reference to a
 *   service whose name does not match resolves to `""` rather than failing, and
 *   treating that as "configured" turns a one-word mistake into an unexplained
 *   connection error.
 * - Every candidate is validated the same way, so a malformed alternative is
 *   reported against the variable it came from instead of the primary name.
 * - Host and port must be explicit. No host is ever inferred — every value here
 *   was provided by the deployment.
 */

/** One place a connection string may come from, with the name to report. */
export interface ConnectionUrlCandidate {
  /** Variable the value came from; named in validation errors. */
  readonly source: string;
  readonly value: string | undefined;
}

/** How one backing service's connection string is resolved. */
interface ConnectionUrlSpec {
  /** Accepted URL schemes, e.g. `postgres:` / `postgresql:`. */
  readonly schemes: readonly string[];
  /** URL variables, in resolution order. */
  readonly candidates: readonly ConnectionUrlCandidate[];
  /** Discrete parts, used only when no URL variable is set. */
  readonly assembled?: ConnectionUrlCandidate | undefined;
  /** Error text when nothing at all is configured. */
  readonly missing: string;
}

export function requireConnectionUrl(spec: ConnectionUrlSpec): string {
  for (const candidate of spec.candidates) {
    const trimmed = candidate.value?.trim();
    if (trimmed) return validateConnectionUrl(trimmed, candidate.source, spec.schemes);
  }
  const assembled = spec.assembled;
  if (assembled?.value !== undefined) {
    return validateConnectionUrl(assembled.value, assembled.source, spec.schemes);
  }
  throw new Error(spec.missing);
}

function validateConnectionUrl(url: string, source: string, schemes: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${source} is not a valid URL: ${url}`);
  }
  if (!schemes.includes(parsed.protocol)) {
    throw new Error(
      `${source} must use the ${schemes.join(" or ")} scheme (got "${parsed.protocol}")`,
    );
  }
  if (!parsed.hostname) {
    throw new Error(`${source} must include an explicit host (got hostname="${parsed.hostname}")`);
  }
  // Default ports are valid: postgres://host/db and redis://host rely on
  // 5432/6379 and must not force operators to append them by hand.
  if (!parsed.port) return url;
  return url;
}

/** Percent-encodes one authority component so it cannot reshape the URL. */
export function encodeConnectionComponent(value: string): string {
  return encodeURIComponent(value);
}

/** Brackets an IPv6 literal so it is not read as a `host:port` pair. */
export function formatConnectionHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
