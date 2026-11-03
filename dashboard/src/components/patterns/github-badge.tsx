import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  GITHUB_ALT_REPO_URL,
  GITHUB_REPO,
  GITHUB_REPO_URL,
  NPM_PACKAGE_URL,
  SOURCE_LINKS,
  type SourceLink,
} from "../../lib/links";

/**
 * The badge host, declared here rather than imported from the backend CSP
 * module: that module reads `node:crypto` and browser code must not pull in a
 * Node-only runtime dependency. The two must be kept in agreement by hand —
 * the dashboard CSP must name this origin, or the badge is silently blocked
 * behind a CSP violation.
 */
export const BADGE_IMAGE_ORIGIN = "https://img.shields.io";

/**
 * Live star and fork counts, as shields.io SVG badges.
 *
 * The counts arrive as `<img>` rather than a `fetch` because the dashboard CSP
 * permits the badge host under `img-src` while keeping `connect-src 'self'`: a
 * JSON call to a third-party API would be blocked, an image is not. The numbers
 * live inside the image, so the `alt` names what is counted rather than the
 * figure — a reader who needs the exact number follows the link to the
 * repository, which is the only place it is authoritative.
 *
 * Read from the primary repository. These used to read from the alternative
 * one on the assumption the primary account was still hidden and would render
 * zero; it is public again, so counting the mirror showed a number for a
 * project the badge no longer links to.
 */
function badgeUrl(metric: "stars" | "forks", color: string): string {
  const params = new URLSearchParams({
    style: "flat-square",
    labelColor: "0b1220",
    color,
  });
  return `${BADGE_IMAGE_ORIGIN}/github/${metric}/${GITHUB_REPO}?${params.toString()}`;
}

/** The GitHub mark, inlined so no brand-icon dependency is needed. */
export function GithubMark({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** The npm mark, inlined for the same reason as the GitHub one. */
function NpmMark({ size = 15 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M0 0v16h16V0H0Zm13 13h-2V5H8v8H3V3h10v10Z" />
    </svg>
  );
}

/** The GitLab mark, inlined for the same reason as the GitHub one. */
function GitlabMark({ size = 15 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m15.5 6.3-.02-.06-2.14-5.58a.56.56 0 0 0-.22-.26.57.57 0 0 0-.65.03.57.57 0 0 0-.19.29l-1.45 4.42H5.17L3.72.72A.57.57 0 0 0 3.53.43a.57.57 0 0 0-.65-.03.56.56 0 0 0-.22.26L.52 6.24l-.02.06a3.97 3.97 0 0 0 1.32 4.59l.01.01.02.02 3.25 2.44 1.61 1.22.98.74a.67.67 0 0 0 .81 0l.98-.74 1.61-1.22 3.26-2.45.01-.01a3.97 3.97 0 0 0 1.32-4.59Z" />
    </svg>
  );
}

/** The Discord mark, inlined for the same reason as the others. */
function DiscordMark({ size = 15 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M13.55 3.02A12.6 12.6 0 0 0 10.5 2.1a8.9 8.9 0 0 0-.4.83 11.7 11.7 0 0 0-3.2 0 8.6 8.6 0 0 0-.41-.83 12.6 12.6 0 0 0-3.05.92C1.3 5.75.85 8.4 1.07 11.01a12.7 12.7 0 0 0 3.74 1.9c.3-.41.57-.85.8-1.31-.44-.17-.86-.37-1.26-.6l.31-.24a9 9 0 0 0 7.68 0l.31.24c-.4.23-.82.43-1.26.6.23.46.5.9.8 1.31a12.7 12.7 0 0 0 3.74-1.9c.26-3.03-.44-5.66-1.98-7.99ZM5.68 9.4c-.73 0-1.33-.67-1.33-1.49s.59-1.49 1.33-1.49c.74 0 1.34.68 1.33 1.49 0 .82-.59 1.49-1.33 1.49Zm4.64 0c-.73 0-1.33-.67-1.33-1.49s.59-1.49 1.33-1.49c.74 0 1.34.68 1.33 1.49 0 .82-.59 1.49-1.33 1.49Z" />
    </svg>
  );
}

export function MarkFor({ id, size }: { id: SourceLink["id"]; size?: number }): ReactElement {
  if (id === "npm") return <NpmMark size={size} />;
  if (id === "gitlab") return <GitlabMark size={size} />;
  if (id === "discord") return <DiscordMark size={size} />;
  return <GithubMark size={size} />;
}

/**
 * Repository link with live star and fork counts, plus a split menu of every
 * place the project can be obtained.
 *
 * The primary action opens the alternative repository, because the primary
 * repository is hidden — a link that may not load is not a useful default. The
 * menu carries the rest so the reader is not left without a way through.
 *
 * The host surface supplies the chip styling; this component owns the mark,
 * the badges, the menu, and the targets.
 */
export function GithubBadge({ className = "" }: { className?: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Dismiss on outside click and on Escape, so the menu cannot trap focus or
  // outlive the reader's attention.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    // The host surface styles the OUTER element (it sets height, padding and
    // colors for its own header), so the split layout lives on an inner wrapper.
    // Putting `github-split` on the same element made the host's
    // `align-items: center` and `gap` win on specificity, which collapsed the
    // toggle to its icon height and left a gap between the two halves.
    <div className={className} ref={rootRef}>
      <div className="github-split">
      <a
        className="github-badge"
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="Cartethyia on GitHub"
      >
        <GithubMark size={15} />
        <img
          className="github-badge-metric"
          src={badgeUrl("stars", "2ea043")}
          alt="GitHub stars"
          height={20}
          loading="lazy"
          decoding="async"
        />
        <img
          className="github-badge-metric"
          src={badgeUrl("forks", "1f6feb")}
          alt="GitHub forks"
          height={20}
          loading="lazy"
          decoding="async"
        />
      </a>
      <button
        type="button"
        className="github-split-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="More ways to get Cartethyia"
        onClick={() => setOpen((value) => !value)}
      >
        <svg width={12} height={12} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
          <path d="M8 11 3 5h10l-5 6Z" />
        </svg>
      </button>
      {open ? (
        <div className="github-split-menu" id={menuId} role="menu" aria-label="Source and package links">
          {SOURCE_LINKS.map((link) => (
            <a
              key={link.id}
              className="github-split-item"
              href={link.href}
              target="_blank"
              rel="noreferrer"
              role="menuitem"
              onClick={close}
            >
              <MarkFor id={link.id} size={14} />
              <span className="github-split-item-text">
                <span className="github-split-item-label">{link.label}</span>
                <span className="github-split-item-hint">{link.hint}</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
      </div>
    </div>
  );
}

export { GITHUB_ALT_REPO_URL, GITHUB_REPO_URL, NPM_PACKAGE_URL };
