import { useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Loader2, Package, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { CodeChip } from "./ui/code-chip";
import { Dialog } from "./ui/dialog";
import { DialogActions } from "./ui/dialog-actions";
import {
  GITHUB_ALT_RELEASES_URL,
  NPM_PACKAGE_URL,
  NPM_UPDATE_COMMAND,
} from "../lib/links";

/** Which release the operator has already been told about and dismissed. */
const DISMISS_KEY = "cartethyia:update-dismissed";

/**
 * Reads the dismissed release, and records one.
 *
 * `localStorage` can throw — a full quota, or a browser with storage blocked —
 * and a failed write must not take the dialog down with it. Reading falls back
 * to "never dismissed", which is the safer failure: the operator sees the
 * prompt again rather than never being told about a release.
 */
/** Reads the dismissed release. Exported so the shell can gate the auto-prompt. */
export function readDismissedUpdate(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/** Records that a release has been seen, so the auto-prompt stops returning. */
export function dismissUpdate(version: string): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, version);
  } catch {
    // Not fatal: the prompt simply returns on the next load.
  }
}

/**
 * What the gateway is running and what GitHub says is newest.
 *
 * `currentVersion` is the gateway's own answer, not the bundled dashboard's:
 * the install is what an operator upgrades, so that is the number an update
 * decision has to be about.
 */
export interface UpdateDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly currentVersion: string;
  /** Newest published tag, `v` prefix stripped. Absent when the check failed. */
  readonly latestVersion?: string | undefined;
  /** Release page to open. Falls back to the public mirror. */
  readonly releaseUrl?: string | undefined;
  /**
   * Records that this release has been seen, so the automatic prompt does not
   * return on every reload. Absent when the dialog was opened from the badge,
   * where there is nothing automatic to suppress.
   */
  readonly onDismissVersion?: (() => void) | undefined;
  /** Triggered when the operator clicks "Update now". */
  readonly onUpdateNow?: (() => void) | undefined;
  /** Whether an update is currently in progress (blocks refresh). */
  readonly updating?: boolean;
  /** Set when the install failed or could not start; rendered instead of the spinner. */
  readonly error?: string;
}

/** Copies text and reports the transient "copied" state to the button. */
function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return { copied, copy };
}

/**
 * Tells the operator a release exists and how to install it.
 *
 * Deliberately not a "Update now" button. npm cannot replace this package's
 * directory while a process is executing out of it — on Windows the rename
 * fails with EBUSY — so a button that tried would fail in a way that looks
 * like a bug in the gateway. The honest thing the console can do is say what
 * to run, and say why it has to be run outside.
 */
export function UpdateDialog({
  open,
  onClose,
  currentVersion,
  latestVersion,
  releaseUrl,
  onDismissVersion,
  onUpdateNow,
  updating = false,
  error,
}: UpdateDialogProps): ReactNode {
  const { copied, copy } = useCopy();
  const target = latestVersion ?? "the latest release";
  const dismiss = (): void => {
    onDismissVersion?.();
    onClose();
  };

  return (
    <>
      <Dialog
      open={open}
      onClose={onClose}
      title="Update available"
      description={`Cartethyia ${target} is available; this install runs ${currentVersion}.`}
      size="md"
      footer={
        <DialogActions>
          {onDismissVersion === undefined ? (
            <Button variant="ghost" onClick={onClose}>
              Later
            </Button>
          ) : (
            <Button variant="ghost" onClick={dismiss}>
              Don&rsquo;t show for v{target}
            </Button>
          )}
          {onUpdateNow !== undefined && !error ? (
            <Button onClick={onUpdateNow} disabled={updating}>
              {updating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              {updating ? "Updating…" : "Update now"}
            </Button>
          ) : null}
          <Button onClick={() => copy(NPM_UPDATE_COMMAND)} disabled={updating}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? "Copied" : "Copy update command"}
          </Button>
        </DialogActions>
      }
    >
      <div className="flex flex-col gap-8 py-2 px-0">
        <div className="flex items-start gap-6">
          <span className="mt-0.5 grid size-12 shrink-0 place-items-center rounded-control bg-surface-1 text-text-secondary">
            <Package size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-caption">
              {currentVersion} &rarr; {target}
            </p>
            <p className="text-badge text-text-secondary mt-1">
              Stop the gateway, run the command, then start again.
            </p>
          </div>
        </div>

        <div className="rounded-card border border-inner-border bg-surface-2 p-4">
          <p className="text-badge text-text-tertiary">Run this in a terminal</p>
          <div className="mt-3 flex items-center gap-4 min-w-0">
            <CodeChip
              value={NPM_UPDATE_COMMAND}
              tone="muted"
              title={NPM_UPDATE_COMMAND}
              className="min-w-0 flex-1 truncate"
            />
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => copy(NPM_UPDATE_COMMAND)}
              aria-label="Copy the update command"
            >
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </Button>
          </div>
        </div>

        <div className="flex items-start gap-6 rounded-card border border-inner-border bg-surface-2 p-4">
          <span className="mt-0.5 shrink-0 text-text-secondary">
            <TriangleAlert size={14} aria-hidden="true" />
          </span>
          <p className="text-badge text-text-secondary min-w-0">
            npm cannot replace the package while Cartethyia is running from it, so this
            cannot update itself the way a single-binary tool can. That is why the console
            gives you the command instead of a button that installs.
          </p>
        </div>

        {error ? (
          <div className="flex items-start gap-6 rounded-card border border-inner-border bg-surface-2 p-4 text-red-500">
            <span className="mt-0.5 shrink-0">
              <TriangleAlert size={14} aria-hidden="true" />
            </span>
            <p className="text-badge min-w-0 break-words">Update failed — {error}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <a
            href={releaseUrl ?? GITHUB_ALT_RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-badge text-accent hover:underline"
          >
            <ExternalLink size={12} aria-hidden="true" />
            What&rsquo;s new on GitHub
          </a>
          <a
            href={NPM_PACKAGE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-badge text-accent hover:underline"
          >
            <ExternalLink size={12} aria-hidden="true" />
            Package on npm
          </a>
        </div>
      </div>
    </Dialog>
    {updating ? (
      <div className="fixed inset-0 z-toast grid place-items-center bg-black/70 backdrop-blur-sm">
        <div className="flex flex-col items-center gap-4 text-white">
          <Loader2 size={40} className="animate-spin" aria-hidden="true" />
          <p className="text-lg font-semibold">Updating Cartethyia…</p>
          <p className="text-sm opacity-80">Do not refresh or close this page.</p>
        </div>
      </div>
    ) : null}
    </>
  );
}
