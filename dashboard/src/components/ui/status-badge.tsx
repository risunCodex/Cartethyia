import { type ReactNode } from "react";
import { Badge } from "./badge";

/**
 * A small "satisfied / not satisfied" status pill, used wherever a field or
 * value is either set or missing. Green when satisfied, warn (orange) when
 * missing — the same visual language as the `routing:cli_mapping` badge and
 * the account status pills, so the dashboard speaks one status vocabulary.
 */
export function StatusBadge({
  ok,
  label,
  missingLabel,
  title,
}: {
  readonly ok: boolean;
  readonly label: string;
  readonly missingLabel?: string;
  readonly title?: string;
}): ReactNode {
  return ok ? (
    <Badge tone="ok" dot title={title}>
      {label} set
    </Badge>
  ) : (
    <Badge tone="warn" dot title={title}>
      {missingLabel ?? label} not set
    </Badge>
  );
}
