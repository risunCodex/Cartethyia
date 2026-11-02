/**
 * The share card's social metadata agrees with the image it points at.
 *
 * Crawlers do not run the client bundle, so this server-rendered block is the
 * only thing that decides how a `/share/*` link looks when pasted anywhere.
 * Two parts of it can be wrong without failing a build:
 *
 * - the path can point at a file that is not shipped, which renders as no
 *   card at all;
 * - `og:image:width` / `og:image:height` can be stale. A crawler allocates the
 *   card from those numbers *before* the bytes arrive, so a size carried over
 *   from a previous image crops every preview — and nothing at runtime notices.
 *
 * So the dimensions are read back out of the file's own header rather than
 * asserted as literals that someone has to remember to update.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SHARE_SOCIAL_META } from "../../src/console/dashboard-assets";

const PUBLIC_ROOT = "dashboard/public";

/** Canvas size from a WebP's VP8/VP8X/VP8L header. */
function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const fourcc = String.fromCharCode(...bytes.slice(12, 16));
  if (fourcc === "VP8X") {
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    };
  }
  if (fourcc === "VP8 ") {
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  if (fourcc === "VP8L") {
    const bits =
      bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** Canvas size from a JPEG's SOFn marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1]!;
    // Standalone markers carry no length; skip them.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    // SOF0–SOF15 (excluding the ones with no dimension payload).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: (bytes[i + 5]! << 8) | bytes[i + 6]!,
        width: (bytes[i + 7]! << 8) | bytes[i + 8]!,
      };
    }
    i += 2 + length;
  }
  return undefined;
}

/** Canvas size for the social card image (JPEG or WebP). */
function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  return webpSize(bytes);
}

describe("share social metadata", () => {
  test("the image is a file that is actually shipped", () => {
    // A path pointing at a missing asset renders as no card at all.
    const bytes = readFileSync(`${PUBLIC_ROOT}${SHARE_SOCIAL_META.image}`);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  test("the declared MIME type matches the file", () => {
    const bytes = new Uint8Array(readFileSync(`${PUBLIC_ROOT}${SHARE_SOCIAL_META.image}`));
    if (SHARE_SOCIAL_META.imageType === "image/jpeg") {
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
    } else {
      expect(SHARE_SOCIAL_META.imageType).toBe("image/webp");
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
      expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WEBP");
    }
  });

  test("the declared dimensions are the file's real dimensions", () => {
    // The regression this guards: replacing the image and leaving the previous
    // size behind crops every preview.
    const bytes = new Uint8Array(readFileSync(`${PUBLIC_ROOT}${SHARE_SOCIAL_META.image}`));
    const size = imageSize(bytes);
    if (size === undefined) throw new Error("could not read canvas size from the image");
    expect(SHARE_SOCIAL_META.imageWidth).toBe(size.width);
    expect(SHARE_SOCIAL_META.imageHeight).toBe(size.height);
  });

  test("the card still carries a title, description and alt text", () => {
    // Not just the image: an empty alt makes the card inaccessible.
    expect(SHARE_SOCIAL_META.title.length).toBeGreaterThan(0);
    expect(SHARE_SOCIAL_META.description.length).toBeGreaterThan(0);
    expect(SHARE_SOCIAL_META.imageAlt.length).toBeGreaterThan(0);
  });
});
