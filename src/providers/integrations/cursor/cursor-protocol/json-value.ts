/**
 * `google.protobuf.Value` wire codec for Cursor's schema/argument bytes.
 *
 * Cursor encodes JSON-ish payloads (`McpToolDefinition.inputSchema`,
 * `McpArgs.args` values) as protobuf `Value` messages — NOT as JSON text.
 * Sending `JSON.stringify` output on those fields is unparseable for the
 * server and stalls the turn before the model starts (verified live
 * 2026-11-17: a catalog with a text-encoded schema hung the Run; the
 * Struct-encoded catalog ran). The encoding here is the standard Struct wire
 * format: `1 null`, `2 double`, `3 string`, `4 bool`, `5 struct`, `6 list`.
 *
 * Decoding mirrors the reference client's tolerance ladder: try the Value
 * message first, then fall back to JSON text, then return the raw string.
 */
// ── byte writer / reader ──

// Shared coder instances: every encode/decode in this file is single-shot
// (never `{ stream: true }`), so reusing one encoder/decoder yields identical
// bytes and text without allocating per string field.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Scratch for `double`: setFloat64 writes here and the 8 bytes are copied
// into the writer, avoiding an ArrayBuffer/DataView pair per value.
const floatScratchView = new DataView(new ArrayBuffer(8));
const floatScratchBytes = new Uint8Array(floatScratchView.buffer);

class ByteWriter {
  readonly #bytes: number[] = [];

  varint(value: number): this {
    const truncated = Math.trunc(value);
    // Non-negative safe integers encode identically without BigInt. Every
    // other case (negative two's complement, |value| >= 2^53, NaN/Infinity,
    // which BigInt rejects) keeps the BigInt branch and its exact bytes.
    if (Number.isSafeInteger(truncated) && value >= 0) {
      let n = truncated;
      do {
        let byte = n & 0x7f;
        n = Math.floor(n / 128);
        if (n !== 0) byte |= 0x80;
        this.#bytes.push(byte);
      } while (n !== 0);
      return this;
    }
    let bits = BigInt(truncated);
    if (value < 0) bits = bits + 0x100000000000000000n; // two's complement, 64-bit
    do {
      let byte = Number(bits & 0x7fn);
      bits >>= 7n;
      if (bits !== 0n) byte |= 0x80;
      this.#bytes.push(byte);
    } while (bits !== 0n);
    return this;
  }

  tag(fieldNumber: number, wireType: number): this {
    return this.varint((fieldNumber << 3) | wireType);
  }

  double(value: number): this {
    floatScratchView.setFloat64(0, value, true);
    this.#bytes.push(...floatScratchBytes);
    return this;
  }

  lengthDelimited(bytes: Uint8Array): this {
    this.varint(bytes.byteLength);
    for (const byte of bytes) this.#bytes.push(byte);
    return this;
  }

  string(value: string): this {
    return this.lengthDelimited(textEncoder.encode(value));
  }

  finish(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }
}

function readVarint(data: Uint8Array, offset: number): { value: bigint; offset: number } {
  let result = 0n;
  let shift = 0n;
  let index = offset;
  for (;;) {
    if (index >= data.byteLength) throw new Error("truncated varint");
    const byte = data[index]!;
    index += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, offset: index };
}

/** Decodes one `Value` payload. Returns `undefined` when no field member is set. */
function readValue(data: Uint8Array): unknown {
  let offset = 0;
  let value: unknown;
  while (offset < data.byteLength) {
    const { value: key, offset: afterKey } = readVarint(data, offset);
    const fieldNumber = Number(key >> 3n);
    const wireType = Number(key & 7n);
    let end = afterKey;
    let scalar: bigint | undefined;
    // Where the field's payload begins: right after the key for scalar wires,
    // after the length varint for LEN fields.
    let contentStart = afterKey;
    if (wireType === 0) {
      const read = readVarint(data, afterKey);
      scalar = read.value;
      end = read.offset;
    } else if (wireType === 1) {
      scalar = 0n; // fixed64: handled below by length
      end = afterKey + 8;
    } else if (wireType === 2) {
      const read = readVarint(data, afterKey);
      contentStart = read.offset;
      end = read.offset + Number(read.value);
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
    if (end > data.byteLength) throw new Error("truncated message");

    switch (fieldNumber) {
      case 1:
        value = null;
        break;
      case 2: {
        const view = new DataView(data.buffer, data.byteOffset + afterKey, 8);
        value = view.getFloat64(0, true);
        break;
      }
      case 3:
        value = textDecoder.decode(data.subarray(contentStart, end));
        break;
      case 4:
        value = scalar !== undefined && scalar !== 0n;
        break;
      case 5: {
        // Struct: repeated map entries, each carried as a field-1
        // length-delimited message `{ string key = 1; Value value = 2; }`.
        const fields: Record<string, unknown> = {};
        const struct = data.subarray(contentStart, end);
        let entryOffset = 0;
        while (entryOffset < struct.byteLength) {
          const entryTag = readVarint(struct, entryOffset);
          if (Number(entryTag.value >> 3n) !== 1) throw new Error("malformed struct entry");
          const entryLen = readVarint(struct, entryTag.offset);
          const entryEnd = entryLen.offset + Number(entryLen.value);
          const entry = struct.subarray(entryLen.offset, entryEnd);
          let inner = 0;
          let key: string | undefined;
          while (inner < entry.byteLength) {
            const fieldTag = readVarint(entry, inner);
            const fieldNumber = Number(fieldTag.value >> 3n);
            const len = readVarint(entry, fieldTag.offset);
            const fieldEnd = len.offset + Number(len.value);
            if (fieldNumber === 1) {
              key = textDecoder.decode(entry.subarray(len.offset, fieldEnd));
            } else if (fieldNumber === 2) {
              if (key === undefined) throw new Error("struct value precedes its key");
              fields[key] = readValue(entry.subarray(len.offset, fieldEnd));
              key = undefined;
            }
            inner = fieldEnd;
          }
          entryOffset = entryEnd;
        }
        value = fields;
        break;
      }
      case 6: {
        const items: unknown[] = [];
        const list = data.subarray(contentStart, end);
        let itemOffset = 0;
        while (itemOffset < list.byteLength) {
          const itemKey = readVarint(list, itemOffset);
          const itemLen = readVarint(list, itemKey.offset);
          const itemEnd = itemLen.offset + Number(itemLen.value);
          items.push(readValue(list.subarray(itemLen.offset, itemEnd)));
          itemOffset = itemEnd;
        }
        value = items;
        break;
      }
      default:
        break; // unknown field: skip
    }
    offset = end;
  }
  return value;
}

// ── public API ──

/** Encodes a JSON value as a `google.protobuf.Value` message. */
export function encodeProtoJsonValue(value: unknown): Uint8Array {
  const writer = new ByteWriter();
  const write = (target: ByteWriter, input: unknown): void => {
    if (input === null || input === undefined) {
      target.tag(1, 0).varint(0);
      return;
    }
    if (typeof input === "number") {
      target.tag(2, 1).double(input);
      return;
    }
    if (typeof input === "string") {
      target.tag(3, 2).string(input);
      return;
    }
    if (typeof input === "boolean") {
      target.tag(4, 0).varint(input ? 1 : 0);
      return;
    }
    if (Array.isArray(input)) {
      // ListValue.values is a repeated message field: each item rides its own
      // field-1 length-delimited wrapper, never a bare member encoding.
      const list = new ByteWriter();
      for (const item of input) {
        const itemBytes = new ByteWriter();
        write(itemBytes, item);
        list.tag(1, 2).lengthDelimited(itemBytes.finish());
      }
      target.tag(6, 2).lengthDelimited(list.finish());
      return;
    }
    if (typeof input === "object") {
      const struct = new ByteWriter();
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        const entry = new ByteWriter();
        entry.tag(1, 2).string(key);
        const itemBytes = new ByteWriter();
        write(itemBytes, item);
        entry.tag(2, 2).lengthDelimited(itemBytes.finish());
        struct.tag(1, 2).lengthDelimited(entry.finish());
      }
      target.tag(5, 2).lengthDelimited(struct.finish());
      return;
    }
    // Functions/symbols have no JSON meaning; encode as empty string.
    target.tag(3, 2).string("");
  };
  write(writer, value);
  return writer.finish();
}

/**
 * Decodes `Value` bytes, tolerating the payload shapes Cursor actually sends:
 * a `Value` message, JSON text, or a bare string.
 */
export function decodeProtoJsonValue(data: Uint8Array): unknown {
  try {
    const decoded = readValue(data);
    if (decoded !== undefined) return decoded;
  } catch {
    // Not a Value message; fall through to text.
  }
  const text = textDecoder.decode(data);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
