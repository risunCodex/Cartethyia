import type { ReactNode } from "react";
import { toast as sonnerToast, type ExternalToast } from "sonner";

/** Builds a "Copy" action that puts the toast's title + description on the clipboard. */
function withCopyAction(title: string, description?: string | null): ExternalToast {
  const text = [title, description].filter((value): value is string => Boolean(value)).join("\n");
  return {
    ...(description ? { description } : {}),
    action: {
      label: "Copy",
      onClick: () => {
        if (!navigator.clipboard) {
          sonnerToast.error("Clipboard unavailable");
          return;
        }
        void navigator.clipboard.writeText(text).then(
          () => sonnerToast.success("Toast content copied", { duration: 2_000 }),
          () => sonnerToast.error("Copy failed", { duration: 2_000 }),
        );
      },
    },
  };
}

export const toast = {
  success: (title: string, description?: string | null) =>
    sonnerToast.success(title, withCopyAction(title, description)),
  /**
   * A success toast whose body is rendered rather than plain text.
   *
   * The probe reports a model id the upstream chose, and that id belongs in a
   * chip beside the sample text — not concatenated into one string, where it
   * reads as part of the answer. `copyText` is what the Copy action puts on the
   * clipboard, so a rendered body still copies as something pasteable.
   */
  successRich: (title: string, body: ReactNode, copyText: string) =>
    sonnerToast.success(title, {
      description: body,
      action: {
        label: "Copy",
        onClick: () => {
          if (!navigator.clipboard) {
            sonnerToast.error("Clipboard unavailable");
            return;
          }
          void navigator.clipboard.writeText(`${title}\n${copyText}`).then(
            () => sonnerToast.success("Toast content copied", { duration: 2_000 }),
            () => sonnerToast.error("Copy failed", { duration: 2_000 }),
          );
        },
      },
    }),
  error: (title: string, description?: string | null) =>
    sonnerToast.error(title, withCopyAction(title, description)),
  warning: (title: string, description?: string | null) =>
    sonnerToast.warning(title, withCopyAction(title, description)),
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
};
