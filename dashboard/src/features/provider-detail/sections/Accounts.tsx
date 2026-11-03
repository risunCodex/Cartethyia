import {
  Download,
  FlaskConical,
  LockOpen,
  PowerOff,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { consoleRequest } from "../../../data/api";
import { mapWithConcurrency } from "../../../lib/concurrency";
import { Button } from "../../../components/ui/button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { Stack } from "../../../components/ui/stack";
import { EmptyState } from "../../../components/ui/state";
import {
  useExportProviderAccounts,
  useRecoverAccount,
  useUpdateProviderAccount,
} from "../../../hooks/providers";
import { useProviderAccountInflight } from "../../../hooks/routing";
import { useQuotaOverview, type AccountTestResult, type QuotaWindow } from "../../../hooks/quota";
import { queryKeys } from "../../../data/query-keys";
import { downloadTextFile } from "../../../lib/download";
import { toast } from "../../../lib/toast";
import type { ProviderAccountResponse } from "../../../data/contracts";
import { AccountRow } from "./AccountRow";
export { AccountStatusBadge } from "./AccountStatusBadge";
export { AddAccountModal } from "./AddAccountModal";

function accountStatusRank(status: string): number {
  if (status === "active") return 0;
  if (status === "cooldown") return 2;
  return 3;
}
type AccountSortKey = "added" | "label" | "status" | "lastCheck";
type AccountSortValue = `${AccountSortKey}-${"asc" | "desc"}`;

const ACCOUNT_SORT_OPTIONS: ReadonlyArray<{ value: AccountSortValue; label: string }> = [
  { value: "added-asc", label: "Added · oldest" },
  { value: "added-desc", label: "Added · newest" },
  { value: "label-asc", label: "Name · A–Z" },
  { value: "label-desc", label: "Name · Z–A" },
  { value: "status-asc", label: "Status · active first" },
  { value: "status-desc", label: "Status · disabled first" },
  { value: "lastCheck-desc", label: "Last check · newest" },
  { value: "lastCheck-asc", label: "Last check · oldest" },
];

function compareAccounts(
  a: ProviderAccountResponse,
  b: ProviderAccountResponse,
  key: AccountSortKey,
): number {
  const stableTie = (left: ProviderAccountResponse, right: ProviderAccountResponse): number =>
    (left.label || left.id).localeCompare(right.label || right.id) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id);
  if (key === "added") {
    // The server's stable list position; falls back to creation order for
    // payloads that predate the index.
    return (
      a.sortIndex - b.sortIndex ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
    );
  }
  if (key === "label") return stableTie(a, b);
  if (key === "status") {
    const rank = accountStatusRank(a.status) - accountStatusRank(b.status);
    return rank !== 0 ? rank : stableTie(a, b);
  }
  const at = new Date(a.lastSuccessAt ?? a.createdAt).getTime();
  const bt = new Date(b.lastSuccessAt ?? b.createdAt).getTime();
  return bt - at || stableTie(a, b);
}
export function AccountsList({
  providerId,
  accounts,
  onDelete,
  showGrokProbe = false,
  grokProbePending = false,
  onGrokProbe,
}: {
  readonly providerId: string;
  readonly accounts: readonly ProviderAccountResponse[];
  readonly onDelete: (account: ProviderAccountResponse) => void;
  readonly showGrokProbe?: boolean;
  readonly grokProbePending?: boolean;
  readonly onGrokProbe?: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const update = useUpdateProviderAccount();
  const recover = useRecoverAccount();
  const exportAccounts = useExportProviderAccounts();
  const inflightQuery = useProviderAccountInflight(providerId);
  const inflightByAccount = inflightQuery.data ?? new Map<string, number>();
  const quotaQuery = useQuotaOverview();
  const quotaByAccount = useMemo(() => {
    const map = new Map<string, readonly QuotaWindow[]>();
    for (const entry of quotaQuery.data?.accounts ?? []) {
      if (entry.provider === providerId && entry.quota) map.set(entry.id, entry.quota.windows);
    }
    return map;
  }, [quotaQuery.data, providerId]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<AccountSortValue>("added-asc");
  const [bulkBusy, setBulkBusy] = useState(false);
  /**
   * "Test all" progress, as tested-of-total.
   *
   * The button shows only the count while running — no pass/fail. Per-account
   * verdicts already arrive as toasts and land in the health log, so a
   * running tally on the button would duplicate them and, worse, read as a
   * verdict while the run is still in flight.
   */
  const [testAllProgress, setTestAllProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalizedQuery) return accounts;
    return accounts.filter((account) => {
      const haystack = `${account.label ?? ""} ${account.id} ${account.credentialKind} ${account.status}`.toLowerCase();
      return normalizedQuery.split(/\s+/).every((token) => haystack.includes(token));
    });
  }, [accounts, normalizedQuery]);

  const sorted = useMemo(() => {
    const key = sort.slice(0, sort.lastIndexOf("-")) as AccountSortKey;
    const direction = sort.endsWith("-desc") ? -1 : 1;
    const copy = [...filtered];
    copy.sort((a, b) => direction * compareAccounts(a, b, key));
    return copy;
  }, [filtered, sort]);

  const selectedAccounts = useMemo(
    () => accounts.filter((account) => account.kind !== "pool" && selected.has(account.id)),
    [accounts, selected],
  );
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((account) => selected.has(account.id));
  // Enable and Disable only appear when the selection actually has an account
  // in the other state. Recover stays available either way: a cooldown can sit
  // on a model while the account itself still reads as active.
  const selectionHasDisabled = selectedAccounts.some((account) => account.status === "disabled");
  const selectionHasEnabled = selectedAccounts.some((account) => account.status !== "disabled");
  const nothingSelected = selectedAccounts.length === 0;

  const toggleSelect = (accountId: string, next: boolean) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(accountId);
      else copy.delete(accountId);
      return copy;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (allFilteredSelected) {
        for (const account of filtered) copy.delete(account.id);
      } else {
        for (const account of filtered) {
          if (account.kind !== "pool") copy.add(account.id);
        }
      }
      return copy;
    });
  };

  const runBulk = async (label: string, fn: (account: ProviderAccountResponse) => Promise<unknown>) => {
    if (selectedAccounts.length === 0) return;
    setBulkBusy(true);
    const results = await mapWithConcurrency(selectedAccounts, TEST_ALL_CONCURRENCY, fn);
    const failed = results.filter((result) => result.status === "rejected").length;
    const ok = results.length - failed;
    setBulkBusy(false);
    if (failed === 0) {
      toast.success(`${label} complete`, `${ok} account${ok === 1 ? "" : "s"}`);
    } else {
      toast.error(`${label} partially failed`, `${ok} succeeded, ${failed} failed`);
    }
  };

  const bulkRecover = () =>
    runBulk("Recover", (account) =>
      recover.mutateAsync({ providerId, accountId: account.id }),
    );

/**
 * Accounts tested at once by "Test all".
 *
 * One at a time is slow across a large provider; all at once is a burst the
 * provider's own quota endpoint rate-limits, which failed accounts that pass
 * individually.
 */
const TEST_ALL_CONCURRENCY = 3;

  /**
   * Tests every account, independent of the current selection or filter.
   *
   * Reports progress as a count, not a verdict: a failed test is a 200 with
   * `ok: false`, and each account's own outcome is already surfaced by the
   * per-account toast and recorded in the health log. The button therefore
   * tracks how far the run has got and nothing about how it went.
   */
  const testAllAccounts = async () => {
    const realAccounts = accounts.filter((account) => account.kind !== "pool");
    if (realAccounts.length === 0) return;
    setBulkBusy(true);
    setTestAllProgress({ done: 0, total: realAccounts.length });
    await mapWithConcurrency(realAccounts, TEST_ALL_CONCURRENCY, async (account, index) => {
      const result = await consoleRequest<AccountTestResult>(
        `/accounts/${encodeURIComponent(account.id)}/quota/refresh`,
        { method: "POST" },
      );
      // Counted as each one settles, so the button tracks the run instead of
      // jumping from 0 to done at the end.
      setTestAllProgress({ done: index + 1, total: accounts.length });
      return result;
    });
    // Nothing reads `results`: each account's own outcome is surfaced per
    // account, and a running pass/fail tally here would both duplicate that
    // and read as a verdict while accounts are still in flight.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
    ]);
    setBulkBusy(false);
    setTestAllProgress(null);
    // Count only: the per-account verdicts are toasts and health-log entries,
    // so a summary here would restate them and read as a verdict of its own.
    toast.success("Test complete", `${realAccounts.length} account${realAccounts.length === 1 ? "" : "s"} tested`);
  };

  const bulkSetActive = (active: boolean) =>
    runBulk(active ? "Enable" : "Disable", (account) =>
      update.mutateAsync({
        providerId,
        accountId: account.id,
        request: { status: active ? "active" : "disabled" },
      }),
    );

  const bulkExport = async () => {
    if (selectedAccounts.length === 0) return;
    setBulkBusy(true);
    try {
      const body = await exportAccounts.mutateAsync({
        providerId,
        accountIds: selectedAccounts.map((account) => account.id),
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadTextFile(
        `${providerId}-accounts-${stamp}.json`,
        JSON.stringify(body, null, 2),
        "application/json",
      );
      toast.success(
        "Accounts exported",
        `${body.accounts.length} account${body.accounts.length === 1 ? "" : "s"} — contains plaintext credentials`,
      );
    } catch (err) {
      toast.error(
        "Export failed",
        (err as { message?: string }).message ?? "Unable to export accounts",
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    await runBulk("Delete", async (account) => {
      // Shared accounts carry `tenant_id IS NULL` and live under the
      // global-admin route; the tenant-scoped path can never match them.
      const path =
        account.tenantId === null
          ? `/global/accounts/${encodeURIComponent(account.id)}`
          : `/accounts/${encodeURIComponent(account.id)}`;
      await consoleRequest(path, { method: "DELETE" });
      queryClient.removeQueries({ queryKey: queryKeys.quota.account(account.id), exact: true });
    });
    setSelected(new Set());
    setBulkDeleteOpen(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(providerId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
    ]);
  };

  return (
    <Stack gap="8px">
      {/* Flat toolbar: every action is a persistent button that greys out when
          it does not apply, instead of hiding behind a dropdown. A control that
          appears only once you have selected accounts hides what the toolbar
          can do, and moves the remaining buttons sideways every time the
          selection changes.
          One row: compact search on the left, bulk actions right after it in a
          stable order, and sort/select pinned to the right edge. On narrow
          viewports the search takes the full width and everything wraps
          naturally, so no space is left empty on either side. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2 p-3 border border-inner-border rounded-control bg-surface-2">
        <label className="relative w-full min-medium:w-56 shrink-0">
          <Search
            size={13}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <Input
            id="accounts-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search accounts..."
            aria-label="Search accounts"
            className="pl-9 h-15 py-0"
          />
        </label>
        <Button
          size="sm"
          variant="primary"
          icon={<FlaskConical size={12} />}
          disabled={bulkBusy || accounts.length === 0}
          onClick={testAllAccounts}
          aria-label={
            testAllProgress === null
              ? "Test all accounts"
              : `Testing accounts, ${testAllProgress.done} of ${testAllProgress.total} tested`
          }
          title="Test every account, regardless of selection or filters"
        >
          {testAllProgress === null
            ? "Test all"
            : `Tested ${testAllProgress.done}/${testAllProgress.total}`}
        </Button>
        {/* Selection-scoped actions. Each stays mounted and greys out when it
            does not apply — `nothingSelected` and `bulkBusy` disable, they do
            not remove — so the toolbar's shape never depends on what happens
            to be selected. */}
        <Button
          size="sm"
          variant="secondary"
          icon={<RotateCcw size={12} />}
          disabled={bulkBusy || nothingSelected}
          title={
            nothingSelected
              ? "Select at least one account to recover it"
              : "Clear cooldowns and retry-wait states on the selected accounts"
          }
          onClick={() => void bulkRecover()}
        >
          Recover
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<LockOpen size={12} />}
          disabled={bulkBusy || !selectionHasDisabled}
          title={
            nothingSelected
              ? "Select at least one disabled account to enable it"
              : selectionHasDisabled
                ? "Enable the selected accounts"
                : "No selected account is currently disabled"
          }
          onClick={() => void bulkSetActive(true)}
        >
          Enable
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<PowerOff size={12} />}
          disabled={bulkBusy || !selectionHasEnabled}
          title={
            nothingSelected
              ? "Select at least one enabled account to disable it"
              : selectionHasEnabled
                ? "Disable the selected accounts"
                : "No selected account is currently enabled"
          }
          onClick={() => void bulkSetActive(false)}
        >
          Disable
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<Download size={12} />}
          disabled={bulkBusy || nothingSelected}
          title={
            nothingSelected
              ? "Select at least one account to export"
              : "Download the selected accounts as JSON"
          }
          onClick={() => void bulkExport()}
        >
          Export
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={12} />}
          disabled={bulkBusy || nothingSelected}
          title={
            nothingSelected
              ? "Select at least one account to delete"
              : `Delete ${selectedAccounts.length} selected account${selectedAccounts.length === 1 ? "" : "s"}`
          }
          onClick={() => setBulkDeleteOpen(true)}
        >
          Delete
        </Button>
        {/* Grok-only: the 407 streaming probe is meaningless on any other
            provider, so it is not merely greyed out elsewhere — it is absent.
            The actions above stay mounted because they are always meaningful
            operations that only need a selection; this one is not an
            operation a non-Grok provider has at all. */}
        {showGrokProbe ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<FlaskConical size={12} className={grokProbePending ? "animate-spin" : ""} />}
            disabled={grokProbePending || accounts.length === 0}
            onClick={onGrokProbe}
            title="Probe every Grok account with the live 407 streaming request"
          >
            {grokProbePending ? "Testing…" : "Test 407"}
          </Button>
        ) : null}
        <label className="inline-flex h-15 shrink-0 items-center gap-2 text-caption font-semibold text-text-secondary ml-auto max-small:ml-0 [&_.radix-select-trigger]:font-semibold [&_.radix-select-trigger]:bg-hover [&_.radix-select-trigger]:text-text-primary">
          <Select
            size="sm"
            value={sort}
            onValueChange={(value) => setSort(value as AccountSortValue)}
            options={ACCOUNT_SORT_OPTIONS}
            aria-label="Sort accounts by"
          />
        </label>
        <label className="inline-flex h-15 shrink-0 items-center gap-2 text-caption font-semibold text-text-secondary">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={toggleSelectAll}
            aria-label="Select accounts"
          />
          <span>Select</span>
        </label>
        {/* The selection count doubles as the clear affordance, so clearing
            does not cost a toolbar slot on every row width. */}
        {nothingSelected ? null : (
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="inline-flex h-15 shrink-0 items-center gap-1 rounded-control border border-inner-border px-3 text-badge font-semibold text-text-secondary hover:bg-hover"
            title="Clear selection"
          >
            {selectedAccounts.length} selected
            <X size={11} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="account-list flex flex-col gap-3 max-h-230 overflow-y-auto pr-1 [container-type:inline-size] [container-name:account-list]" role="list" aria-label="Provider accounts">
        {/* Say why nothing matched in the space the rows would have occupied,
            rather than leaving only the footer counter to explain it. */}
        {sorted.length === 0 ? (
          <EmptyState
            compact
            icon={<Search size={20} />}
            title="No matching accounts"
            message={
              normalizedQuery
                ? `Nothing matches “${normalizedQuery}”. Clear the filter to see all ${accounts.length} account${accounts.length === 1 ? "" : "s"}.`
                : "This provider has no accounts yet."
            }
          />
        ) : sorted.map((account) => (
          <AccountRow
            key={account.id}
            providerId={providerId}
            account={account}
            inflight={inflightByAccount.get(account.id) ?? account.inflight}
            quota={quotaByAccount.get(account.id)}
            selected={selected.has(account.id)}
            onToggleSelect={toggleSelect}
            onDelete={onDelete}
          />
        ))}
      </div>
      <div
        className="flex items-center justify-between text-badge text-text-tertiary"
      >
        <span>
          Showing {filtered.length} account{filtered.length === 1 ? "" : "s"}
          {normalizedQuery ? ` (filtered from ${accounts.length})` : ""}
        </span>
      </div>

      <ConfirmDialog
        open={bulkDeleteOpen}
        onClose={() => {
          if (!bulkBusy) setBulkDeleteOpen(false);
        }}
        onConfirm={bulkDelete}
        title={`Delete ${selectedAccounts.length} account${selectedAccounts.length === 1 ? "" : "s"}?`}
        message="This permanently removes the selected accounts and their credentials. This cannot be undone."
        confirmLabel="Delete"
        danger
      />
    </Stack>
  );
}
