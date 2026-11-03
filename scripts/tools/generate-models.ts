/**
 * Rebuilds the packed offline model catalog.
 *
 * Run: `bun run scripts/tools/generate-models.ts`
 *
 * Two upstreams feed one blob:
 *
 * - **models.dev** (`https://models.dev/api.json`) is the broad catalog: 223
 *   providers, 8090 model rows, and the only source of per-model pricing.
 * - **models.opencode.ai** (`https://models.opencode.ai/api.json`) is the
 *   authoritative catalog for the OpenCode family. Its rows carry
 *   `limit: {context, output}` plus `modalities`, `reasoning`, `tool_call`,
 *   and `cost`; the listing Cartethyia dispatches against
 *   (`/zen/v1/models`, `/inference/v1/models`) publishes ids only, with no
 *   limits at all. models.dev lags the OpenCode catalog — 18 of 127 rows
 *   disagreed at the time this was written, and a model added since the
 *   snapshot was taken was absent entirely, which is why every freshly fetched
 *   OpenCode model published an invented 200k/64k.
 *
 * OpenCode rows therefore **override** models.dev rows for the `opencode` and
 * `opencode-go` provider keys; a models.dev row for an OpenCode model that the
 * OpenCode catalog no longer lists is dropped rather than kept stale.
 *
 * The output is a single binary blob, base64-encoded into a TypeScript module.
 * See `catalog-format.ts` for the layout.
 */
import path from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { checkedPackedLimit, positiveInt } from "./generate-models-util";

const OUT_PATH = path.join(
  import.meta.dir,
  "../../src/providers/discovery/catalog/catalog-blob.ts",
);
const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENCODE_URL = "https://models.opencode.ai/api.json";

/** Every bit in a modality mask. Must match `CATALOG_MODALITIES`. */
const MODALITIES = ["text", "image", "pdf", "video", "audio"] as const;

const MAGIC = 0x43485443;
const VERSION = 1;
const HEADER_BYTES = 40;
const NO_COST = 0xffff_ffff;

/** Which `(context, output)` pair is worth keeping when a model repeats. */
const COST_KEYS = ["input", "output", "cache_read", "cache_write", "reasoning"] as const;

interface RawCost {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly cache_read?: unknown;
  readonly cache_write?: unknown;
  readonly reasoning?: unknown;
}

interface RawModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly limit?: { readonly context?: unknown; readonly output?: unknown };
  readonly modalities?: { readonly input?: unknown; readonly output?: unknown };
  readonly reasoning?: unknown;
  readonly tool_call?: unknown;
  readonly cost?: RawCost;
}

interface CatalogRow {
  /** Lowercased, trimmed provider key. */
  readonly provider: string;
  /** Lowercased, trimmed model id. */
  readonly id: string;
  readonly context: number;
  readonly output: number;
  readonly inMask: number;
  readonly outMask: number;
  readonly flags: number;
  readonly cost: Readonly<Record<string, number>>;
}

const align4 = (value: number): number => (value + 3) & ~3;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.trim().toLowerCase() : undefined;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function modalityMask(values: readonly string[]): number {
  return values.reduce((mask, value) => {
    const index = MODALITIES.indexOf(value as (typeof MODALITIES)[number]);
    return index < 0 ? mask : mask | (1 << index);
  }, 0);
}

function pruneCost(cost: RawCost | undefined): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const key of COST_KEYS) {
    const value = cost?.[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Whether an upstream id names a model a client can actually request.
 *
 * Three spellings are dropped, each for a different reason:
 * - `test` — a smoke-test placeholder in the OpenCode catalog;
 * - `*-backup` — an operator's manual failover row, not a published model;
 * - `gpt-6-astra` — a hallucinated vendor id models.dev carries under several
 *   resellers. It is excluded from pricing as well, because a price for a
 *   model nobody serves is worse than no price.
 */
function isRealModelId(id: string): boolean {
  if (id === "test") return false;
  if (id.endsWith("-backup")) return false;
  if (/\bgpt[- ]?6[- ]?astra\b/i.test(id)) return false;
  return true;
}

/** The models.dev rows for one provider, in the shape the blob stores. */
function modelsDevRows(provider: string, rawModels: Record<string, unknown>): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const value of Object.values(rawModels)) {
    if (typeof value !== "object" || value === null) continue;
    const model = value as RawModel;
    const id = text(model.id);
    if (id === undefined) continue;
    // Ids the upstream catalogs carry that are not models a caller can ask
    // for: a smoke-test placeholder, and an operator's manual row. Resolving
    // either would publish a limit and a price for a name only one deployment
    // knows. `gpt-6-astra` is a hallucinated vendor id models.dev carries
    // under several resellers, so it must not resolve to a price either.
    if (!isRealModelId(id)) continue;
    rows.push({
      provider,
      id,
      // The packed catalog stores these in u32 columns; values ≥ 2^31 would
      // wrap modulo 2^32 — fail loudly instead of corrupting the limit.
      context: checkedPackedLimit("context", positiveInt(model.limit?.context)),
      output: checkedPackedLimit("output", positiveInt(model.limit?.output)),
      inMask: modalityMask(stringList(model.modalities?.input)),
      outMask: modalityMask(stringList(model.modalities?.output)),
      flags: (model.reasoning === true ? 1 : 0) | (model.tool_call === true ? 2 : 0),
      cost: pruneCost(model.cost),
    });
  }
  return rows;
}

/** The OpenCode catalog's rows for one provider key. */
function opencodeRows(providerKey: string, rawModels: Record<string, unknown>): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const value of Object.values(rawModels)) {
    if (typeof value !== "object" || value === null) continue;
    const model = value as RawModel;
    const id = text(model.id);
    if (id === undefined) continue;
    // Same filter as the models.dev path: the OpenCode catalog also carries the
    // `gpt-6-astra` placeholder, and a row that survives here would resolve
    // (and price) an id the catalog is supposed to refuse.
    if (!isRealModelId(id)) continue;
    rows.push({
      provider: providerKey,
      id,
      // See the models.dev path: 2^31+ would wrap in the packed u32 column.
      context: checkedPackedLimit("context", positiveInt(model.limit?.context)),
      output: checkedPackedLimit("output", positiveInt(model.limit?.output)),
      inMask: modalityMask(stringList(model.modalities?.input)),
      outMask: modalityMask(stringList(model.modalities?.output)),
      flags: (model.reasoning === true ? 1 : 0) | (model.tool_call === true ? 2 : 0),
      cost: pruneCost(model.cost),
    });
  }
  return rows;
}

function bareId(modelId: string): string {
  return modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
}

function stripDateSuffix(modelId: string): string {
  return modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** How many optional cost fields a row states; used to pick the richest row. */
function costCompleteness(cost: Readonly<Record<string, number>>): number {
  let score = 0;
  if (typeof cost["cache_read"] === "number") score += 1;
  if (typeof cost["cache_write"] === "number") score += 1;
  if (typeof cost["reasoning"] === "number") score += 1;
  return score;
}

async function loadJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} responded with HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`${url} returned an invalid catalog`);
  }
  return payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Gather
// ---------------------------------------------------------------------------

const [modelsDev, opencodeLive] = await Promise.all([
  loadJson(MODELS_DEV_URL),
  loadJson(OPENCODE_URL),
]);

/** Provider keys the OpenCode catalog owns outright, with its own key spelling. */
const OPENCODE_CATALOG_KEYS: Readonly<Record<string, string>> = {
  opencode: "opencode",
  "opencode-go": "opencode-go",
};

const byKey = new Map<string, CatalogRow>();
const modelRowKey = (row: CatalogRow): string => `${row.provider}\u0000${row.id}`;

for (const [provider, providerValue] of Object.entries(modelsDev)) {
  if (typeof providerValue !== "object" || providerValue === null) continue;
  const rawModels = (providerValue as { models?: Record<string, unknown> }).models;
  if (rawModels === undefined || typeof rawModels !== "object") continue;
  const providerKey = provider.trim().toLowerCase();
  for (const row of modelsDevRows(providerKey, rawModels)) {
    byKey.set(modelRowKey(row), row);
  }
}
/**
 * Overlay the OpenCode catalog.
 *
 * Its provider keys are the ids models.dev also uses, so a live row replaces
 * the models.dev row for the same model id — that is the whole point, since
 * models.dev lags and its OpenCode limits are what published an invented
 * 200k/64k for every freshly fetched model.
 *
 * Rows the live catalog does not list are **kept**, not dropped: it is a
 * superset of the dispatch listing, but not of models.dev — the System One
 * decision ids (`jev-1.13`, `jev-1.13-free`) appear only in the dispatch
 * listing, and a stale limit on a model upstream retired is harmless while a
 * dropped row loses the limits of one still serving.
 */
for (const [liveKey, providerId] of Object.entries(OPENCODE_CATALOG_KEYS)) {
  const providerValue = opencodeLive[liveKey];
  if (typeof providerValue !== "object" || providerValue === null) {
    throw new Error(`OpenCode catalog has no "${liveKey}" entry`);
  }
  const rawModels = (providerValue as { models?: Record<string, unknown> }).models;
  if (rawModels === undefined || typeof rawModels !== "object") {
    throw new Error(`OpenCode catalog "${liveKey}" states no models`);
  }
  for (const row of opencodeRows(providerId, rawModels)) {
    byKey.set(modelRowKey(row), row);
  }
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

const providers = [...new Set([...byKey.values()].map((row) => row.provider))].sort(compareText);
const providerIndex = new Map(providers.map((provider, index) => [provider, index]));

/**
 * Every row, sorted by `(providerIndex, lowercasedId)`.
 *
 * The blob's exact lookup is a binary search over this order, so it is what
 * makes a `provider:model` hit one search with no index built at runtime.
 */
const rows = [...byKey.values()].sort(
  (a, b) =>
    (providerIndex.get(a.provider) ?? 0) - (providerIndex.get(b.provider) ?? 0) ||
    compareText(a.id, b.id),
);
/**
 * The cheapest fully-stated rate per bare id, for `costFor`'s global tier.
 *
 * Pricing is a property of the model, not the reseller: a gateway republishing
 * `grok-4.7` bills the model's rate even though models.dev files that id under
 * `xai`. The winner is the most-agreed `(input, output)` pair, and among rows
 * agreeing on the pair, the one stating the most optional fields — so a row
 * with `cache_read` supplies it rather than a bare row winning by order.
 */
function buildGlobalCostRows(): { keys: string[]; rowIndexes: number[] } {
  const votes = new Map<string, Map<string, { rowIndex: number; count: number; detail: number; total: number }>>();
  for (const [index, row] of rows.entries()) {
    if (typeof row.cost["input"] !== "number" || typeof row.cost["output"] !== "number") continue;
    const id = bareId(row.id);
    let byPair = votes.get(id);
    if (byPair === undefined) {
      byPair = new Map();
      votes.set(id, byPair);
    }
    const signature = `${row.cost["input"]}/${row.cost["output"]}`;
    const detail = costCompleteness(row.cost);
    const existing = byPair.get(signature);
    if (existing === undefined) {
      byPair.set(signature, {
        rowIndex: index,
        count: 1,
        detail,
        total: (row.cost["input"] ?? 0) + (row.cost["output"] ?? 0),
      });
      continue;
    }
    existing.count += 1;
    if (detail > existing.detail) {
      existing.rowIndex = index;
      existing.detail = detail;
    }
  }
  const chosen = new Map<string, number>();
  for (const [id, byPair] of votes) {
    let winner: { rowIndex: number; count: number; total: number } | undefined;
    for (const vote of byPair.values()) {
      if (
        winner === undefined ||
        vote.count > winner.count ||
        (vote.count === winner.count && vote.total > winner.total)
      ) {
        winner = { rowIndex: vote.rowIndex, count: vote.count, total: vote.total };
      }
    }
    if (winner !== undefined) chosen.set(id, winner.rowIndex);
  }
  // A dated snapshot bills the same rate as the model it snapshots.
  for (const [id, rowIndex] of [...chosen]) {
    const undated = stripDateSuffix(id);
    if (undated !== id && !chosen.has(undated)) chosen.set(undated, rowIndex);
  }
  const keys = [...chosen.keys()].sort(compareText);
  return { keys, rowIndexes: keys.map((key) => chosen.get(key) as number) };
}

const global = buildGlobalCostRows();

/** Bare-id ordering of row indices, for the ambiguous-bare and majority reads. */
const bareOrder = rows
  .map((_, index) => index)
  .sort((left, right) => compareText(bareId(rows[left]!.id), bareId(rows[right]!.id)) || left - right);

// ---------------------------------------------------------------------------
// Cost tuples
// ---------------------------------------------------------------------------

const costTuples: Readonly<Record<string, number>>[] = [];
const costIndexBySignature = new Map<string, number>();
const costTupleByRow: number[] = [];
for (const row of rows) {
  if (Object.keys(row.cost).length === 0) {
    costTupleByRow.push(NO_COST);
    continue;
  }
  const signature = COST_KEYS.map((key) => row.cost[key] ?? "").join("|");
  let index = costIndexBySignature.get(signature);
  if (index === undefined) {
    index = costTuples.length;
    costTuples.push(row.cost);
    costIndexBySignature.set(signature, index);
  }
  costTupleByRow.push(index);
}

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const fetchedAt = new Date().toISOString();

/** The shared string table: ids, provider keys, global cost keys, timestamp. */
const chunks: Uint8Array[] = [];
let stringBytes = 0;
function intern(value: string): number {
  const encoded = encoder.encode(value);
  const offset = stringBytes;
  chunks.push(encoded);
  stringBytes += encoded.length;
  return offset;
}

const providerOffsets = providers.map((provider) => intern(provider));
providerOffsets.push(stringBytes); // sentinel: end of the last provider name
const rowIdOffsets = rows.map((row) => intern(row.id));
const globalKeyOffsets = global.keys.map((key) => intern(key));
const fetchedAtOffset = intern(fetchedAt);

const stringTable = new Uint8Array(stringBytes);
{
  let at = 0;
  for (const chunk of chunks) {
    stringTable.set(chunk, at);
    at += chunk.length;
  }
}

const counts = {
  rowCount: rows.length,
  providerCount: providers.length,
  globalCount: global.keys.length,
  costCount: costTuples.length,
  stringBytes,
};

// Section offsets, computed the same way `catalogLayout` does.
let cursor = HEADER_BYTES;
const section = (bytes: number): number => {
  const offset = cursor;
  cursor = align4(cursor + bytes);
  return offset;
};
const L = {
  strings: section(stringBytes),
  providerOff: section((providers.length + 1) * 4),
  rowIdOff: section(rows.length * 4),
  rowIdLen: section(rows.length),
  globalKeyOff: section(global.keys.length * 4),
  globalKeyLen: section(global.keys.length),
  provIdx: section(rows.length * 2),
  ctx: section(rows.length * 4),
  out: section(rows.length * 4),
  inMask: section(rows.length),
  outMask: section(rows.length),
  flags: section(rows.length),
  costIdx: section(rows.length * 4),
  bareOrder: section(rows.length * 4),
  globalRow: section(global.keys.length * 4),
  costIn: section(costTuples.length * 8),
  costOut: section(costTuples.length * 8),
  costCacheRead: section(costTuples.length * 8),
  costCacheWrite: section(costTuples.length * 8),
  costReasoning: section(costTuples.length * 8),
};
const totalBytes = cursor;

const blob = new Uint8Array(totalBytes);
const view = new DataView(blob.buffer);
view.setUint32(0, MAGIC, true);
view.setUint32(4, VERSION, true);
view.setUint32(8, counts.rowCount, true);
view.setUint32(12, counts.providerCount, true);
view.setUint32(16, counts.globalCount, true);
view.setUint32(20, counts.costCount, true);
view.setUint32(24, counts.stringBytes, true);
view.setUint32(28, fetchedAtOffset, true);
view.setUint32(32, fetchedAt.length, true);

blob.set(stringTable, L.strings);
const u32 = new Uint32Array(blob.buffer);
const u16 = new Uint16Array(blob.buffer);
const f64 = new Float64Array(blob.buffer);

for (const [index, offset] of providerOffsets.entries()) u32[(L.providerOff + index * 4) / 4] = offset;
for (const [index, row] of rows.entries()) {
  u32[(L.rowIdOff + index * 4) / 4] = rowIdOffsets[index] as number;
  blob[L.rowIdLen + index] = encoder.encode(row.id).length;
  u16[(L.provIdx + index * 2) / 2] = providerIndex.get(row.provider) as number;
  u32[(L.ctx + index * 4) / 4] = row.context;
  u32[(L.out + index * 4) / 4] = row.output;
  blob[L.inMask + index] = row.inMask;
  blob[L.outMask + index] = row.outMask;
  blob[L.flags + index] = row.flags;
  u32[(L.costIdx + index * 4) / 4] = costTupleByRow[index] as number;
}
for (const [index, row] of bareOrder.entries()) u32[(L.bareOrder + index * 4) / 4] = row;
for (const [index, key] of global.keys.entries()) {
  u32[(L.globalKeyOff + index * 4) / 4] = globalKeyOffsets[index] as number;
  blob[L.globalKeyLen + index] = encoder.encode(key).length;
  u32[(L.globalRow + index * 4) / 4] = global.rowIndexes[index] as number;
}
for (const [index, cost] of costTuples.entries()) {
  f64[(L.costIn + index * 8) / 8] = cost["input"] ?? Number.NaN;
  f64[(L.costOut + index * 8) / 8] = cost["output"] ?? Number.NaN;
  f64[(L.costCacheRead + index * 8) / 8] = cost["cache_read"] ?? Number.NaN;
  f64[(L.costCacheWrite + index * 8) / 8] = cost["cache_write"] ?? Number.NaN;
  f64[(L.costReasoning + index * 8) / 8] = cost["reasoning"] ?? Number.NaN;
}

// Brotli, then base64. The packed blob is 584 KB; base64 alone would spend
// 778 KB of source on it. Brotli takes it to ~105 KB (140 KB base64) and
// decompresses in ~3 ms, which is cheaper than the `JSON.parse` it replaced.
const compressed = brotliCompressSync(blob, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
});
const base64 = compressed.toString("base64");
const opencodeCount = rows.filter(
  (row) => row.provider === "opencode" || row.provider === "opencode-go",
).length;

await Bun.write(
  OUT_PATH,
  `/**
 * GENERATED — do not edit.
 *
 * The packed, brotli-compressed offline model catalog for \`ModelsDevCatalog\`.
 * Rebuild with \`bun run scripts/tools/generate-models.ts\`.
 *
 * Sources: models.dev (pricing, every provider) and models.opencode.ai (the
 * authoritative limits for the OpenCode family).
 *
 * Fetched ${fetchedAt} · ${rows.length} rows · ${providers.length} providers ·
 * ${global.keys.length} global price keys · ${costTuples.length} cost tuples ·
 * ${(totalBytes / 1024).toFixed(0)} KB packed → ${(compressed.length / 1024).toFixed(0)} KB brotli.
 */
export const CATALOG_BLOB_BROTLI_BASE64 =
  "${base64}";

/** Byte length of the blob *after* decompression, so a reader can preallocate. */
export const CATALOG_BLOB_BYTES = ${totalBytes};
`,
);

console.log(
  `Wrote ${rows.length} rows across ${providers.length} providers ` +
    `(${opencodeCount} OpenCode) · ${global.keys.length} global price keys · ` +
    `${costTuples.length} cost tuples · ${(totalBytes / 1024).toFixed(0)} KB packed / ` +
    `${(compressed.length / 1024).toFixed(0)} KB brotli → ${OUT_PATH}`,
);
