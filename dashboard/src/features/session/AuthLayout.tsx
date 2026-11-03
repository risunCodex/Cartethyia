import type { ReactNode } from "react";
import { MarkFor } from "../../components/patterns/github-badge";
import { SOURCE_LINKS } from "../../lib/links";

/** Only the primary destination links: no historical mirror or GitLab mirror. */
const AUTH_SOURCE_LINKS = SOURCE_LINKS.filter(
  (link) => link.id !== "github-alt" && link.id !== "gitlab",
);

interface AuthLayoutProps {
  readonly title: string;
  readonly description: string;
  /** Optional icon shown inside the logo chip (e.g. the banned shield). */
  readonly icon?: ReactNode;
  /** Extra classes for the logo chip when it is not the default favicon. */
  readonly logoClassName?: string;
  readonly children: ReactNode;
}

/**
 * Shared auth frame for login, setup, and banned surfaces.
 *
 * Full-bleed key art: the image covers the entire viewport edge to edge, and
 * the brand block + form float on a frosted-glass panel at the right edge.
 * On narrow screens the panel centers as a card over the image. Inside the
 * console shell (error boundary) the split falls back to a solid gradient.
 */
export default function AuthLayout({
  title,
  description,
  icon,
  logoClassName = "",
  children,
}: AuthLayoutProps): ReactNode {
  return (
    <main className="auth-viewport">
      <div className="auth-image-col" role="presentation" aria-hidden="true" />
      <section className="auth-form-col">
        <div className="auth-form-inner">
          <div className="auth-brand-head">
            <div className={`auth-logo ${logoClassName}`.trim()} aria-hidden="true">
              {icon}
            </div>
            <h1 className="auth-title">{title}</h1>
            <p className="auth-desc">{description}</p>
          </div>

          <div className="auth-form-body">{children}</div>

          <nav className="auth-hero-links" aria-label="Public source and distribution links">
            <span className="auth-brand-links-label">Get Cartethyia</span>
            <div className="auth-brand-links-grid">
              {AUTH_SOURCE_LINKS.map((link) => (
                <a
                  key={link.id}
                  className="auth-brand-link"
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  title={link.hint}
                >
                  <MarkFor id={link.id} size={15} />
                  <span>{link.label}</span>
                </a>
              ))}
            </div>
          </nav>
        </div>
      </section>
    </main>
  );
}
