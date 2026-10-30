/**
 * Centralized query-key factory for every dashboard server-state resource.
 *
 * Keys are readonly tuples so query readers and mutation invalidations share one
 * authority. Feature code must not create inline TanStack Query keys.
 */
export const queryKeys = {
  session: {
    current: ["console", "session"] as const,
  },
  system: {
    health: ["console", "system", "health"] as const,
  },
  releases: {
    githubLatest: ["console", "releases", "github-latest"] as const,
  },
  usageAnalytics: {
    summary: (period: string) => ["console", "usage", "summary", period] as const,
    chart: (period: string) => ["console", "usage", "chart", period] as const,
    by: (period: string, dimension: string) => ["console", "usage", "by", period, dimension] as const,
    requests: (period: string, limit: number, httpStatus?: number | null) =>
      ["console", "usage", "requests", period, limit, httpStatus ?? "all"] as const,
    requestDetail: (requestId: string) => ["console", "usage", "requests", requestId] as const,
  },
  providers: {
    all: ["console", "providers"] as const,
    detail: (providerId: string) => ["console", "providers", providerId] as const,
    models: (providerId: string | undefined) =>
      ["console", "providers", providerId, "models"] as const,
    flatAll: ["console", "providers", "models-flat-all"] as const,
    accounts: (providerId: string | undefined) =>
      ["console", "providers", providerId, "accounts"] as const,
    usageMatrix: (providerId: string | undefined) =>
      ["console", "providers", providerId, "usage-matrix"] as const,
    routing: (providerId: string | undefined) =>
      ["console", "providers", providerId, "routing"] as const,
    accountInflight: (providerId: string | undefined) =>
      ["console", "providers", providerId, "account-inflight"] as const,
    healthEvents: (providerId: string | undefined, accountId: string | undefined) =>
      [
        "console",
        "providers",
        providerId,
        "accounts",
        accountId,
        "health-events",
      ] as const,
  },
  modelRouting: {
    all: ["console", "model-routing"] as const,
    aliases: ["console", "model-routing", "aliases"] as const,
    combos: ["console", "model-routing", "combos"] as const,
  },
  network: {
    pools: ["console", "network", "pools"] as const,
    poolStrategy: ["console", "network", "pool-strategy"] as const,
  },
  apiKeys: {
    all: ["console", "api-keys"] as const,
    shareLink: (keyId: string) => ["console", "api-keys", keyId, "share"] as const,
    sharedKeys: (keyId: string) => ["console", "api-keys", keyId, "shared-keys"] as const,
    sharedKeyActivity: (parentKeyId: string, childKeyId: string) =>
      ["console", "api-keys", parentKeyId, "shared-keys", childKeyId, "activity"] as const,
  },
  settings: {

    runtime: ["console", "settings", "runtime"] as const,
    /** On-disk telemetry and payload sizes, and the reclaim actions. */
    diskUsage: ["console", "settings", "disk-usage"] as const,
  },
  remoteSupport: {
    status: ["console", "remote-support", "status"] as const,
  },
  cliTools: {
    registry: ["console", "cli-tools", "registry"] as const,
    statuses: ["console", "cli-tools", "statuses"] as const,
    mappings: (toolId: string, keyId: string) => ["console", "cli-tools", toolId, keyId, "mappings"] as const,
  },
  audit: {
    list: (filters: { action?: string; actor?: string; cursor?: string; limit?: number }) =>
      ["console", "audit", "list", filters] as const,
  },
  quota: {
    all: ["console", "quota"] as const,
    account: (accountId: string) => ["console", "quota", "account", accountId] as const,
    resets: (accountId: string) => ["console", "quota", "account", accountId, "resets"] as const,
  },
  /**
   * InferHub market data. Deliberately has **no** `refetchInterval` anywhere it
   * is used: price and availability are read when an operator opens a page, not
   * polled in the background.
   */
  inferhub: {
    summary: ["console", "inferhub", "summary"] as const,
    models: (prefix?: string) => ["console", "inferhub", "models", prefix ?? "all"] as const,
  },
  systemPrompt: {
    config: ["console", "system-prompt"] as const,
  },
} as const;
