/**
 * Maps a stored `auth_method` onto a short, operator-facing badge label for
 * the identity family that minted the credential. Kiro (and similar
 * multi-family providers) can have many accounts that all look like plain
 * OAuth; the badge tells a Social sign-in apart from an OIDC/Builder-ID one
 * without exposing any auth state.
 */

export interface AccountAuthMethodPill {
  readonly label: string;
  readonly tone: "default" | "accent";
}

export function authMethodPill(authMethod: string | undefined): AccountAuthMethodPill | null {
  switch (authMethod) {
    case "google":
    case "github":
      return { label: "Social", tone: "default" };
    case "builder-id":
    case "idc":
      return { label: "OIDC", tone: "default" };
    case "external_idp":
      return { label: "Enterprise IdP", tone: "default" };
    case "api_key":
      return { label: "API key", tone: "default" };
    case "imported":
      return { label: "Imported", tone: "default" };
    default:
      return null;
  }
}
