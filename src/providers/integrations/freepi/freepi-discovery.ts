// Free-pi live model discovery.
//
// `GET /client-version` (Bearer) returns the full model catalog:
// `models[]` with `{id, name, section?, tier?}` plus `fusion`, `model`, and
// `notice`. Discovery parses that into `ModelDefinition` rows. The static
// roster remains the fallback when the live call fails (mirrors the Trae
// pattern).
//
// Normalization:
//   - The CLI's default id is `deepseek/deepseek-v4-flash`, while the catalog
//     lists the bare `deepseek-v4-flash`. They are one model; discovery maps
//     the bare id onto the default id so a single row survives (no duplicate,
//     no ambiguous pair inside the provider).
//   - Every discovered row is kept as-is (no free/pro filtering); the static
//     roster is the fallback and carries only the free rows.
//   - No vision/audio/document claims: the catalog publishes only
//     id/name/section/tier, and the live sweep verified text completions only.

import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import {
  FREEPI_CHAT_PATH,
  FREEPI_CLI_VERSION,
  FREEPI_CONTEXT_WINDOW,
  FREEPI_DEFAULT_MODEL,
  FREEPI_MAX_OUTPUT_TOKENS,
  FREEPI_PROVIDER_ID,
} from "./freepi-realm";

/** Catalog id → canonical roster id for one model. */
const CATALOG_ID_REMAP: Readonly<Record<string, string>> = {
  "deepseek-v4-flash": FREEPI_DEFAULT_MODEL,
};

/** Fetches the live model catalog. */
export async function discoverFreepiModels(input: {
  readonly token: string;
  readonly fetcher: typeof fetch;
  readonly signal?: AbortSignal;
  readonly providerId?: string;
}): Promise<readonly ModelDefinition[]> {
  const url = new URL("/client-version", "https://api.freepi.ai");
  const response = await input.fetcher(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: "application/json",
      "x-client-version": FREEPI_CLI_VERSION,
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed["models"]) ? (parsed["models"] as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  const out: ModelDefinition[] = [];
  for (const row of rows) {
    const rawId = String(row["id"] ?? "").trim();
    if (!rawId) continue;
    const id = CATALOG_ID_REMAP[rawId] ?? rawId;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(
      defineModel({
        id,
        providerId: input.providerId ?? FREEPI_PROVIDER_ID,
        wireFamily: "chat",
        endpoint: FREEPI_CHAT_PATH,
        ctx: FREEPI_CONTEXT_WINDOW,
        out: FREEPI_MAX_OUTPUT_TOKENS,
        vision: false,
        reasoning: true,
        toolCall: true,
      }),
    );
  }
  return out;
}
