/**
 * Provider-response shaping for the provider console domain: the sanitized
 * wire response, registry capability attachment, browser login-field
 * mapping, and the cached provider-list computation. Extracted from
 * `provider-operations.ts`; the operations factory keeps the access
 * validation and side effects (audit, snapshot invalidation, sync).
 */
import { ConsoleDomainError } from "../../shared/errors";
import {
  isWireFamily,
  type ProviderLoginField,
  type ProviderResponse,
} from "./contracts";
import { getProviderClientVersion, getRouteIdentityVersions } from "../../../providers/operations/client-versions";
import type { OAuthLoginField } from "../../../providers/authentication/oauth-flow-store";
import { providerCredentialHint, providerCredentialUrl, providerDisplayName, providerHasAdapterUserAgent, providerOperatorNotice, providerServiceKinds, customProviderServiceKinds, type CompatibilityProfile } from "../../../providers/provider-metadata";
import type { ProviderRegistry } from "../../../providers/provider-registry";
import type { ProviderCatalogConfig } from "./provider-operations";
import { pickDefined } from "../../shared/object";

export function sanitizeProviderResponse(
  provider: unknown,
  includeSecrets = false,
): ProviderResponse {
  if (!provider || typeof provider !== "object")
    throw new ConsoleDomainError("invalid_provider", 400, "Provider must be an object");
  const p = provider as Record<string, unknown>;
  if (typeof p.providerId !== "string" || p.providerId.length === 0)
    throw new ConsoleDomainError("invalid_provider", 400, "Provider providerId is required");
  for (const field of ["enabled", "isBuiltIn", "requiresAccount"] as const) {
    if (p[field] !== undefined && typeof p[field] !== "boolean")
      throw new ConsoleDomainError("invalid_provider", 400, `Provider ${field} must be a boolean`);
  }
  // Both are derived from bundled metadata rather than the persisted record, so
  // a BYOK provider (or a stale row for a provider that gained a page later)
  // always reports the current canonical values.
  const credentialUrl = providerCredentialUrl(p.providerId);
  const credentialHint = providerCredentialHint(p.providerId);
  const operatorNotice = providerOperatorNotice(p.providerId);
  const clientVersion = getProviderClientVersion(p.providerId);
  const compatibilityProfile = p.compatibilityProfile as CompatibilityProfile | undefined;
  const isBuiltIn = (p.isBuiltIn as boolean | undefined) ?? false;
  const response: ProviderResponse = {
    providerId: p.providerId,
    serviceKinds: isBuiltIn
      ? providerServiceKinds(p.providerId)
      : customProviderServiceKinds(compatibilityProfile),
    displayName: providerDisplayName(p.providerId),
    enabled: (p.enabled as boolean | undefined) ?? true,
    isBuiltIn,
    requiresAccount: (p.requiresAccount as boolean | undefined) ?? true,
    hasAdapterUserAgent: providerHasAdapterUserAgent(p.providerId),
    // No model advertises search; see the note in provider-metadata.ts.
    supportsWebSearch: false,
    ...pickDefined({ credentialUrl }),
    ...pickDefined({ credentialHint }),
    ...pickDefined({ operatorNotice }),
    ...pickDefined({ clientVersion }),
    routeIdentityVersions: getRouteIdentityVersions(),
    supportsModelDiscovery: (p.supportsModelDiscovery as boolean | undefined) ?? !isBuiltIn,
    ...(typeof p.createdAt === "string" ? { createdAt: p.createdAt } : {}),
    ...(typeof p.updatedAt === "string" ? { updatedAt: p.updatedAt } : {}),
  };
  if (includeSecrets && p.capabilityProfile)
    response.capabilityProfile = p.capabilityProfile as Record<string, unknown>;
  if (includeSecrets && typeof p.baseUrl === "string") response.baseUrl = p.baseUrl;
  if (includeSecrets && p.compatibilityProfile)
    response.compatibilityProfile = p.compatibilityProfile as CompatibilityProfile;
  if (isWireFamily(p.wireFamilyDefault)) response.wireFamilyDefault = p.wireFamilyDefault;
  // Derived policy, not a secret: always projected. Entries are re-validated so
  // a malformed record narrows to the families the vocabulary admits instead of
  // emitting a value dispatch would reject.
  if (Array.isArray(p.supportedWireFamilies)) {
    const families = p.supportedWireFamilies.filter(isWireFamily);
    if (families.length > 0) response.supportedWireFamilies = families;
  }
  return response;
}

async function attachProviderCapabilities(
  response: ProviderResponse,
  registry: ProviderRegistry,
): Promise<ProviderResponse> {
  const supportsDiscovery =
    !response.isBuiltIn || (await registry.resolveModelDiscovery(response.providerId)) !== undefined;
  const client = await registry.resolveLoginClient(response.providerId);
  if (!client)
    return {
      ...response,
      supportsModelDiscovery: supportsDiscovery,
      // A credential-less custom provider is exactly that: it was created with
      // the "Public Key" switch, so the dashboard names the account row and
      // keeps account management reachable.
      ...(response.requiresAccount === false ? { publicKey: true } : {}),
    };
  // Capability is a static property of the client's methods, never of one URL
  // build: a client whose `buildAuthorizeUrl` can throw must still report the
  // browser flow it genuinely supports, otherwise the Login with browser button
  // disappears for a provider that has one.
  //
  // `supportsBrowserCode` is authoritative when the client states it. The base
  // `OAuthClient` always defines `buildAuthorizeUrl` and `exchangeCode` — the
  // device-only clients override the latter to throw — so testing only for the
  // methods reports browser support for every device-only provider (Cline,
  // Grok, Kimi, Muse, Buddy, GitHub, Kilo, xAI). The dashboard then offered "Login with
  // browser" on those rows and the click failed server-side with
  // `browser_code_not_supported`. An explicit `false` suppresses the flow; an
  // omitted flag keeps the method-shape test, since a client that does not
  // state the capability is judged by what it can do.
  const hasBrowserFlow =
    client.supportsBrowserCode === false
      ? false
      : typeof client.buildAuthorizeUrl === "function" &&
        typeof client.exchangeCode === "function";
  return {
    ...response,
    supportsModelDiscovery: supportsDiscovery,
    ...(response.requiresAccount === false ? { publicKey: true } : {}),
    oauthFlows: {
      browser: hasBrowserFlow,
      device: client.supportsDeviceCode === true && typeof client.startDeviceAuth === "function",
      // The import path is offered only when the client can actually complete
      // one, so the dashboard never renders a form whose submit the server
      // would refuse.
      import: typeof client.importCredential === "function",
      // Both halves are required: an import-only client that cannot refresh
      // (Alibaba Coding Plan, Cloudflare AI) stores a durable static key, while
      // one that can (Trae) stores a token pair that expires and renews. The
      // refresher comes from the registry rather than the login client because
      // that is where `loadAuthentication` registers it.
      refreshable:
        typeof client.importCredential === "function" &&
        (await registry.resolveRefresher(response.providerId)) !== undefined,
      browserLoginFields: (client.browserLoginFields ?? []).map(toProviderLoginField),
      deviceLoginFields: (client.deviceLoginFields ?? []).map(toProviderLoginField),
      importFields: (client.importFields ?? []).map(toProviderLoginField),
    },
  };
}

/** Copies a registry login-field descriptor into the browser-facing contract. */
function toProviderLoginField(field: OAuthLoginField): ProviderLoginField {
  return {
    key: field.key,
    label: field.label,
    ...pickDefined({ placeholder: field.placeholder }),
    ...pickDefined({ secret: field.secret }),
    ...pickDefined({ required: field.required }),
    ...pickDefined({ defaultValue: field.defaultValue }),
    ...(field.options === undefined
      ? {}
      : { options: field.options.map((option) => ({ value: option.value, label: option.label })) }),
  };
}
/** Provider-list cache TTL: short enough that a 60s poll re-checks the DB
 * occasionally, long enough that a warm page does zero per-card work. */
const PROVIDER_LIST_CACHE_TTL_SECONDS = 20;

/** Cache key namespace + shape version for the provider-list overview. */
const PROVIDER_LIST_CACHE_SHAPE = "providers:v1:list";

/** Version of the read-through cache backend, so a bump is a key rotation. */
const PROVIDER_LIST_CACHE_REVISION = 1;

/** The list projection shared by `listProviders` and its cached wrapper. */
export async function computeProviderList(
  config: ProviderCatalogConfig,
  tenantId: string,
): Promise<ProviderResponse[]> {
  const [records, accountCounts, modelCounts] = await Promise.all([
    config.store.list(tenantId),
    config.store.providerAccountCounts(tenantId),
    config.store.providerModelCounts(tenantId),
  ]);
  const accountsByProvider = new Map(accountCounts.map((row) => [row.providerId, row]));
  const modelsByProvider = new Map(modelCounts.map((row) => [row.providerId, row.count]));
  return Promise.all(
    records.map((r) => {
      const counts = accountsByProvider.get(r.providerId);
      return attachProviderCapabilities(
        {
          ...sanitizeProviderResponse(r),
          // A provider with no persisted accounts is not "configured"; the
          // count fields are still present (zero) so the card renders the
          // empty state instead of a loading placeholder.
          configured: counts !== undefined,
          accountCount: counts?.total ?? 0,
          activeAccountCount: counts?.active ?? 0,
          modelCount: modelsByProvider.get(r.providerId) ?? 0,
        },
        config.providerRegistry,
      );
    }),
  );
}

export {
  PROVIDER_LIST_CACHE_REVISION,
  PROVIDER_LIST_CACHE_SHAPE,
  PROVIDER_LIST_CACHE_TTL_SECONDS,
  attachProviderCapabilities,
  toProviderLoginField,
};
