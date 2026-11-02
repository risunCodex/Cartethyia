/**
 * Vendored from `cursor-opencode-provider` (protocol layer only).
 *
 * MIT License
 *
 * Copyright (c) 2026 Oleksiy Akimov
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { gunzipSync, gzipSync } from "node:zlib"

export const FLAG_GZIP = 0x01
export const FLAG_END_STREAM = 0x02

export type Frame = {
  flags: number
  payload: Uint8Array
}

export function encodeFrame(flags: number, payload: Uint8Array): Uint8Array {
  let data = payload
  if (flags & FLAG_GZIP) {
    data = gzipSync(data)
  }
  const len = data.length
  const header = new Uint8Array(5)
  header[0] = flags
  header[1] = (len >> 24) & 0xff
  header[2] = (len >> 16) & 0xff
  header[3] = (len >> 8) & 0xff
  header[4] = len & 0xff
  const out = new Uint8Array(5 + len)
  out.set(header, 0)
  out.set(data, 5)
  return out
}

export function decodeFramePayload(frame: Frame): Uint8Array {
  return frame.flags & FLAG_GZIP ? gunzipSync(frame.payload) : frame.payload
}

export function* streamFrames(buffer: Uint8Array): Generator<Frame, void, void> {
  let offset = 0
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset] ?? 0
    const len =
      (((buffer[offset + 1] ?? 0) << 24) |
        ((buffer[offset + 2] ?? 0) << 16) |
        ((buffer[offset + 3] ?? 0) << 8) |
        (buffer[offset + 4] ?? 0)) >>> 0
    const start = offset + 5
    if (start + len > buffer.length) break
    yield { flags, payload: buffer.subarray(start, start + len) }
    offset = start + len
  }
}
