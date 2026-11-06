import { resolve } from "path";
import {
  API_CONTENT_SECURITY_POLICY,
  X_FRAME_OPTIONS,
  dashboardContentSecurityPolicy,
} from "../security/outbound-headers";
import { acceptsGzip } from "./response-compression";

/**
 * Represents the result of serving a static file.
 */
interface StaticServeResult {
  status: number;
  body: Uint8Array | undefined;
  headers: Record<string, string>;
}

/**
 * Configuration for the static file handler.
 */
interface StaticHandlerConfig {
  /** Absolute path to the dashboard build directory */
  buildDir: string;
  /**
   * SPA entry documents are keyed by URL prefix. A request whose path is not a
   * real file but sits under one of these prefixes is served that document so
   * the client can resolve the route.
   */
  entries?: Readonly<Record<string, string>>;
}

/** Shared landing, console, and public share entry document produced by Vite. */
const DEFAULT_ENTRY_DOCUMENTS: Readonly<Record<string, string>> = {
  "/": "index.html",
  "/share": "index.html",
  "/console": "index.html",
};

function dashboardBuildHeader(html: string): Record<string, string> {
  const buildId = /<meta\s+name="cartethyia-dashboard-build"\s+content="([a-f0-9]{16})"\s*\/?>/i.exec(html)?.[1];
  return buildId === undefined ? {} : { "x-cartethyia-dashboard-build": buildId };
}

/**
 * Open Graph / Twitter card values injected into a served document. The shared
 * index document ships the landing card, so the public share routes swap in
 * their own card here — crawlers do not run the client bundle, so a
 * `document.title` set at runtime cannot reach them.
 */
interface SocialMeta {
  title: string;
  description: string;
  image: string;
  imageType: string;
  imageWidth: number;
  imageHeight: number;
  imageAlt: string;
}

/** Social card for the public enrollment page (`/share/*`). */
export const SHARE_SOCIAL_META: SocialMeta = {
  title: "Cartethyia — Bansos Token",
  description:
    "Come and save your tokens 💖 Shared Cartethyia API key — Bansos Token with live quota, usage and model allowlist.",
  image: "/assets/brand/og_bansos.webp",
  imageType: "image/webp",
  // Read from the file's own header, not carried over from a previous image:
  // og:image:width/height are what a crawler uses to allocate the card before
  // the bytes arrive, so a copied size makes every preview crop.
  imageWidth: 1200,
  imageHeight: 393,
  imageAlt: "Cartethyia Bansos Token — Come and save your tokens",
};

/** Sentinel-delimited block in the shared index document that carries the card. */
const SOCIAL_META_BLOCK =
  /<!-- cartethyia:social-meta:start -->[\s\S]*?<!-- cartethyia:social-meta:end -->/;

/** Escapes a value for use inside an HTML double-quoted attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Renders the sentinel block for one social card. */
function renderSocialMeta(meta: SocialMeta): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const image = escapeHtml(meta.image);
  const imageAlt = escapeHtml(meta.imageAlt);
  return [
    "<!-- cartethyia:social-meta:start -->",
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:type" content="${meta.imageType}" />`,
    `<meta property="og:image:width" content="${meta.imageWidth}" />`,
    `<meta property="og:image:height" content="${meta.imageHeight}" />`,
    `<meta property="og:image:alt" content="${imageAlt}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="${imageAlt}" />`,
    "<!-- cartethyia:social-meta:end -->",
  ].join("\n    ");
}

/**
 * Rewrites the document's social card and title for a public share route.
 * Non-share paths and documents without the sentinel are returned unchanged.
 */
function applySocialMeta(html: string, pathname: string): string {
  if (pathname !== "/share" && !pathname.startsWith("/share/")) return html;
  const meta = SHARE_SOCIAL_META;
  return html
    .replace(SOCIAL_META_BLOCK, renderSocialMeta(meta))
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    )
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(meta.title)}</title>`);
}


/** Longest-prefix match of an SPA route against the configured entry documents. */
function entryDocumentFor(pathname: string, entries: Readonly<Record<string, string>>): string | undefined {
  let matched: string | undefined;
  let matchedLength = -1;
  for (const [prefix, document] of Object.entries(entries)) {
    const isRoot = prefix === "/";
    const matches = isRoot ? pathname === "/" : pathname === prefix || pathname.startsWith(`${prefix}/`);
    if (!matches) continue;
    if (prefix.length > matchedLength) {
      matched = document;
      matchedLength = prefix.length;
    }
  }
  return matched;
}

/**
 * Creates a hardened multi-page static file handler for the public routes.
 *
 * - Serves the shared index at `/`, `/share/*`, and `/console/*` for
 *   extensionless client-side routes
 * - Serves real files (assets, provider icons, chapter art) from the build root
 * - Safely decodes and normalizes request paths, rejecting traversal
 * - Rejects the reserved `/console/api` namespace defensively
 * - Serves hashed assets with immutable cache headers and documents with no-cache
 * - Returns 404 for missing asset-like files
 */
/**
 * The `.gz` sibling of an asset, when one exists and the client offered gzip.
 *
 * Restricted to hashed assets — see the check below for why — and best-effort:
 * a build that emitted no `.gz` simply serves the plain file.
 */
async function readPrecompressed(
  fullPath: string,
  acceptEncoding: string | undefined | null,
): Promise<Uint8Array | undefined> {
  if (acceptEncoding === undefined || acceptEncoding === null) return undefined;
  if (!acceptsGzip(acceptEncoding)) return undefined;
  // Only hashed assets: those are the immutable ones, and they are what the
  // Vite build precompresses. An unhashed asset is served with a revalidating
  // cache header precisely because it may be replaced in place, and a `.gz`
  // left beside a file that was swapped afterwards would not match it.
  if (!hasHashInFilename(fullPath)) return undefined;
  const file = Bun.file(`${fullPath}.gz`);
  if (!(await file.exists())) return undefined;
  return await file.bytes();
}

/**
 * Builds the static handler.
 *
 * The returned function takes an optional `acceptEncoding` so the caller can
 * pass the request's header: a precompressed `.gz` sibling is only usable when
 * the client asking for it offered gzip. Omitting it serves the plain file,
 * which is what the tests and any non-HTTP caller want.
 */
export function createStaticHandler(
  config: StaticHandlerConfig,
): (pathname: string, acceptEncoding?: string | null) => Promise<StaticServeResult> {
  const buildDirResolved = resolve(config.buildDir);
  const buildDirNorm = normalizePathSeparators(buildDirResolved);
  const entries = config.entries ?? DEFAULT_ENTRY_DOCUMENTS;

  const serveDocument = async (document: string, pathname: string): Promise<StaticServeResult> => {
    const file = Bun.file(resolve(buildDirResolved, document));
    if (!(await file.exists())) {
      return { status: 404, body: undefined, headers: {} };
    }
    const html = applySocialMeta(await file.text(), pathname);
    return {
      status: 200,
      body: new TextEncoder().encode(html),
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
        expires: "0",
        ...dashboardBuildHeader(html),
      },
    };
  };

  const serve = async (
    pathname: string,
    acceptEncoding?: string | null,
  ): Promise<StaticServeResult> => {
    // Reject the reserved `/console/api` namespace, including its bare prefix.
    if (pathname === "/console/api" || pathname.startsWith("/console/api/")) {
      return {
        status: 404,
        body: undefined,
        headers: { "content-type": "application/json" },
      };
    }

    // Decode the path to handle URL-encoded characters
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return { status: 404, body: undefined, headers: {} };
    }

    const normalizedPath = normalizePathSeparators(decodedPath);
    // The console document is mounted under `/console`, but the Vite build
    // emits assets at the origin root (base `/`). Strip the mount prefix so
    // `/console/assets/app.js` resolves to the same file as `/assets/app.js`.
    // The prefix is only stripped when present: a leading slash on any other
    // path is preserved so `resolve` treats it as absolute and the containment
    // check below rejects it.
    const relativePath = normalizedPath.startsWith("/console/")
      ? normalizedPath.slice("/console/".length)
      : normalizedPath.replace(/^\/+/, "");

    // Security check: the resolved path must stay inside the build directory.
    // This rejects `..` traversal, absolute paths, and normalized backslashes.
    const fullPath = resolve(buildDirResolved, relativePath);
    const fullPathNorm = normalizePathSeparators(fullPath);
    const buildDirWithSlash = buildDirNorm + (buildDirNorm.endsWith("/") ? "" : "/");
    const insideBuildDir =
      fullPathNorm === buildDirNorm || fullPathNorm.startsWith(buildDirWithSlash);
    if (!insideBuildDir) {
      return { status: 404, body: undefined, headers: {} };
    }

    const entryDocument = entryDocumentFor(normalizedPath, entries);
    const lastSegment = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    // A missing path with a dot is an asset request and must 404 rather than
    // falling back to the SPA document.
    const isAssetLike = lastSegment.includes(".");

    if (relativePath.length > 0) {
      try {
        const file = Bun.file(fullPath);
        if (await file.exists()) {
          const data = await file.bytes();
          const mimeType = getMimeType(fullPath);

          // Determine cache headers based on file type
          let cacheControl: string;
          if (relativePath === "index.html" || relativePath.endsWith("/index.html")) {
            cacheControl = "no-store, no-cache, must-revalidate";
          } else if (hasHashInFilename(fullPath)) {
            // Hashed assets (e.g., app.abc123.js) are immutable
            cacheControl = "public, max-age=31536000, immutable";
          } else if (!relativePath.includes(".")) {
            // Extensionless paths (SPA routes)
            cacheControl = "no-store, no-cache, must-revalidate";
          } else {
            // Regular assets without hash
            cacheControl = "public, max-age=3600";
          }
          const buildHeaders =
            mimeType.startsWith("text/html")
              ? dashboardBuildHeader(new TextDecoder().decode(data))
              : {};

          // A precompressed sibling is served when the client asked for gzip
          // and the build emitted one. The bytes were compressed at build time
          // (level 9), so this is a disk read rather than a per-request
          // compress — and a build with no `.gz` falls through to the plain
          // file, which is why there is no error path here.
          const precompressed = await readPrecompressed(fullPath, acceptEncoding);
          if (precompressed !== undefined) {
            return {
              status: 200,
              body: precompressed,
              headers: {
                "content-type": mimeType,
                "cache-control": cacheControl,
                "content-encoding": "gzip",
                // Without this a shared cache would hand the gzipped bytes to a
                // client that never offered gzip: the URL is identical either
                // way, so `accept-encoding` is the only thing that differs.
                vary: "accept-encoding",
                ...buildHeaders,
              },
            };
          }

          return {
            status: 200,
            body: data,
            headers: {
              "content-type": mimeType,
              "cache-control": cacheControl,
              ...buildHeaders,
            },
          };
        }
      } catch {
        return { status: 404, body: undefined, headers: {} };
      }
    }

    // No file on disk: hand the route to its SPA document when one owns it.
    if (entryDocument !== undefined && !isAssetLike) {
      return serveDocument(entryDocument, normalizedPath);
    }

    return { status: 404, body: undefined, headers: {} };
  };

  return async (pathname: string, acceptEncoding?: string | null): Promise<StaticServeResult> =>
    applyStaticSecurityHeaders(await serve(pathname, acceptEncoding));
}

/**
 * Adds the browser-hardening headers shared by every `/console/*` response.
 * Documents get the dashboard CSP (inline scripts allowed only by hash);
 * non-document assets get the locked-down API policy so no static response is
 * ever served without an explicit CSP.
 */
function applyStaticSecurityHeaders(result: StaticServeResult): StaticServeResult {
  const contentType = result.headers["content-type"] ?? "";
  const isHtml = contentType.includes("text/html");
  const csp = isHtml
    ? dashboardContentSecurityPolicy(result.body ? new TextDecoder().decode(result.body) : "")
    : API_CONTENT_SECURITY_POLICY;
  return {
    ...result,
    headers: {
      ...result.headers,
      "x-content-type-options": "nosniff",
      "x-frame-options": X_FRAME_OPTIONS,
      "referrer-policy": "no-referrer",
      "content-security-policy": csp,
    },
  };
}

/**
 * Normalizes path separators to forward slashes for consistent comparison.
 */
function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Determines the MIME type of a file based on its extension.
 */
function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".otf": "font/otf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".gz": "application/gzip",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * True when a filename carries a build hash, so its bytes are immutable.
 *
 * Matched on the two separator forms a bundler actually emits — `app.a1b2c3d4.js`
 * and the modern Vite spelling `app-BCnqn3N3.js` — plus `_`, and then required
 * to *look generated*: the segment must contain a digit or mix upper and lower
 * case. The second half is what keeps a plain word out of the set, since
 * `console-backgrounds.webp` and `openai-light.svg` both match the separator
 * alone and are emphatically not immutable.
 *
 * Getting this wrong in either direction costs real money: a hashed asset
 * served with a revalidating header is re-downloaded after every deploy, and an
 * unhashed one served `immutable` is pinned in the browser cache until it
 * expires. Measured against a real build, this matches 198 of 288 files — all
 * of them hashed bundles — and rejects every icon, photo, and document.
 */
function hasHashInFilename(filePath: string): boolean {
  const filename = filePath.split(/[/\\]/).pop() ?? "";
  const match = /[._-]([A-Za-z0-9_-]{8,})\./.exec(filename);
  if (match === null) return false;
  const segment = match[1] ?? "";
  const hasDigit = /[0-9]/.test(segment);
  const hasMixedCase = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
  return hasDigit || hasMixedCase;
}
