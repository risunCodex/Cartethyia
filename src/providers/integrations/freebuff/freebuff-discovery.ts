// Freebuff live model discovery — TypeScript, Freebuff provider.
//
// `GET /api/v1/freebuff/models` with catalog protocol 1 + desktop client. The
// response rows carry `m-<hex>` keys, `legacyDigests`, display names, and an
// ephemeral handle (`fbm1.*`). Discovery maps rows to ModelDefinitions keyed on
// the `m-<hex>` id; the handle is NOT stored (it is single-fetch ephemeral and
// re-resolved per dispatch).

import type { ModelDefinition } from "../../provider-model-definition";
import { defineModel } from "../../provider-model-definition";
import type { ProviderModelDiscovery } from "../../discovery/discovery-types";
import {
  FREEBUFF_API_HOST,
  FREEBUFF_CATALOG_PROTOCOL_HEADER,
  FREEBUFF_CATALOG_PROTOCOL_VERSION,
  FREEBUFF_CHAT_COMPLETIONS_PATH,
  FREEBUFF_CLIENT_HEADER,
  FREEBUFF_CLIENT_HEADER_VALUE,
} from "./freebuff";

const KNOWN_PREMIUM_KEYS: ReadonlySet<string> = new Set([
  "m-127314bb39", // DeepSeek V4.1 Flash Fast
  "m-5a5d0e255e", // GPT-6 Luna
  "m-ffcbc2bcf3", // Muse Spark 1.3
  "m-7d6e1b3ae0", // GPT-6.1 Terra
  "m-5b6a604eb6", // Claude Haiku 5.5 · 100k
]);

const KNOWN_FREE_KEYS: ReadonlySet<string> = new Set([
  "m-096e75164d", // DeepSeek Fast
  "m-8db1ccbba6", // DeepSeek
  "m-61c26317cc", // DeepSeek Slow
  "m-9a7e098cc1", // Solar Pro 4
  "m-69307952f8", // Solar Mini 4
  "m-0921d81ce7", // Crouton Alpha
  "m-02244092cb", // Glyph Cluster
  "m-ddc687c50f", // Nemotron 3.5 Lightning
]);

/**
 * Live discovery over the static floor: `GET /api/v1/freebuff/models` answers
 * with the account's current roster. A failed fetch returns the static roster
 * (offline fallback) rather than raising.
 */
export function freebuffModelDiscovery(): ProviderModelDiscovery {
  return async ({ credential, fetcher }) => {
    if (credential.trim().length === 0) return null;
    const fetchFn = fetcher ?? globalThis.fetch;
    const res = await fetchFn(`${FREEBUFF_API_HOST}/api/v1/freebuff/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.trim()}`,
        [FREEBUFF_CATALOG_PROTOCOL_HEADER]: FREEBUFF_CATALOG_PROTOCOL_VERSION,
        [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    if (typeof body !== "object" || body === null || !Array.isArray((body as { rows?: unknown }).rows)) return null;
    const rows = (body as { rows: unknown[] }).rows;
    const models: ModelDefinition[] = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      const key = typeof r["key"] === "string" ? r["key"] : undefined;
      const display = typeof r["displayName"] === "string" ? r["displayName"] : undefined;
      const access = typeof r["access"] === "string" ? r["access"] : undefined;
      const premium = r["premium"] === true;
      if (!key) continue;
      const isPremium = premium || access === "locked" || KNOWN_PREMIUM_KEYS.has(key);
      const isFree = KNOWN_FREE_KEYS.has(key) || access === "open";
      models.push(
        defineModel({
          id: key,
          providerId: "freebuff",
          wireFamily: "chat",
          endpoint: FREEBUFF_CHAT_COMPLETIONS_PATH,
          ctx: 131_072,
          out: 8_192,
          reasoning: true,
          toolCall: true,
          ...(isFree ? { free: true, freeTier: true } : {}),
          ...(isPremium ? { proOnly: true } : {}),
          // Preserve the display name for the console list.
          ...(display ? { warnings: [{ kind: "freebuff_display", message: display, severity: "info" as const }] } : {}),
        }),
      );
    }
    return models.length > 0 ? models : null;
  };
}

export { defineModel };
