// Perch credential-envelope parsing.
//
// Perch accounts authenticate via Supabase OAuth (PKCE), and the stored secret
// is the OAuth envelope JSON with `accessToken` (or `access_token`). Both the
// dispatch adapter and the quota collector need the access token out of that
// envelope; the parse is shared here and each surface keeps its own fallback
// for a secret that is not an envelope.

/**
 * Reads the access token out of a stored Perch OAuth envelope.
 *
 * Returns the token when the secret parses as JSON and carries `accessToken`
 * (or `access_token`) as a string; `null` when it is not such an envelope
 * (not JSON, or JSON without a token field). The caller decides what a
 * `null` means for its surface.
 */
export function parsePerchCredentialToken(secret: string): string | null {
  try {
    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const found = parsed["accessToken"] ?? parsed["access_token"];
    return typeof found === "string" ? found : null;
  } catch {
    return null;
  }
}
