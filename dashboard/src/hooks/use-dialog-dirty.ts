import { createContext, useContext, useEffect } from "react";

/**
 * Dirty-state registration for dialogs.
 *
 * Any form living inside a `Dialog` can call `useDialogDirty(dirty)` to tell
 * the dialog to refuse closing while edits are unsaved. The dialog handles the
 * rest: it blocks backdrop clicks, the X button, and Escape, shakes the panel,
 * and surfaces a warning toast.
 *
 * This makes unsaved-edit protection opt-in per form (one hook call) instead of
 * requiring every dialog call-site to wire `canClose`/`onCloseBlocked` by hand.
 */

export interface DialogDirtyContextValue {
  setDirty: (dirty: boolean) => void;
}

export const DialogDirtyContext = createContext<DialogDirtyContextValue | null>(null);

/**
 * Registers the form's dirty state with the enclosing `Dialog`. Pass `true`
 * when any field differs from its saved value, `false` otherwise.
 *
 * When there is no enclosing dialog (e.g. a form rendered outside a modal),
 * this is a safe no-op.
 */
export function useDialogDirty(dirty: boolean): void {
  const ctx = useContext(DialogDirtyContext);
  useEffect(() => {
    ctx?.setDirty(dirty);
  }, [ctx, dirty]);
}
