import { useEffect, useRef, useState } from "react";
import { Coffee, Download, ExternalLink, HandHeart, Heart, Languages, QrCode, Sparkles, Star } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { DialogActions } from "./ui/dialog-actions";
import { SOURCE_LINKS } from "../lib/links";

/**
 * The language switch and the donation button, in the console topbar.
 *
 * The language control is a placeholder on purpose: wiring it to a real
 * translation catalogue is a larger change than the button, and shipping the
 * catalogue half-done would leave the UI in two languages at once. It shows the
 * current locale and is inert until the catalogue lands.
 */

const DONATION_URL = "https://saweria.co/risuncode";
const QRIS_IMAGE = "/donation/qris-risun-marke.webp";

/** Locales the placeholder offers; only the first is actually applied. */
const LOCALES = [
  { id: "en", label: "EN", name: "English" },
  { id: "id", label: "ID", name: "Bahasa Indonesia" },
  { id: "zh", label: "中文", name: "简体中文" },
  { id: "ja", label: "日本語", name: "日本語" },
] as const;

function LanguageMenu() {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState<string>("en");
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (container.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const current = LOCALES.find((entry) => entry.id === locale) ?? LOCALES[0];

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        className="topbar-icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Change language — ${current.name}`}
        title="Change language (coming soon)"
        onClick={() => setOpen((value) => !value)}
      >
        <Languages size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          className="app-topbar-popover popout-enter glass absolute right-0 top-full z-popover mt-2 min-w-44 rounded-sidebar border border-inner-border bg-popover-bg p-2 shadow-popout"
        >
          {LOCALES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              className="flex w-full items-center justify-between gap-3 rounded-inset px-3 py-2 text-left text-body text-text-secondary hover:bg-hover-bg hover:text-text-primary"
              onClick={() => {
                setLocale(entry.id);
                setOpen(false);
              }}
            >
              <span>{entry.name}</span>
              {entry.id === locale ? <span className="text-accent-text">✓</span> : null}
            </button>
          ))}
          <p className="px-3 pb-1 pt-2 text-badge leading-snug text-text-tertiary">
            Translations are not wired up yet — the console stays in English for now.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The donation modal.
 *
 * Built on the shared `Dialog` rather than a one-off overlay: it already owns
 * the backdrop blur, the focus trap, the escape handling and the viewport
 * bounding, and a second implementation of those is a second thing to keep in
 * step.
 */
function DonationModal({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Buy me a coffee"
      description="Support Cartethyia development via QRIS or Saweria."
      size="lg"
      footer={
        <DialogActions>
          <a
            href={QRIS_IMAGE}
            download="qris-risun-marke.webp"
            className="flex items-center gap-1.5 rounded-inset border border-inner-border px-3 py-2 text-body text-text-secondary hover:bg-hover-bg hover:text-text-primary"
          >
            <Download size={14} aria-hidden="true" />
            Save QR
          </a>
          <a
            href={DONATION_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1.5 rounded-inset bg-accent-bg px-4 py-2 text-body font-semibold text-accent-text hover:opacity-90"
          >
            <Coffee size={14} aria-hidden="true" />
            Donate via Saweria
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </DialogActions>
      }
    >
      <div className="grid grid-cols-1 gap-5 sm:gap-6 donate-qr-grid">
        <div className="flex flex-col items-center gap-2">
          <img
            src={QRIS_IMAGE}
            alt="QRIS payment code for RISUN"
            className="aspect-square w-full donate-qr-image rounded-inset border border-inner-border bg-white object-contain p-2"
          />
          <p className="flex items-center gap-1.5 text-badge text-text-tertiary">
            <QrCode size={12} aria-hidden="true" />
            Scan with any QRIS app
          </p>
        </div>

        <div className="min-w-0">
          <p className="text-body leading-relaxed text-text-secondary">
            Cartethyia is built in the spare hours between everything else — late
            nights, weekends, and a suspicious number of energy drinks. If it saved
            you an afternoon of fighting with rate limits, or made your proxy pool
            behave, a coffee genuinely helps keep the lights on and the commits
            coming.
          </p>

          <ul className="mt-3 flex flex-col gap-1.5 text-caption text-text-secondary">
            <li className="flex items-start gap-2">
              <Sparkles size={14} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
              <span>Keeps late-night debugging sessions fuelled.</span>
            </li>
            <li className="flex items-start gap-2">
              <Heart size={14} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
              <span>Funds the coffee that funds the next release.</span>
            </li>
          </ul>

          <div className="mt-4 border-t border-inner-border pt-3">
            <p className="text-badge font-bold uppercase tracking-label text-text-tertiary">
              Other ways to support
            </p>
            <ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {SOURCE_LINKS.map((link) => (
                <li key={link.id}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-2 rounded-inset border border-inner-border px-3 py-2 text-caption text-text-secondary hover:bg-hover-bg hover:text-text-primary"
                  >
                    {link.id === "github-alt" ? (
                      <Star size={12} className="shrink-0 text-accent-text" aria-hidden="true" />
                    ) : (
                      <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
                    )}
                    <span className="min-w-0 truncate">{link.label}</span>
                    <span className="ml-auto shrink-0 text-micro text-text-tertiary">
                      {link.hint}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-3 text-badge leading-relaxed text-text-tertiary">
            No obligation, no paywall, no nagging — the project stays free either way.
            Thank you for using it. 💙
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/** The language switch and the donation button, for the console topbar. */
export function HeaderExtras() {
  const [donateOpen, setDonateOpen] = useState(false);

  return (
    <>
      {/* Donate leads: it is the only one of the two that is an action rather
          than a setting. The label collapses to the icon alone on a narrow
          topbar, where a second word would crowd the title. */}
      <button
        type="button"
        className="topbar-donate-button"
        aria-label="Support the project"
        title="Buy me a coffee"
        onClick={() => setDonateOpen(true)}
      >
        <span className="text-badge font-bold tracking-wide">Donate</span>
        <HandHeart size={14} aria-hidden="true" />
      </button>
      <LanguageMenu />
      <DonationModal open={donateOpen} onClose={() => setDonateOpen(false)} />
    </>
  );
}
