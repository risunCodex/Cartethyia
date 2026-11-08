import {
  Database,
  Download,
  FileClock,
  Layers,
  Network,
  Server,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Banner } from "./patterns/banner";
import { Input } from "./ui/input";
import { Stack } from "./ui/stack";
import { Switch } from "./ui/switch";
import { toast } from "../lib/toast";
import { downloadBytes, downloadTextFile } from "../lib/download";
import { readBackupFile } from "../lib/backup-file";
import { getErrorMessage } from "../data/api";
import {
  useDeleteAllBackup,
  useExportBackup,
  useInspectBackup,
  useRestoreBackup,
} from "../hooks/backup";
import { Dialog } from "./ui/dialog";
import type {
  BackupImportReport,
  BackupInspection,
  DeleteAllScope,
  RestoreWarning,
} from "../data/contracts";

/**
 * Backup and restore, as a Settings panel.
 *
 * Both actions re-authenticate with the console password, so the form is the
 * same shape for each: type the password, then export or import. The password
 * is never stored — it goes with the one request and is cleared on success.
 *
 * The copy carries the two facts an operator needs before they click, because
 * both behave in ways that are surprising otherwise: the export is plain JSON
 * containing every provider credential, and history restored from older than
 * is pruned again on the next sweep.
 */

/**
 * A heading one step below the card header.
 *
 * `SectionHeading` renders `text-title` (18px) whatever `level` says — the
 * level only picks the tag, not the size — so using it inside a card made
 * "Backup" read larger than the card's own title above it. This is 14px, the
 * same as a card header, which is the right size for a child of one.
 */
function SubsectionHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}): ReactNode {
  return (
    <div className="mb-6 min-w-0">
      <h3 className="text-body-lg font-bold text-text-primary">{title}</h3>
      <p className="mt-1 text-caption text-text-secondary">{description}</p>
    </div>
  );
}

/**
 * One selectable scope, as a card with a glyph.
 *
 * The same shape Data Management gives its disk buckets — icon, name, one line
 * of what it covers — so a checkbox that swallows a whole category reads as
 * the thing it will delete rather than as one row in a list. Checked state is
 * carried by `has-checked:` on the card, so the whole tile lights up instead
 * of just the box.
 *
 * The input stays a real checkbox inside a real label: that is what makes the
 * tile clickable and keyboard-operable without a click handler of its own.
 */
function ScopeCard({
  icon: Icon,
  label,
  description,
  checked,
  onChange,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: () => void;
}): ReactNode {
  return (
    <label className="flex items-start gap-5 min-h-21 px-6 py-5 border border-inner-border rounded-control bg-surface-2 text-text-primary text-caption leading-snug cursor-pointer hover:border-border-strong hover:bg-hover has-checked:border-accent has-checked:bg-accent-soft">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="grid size-9 shrink-0 place-items-center rounded-control bg-surface-1 text-text-secondary">
        <Icon size={15} aria-hidden="true" />
      </span>
      <span className="flex flex-col gap-1 min-w-0">
        <strong>{label}</strong>
        <small className="text-text-tertiary text-badge">{description}</small>
      </span>
    </label>
  );
}

/**
 * One glyph per delete scope.
 *
 * "All configuration" is the union of the other two, so it gets the wider
 * glyph — a stack rather than one of the two things inside it.
 */
function deleteIconFor(scope: DeleteAllScope): LucideIcon {
  if (scope === "providers") return Server;
  if (scope === "proxies") return Network;
  return Layers;
}

/** Renders a router-import report: what landed, what did not, and why. */
function ImportReportPanel({
  report,
}: {
  readonly report: BackupImportReport;
}): ReactNode {
  const imported = Object.entries(report.imported).filter(
    ([, count]) => count > 0,
  );
  return (
    <Stack gap="8px">
      {imported.length > 0 ? (
        <p className="text-caption">
          Imported:{" "}
          {imported.map(([name, count]) => `${count} ${name}`).join(", ")}
        </p>
      ) : null}
      {report.remapped.length > 0 ? (
        <p className="text-caption text-text-secondary">
          Remapped provider ids: {report.remapped.join(", ")}
        </p>
      ) : null}
      {report.skipped.length > 0 ? (
        <div>
          <p className="text-caption text-yellow">
            Skipped ({report.skipped.length}) — nothing was guessed:
          </p>
          <ul className="text-caption text-text-tertiary mt-2 ml-8">
            {report.skipped.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.warnings.length > 0 ? (
        <div>
          <p className="text-caption text-text-secondary">Warnings:</p>
          <ul className="text-caption text-text-tertiary mt-2 ml-8">
            {report.warnings.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Stack>
  );
}

function RestoreWarningPanel({
  warnings,
}: {
  readonly warnings: readonly RestoreWarning[];
}): ReactNode {
  if (warnings.length === 0) return null;
  return (
    <Banner tone="warning" surface="raised" live="status">
      <strong>
        Restore completed with {warnings.length} warning
        {warnings.length === 1 ? "" : "s"}
      </strong>
      <ul className="mt-2 ml-8">
        {warnings.map((warning, index) => (
          <li
            key={`${warning.table ?? "backup"}:${warning.column ?? "general"}:${index}`}
          >
            {warning.table
              ? `${warning.table}${warning.column ? `.${warning.column}` : ""}: `
              : ""}
            {warning.reason}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function transferLabel(
  transfer: { loaded: number; total: number | null; startedAt: number } | null,
  fallback: string,
): string {
  if (transfer === null) return fallback;
  const seconds = Math.max((Date.now() - transfer.startedAt) / 1000, 0.1);
  const speed = formatBytes(transfer.loaded / seconds);
  const size =
    transfer.total === null
      ? formatBytes(transfer.loaded)
      : `${formatBytes(transfer.loaded)} / ${formatBytes(transfer.total)}`;
  return `${size} · ${speed}/s`;
}
export function BackupPanel(): ReactNode {
  const [password, setPassword] = useState("");
  const [passwordFor, setPasswordFor] = useState<
    "download" | "restore" | "delete" | null
  >(null);
  const [includeConfig, setIncludeConfig] = useState(true);
  const [includeTelemetry, setIncludeTelemetry] = useState(false);
  const [highlyCompress, setHighlyCompress] = useState(true);
  const [transfer, setTransfer] = useState<{
    loaded: number;
    total: number | null;
    startedAt: number;
  } | null>(null);
  const [restored, setRestored] = useState<Record<string, number> | null>(null);
  const [restoreWarnings, setRestoreWarnings] = useState<
    readonly RestoreWarning[] | null
  >(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [report, setReport] = useState<BackupImportReport | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [deleteScopes, setDeleteScopes] = useState<ReadonlySet<DeleteAllScope>>(
    new Set(),
  );
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(
    null,
  );
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [selectedTables, setSelectedTables] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [inspectError, setInspectError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const exportBackup = useExportBackup();
  const restoreBackup = useRestoreBackup();
  const deleteAllBackup = useDeleteAllBackup();
  const inspectBackup = useInspectBackup();
  const toggleDeleteScope = (scope: DeleteAllScope) => {
    setDeleteScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };
  const closePassword = () => {
    setPasswordFor(null);
    setPassword("");
  };
  const askDelete = () => {
    if (deleteScopes.size === 0) return;
    setPassword("");
    setPasswordFor("delete");
  };
  const performDelete = async () => {
    if (password.length === 0) return;
    const result = await deleteAllBackup.mutateAsync({
      password,
      scopes: [...deleteScopes],
    });
    setDeleteScopes(new Set());
    closePassword();
    toast.success(
      "Selected configuration deleted.",
      Object.entries(result.deleted)
        .map(([table, count]) => `${table}: ${count}`)
        .join(" · "),
    );
  };
  const download = () => {
    const sections = [
      ...(includeConfig ? ["config"] : []),
      ...(includeTelemetry ? ["telemetry"] : []),
    ].join(",");
    if (sections.length === 0) {
      toast.error("Select at least one backup section.");
      return;
    }
    exportBackup.mutate(
      {
        password,
        sections,
        compressed: highlyCompress,
        onProgress: (progress) =>
          setTransfer((current) => ({
            ...progress,
            startedAt: current?.startedAt ?? Date.now(),
          })),
      },
      {
        onSuccess: (payload) => {
          const stamp = new Date()
            .toISOString()
            .slice(0, 19)
            .replace(/[:T]/g, "-");
          if (payload instanceof Uint8Array) {
            downloadBytes(
              `cartethyia_backup_${stamp}.json.gz`,
              payload,
              "application/gzip",
            );
          } else {
            downloadTextFile(
              `cartethyia_backup_${stamp}.json`,
              JSON.stringify(payload, null, 2),
              "application/json",
            );
          }
          closePassword();
          toast.success("Backup downloaded.");
        },
        onError: (error) =>
          toast.error(getErrorMessage(error, "Backup export failed.")),
      },
    );
  };

  /**
   * Reads the file, then shows what is in it *before* asking for a password.
   *
   * The old flow went straight to the password dialog, so the operator
   * re-authenticated for a restore they could not yet see the scope of — and
   * a backup carries more than one section, so "restore" always meant all of
   * it. Inspection is free and writes nothing, so it comes first and its
   * checklist becomes the selection.
   */
  const upload = async (file: File) => {
    setRestored(null);
    setRestoreWarnings(null);
    setRestoreError(null);
    setReport(null);
    setFormat(null);
    setInspectError(null);
    setInspection(null);
    setSelectedTables(new Set());
    setPendingRestoreFile(file);
    try {
      const parsed = await readBackupFile(file);
      const result = await inspectBackup.mutateAsync({ backup: parsed });
      setInspection(result);
      // Default to everything the file carries and the schema supports. An
      // operator who wants all of it should not have to click every row, and
      // an unsupported table cannot be restored either way.
      setSelectedTables(
        new Set(
          result.rows.filter((row) => row.supported).map((row) => row.table),
        ),
      );
    } catch (error: unknown) {
      setPendingRestoreFile(null);
      toast.error(
        "Could not read that backup",
        getErrorMessage(error, "The file is not a readable backup."),
      );
    }
  };
  const toggleTable = (table: string) => {
    setSelectedTables((current) => {
      const next = new Set(current);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };
  const closeInspect = () => {
    setInspection(null);
    setPendingRestoreFile(null);
    setInspectError(null);
  };
  /** Commits the checklist: the password prompt is the last step, not the first. */
  const beginRestore = () => {
    if (pendingRestoreFile === null || selectedTables.size === 0) return;
    setPassword("");
    setRestoreError(null);
    setPasswordFor("restore");
  };
  const performRestore = async () => {
    const file = pendingRestoreFile;
    if (file === null) return;
    setRestoreError(null);
    try {
      // The compressed download is gzip bytes on disk, so the file cannot be read
      // as text — see `readBackupFile`.
      const parsed = await readBackupFile(file);
      const result = await restoreBackup.mutateAsync({
        password,
        backup: parsed,
        // "All selected" is sent as an explicit list rather than omitted: the
        // server treats an absent list as "the whole file", and the checklist
        // may have deselected a table the file does carry.
        tables: [...selectedTables],
        onProgress: (progress) =>
          setTransfer((current) => ({
            ...progress,
            startedAt: current?.startedAt ?? Date.now(),
          })),
      });
      setRestored(result.restored);
      setRestoreWarnings(result.warnings);
      setReport(result.report ?? null);
      setFormat(result.format);
      closePassword();
      setPendingRestoreFile(null);
      setInspection(null);
      toast.success(
        result.warnings.length === 0
          ? "Restore complete."
          : "Restore completed with warnings.",
        result.warnings.length === 0
          ? null
          : `${result.warnings.length} item(s) need attention. See the restore report below.`,
      );
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Backup restore failed.");
      setRestoreError(message);
      toast.error("Backup restore failed", message);
    }
  };

  const restoreRows = restored === null ? [] : Object.entries(restored);

  return (
    <>
      <div className="grid grid-cols-2 gap-8 w-full min-w-0 max-medium:grid-cols-1">
        <section aria-label="Backup" className="min-w-0">
          <SubsectionHeading
            title="Export and restore"
            description="Download a JSON snapshot, or restore one you already trust."
          />
          <Stack gap="14px">
            <fieldset className="grid grid-cols-2 gap-5 min-w-0 border-0 m-0 p-0 max-medium:grid-cols-1">
              <legend className="mb-4 text-text-secondary text-caption font-semibold">
                Include in the download
              </legend>
              <ScopeCard
                icon={Database}
                label="Account, proxy &amp; settings"
                description="Credentials, API-key hashes, routing, and settings"
                checked={includeConfig}
                onChange={() => setIncludeConfig(!includeConfig)}
              />
              <ScopeCard
                icon={FileClock}
                label="Telemetry history"
                description="Status, tokens, cost, latency — never prompt bodies"
                checked={includeTelemetry}
                onChange={() => setIncludeTelemetry(!includeTelemetry)}
              />
            </fieldset>
            <div className="flex items-center justify-between gap-6 rounded-control border border-inner-border px-6 py-5">
              <span>
                <strong className="block text-body">
                  Highly Compress Backup
                </strong>
                <small className="text-caption text-text-tertiary">
                  Makes the download smaller.
                </small>
              </span>
              <Switch
                checked={highlyCompress}
                onChange={setHighlyCompress}
                aria-label="Highly Compress Backup"
              />
            </div>
            <p className="mt-1 text-caption text-text-tertiary">
              The file contains provider credentials. Treat it like the
              database. Prompt and response bodies, health-event history, and
              console sessions are left out.
            </p>
            <div className="mt-auto flex justify-end gap-4">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setPassword("");
                  setPasswordFor("download");
                }}
                disabled={!includeConfig && !includeTelemetry}
                icon={<Download size={13} />}
              >
                Download backup
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fileInput.current?.click()}
                icon={<Upload size={13} />}
              >
                Restore from file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json,.gz,application/gzip"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                  event.target.value = "";
                }}
              />
            </div>
            {format !== null ? (
              <p className="mt-1 text-caption text-text-tertiary">
                Detected format:{" "}
                {format === "nine_router"
                  ? "router export"
                  : "Cartethyia backup"}
              </p>
            ) : null}
            {restored !== null ? (
              <Banner tone="success" surface="raised" live="status">
                <strong>Restore complete</strong>
                {restoreRows.length > 0 ? (
                  <ul>
                    {restoreRows.map(([table, count]) => (
                      <li key={table}>
                        {table}: {count}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No rows were imported.</p>
                )}
              </Banner>
            ) : null}
            {restoreWarnings !== null ? (
              <RestoreWarningPanel warnings={restoreWarnings} />
            ) : null}
            {report !== null ? <ImportReportPanel report={report} /> : null}
          </Stack>
        </section>

        <section aria-label="Delete data" className="min-w-0">
          <SubsectionHeading
            title="Delete data"
            description="Removes the scopes you check. Console users, sessions, and audit history stay."
          />
          <Stack gap="12px">
            <fieldset className="grid grid-cols-1 gap-5 min-w-0 border-0 m-0 p-0">
              <legend className="mb-4 text-text-secondary text-caption font-semibold">
                Delete
              </legend>
              {(
                [
                  [
                    "providers",
                    "Providers",
                    "Accounts, credentials, tenant models, routing, and account health",
                  ],
                  [
                    "proxies",
                    "Proxies",
                    "Network pools, pool settings, and pool health",
                  ],
                  [
                    "configuration",
                    "All configuration",
                    "Providers, proxies, aliases, combos, API keys, CLI tools, and settings",
                  ],
                ] as const
              ).map(([scope, label, description]) => (
                <ScopeCard
                  key={scope}
                  icon={deleteIconFor(scope)}
                  label={label}
                  description={description}
                  checked={deleteScopes.has(scope)}
                  onChange={() => toggleDeleteScope(scope)}
                />
              ))}
            </fieldset>
            {/*
             * One way out, and it re-authenticates: a scoped delete empties
             * more than the three labels name — "Providers" also takes the
             * models and OAuth states hanging off it. The password prompt is
             * the last chance to notice that.
             */}
            <div className="mt-auto flex justify-end gap-4 flex-wrap">
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={14} />}
                disabled={deleteScopes.size === 0}
                onClick={askDelete}
              >
                Delete selected
              </Button>
            </div>
          </Stack>
        </section>
      </div>
      <Dialog
        open={inspection !== null}
        onClose={closeInspect}
        title="Restore from backup"
        description="Choose which parts of this file to restore, then confirm with your console password."
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeInspect}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={selectedTables.size === 0}
              onClick={beginRestore}
            >
              Restore now
            </Button>
          </>
        }
      >
        <Stack gap="12px">
          {inspection !== null ? (
            <>
              <p className="text-caption text-text-tertiary">
                {inspection.format === "nine_router"
                  ? "Router export — it is converted at restore time, so every table it produces is restored."
                  : `${inspection.total} rows · exported ${inspection.exportedAt || "unknown date"}`}
              </p>
              {inspection.rows.length > 0 ? (
                <fieldset className="grid grid-cols-1 gap-4 min-w-0 border-0 m-0 p-0">
                  <legend className="mb-3 text-text-secondary text-caption font-semibold">
                    Restore these tables
                  </legend>
                  <div className="flex justify-end gap-4">
                    <button
                      type="button"
                      className="text-badge text-accent hover:underline"
                      onClick={() =>
                        setSelectedTables(
                          new Set(
                            inspection.rows
                              .filter((row) => row.supported)
                              .map((row) => row.table),
                          ),
                        )
                      }
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="text-badge text-text-secondary hover:underline"
                      onClick={() => setSelectedTables(new Set())}
                    >
                      Select none
                    </button>
                  </div>
                  {inspection.rows.map((row) => (
                    <label
                      key={`${row.section}:${row.table}`}
                      className="flex items-start gap-4 px-5 py-4 border border-inner-border rounded-control bg-surface-2 text-caption leading-snug cursor-pointer hover:border-border-strong hover:bg-hover has-checked:border-accent has-checked:bg-accent-soft"
                    >
                      <input
                        type="checkbox"
                        checked={selectedTables.has(row.table)}
                        disabled={!row.supported}
                        onChange={() => toggleTable(row.table)}
                      />
                      <span className="flex flex-col gap-1 min-w-0">
                        <strong className="text-text-primary">
                          {row.table}
                        </strong>
                        <small className="text-text-tertiary text-badge">
                          {row.count} rows · {row.section}
                          {row.supported
                            ? ""
                            : " · not in the current schema, will be skipped"}
                        </small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {inspectError !== null ? (
                <p role="alert" className="text-caption text-red">
                  {inspectError}
                </p>
              ) : null}
            </>
          ) : null}
        </Stack>
      </Dialog>
      <Dialog
        open={passwordFor !== null}
        onClose={closePassword}
        title={
          passwordFor === "delete"
            ? "Confirm deletion"
            : passwordFor === "restore"
              ? "Restore backup"
              : "Download backup"
        }
        description="The console password is checked again before this runs."
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closePassword}>
              Cancel
            </Button>
            <Button
              variant={passwordFor === "delete" ? "danger" : "primary"}
              size="sm"
              loading={
                exportBackup.isPending ||
                restoreBackup.isPending ||
                deleteAllBackup.isPending
              }
              disabled={
                password.length === 0 ||
                exportBackup.isPending ||
                restoreBackup.isPending ||
                deleteAllBackup.isPending
              }
              onClick={() => {
                setTransfer(null);
                if (passwordFor === "download") download();
                else if (passwordFor === "restore") void performRestore();
                else void performDelete();
              }}
            >
              {exportBackup.isPending
                ? transferLabel(transfer, "Downloading…")
                : restoreBackup.isPending
                  ? transferLabel(transfer, "Uploading…")
                  : deleteAllBackup.isPending
                    ? "Working…"
                    : passwordFor === "delete"
                      ? "Delete permanently"
                      : passwordFor === "restore"
                        ? "Restore"
                        : "Download"}
            </Button>
          </>
        }
      >
        <Stack gap="10px">
          {passwordFor === "restore" && restoreError !== null ? (
            <p role="alert" className="text-caption text-red">
              {restoreError}
            </p>
          ) : null}
          <p className="mt-1 text-caption text-text-tertiary">
            {passwordFor === "delete"
              ? "This cannot be undone. The password is verified again before anything is removed."
              : passwordFor === "restore"
                ? "Restore replaces the tenant configuration in this file. Continue only if the file is trusted."
                : "The export is plain JSON and contains provider credentials."}
          </p>
          <Input
            label="Console password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            // `useModalFocus` moves initial focus itself, and it reads
            // `[data-autofocus]` — not React's `autoFocus`, which fires once at
            // mount and is then overridden by the hook's effect. Without this the
            // dialog opened with focus on the panel's first control instead of
            // the one field every one of these three flows needs typed into.
            data-autofocus
          />
        </Stack>
      </Dialog>
    </>
  );
}
