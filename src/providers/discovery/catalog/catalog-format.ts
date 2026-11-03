/**
 * Packed binary layout for the offline model catalog.
 *
 * The catalog is one flat binary blob read as columnar typed arrays: zero
 * objects per row, zero `JSON.parse`, and no index built at import — so nothing
 * is materialised before the server can answer its first request.
 *
 * Layout (little-endian; every section is 4-byte aligned):
 *
 * ```text
 * header        10 x u32: magic, version, rowCount, providerCount,
 *                         globalCount, costCount, stringBytes,
 *                         fetchedAtOffset, fetchedAtLength, reserved
 * strings       concatenated UTF-8, shared by every string column
 * providerOff   (providerCount + 1) x u32   offsets into `strings`
 * rowIdOff      rowCount x u32              id offset
 * rowIdLen      rowCount x u8               id byte length
 * globalKeyOff  globalCount x u32           bare-id offset
 * globalKeyLen  globalCount x u8            bare-id byte length
 * provIdx       rowCount x u16              provider index
 * ctx           rowCount x u32              0 = unstated
 * out           rowCount x u32              0 = unstated
 * inMask        rowCount x u8
 * outMask       rowCount x u8
 * flags         rowCount x u8               bit0 reasoning, bit1 toolCall
 * costIdx       rowCount x u32              cost tuple index, NO_COST = none
 * bareOrder     rowCount x u32              row indices sorted by bare id
 * globalRow     globalCount x u32           cost-lookup row index
 * costIn … costReasoning                     costCount x f64 (NaN = unstated)
 * ```
 *
 * Two orderings are stored so both lookups are binary searches over the blob
 * itself and never build an index:
 *
 * - rows are sorted by `(provIdx, idLower)`, so an exact `provider:model` hit
 *   is one search;
 * - `bareOrder` holds row indices sorted by the id's bare form (everything
 *   after the reseller's `/`), so the ambiguous-bare and majority lookups walk
 *   a contiguous range.
 *
 * Only the *lowercased, trimmed* id is stored. `resolve` already compares
 * lowercased ids, and no consumer reads the catalog's display spelling of an id
 * — storing the original too would duplicate ~165 KB for a field nothing reads.
 * Model display names are not stored at all, for the same reason.
 */

/** "CTHC" in little-endian byte order. */
export const CATALOG_MAGIC = 0x43485443;
/** Bumped whenever a column is added, removed, or reordered. */
export const CATALOG_VERSION = 1;
/** 10 little-endian `u32` header fields. */
export const CATALOG_HEADER_BYTES = 40;
/** Sentinel in `costIdx`: this row states no price. */
export const NO_COST = 0xffff_ffff;

/** The modality vocabulary the masks index into, in bit order. */
export const CATALOG_MODALITIES = ["text", "image", "pdf", "video", "audio"] as const;

/** Billing metadata for one model, or a row that states none. */
export interface ModelsDevModelCost {
  readonly input: number | null;
  readonly output: number | null;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly reasoning?: number;
  readonly pricing_model: "pay-per-use" | "subscription" | "unknown";
}

/** Canonical model metadata as read out of the packed catalog. */
export interface ModelsDevModelMetadata {
  readonly id: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly cost: ModelsDevModelCost;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly reasoning: boolean;
  readonly toolCall: boolean;
}

/** Counts that determine every section offset. */
export interface CatalogCounts {
  readonly rowCount: number;
  readonly providerCount: number;
  readonly globalCount: number;
  readonly costCount: number;
  readonly stringBytes: number;
}

/** Byte offset of each section, computed from the counts alone. */
export interface CatalogLayout {
  readonly strings: number;
  readonly providerOff: number;
  readonly rowIdOff: number;
  readonly rowIdLen: number;
  readonly globalKeyOff: number;
  readonly globalKeyLen: number;
  readonly provIdx: number;
  readonly ctx: number;
  readonly out: number;
  readonly inMask: number;
  readonly outMask: number;
  readonly flags: number;
  readonly costIdx: number;
  readonly bareOrder: number;
  readonly globalRow: number;
  readonly costIn: number;
  readonly costOut: number;
  readonly costCacheRead: number;
  readonly costCacheWrite: number;
  readonly costReasoning: number;
  readonly totalBytes: number;
}

const align4 = (value: number): number => (value + 3) & ~3;

/**
 * Section offsets for one catalog shape.
 *
 * Shared by the generator (which writes into the layout) and the decoder
 * (which reads out of it), so the two can never disagree about a column order —
 * a failure that would silently swap context limits for output limits.
 */
export function catalogLayout(counts: CatalogCounts): CatalogLayout {
  const { rowCount, providerCount, globalCount, costCount, stringBytes } = counts;
  let at = CATALOG_HEADER_BYTES;
  const take = (bytes: number): number => {
    const offset = at;
    at = align4(at + bytes);
    return offset;
  };
  return {
    strings: take(stringBytes),
    providerOff: take((providerCount + 1) * 4),
    rowIdOff: take(rowCount * 4),
    rowIdLen: take(rowCount),
    globalKeyOff: take(globalCount * 4),
    globalKeyLen: take(globalCount),
    provIdx: take(rowCount * 2),
    ctx: take(rowCount * 4),
    out: take(rowCount * 4),
    inMask: take(rowCount),
    outMask: take(rowCount),
    flags: take(rowCount),
    costIdx: take(rowCount * 4),
    bareOrder: take(rowCount * 4),
    globalRow: take(globalCount * 4),
    costIn: take(costCount * 8),
    costOut: take(costCount * 8),
    costCacheRead: take(costCount * 8),
    costCacheWrite: take(costCount * 8),
    costReasoning: take(costCount * 8),
    totalBytes: at,
  };
}

const UNKNOWN_COST: ModelsDevModelCost = {
  input: null,
  output: null,
  pricing_model: "unknown",
};

const decoder = new TextDecoder();

const FLAG_REASONING = 1;
const FLAG_TOOL_CALL = 2;

/**
 * Ceiling on {@link PackedCatalog}'s row-metadata cache.
 *
 * Sized well under the catalog's 8941 rows: a gateway resolves a working set of
 * models, not the whole catalog, and every entry is rebuilt from the blob in a
 * few typed-array reads. Holding more than this trades RAM for reads measured
 * in nanoseconds.
 */
export const METADATA_CACHE_MAX_ENTRIES = 2048;
const SLASH = 0x2f;

/** Lowercases and trims an ASCII id into the exact bytes the blob stores. */
export function lowerAscii(value: string): Uint8Array {
  const normalized = value.trim().toLowerCase();
  const bytes = new Uint8Array(normalized.length);
  for (let i = 0; i < normalized.length; i += 1) bytes[i] = normalized.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Random-access view over one packed catalog blob.
 *
 * Holds typed-array views (zero-copy) and nothing else. Metadata objects are
 * created only for rows a caller actually resolves, and cached, so a long-lived
 * process pays for the handful of ids it queried rather than for all 8090.
 *
 * That cache is **bounded**: an entry is rebuilt from the blob in a few
 * typed-array reads, so holding one at the cost of another is never worth it,
 * and an unbounded memo over 8941 rows is memory the operator pays for at idle
 * whether or not those rows are ever queried again. Bounded LRU, oldest
 * insertion evicted first — the same shape the rest of the codebase uses.
 */
export class PackedCatalog {
  private readonly bytes: Uint8Array;
  private readonly u32: Uint32Array;
  private readonly u16: Uint16Array;
  private readonly f64: Float64Array;
  private readonly layout: CatalogLayout;
  private readonly counts: CatalogCounts;
  private readonly providerIndexByName = new Map<string, number>();
  private readonly providerNames: readonly string[];
  private readonly metadataCache = new Map<number, ModelsDevModelMetadata>();
  /** When the generator fetched the upstream catalog. */
  readonly fetchedAt: string;

  constructor(blob: Uint8Array) {
    // Copied so every typed-array view is 4-byte aligned: a `Buffer` from
    // `Buffer.from(base64)` can be a slice of a pooled allocation at an
    // arbitrary byte offset, and a `Uint32Array` view at a misaligned offset
    // throws.
    const bytes = new Uint8Array(blob.byteLength);
    bytes.set(blob);
    this.bytes = bytes;
    const header = new DataView(bytes.buffer, bytes.byteOffset, CATALOG_HEADER_BYTES);
    const magic = header.getUint32(0, true);
    if (magic !== CATALOG_MAGIC) {
      throw new Error(`Catalog blob has an unknown magic 0x${magic.toString(16)}`);
    }
    const version = header.getUint32(4, true);
    if (version !== CATALOG_VERSION) {
      throw new Error(`Catalog blob is version ${version}, expected ${CATALOG_VERSION}`);
    }
    this.counts = {
      rowCount: header.getUint32(8, true),
      providerCount: header.getUint32(12, true),
      globalCount: header.getUint32(16, true),
      costCount: header.getUint32(20, true),
      stringBytes: header.getUint32(24, true),
    };
    this.layout = catalogLayout(this.counts);
    this.u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    this.u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    this.f64 = new Float64Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 8));
    const names: string[] = [];
    for (let index = 0; index < this.counts.providerCount; index += 1) {
      const start = this.u32At(this.layout.providerOff + index * 4);
      const end = this.u32At(this.layout.providerOff + (index + 1) * 4);
      const name = this.decodeAt(this.layout.strings + start, end - start);
      names.push(name);
      this.providerIndexByName.set(name, index);
    }
    this.providerNames = names;
    this.fetchedAt = "";
    const fetchedAtOffset = header.getUint32(28, true);
    const fetchedAtLength = header.getUint32(32, true);
    if (fetchedAtLength > 0) {
      this.fetchedAt = this.decodeAt(this.layout.strings + fetchedAtOffset, fetchedAtLength);
    }
  }

  /** Number of model rows. */
  get rowCount(): number {
    return this.counts.rowCount;
  }

  /** Every provider id the catalog files, lowercased and sorted. */
  get providers(): readonly string[] {
    return this.providerNames;
  }

  private u32At(offset: number): number {
    return this.u32[offset / 4] ?? 0;
  }

  private u8At(offset: number): number {
    return this.bytes[offset] ?? 0;
  }

  private u16At(offset: number): number {
    return this.u16[offset / 2] ?? 0;
  }

  private f64At(offset: number): number {
    return this.f64[offset / 8] ?? Number.NaN;
  }

  private decodeAt(start: number, length: number): string {
    if (length <= 0) return "";
    return decoder.decode(this.bytes.subarray(start, start + length));
  }

  /** The lowercased provider id filed at `index`. */
  providerAt(index: number): string {
    return this.providerNames[index] ?? "";
  }

  /** Index of a lowercased provider id, or `-1`. */
  providerIndex(providerLower: string): number {
    return this.providerIndexByName.get(providerLower) ?? -1;
  }

  /** The lowercased model id of a row. */
  rowId(index: number): string {
    const entry = this.layout.rowIdOff + index * 4;
    return this.decodeAt(
      this.layout.strings + this.u32At(entry),
      this.u8At(this.layout.rowIdLen + index),
    );
  }

  /** Byte range of one row's id inside the shared string table. */
  private rowIdRange(index: number): readonly [number, number] {
    const offset = this.u32At(this.layout.rowIdOff + index * 4);
    const length = this.u8At(this.layout.rowIdLen + index);
    return [this.layout.strings + offset, length];
  }

  /**
   * Byte range of a row's *bare* id — everything after the reseller's `/`.
   *
   * Derived from the row's own id rather than stored: it is one scan of at most
   * 61 bytes, and a fourth string table would cost more than it saves.
   */
  private bareIdRange(index: number): readonly [number, number] {
    const [start, length] = this.rowIdRange(index);
    const end = start + length;
    for (let at = start; at < end; at += 1) {
      if (this.bytes[at] === SLASH) return [at + 1, end - at - 1];
    }
    return [start, length];
  }

  /** Compares a blob byte range against an already-lowercased ASCII needle. */
  private compareRange(start: number, length: number, needle: Uint8Array): number {
    const limit = Math.min(length, needle.length);
    for (let i = 0; i < limit; i += 1) {
      const left = this.bytes[start + i] ?? 0;
      const right = needle[i] ?? 0;
      if (left !== right) return left < right ? -1 : 1;
    }
    if (length === needle.length) return 0;
    return length < needle.length ? -1 : 1;
  }

  /**
   * Row index for an exact `(providerIndex, lowercasedId)` pair, or `-1`.
   *
   * Rows are sorted by `(provIdx, idLower)`, so this is one binary search over
   * the packed id column and builds nothing.
   */
  exactIndex(providerIndex: number, idLower: Uint8Array): number {
    if (providerIndex < 0) return -1;
    let low = 0;
    let high = this.counts.rowCount;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const rowProvider = this.u16At(this.layout.provIdx + middle * 2);
      let comparison = rowProvider - providerIndex;
      if (comparison === 0) {
        const [start, length] = this.rowIdRange(middle);
        comparison = this.compareRange(start, length, idLower);
      }
      if (comparison < 0) low = middle + 1;
      else if (comparison > 0) high = middle;
      else return middle;
    }
    return -1;
  }

  /**
   * Contiguous `[start, end)` range of `bareOrder` positions whose bare id
   * equals the needle.
   */
  bareRange(bareLower: Uint8Array): readonly [number, number] {
    let low = 0;
    let high = this.counts.rowCount;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const row = this.u32At(this.layout.bareOrder + middle * 4);
      const [start, length] = this.bareIdRange(row);
      if (this.compareRange(start, length, bareLower) < 0) low = middle + 1;
      else high = middle;
    }
    const start = low;
    while (low < this.counts.rowCount) {
      const row = this.u32At(this.layout.bareOrder + low * 4);
      const [rangeStart, length] = this.bareIdRange(row);
      if (this.compareRange(rangeStart, length, bareLower) !== 0) break;
      low += 1;
    }
    return [start, low];
  }

  /** The row index at position `position` of the bare-id ordering. */
  bareOrderAt(position: number): number {
    return this.u32At(this.layout.bareOrder + position * 4);
  }

  /** Metadata for one row, built once and cached; `undefined` out of range. */
  metadataAt(index: number): ModelsDevModelMetadata | undefined {
    if (index < 0 || index >= this.counts.rowCount) return undefined;
    const cached = this.metadataCache.get(index);
    if (cached !== undefined) return cached;
    const mask = this.u8At(this.layout.inMask + index);
    const outputMask = this.u8At(this.layout.outMask + index);
    const flags = this.u8At(this.layout.flags + index);
    const metadata: ModelsDevModelMetadata = {
      id: this.rowId(index),
      contextLimit: this.rowContext(index),
      outputLimit: this.rowOutput(index),
      cost: this.rowCost(index),
      modalities: {
        input: CATALOG_MODALITIES.filter((_, bit) => (mask & (1 << bit)) !== 0),
        output: CATALOG_MODALITIES.filter((_, bit) => (outputMask & (1 << bit)) !== 0),
      },
      reasoning: (flags & FLAG_REASONING) !== 0,
      toolCall: (flags & FLAG_TOOL_CALL) !== 0,
    };
    if (this.metadataCache.size >= METADATA_CACHE_MAX_ENTRIES) {
      const oldest = this.metadataCache.keys().next().value;
      if (oldest !== undefined) this.metadataCache.delete(oldest);
    }
    this.metadataCache.set(index, metadata);
    return metadata;
  }

  /**
   * Stated context limit, or `null`.
   *
   * Stored in a `Uint32Array` column; the generator
   * (`scripts/tools/generate-models.ts`) refuses to write a value ≥ 2^31
   * (`checkedPackedLimit`), so no row here can wrap modulo 2^32 and decode as a
   * garbage limit.
   */
  rowContext(index: number): number | null {
    const value = this.u32At(this.layout.ctx + index * 4);
    return value > 0 ? value : null;
  }

  /**
   * Stated output limit, or `null`.
   *
   * Same u32 storage contract as `rowContext` — see the generator guard.
   */
  rowOutput(index: number): number | null {
    const value = this.u32At(this.layout.out + index * 4);
    return value > 0 ? value : null;
  }

  /** Price of one row, or the unknown-cost shape when it states none. */
  rowCost(index: number): ModelsDevModelCost {
    const tuple = this.u32At(this.layout.costIdx + index * 4);
    if (tuple === NO_COST || tuple >= this.counts.costCount) return UNKNOWN_COST;
    return this.costAt(tuple);
  }

  /** Price of one cost-tuple index. */
  private costAt(tuple: number): ModelsDevModelCost {
    const input = this.f64At(this.layout.costIn + tuple * 8);
    const output = this.f64At(this.layout.costOut + tuple * 8);
    const cacheRead = this.f64At(this.layout.costCacheRead + tuple * 8);
    const cacheWrite = this.f64At(this.layout.costCacheWrite + tuple * 8);
    const reasoning = this.f64At(this.layout.costReasoning + tuple * 8);
    const stated = Number.isNaN(input) ? null : input;
    const statedOutput = Number.isNaN(output) ? null : output;
    return {
      input: stated,
      output: statedOutput,
      ...(Number.isNaN(cacheRead) ? {} : { cache_read: cacheRead }),
      ...(Number.isNaN(cacheWrite) ? {} : { cache_write: cacheWrite }),
      ...(Number.isNaN(reasoning) ? {} : { reasoning }),
      pricing_model: stated !== null || statedOutput !== null ? "pay-per-use" : "unknown",
    };
  }

  /** Row index whose price answers for a bare model id, or `-1`. */
  globalCostRow(bareLower: Uint8Array): number {
    let low = 0;
    let high = this.counts.globalCount;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const entry = this.layout.globalKeyOff + middle * 4;
      const start = this.layout.strings + this.u32At(entry);
      const length = this.u8At(this.layout.globalKeyLen + middle);
      const comparison = this.compareRange(start, length, bareLower);
      if (comparison === 0) return this.u32At(this.layout.globalRow + middle * 4);
      if (comparison < 0) low = middle + 1;
      else high = middle;
    }
    return -1;
  }
}
