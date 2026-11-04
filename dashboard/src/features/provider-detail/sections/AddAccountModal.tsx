import { useRef, useState, type ReactNode } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button, buttonClass } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import { getErrorMessage } from "../../../data/api";
import {
  useCreateProviderAccount,
  useCreateProviderAccountsBatch,
} from "../../../hooks/providers";
import {
  assignAccountNames,
  chunkCredentials,
  detectCrossChannelCredential,
  jwtExpiresAt,
  MAX_ACCOUNTS_PER_BATCH_REQUEST,
  mergeCredentialFiles,
  parseCredentialBatch,
  type ParsedCredentialEntry,
} from "../../../lib/credentials";
import { toast } from "../../../lib/toast";
import type { CredentialMode, ProviderAccountResponse } from "../../../data/contracts";

/** Cap on an imported credential file; a mis-picked file must not stall the tab. */
const CREDENTIAL_FILE_MAX_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_FILE_MAX_MB = CREDENTIAL_FILE_MAX_BYTES / (1024 * 1024);

export function AddAccountModal({
  providerId,
  accounts,
  onClose,
}: {
  readonly providerId: string;
  readonly accounts: readonly ProviderAccountResponse[];
  readonly onClose: () => void;
}): ReactNode {
  const create = useCreateProviderAccount();
  const createBatch = useCreateProviderAccountsBatch();
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>("auto");
  // The warning is acknowledged once per paste, not once per dialog: changing
  // the credential after acknowledging must ask again, or the operator would
  // confirm a token they never saw the warning for.
  const [crossChannelAckFor, setCrossChannelAckFor] = useState<string | undefined>(undefined);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const entries = parseCredentialBatch(secret);
  const isBatch = entries.length > 1;
  const singleEntry = entries.length === 1 ? entries[0] : undefined;
  const detectedKind = credentialMode === "auto" ? singleEntry?.kind : credentialMode;
  const detectedExpiry =
    singleEntry && detectedKind === "jwt" ? jwtExpiresAt(singleEntry.value) : undefined;
  const crossChannel = entries.length > 0
    ? detectCrossChannelCredential(providerId, secret)
    : undefined;
  const crossChannelPending = crossChannel !== undefined && crossChannelAckFor !== secret;
  const existingNames = accounts.map((account) => account.label);
  const batchNames = isBatch ? assignAccountNames(entries, providerId, existingNames) : [];
  const requestForEntry = (entry: ParsedCredentialEntry) => {
    const mode: CredentialMode =
      credentialMode === "auto" ? (entry.kind === "jwt" ? "jwt" : "auto") : credentialMode;
    return {
      credentialKind: mode === "auto" && entry.kind === "oauth" ? ("oauth" as const) : ("api_key" as const),
      credentialMode: mode,
      secret: entry.value,
    };
  };
  const submitting = create.isPending || batchSubmitting;

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setSecret(text);
      const parsed = parseCredentialBatch(text);
      if (parsed.length > 1) {
        toast.success("Pasted from clipboard", `Detected ${parsed.length} credentials`);
      } else {
        const kind = parsed[0]?.kind ?? "api_key";
        const detectedLabel =
          kind === "oauth" ? "OAuth export" : kind === "jwt" ? "Static JWT" : "API key";
        toast.success("Pasted from clipboard", `Detected: ${detectedLabel}`);
      }
    } catch {
      toast.error("Clipboard access denied");
    }
  };

  /**
   * Reads one or more picked/dropped credential files into the same field the
   * paste path fills.
   *
   * Multiple files are merged first (see `mergeCredentialFiles`), so a JSON
   * array per file stays parseable and every entry survives. The parser then
   * detects, labels, and previews the whole selection through the shared path.
   * Size is capped per file so a mis-picked file cannot freeze the tab.
   */
  const handleFiles = (files: readonly File[]) => {
    if (files.length === 0) return;
    const oversized = files.find((file) => file.size > CREDENTIAL_FILE_MAX_BYTES);
    if (oversized) {
      toast.error(
        "File too large",
        `${oversized.name} is over ${CREDENTIAL_FILE_MAX_MB} MB — credential files must be ${CREDENTIAL_FILE_MAX_MB} MB or smaller.`,
      );
      return;
    }
    const readers = files.map(
      (file) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
          reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
          reader.readAsText(file);
        }),
    );
    Promise.all(readers)
      .then((texts) => {
        const merged = mergeCredentialFiles(
          files.map((file, index) => ({ name: file.name, text: texts[index] ?? "" })),
        );
        if (merged.entries.length === 0) {
          toast.error("Nothing to import", "None of the selected files held a credential the gateway recognises.");
          return;
        }
        setSecret(merged.text);
        toast.success(
          `Imported ${files.length} file${files.length === 1 ? "" : "s"}`,
          merged.entries.length > 1
            ? `Detected ${merged.entries.length} credentials`
            : merged.entries[0]?.kind === "oauth"
              ? "Detected: OAuth export"
              : "Detected: API key",
        );
      })
      .catch((error: unknown) => toast.error("Could not read those files", String(error)));
  };

  const handleSubmit = async () => {
    if (entries.length === 0) return;
    // A cross-channel token must be acknowledged first: submitting is blocked,
    // not merely warned about, because the risk is a ban the operator cannot
    // undo and the warning is the only thing standing between them and it.
    if (crossChannelPending) return;
    if (entries.length === 1) {
      const entry = entries[0] as ParsedCredentialEntry;
      create.mutate(
        {
          providerId,
          request: {
            label: (label.trim() || entry.identity) ?? undefined,
            ...requestForEntry(entry),
          },
        },
        {
          onSuccess: () => {
            toast.success(
              "Account connected",
              `New ${
                entry.kind === "oauth" ? "OAuth" : entry.kind === "jwt" ? "Static JWT" : "API key"
              } account registered successfully`,
            );
            onClose();
          },
          onError: (err) =>
            toast.error(
              "Failed to add account",
              (err as { message?: string }).message ?? "Invalid credentials",
            ),
        },
      );
      return;
    }

    setBatchSubmitting(true);
    try {
      // One request per chunk, not one per account and not one for the whole
      // paste: the server caps a batch at 100 accounts, so a multi-thousand
      // paste sent whole is rejected outright. Each chunk still creates its
      // accounts in a single server-side transaction, so this stays a bounded
      // number of round-trips and one invalidation per chunk.
      const requests = entries.map((entry, index) => ({
        label: batchNames[index],
        ...requestForEntry(entry),
      }));
      const chunks = chunkCredentials(requests);
      const chunkSize = MAX_ACCOUNTS_PER_BATCH_REQUEST;

      let created = 0;
      const failures: string[] = [];
      let aborted = false;
      for (const [chunkIndex, chunk] of chunks.entries()) {
        try {
          const result = await createBatch.mutateAsync({
            providerId,
            accounts: chunk,
          });
          created += result.created;
          const offset = chunkIndex * chunkSize;
          for (const item of result.results) {
            if (item.ok) continue;
            failures.push(
              `${batchNames[offset + item.index] ?? offset + item.index}: ${item.error ?? "rejected"}`,
            );
          }
        } catch (error) {
          // One chunk failing must not silently drop the rest: report how far
          // the import got so the operator knows what is already registered.
          aborted = true;
          failures.push(
            `chunk ${chunkIndex + 1}/${chunks.length}: ${getErrorMessage(error, "request failed")}`,
          );
          break;
        }
      }

      const skipped = failures.length;
      if (created > 0) {
        toast.success(
          `${created} account${created === 1 ? "" : "s"} added`,
          aborted
            ? `stopped partway; ${skipped} failed`
            : skipped > 0
              ? `${skipped} skipped`
              : undefined,
        );
      }
      if (skipped > 0) {
        toast.error(
          `${skipped} account${skipped === 1 ? "" : "s"} skipped`,
          failures.slice(0, 5).join("\n") + (skipped > 5 ? `\n…and ${skipped - 5} more` : ""),
        );
      }
      if (created > 0) onClose();
    } finally {
      setBatchSubmitting(false);
    }
  };

  return (
    <Dialog open={true} onClose={onClose} title="Add Account (API key / JSON)" width={560} footer={
      <>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={submitting || entries.length === 0} onClick={() => void handleSubmit()}>
          {submitting
            ? "Connecting..."
            : crossChannelPending
              ? "Confirm below"
              : isBatch
                ? `Add ${entries.length} Accounts`
                : "Add Account"}
        </Button>
      </>
    }>
      <div
        className="flex flex-col gap-5"
      >
        {!isBatch && (
          <Input
            label="Account label (optional)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={singleEntry?.identity ?? `${providerId} account`}
          />
        )}
        <Select
          label="Credential type"
          id="credential-mode"
          value={credentialMode}
          onValueChange={(value) =>
            setCredentialMode(value === "jwt" || value === "api_key" ? value : "auto")
          }
          options={[
            { value: "auto", label: "Auto — detect JWT, OAuth, or API key" },
            { value: "jwt", label: "JWT — static, no refresh" },
            { value: "api_key", label: "API key — do not decode as JWT" },
          ]}
        />
        <Stack gap="6px" className="min-w-0">
          <div
            className="flex items-center justify-between gap-4"
          >
            <label className="text-caption font-semibold text-text-secondary">
              API key, OAuth token, or exported JSON — one or many
              <span className="font-normal text-text-tertiary">
                {" "}·{" "}also supports <code className="font-mono text-micro">name|credential</code> per line
              </span>
            </label>
            {isBatch ? (
              <Badge tone="accent">Detected: {entries.length} accounts</Badge>
            ) : singleEntry ? (
              <Badge tone={detectedKind === "oauth" || detectedKind === "jwt" ? "accent" : "default"}>
                Detected:{" "}
                {detectedKind === "oauth"
                  ? "OAuth"
                  : detectedKind === "jwt"
                    ? "Static JWT"
                    : "API key"}
                {singleEntry.identity ? ` · ${singleEntry.identity}` : ""}
              </Badge>
            ) : null}
              {singleEntry && detectedKind === "jwt" ? (
                <p className="text-micro text-text-tertiary">
                  Static JWT · no refresh token
                  {detectedExpiry ? ` · expires ${new Date(detectedExpiry).toLocaleString()}` : " · no expiry claim"}
                </p>
              ) : null}
          </div>
          <div
            className="flex flex-col gap-2 rounded-control border-2 border-dashed p-3 transition-colors"
            data-drag-active={dragActive ? "true" : undefined}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              const files = [...event.dataTransfer.files].filter((file) =>
                file.name.endsWith(".json") ||
                file.name.endsWith(".jsonl") ||
                file.name.endsWith(".ndjson") ||
                file.name.endsWith(".txt") ||
                file.type.startsWith("application/json") ||
                file.type.startsWith("text/plain"),
              );
              if (files.length === 0) {
                toast.error("Unsupported file", "Drop .json, .txt, .jsonl, or .ndjson credential files.");
                return;
              }
              handleFiles(files);
            }}
          >
            <textarea
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Paste one credential, or many — one per line, a JSON array, or newline-delimited OAuth exports. Prefix a line with name| to name that account (e.g. onlybougieclan|pt-…). Kind and account naming are detected automatically…"
              rows={6}
              spellCheck={false}
              className="font-mono tabular-nums w-full min-w-0 min-h-65 rounded-control border border-inner-border bg-input-bg px-6 py-5 text-caption text-text-primary resize-y box-border"
            />
            <p className="text-micro text-text-tertiary text-center">
              Or drop credential files here — JSON, .txt, .jsonl, .ndjson — several at once, merged and detected together.
            </p>
          </div>
          {/* Paste and import feed the same field, so they sit under it rather
              than beside it: sharing a row with the textarea stole ~120px of its
              width and left the two actions floating beside a six-row input.
              Right-aligned so the slack collects at the start of the row instead
              of between the field and its actions. */}
          <Inline gap="8px" className="justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handlePaste()}
            >
              Paste
            </Button>
            {/* Same field, same parser — the files only replace typing. Accepts
                the JSON export this dialog produces, plus .txt/.jsonl carrying
                one credential per line. Multiple files are merged. */}
            <label className={buttonClass({ size: "sm", className: "cursor-pointer" })}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.txt,.jsonl,.ndjson,application/json,text/plain"
                multiple
                aria-label="Import credentials from files"
                className="hidden"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (files.length > 0) handleFiles(files);
                }}
              />
              Import files
            </label>
          </Inline>
        </Stack>
        {isBatch && (
          <div
            className="flex flex-col gap-2 max-h-75 overflow-y-auto rounded-control border border-inner-border bg-surface-2 px-4 py-5"
          >
            {entries.map((entry, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <div
                key={index}
                className="flex items-center justify-between gap-4 text-badge"
              >
                <span className="truncate min-w-0">
                  {batchNames[index]}
                </span>
                <Badge tone={entry.kind === "oauth" ? "accent" : "default"}>
                  {entry.kind === "oauth" ? "OAuth" : "API key"}
                </Badge>
              </div>
            ))}
          </div>
        )}
        {/* Interchangeable token warning. Shown before the operator commits,
            because the gateway cannot tell which channel issued a token — only
            the operator knows, and using one outside its channel raises the
            ban risk on an account they may depend on. */}
        {crossChannel && (
          <div
            className="flex flex-col gap-3 rounded-control border border-warning-line bg-surface-2 px-4 py-5"
            role="alert"
          >
            <div className="flex items-start gap-3">
              <span className="inline-flex items-center flex-none px-3.5 py-px border rounded-md bg-surface-2 text-badge tabular-nums border-warning-line text-status-warning">
                Cross-channel credential
              </span>
            </div>
            <p className="text-caption text-text-primary">
              This looks like a {crossChannel.provider} credential.{" "}
              {crossChannel.provider} and {crossChannel.counterpart} tokens are
              interchangeable — one works in the other — but using a token on a
              channel it was not issued for can raise the risk of the account
              being banned, because it appears active somewhere it never
              authenticated. The same applies in reverse.
            </p>
            {crossChannelPending ? (
              <Inline gap="8px" className="justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSecret("");
                    onClose();
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setCrossChannelAckFor(secret)}
                >
                  Add anyway
                </Button>
              </Inline>
            ) : (
              <p className="text-micro text-text-tertiary">
                Acknowledged — you can add this account now.
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
