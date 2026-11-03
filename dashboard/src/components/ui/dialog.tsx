import { Maximize2, Minus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePresence } from "../../hooks/use-presence";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { DialogDirtyContext } from "../../hooks/use-dialog-dirty";
import { toast } from "../../lib/toast";
import { cn } from "../../lib/classnames";

const TRAFFIC_LIGHT =
  "traffic-light grid size-7 cursor-pointer place-items-center rounded-pill border-none p-0 transition-transform duration-(--dur-micro) ease-standard hover:scale-112 focus-visible:outline-2 focus-visible:outline-current focus-visible:outline-offset-2";

/** Named panel size. One of the four scale steps. */
export type DialogSize = "sm" | "md" | "lg" | "xl";

const DIALOG_SIZE_WIDTH: Record<DialogSize, number> = {
  sm: 420,
  md: 640,
  lg: 880,
  /** Wide data/workspace dialogs; expanded mode remains the explicit full-width escape hatch. */
  xl: 960,
};

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Optional description text, rendered visually hidden and wired via aria-describedby. */
  description?: string;
  /** Preferred panel width in px; the panel never exceeds the viewport. Defaults to 520. */
  width?: number;
  /** Named size step from the modal scale. Wins over width when both are set. */
  size?: DialogSize;
  /** Optional action row pinned below the scrollable body (buttons stay put). */
  footer?: ReactNode;
  /**
   * When false, the dialog refuses to close (backdrop, X, Escape) and instead
   * shakes the panel and calls `onCloseBlocked`. Use for forms with unsaved
   * changes so a stray drag/click outside cannot lose edits.
   */
  canClose?: boolean;
  /** Called when a close attempt is blocked (canClose === false). */
  onCloseBlocked?: () => void;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  width = 520,
  size,
  footer,
  canClose = true,
  onCloseBlocked,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { mounted, closing } = usePresence(open);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [shaking, setShaking] = useState(false);
  // Set by forms inside this dialog via `useDialogDirty`. When true, the
  // dialog refuses to close (backdrop, X, Escape) and shakes + warns.
  const [dirty, setDirty] = useState(false);
  // Tracks drags that started inside the panel (e.g. selecting text). If the
  // pointer releases on the backdrop, that is not an intent to close — it is
  // the tail of a selection drag, so the overlay must not close on that click.
  const dragStartedInsideRef = useRef(false);
  useModalFocus({ open, mounted, panelRef, onClose });

  const attemptClose = () => {
    if (canClose && !dirty) {
      onClose();
      return;
    }
    // Blocked: shake the panel and let the caller surface a notification.
    setShaking(true);
    window.setTimeout(() => setShaking(false), 400);
    if (onCloseBlocked) {
      onCloseBlocked();
    } else {
      toast.warning("Unsaved changes — finish editing or save before closing.");
    }
  };

  // Same contract as `Drawer`: shut the mobile nav rail so its dim overlay
  // never sits under this panel and traps touch scroll.
  useEffect(() => {
    if (mounted) window.dispatchEvent(new CustomEvent("cartethyia:overlay-open"));
  }, [mounted]);
  // Reset window chrome when the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setMinimized(false);
      setExpanded(false);
    }
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={cn(
        "dialog-overlay scroll-region fixed inset-0 z-drawer box-border flex items-center justify-center overflow-y-auto bg-overlay p-8 backdrop-blur-dialog max-small:p-6",
        closing && "closing pointer-events-none",
      )}
      onClick={(event) => {
        // Only close when this is a genuine backdrop click — not the tail of a
        // text-selection drag that started inside the panel.
        if (event.target === event.currentTarget && !dragStartedInsideRef.current) {
          attemptClose();
        }
        dragStartedInsideRef.current = false;
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onMouseDown={() => {
          dragStartedInsideRef.current = true;
        }}
        className={cn(
          "dialog-panel modal-window m-auto box-border flex flex-col overflow-hidden rounded-sidebar border border-border-strong bg-surface-1 shadow-window",
          closing && "closing",
          expanded && "expanded",
          shaking && "dialog-shake",
        )}
        style={
          expanded
            ? undefined
            : { ["--dialog-width" as string]: `${size !== undefined ? DIALOG_SIZE_WIDTH[size] : width}px` }
        }
        // `role="dialog"` is what makes the `aria-modal` and `aria-labelledby`
        // below meaningful — both are inert on a plain `div`, so without it a
        // screen-reader user gets no announcement that focus moved into a modal.
        // `drawer.tsx`, the sibling primitive, already declares the role.
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          const target = event.target;
          if (target instanceof HTMLTextAreaElement) return;
          const submit = event.currentTarget.querySelector(".modal-footer .btn-primary, .modal-footer .btn-danger");
          if (!(submit instanceof HTMLButtonElement) || submit.disabled) return;
          event.preventDefault();
          submit.click();
        }}
      >
        <div className="modal-header flex items-center justify-between gap-6 border-b border-inner-border px-9 py-7">
          <div className="window-traffic-lights flex shrink-0 items-center gap-4" role="group" aria-label="Window controls">
            <button
              type="button"
              className={cn(TRAFFIC_LIGHT, "traffic-light-close bg-window-close text-window-close-ink")}
              onClick={attemptClose}
              aria-label="Close dialog"
              title="Close"
            >
              <X size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cn(TRAFFIC_LIGHT, "traffic-light-minimize bg-window-minimize text-window-minimize-ink")}
              onClick={() => setMinimized((v) => !v)}
              aria-label={minimized ? "Restore dialog" : "Minimize dialog"}
              title={minimized ? "Restore" : "Minimize"}
            >
              <Minus size={9} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cn(TRAFFIC_LIGHT, "traffic-light-expand bg-window-expand text-window-expand-ink")}
              onClick={() => {
                setExpanded((v) => !v);
                setMinimized(false);
              }}
              aria-label={expanded ? "Restore dialog size" : "Expand dialog"}
              title={expanded ? "Restore" : "Expand"}
            >
              <Maximize2 size={8} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
          <h3 id={titleId} className="modal-title min-w-0 flex-1 overflow-hidden text-center text-lead font-bold text-text-primary text-ellipsis whitespace-nowrap">
            {title}
          </h3>
          <span className="window-traffic-lights-spacer w-29 shrink-0" aria-hidden="true" />
        </div>
        {minimized ? null : (
          <div className="modal-body scroll-region min-h-0 flex-auto overflow-y-auto px-9 py-8">
            <DialogDirtyContext.Provider value={{ setDirty }}>{children}</DialogDirtyContext.Provider>
          </div>
        )}
        {minimized || footer === undefined ? null : <div className="modal-footer flex shrink-0 items-center justify-end gap-4 border-t border-inner-border px-9 py-6">{footer}</div>}
        {description ? (
          // `sr-only` is exactly the visually-hidden pattern that was inlined here
          // (1px box, clipped, no border) — the description stays available to a
          // screen reader without taking part in layout.
          <p id={descriptionId} className="sr-only">
            {description}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
