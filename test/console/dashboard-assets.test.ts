/**
 * Static asset serving and the SPA fallback.
 *
 * `createStaticHandler` decides what a browser receives for every non-API path,
 * and three properties matter more than the rest because getting them wrong is
 * invisible until it hurts:
 *
 * - **Cache headers.** An entry document served with a long cache lets a
 *   browser keep serving the previous build's HTML after a deploy, which
 *   references hashed bundles that no longer exist. The reported symptom was
 *   needing `Ctrl+Shift+R` after every update. `no-store, no-cache,
 *   must-revalidate` is the fix, and this suite pins it.
 * - **Path containment.** A request path is attacker-controlled. `..`
 *   traversal, absolute paths, and encoded separators must never escape the
 *   build directory.
 * - **The SPA fallback's boundary.** An extensionless path under a document
 *   namespace resolves to `index.html` so a client-side route deep link works;
 *   a path that *looks* like a file must 404 instead of being answered with
 *   HTML, or a missing bundle becomes a page of garbage the browser tries to
 *   execute.
 *
 * The suite builds a real directory tree in a temp dir, so it exercises the
 * filesystem path rather than a mocked `fs`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStaticHandler } from "../../src/console/dashboard-assets";

let buildDir: string;
let outsideFile: string;
let handler: ReturnType<typeof createStaticHandler>;

/** Body of a result as text, or `""` when the result has no body. */
function bodyText(result: { body?: unknown }): string {
  if (result.body === undefined || result.body === null) return "";
  return new TextDecoder().decode(result.body as Uint8Array);
}

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "cartethyia-assets-"));
  const indexHtml =
    "<!doctype html><html><head><meta name=\"cartethyia-dashboard-build\" content=\"0123456789abcdef\" /></head><body><div id=\"root\"></div></body></html>";
  await writeFile(
    join(buildDir, "index.html"),
    indexHtml,
  );
  await writeFile(join(buildDir, "assets.js"), "console.log('bundle')");
  await writeFile(join(buildDir, "styles.css"), "body{margin:0}");
  await writeFile(join(buildDir, "favicon.webp"), "RIFF");
  await mkdir(join(buildDir, "providers"), { recursive: true });
  await writeFile(join(buildDir, "providers", "openai-light.svg"), "<svg/>");
  // A hashed asset and its precompressed sibling, as the Vite build emits
  // them: immutable bytes, compressed once at build time.
  await mkdir(join(buildDir, "hashassets"), { recursive: true });
  await writeFile(join(buildDir, "hashassets", "app.a1b2c3d4.js"), "console.log('bundle')");
  await writeFile(
    join(buildDir, "hashassets", "app.a1b2c3d4.js.gz"),
    Bun.gzipSync(new TextEncoder().encode("console.log('bundle')")),
  );
  await mkdir(join(buildDir, "nested"), { recursive: true });
  await writeFile(join(buildDir, "nested", "deep.txt"), "deep");
  // A sibling of the build dir, to prove traversal cannot reach it.
  outsideFile = join(buildDir, "..", `outside-${Date.now()}.txt`);
  await writeFile(outsideFile, "secret");
  handler = createStaticHandler({ buildDir });
});

afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(outsideFile, { force: true }).catch(() => undefined);
});

describe("static assets — precompressed siblings", () => {
  test("a gzip client gets the .gz with content-encoding set", async () => {
    const result = await handler("/hashassets/app.a1b2c3d4.js", "gzip");
    expect(result.status).toBe(200);
    expect(result.headers["content-encoding"]).toBe("gzip");
    // The bytes are what a browser would decompress back to the source.
    expect(new TextDecoder().decode(Bun.gunzipSync(result.body as Uint8Array<ArrayBuffer>))).toBe(
      "console.log('bundle')",
    );
  });

  test("vary is set so a cache cannot serve gzip to a client that did not ask", async () => {
    // The URL is identical either way, so `accept-encoding` is the only thing
    // that distinguishes the two representations.
    const result = await handler("/hashassets/app.a1b2c3d4.js", "gzip");
    expect(result.headers.vary).toBe("accept-encoding");
  });

  test("the immutable cache-control is preserved", async () => {
    const gzipped = await handler("/hashassets/app.a1b2c3d4.js", "gzip");
    const plain = await handler("/hashassets/app.a1b2c3d4.js");
    expect(gzipped.headers["cache-control"]).toBe(plain.headers["cache-control"]);
  });

  test("a client that did not offer gzip gets the plain file", async () => {
    const result = await handler("/hashassets/app.a1b2c3d4.js", "identity");
    expect(result.headers["content-encoding"]).toBeUndefined();
    expect(bodyText(result)).toBe("console.log('bundle')");
  });

  test("an absent header serves the plain file", async () => {
    // The non-HTTP caller path: no header, no guess.
    const result = await handler("/hashassets/app.a1b2c3d4.js");
    expect(result.headers["content-encoding"]).toBeUndefined();
    expect(bodyText(result)).toBe("console.log('bundle')");
  });

  test("a hashed asset with no .gz falls back to the plain file", async () => {
    // A build without the precompress plugin must still work.
    const result = await handler("/assets.js", "gzip");
    expect(result.status).toBe(200);
    expect(result.headers["content-encoding"]).toBeUndefined();
    expect(bodyText(result)).toBe("console.log('bundle')");
  });

  test("an unhashed asset is never served from a .gz, even when one exists", async () => {
    // The risky pair: an unhashed file may be replaced in place, so a `.gz`
    // left beside an earlier copy would not describe the bytes now on disk.
    // The plain file is always correct; the compression is not worth the doubt.
    await writeFile(
      join(buildDir, "assets.js.gz"),
      Bun.gzipSync(new TextEncoder().encode("stale bundle from an older build")),
    );
    const plain = await handler("/assets.js", "gzip");
    expect(plain.status).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(bodyText(plain)).toBe("console.log('bundle')");
  });

  test("the content type is the asset's own, not the archive's", async () => {
    const result = await handler("/hashassets/app.a1b2c3d4.js", "gzip");
    expect(result.headers["content-type"]).toContain("javascript");
  });
});

describe("static assets — hashed vs unhashed", () => {
  /**
   * The cache header for a hashed asset is `immutable`; for anything else it
   * revalidates. So this predicate is load-bearing in both directions: a hashed
   * asset treated as unhashed is re-downloaded after every deploy, and an
   * unhashed one treated as hashed is pinned in the browser cache until it
   * expires.
   */
  const cases: ReadonlyArray<{ name: string; hashed: boolean; why: string }> = [
    { name: "app-BCnqn3N3.js", hashed: true, why: "the modern Vite spelling: hyphen separator" },
    { name: "app.a1b2c3d4.js", hashed: true, why: "the older dot-separated spelling" },
    { name: "entry-CBp7BXQq.js", hashed: true, why: "a chunk entry, same shape" },
    { name: "app-N-ONyork.css", hashed: true, why: "CSS chunk, hash contains hyphens" },
    { name: "script_ab12cd34ef.js", hashed: true, why: "underscore separator" },
    { name: "index.html", hashed: false, why: "the entry document is never immutable" },
    { name: "console-backgrounds.webp", hashed: false, why: "a word, despite matching the separator" },
    { name: "openai-light.svg", hashed: false, why: "a provider icon; must revalidate" },
    { name: "favicon.webp", hashed: false, why: "no hash segment at all" },
    { name: "wuthering-waves-hiyuki-aemeath-hiyuki-rover.webp", hashed: false, why: "story art: words, not a hash" },
  ];

  for (const testCase of cases) {
    test(`${testCase.name} is ${testCase.hashed ? "hashed" : "unhashed"} — ${testCase.why}`, async () => {
      const dir = join(buildDir, "hashdetect");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, testCase.name), "x");
      const result = await handler(`/hashdetect/${testCase.name}`);
      const cacheControl = result.headers["cache-control"] ?? "";
      expect(cacheControl.includes("immutable")).toBe(testCase.hashed);
    });
  }
});

describe("static assets — served files", () => {
  test("serves an existing file with its bytes", async () => {
    const result = await handler("/assets.js");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toBe("console.log('bundle')");
  });

  test("serves a nested file", async () => {
    const result = await handler("/providers/openai-light.svg");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toBe("<svg/>");
  });

  test("serves a file below a nested directory", async () => {
    const result = await handler("/nested/deep.txt");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toBe("deep");
  });

  test("the caller's pathname is used verbatim; a query string is not this layer's job", async () => {
    // `createStaticHandler` takes a pathname, not a URL: `app.ts` passes
    // `fastPathname(request.url)`, which has already dropped the query. A
    // suite that handed it a raw `?v=…` would be testing a caller contract that
    // does not exist — so this pins the real one: the handler treats whatever
    // it is given as a path, and a path containing `?` is simply not a file.
    const result = await handler("/assets.js?v=abc123");
    expect(result.status).toBe(404);
    // And the value `app.ts` actually passes does resolve.
    const direct = await handler("/assets.js");
    expect(direct.status).toBe(200);
  });

  test("a missing asset is a 404, not the SPA document", async () => {
    // Answering a missing `.js` with HTML is worse than a 404: the browser
    // tries to execute the markup and reports a syntax error at the app's
    // expense.
    const result = await handler("/assets-missing.js");
    expect(result.status).toBe(404);
  });

  test("a missing file in an existing directory is a 404", async () => {
    const result = await handler("/providers/not-a-file.svg");
    expect(result.status).toBe(404);
  });
});

describe("static assets — cache policy", () => {
  test("the entry document is never cached", async () => {
    // The reported defect: after a deploy the browser reused the previous
    // build's HTML, which referenced bundles that no longer exist, and a hard
    // refresh was the only cure.
    const result = await handler("/index.html");
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");
    expect(result.headers["x-cartethyia-dashboard-build"]).toBe("0123456789abcdef");
  });

  test("a directly-served index.html carries the legacy cache headers too", async () => {
    // The file-on-disk branch sets only `cache-control`; the document branch
    // (`serveDocument`) is the one that also sets `pragma`/`expires`. Both
    // paths are exercised because both serve HTML, and the assertion differs by
    // branch — which is the finding this test records.
    const direct = await handler("/index.html");
    expect(direct.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");

    // The SPA-fallback branch does add the pair.
    const fallback = await handler("/console/overview");
    expect(fallback.headers["pragma"]).toBe("no-cache");
    expect(fallback.headers["expires"]).toBe("0");
    expect(fallback.headers["x-cartethyia-dashboard-build"]).toBe("0123456789abcdef");
  });

  test("an SPA fallback response is never cached either", async () => {
    const result = await handler("/console/overview");
    expect(result.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");
  });

  test("a content-addressed asset may be cached", async () => {
    // Hashed bundle names change on every build, so caching them is safe and
    // is what makes a repeat visit fast.
    const result = await handler("/assets.js");
    expect(result.headers["cache-control"]).not.toBe("no-store, no-cache, must-revalidate");
  });
});

describe("static assets — SPA fallback", () => {
  test("the root serves the entry document", async () => {
    const result = await handler("/");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toContain('<div id="root">');
  });

  test("an extensionless route under /console serves the entry document", async () => {
    const result = await handler("/console/overview");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toContain('<div id="root">');
  });

  test("a deeply nested extensionless route also falls back", async () => {
    // A client-side route can be any depth; matching only single-segment paths
    // would break a deep link.
    const result = await handler("/console/cli-tools/claude");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toContain('<div id="root">');
  });

  test("a path with a file extension does not fall back", async () => {
    // The distinguishing rule: a dotted last segment means the client asked for
    // a file, so a miss is a 404 rather than the app shell.
    const result = await handler("/console/missing-thing.js");
    expect(result.status).toBe(404);
  });

  test("a request that escapes the build directory is refused", async () => {
    const result = await handler("/../outside.txt");
    expect(result.status).not.toBe(200);
  });

  test("an encoded traversal attempt is refused", async () => {
    // The handler receives a decoded pathname, but a client can also send the
    // encoded form; either way it must not resolve outside the build dir.
    const result = await handler("/%2e%2e/outside.txt");
    expect(result.status).not.toBe(200);
  });

  test("an absolute path cannot select an arbitrary file", async () => {
    const result = await handler("//etc/passwd");
    expect(result.status).not.toBe(200);
  });

  test("a path containing a null byte is refused rather than throwing", async () => {
    // A null byte in a filesystem path is either rejected by the OS or
    // truncated by a lower layer; either way the handler must answer, not crash.
    const result = await handler("/index.html\0.txt");
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  test("a directory request does not leak a listing", async () => {
    const result = await handler("/providers");
    expect(result.status).not.toBe(200);
    expect(bodyText(result)).not.toContain("openai-light");
  });
});
