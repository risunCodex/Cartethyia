import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  FlaskConical,
  KeyRound,
  Loader2,
  LockOpen,
  Pencil,
  PowerOff,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useUpdateProviderAccount } from "../../../hooks/providers";
import { useRecoverAccount } from "../../../hooks/providers";
import { useRefreshAccountQuota, type QuotaWindow } from "../../../hooks/quota";
import { useMysteriousAccounts } from "../../../lib/privacy-mode";
import { lastModelCooldownAt } from "../../../components/AccountCooldown";
import { Button } from "../../../components/ui/button";
import { HealthEventsModal } from "../../../components/HealthEventsModal";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import { formatResetDistance } from "../../../lib/format/quota";
import { toast } from "../../../lib/toast";
import type { ProviderAccountResponse } from "../../../data/contracts";
import { AccountStatusBadge } from "./AccountStatusBadge";

function credentialExpiryLabel(expiresAt: string | undefined): string | undefined {
  if (expiresAt === undefined) return undefined;
  const timestamp = new Date(expiresAt).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  if (timestamp <= Date.now()) return `Expired ${new Date(expiresAt).toLocaleDateString()}`;
  return formatResetDistance(expiresAt, false);
}

/**
 * One chip for pooled credits when available, otherwise the lowest independent
 * quota percent. Sits before the inflight chip so the operator sees allowance
 * before concurrency.
 */
function QuotaPill({
  windows,
}: {
  readonly windows: readonly QuotaWindow[] | undefined;
}): ReactNode {
  if (windows === undefined || windows.length === 0) return null;
  let remaining = 0;
  let total = 0;
  let hasCredits = false;
  let lowestPercent: number | null = null;
  for (const window of windows) {
    const isPooled = window.accounting === "pooled";
    if (!isPooled) {
      if (typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)) {
        lowestPercent =
          lowestPercent === null ? window.remainingPercent : Math.min(lowestPercent, window.remainingPercent);
      }
      continue;
    }
    const limit = typeof window.limit === "number" && Number.isFinite(window.limit) ? window.limit : null;
    const left =
      typeof window.remaining === "number" && Number.isFinite(window.remaining)
        ? window.remaining
        : limit !== null && typeof window.used === "number" && Number.isFinite(window.used)
          ? limit - window.used
          : null;
    if (left !== null && limit !== null) {
      remaining += Math.max(0, left);
      total += limit;
      hasCredits = true;
    }
  }
  let displayText: string | null = null;
  if (hasCredits) {
    displayText = `${trimNumber(remaining)} of ${trimNumber(total)}`;
  } else if (lowestPercent !== null) {
    displayText = `${Math.round(lowestPercent)}% left`;
  }
  if (displayText === null) return null;
  const low = hasCredits
    ? remaining <= 0 || (lowestPercent ?? 100) <= 10
    : (lowestPercent ?? 100) <= 10;
  return (
    <span className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap" data-tone={low ? "warn" : undefined} title={hasCredits ? `${trimNumber(remaining)} credits available of ${trimNumber(total)}` : "Lowest remaining percent across this account's quota windows"}>
      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Quota</span>
      {displayText}
    </span>
  );
}

function trimNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/**
 * Replaces one account's credential in place. Unlike `AddAccountModal` this
 * never creates a row: it PATCHes `{ secret }` onto the existing account, so
 * the account keeps its id, label, usage history, routing preferences, and
 * quota rows. The server re-encrypts, re-fingerprints, clears failure state,
 * and invalidates the credential cache on a secret patch.
 */
function EditAccountKeyModal({
  providerId,
  account,
  onClose,
}: {
  readonly providerId: string;
  readonly account: ProviderAccountResponse;
  readonly onClose: () => void;
}): ReactNode {
  const update = useUpdateProviderAccount();
  const [secret, setSecret] = useState("");
  const shown = account.label || account.id.slice(0, 8);
  const submitting = update.isPending;
  const canSave = secret.trim().length > 0 && !submitting;

  const handlePaste = async () => {
    try {
      setSecret(await navigator.clipboard.readText());
    } catch {
      toast.error("Clipboard access denied");
    }
  };

  const handleSave = () => {
    const next = secret.trim();
    if (!next) return;
    update.mutate(
      { providerId, accountId: account.id, request: { secret: next } },
      {
        onSuccess: () => {
          toast.success("API key replaced", shown);
          onClose();
        },
        onError: (err) => {
          const message = err instanceof Error ? err.message : "Unable to update account";
          toast.error("Failed to replace key", message);
        },
      },
    );
  };

  return (
    <Dialog open={true} onClose={onClose} title={`Replace API key — ${shown}`} width={560} footer={
      <>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!canSave} onClick={handleSave}>
          {submitting ? "Saving…" : "Replace key"}
        </Button>
      </>
    }>
      <div className="flex flex-col gap-5">
        <p className="m-0 text-caption text-text-secondary">
          Paste the new key for this account. The old key stops working immediately;
          the account keeps its label, history, and routing.
        </p>
        <Stack gap="6px" className="min-w-0">
          <label className="text-caption font-semibold text-text-secondary">
            New API key
          </label>
          <textarea
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder="Paste the replacement key…"
            rows={4}
            spellCheck={false}
            autoFocus
            className="font-mono tabular-nums w-full min-w-0 min-h-65 rounded-control border border-inner-border bg-input-bg px-6 py-5 text-caption text-text-primary resize-y box-border"
          />
          <Inline gap="8px" className="justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handlePaste()}
            >
              Paste
            </Button>
          </Inline>
        </Stack>
      </div>
    </Dialog>
  );
}

export function AccountRow({
  providerId,
  account,
  inflight,
  quota,
  selected,
  onToggleSelect,
  onDelete,
}: {
  readonly providerId: string;
  readonly account: ProviderAccountResponse;
  readonly inflight?: number;
  readonly quota?: readonly QuotaWindow[];
  readonly selected: boolean;
  readonly onToggleSelect: (accountId: string, next: boolean) => void;
  readonly onDelete: (account: ProviderAccountResponse) => void;
}): ReactNode {
  const update = useUpdateProviderAccount();
  const recover = useRecoverAccount();
  const testQuota = useRefreshAccountQuota(account.id);
  const disabled = account.status === "disabled";
  const cooldownUntilMs = account.cooldownUntil ? new Date(account.cooldownUntil).getTime() : NaN;
  const hasActiveCooldown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > Date.now();
  const isRecoverable = account.status === "cooldown" || hasActiveCooldown;
  const [showHistory, setShowHistory] = useState(false);
  const [editKeyOpen, setEditKeyOpen] = useState(false);
  const [, setTick] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const privacy = useMysteriousAccounts(providerId);
  const shown = (account.label?.match(/[^\s@]+@[^\s@]+/)?.[0] ?? account.label) || account.id.slice(0, 8);
  const label = privacy.enabled ? "Mysterious accounts" : shown;
  const expiryLabel = credentialExpiryLabel(account.tokenExpiresAt);
  // The countdown re-renders on a timer. It must be armed by the per-model
  // backoffs too, not only by `cooldownUntil`: a model-scoped 429 writes
  // `modelCooldowns` and deliberately leaves `cooldownUntil` untouched (the
  // account stays routable for every other model), so keying the timer on
  // `cooldownUntil` alone left a per-model badge that never counted down.
  const lastModelCooldownAtValue = lastModelCooldownAt(account);
  const countdownTarget = Math.max(
    hasActiveCooldown && account.cooldownUntil ? cooldownUntilMs : 0,
    lastModelCooldownAtValue ?? 0,
  );
  useEffect(() => {
    if (countdownTarget <= Date.now()) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [countdownTarget]);

  const saveLabel = () => {
    const next = draftLabel.trim();
    setRenaming(false);
    if (!next || next === (account.label ?? "")) return;
    update.mutate(
      { providerId, accountId: account.id, request: { label: next } },
      {
        onSuccess: () => toast.success("Account renamed", next),
        onError: (err) =>
          toast.error(
            "Rename failed",
            (err as { message?: string }).message ?? "Unable to rename account",
          ),
      },
    );
  };
  const toggleEnabled = () => {
    const nextActive = disabled;
    update.mutate(
      {
        providerId,
        accountId: account.id,
        request: { status: nextActive ? "active" : "disabled" },
      },
      {
        onSuccess: () =>
          toast.success(nextActive ? "Account enabled" : "Account disabled", label),
        onError: (err) =>
          toast.error(
            "Update failed",
            (err as { message?: string }).message ?? "Unable to update account",
          ),
      },
    );
  };


  const handleTest = () => {
    testQuota.mutate(undefined, {
      onSuccess: (result) => {
        if (result?.ok) toast.success("Account test passed", label);
        else toast.error("Account test failed", result?.message ?? "Provider reported an error");
      },
      onError: (err) =>
        toast.error(
          "Account test failed",
          (err as { message?: string }).message ?? "Unable to test account",
        ),
    });
  };

  return (
    <>
      <div
        className={`account-row account-row-grid grid items-center gap-5 px-5 py-4 border rounded-control bg-surface-2 ${selected ? "border-accent" : "border-inner-border"} hover:bg-hover`}
        role="listitem"
        data-selected={selected ? "true" : undefined}
        style={{ opacity: disabled ? 0.62 : 1 }}
      >
        <div className="flex items-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onToggleSelect(account.id, event.target.checked)}
            aria-label={`Select ${label}`}
            className="cursor-pointer"
          />
        </div>

        <div className="min-w-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-3 min-w-0">
            {renaming ? (
              <Input
                value={draftLabel}
                onChange={(event) => setDraftLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveLabel();
                  if (event.key === "Escape") setRenaming(false);
                }}
                onBlur={saveLabel}
                autoFocus
                aria-label="Account label"
                className="text-body max-w-120"
              />
            ) : (
              <>
                <span className="text-body font-semibold text-text-primary min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={account.label || account.id}>
                  {label}
                </span>
                <button
                  type="button"
                  className="shrink-0 grid place-items-center w-10 h-10 p-0 border-0 bg-transparent text-text-tertiary cursor-pointer rounded-tiny hover:bg-inner-border hover:text-text-primary"
                  title="Rename account"
                  aria-label={`Rename ${label}`}
                  onClick={() => {
                    setDraftLabel(account.label ?? "");
                    setRenaming(true);
                  }}
                >
                  <Pencil size={11} />
                </button>
              </>
            )}
          </div>
          <div className="flex items-center flex-nowrap gap-2 min-w-0 overflow-hidden">
            <AccountStatusBadge account={account} />
            {expiryLabel ? (
              <span
                className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap"
                title={expiryLabel}
              >
                {expiryLabel}
              </span>
            ) : null}
          </div>
          <div className="flex items-center flex-wrap gap-2 min-w-0">
            <span className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap" title={`Today: ${account.usageToday.totalTokens.toLocaleString()} tokens, ${account.usageToday.requests.toLocaleString()} requests`}>
              <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Today</span>
              {account.usageToday.totalTokens.toLocaleString()} tok · {account.usageToday.requests.toLocaleString()} req
            </span>
            <span
              className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap"
              title="Lifetime totals are backfilled from telemetry still retained when tracking starts; new totals survive telemetry cleanup."
            >
              <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">All time</span>
              {account.usageAllTime.totalTokens.toLocaleString()} tok · {account.usageAllTime.requests.toLocaleString()} req
            </span>
            <QuotaPill windows={quota} />
            <span
              className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap"
              title="Concurrency comes from this provider’s Routing Strategy; accounts carry no manual ceilings."
            >
              <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">In flight</span>
              {inflight?.toLocaleString() ?? "—"}
            </span>
          </div>
        </div>

        <div className="account-row-actions flex items-center justify-end gap-3 flex-wrap">
          <Button
            size="icon"
            variant="secondary"
            icon={<Activity size={12} />}
            label="Health"
            aria-label={`Health for ${label}`}
            onClick={() => setShowHistory(true)}
            title="View Health & Error History"
          />
          <Button
            size="icon"
            variant="secondary"
            icon={
              testQuota.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <FlaskConical size={12} />
              )
            }
            label={testQuota.isPending ? "Testing…" : "Test"}
            aria-label={`Test ${label}`}
            disabled={testQuota.isPending}
            onClick={handleTest}
            title="Refresh quota and health for this account"
          />
          <Button
            size="icon"
            variant="secondary"
            icon={<KeyRound size={12} />}
            label="Edit key"
            aria-label={`Replace API key for ${label}`}
            onClick={() => setEditKeyOpen(true)}
            title="Replace API key"
          />
          <Button
            size="icon"
            variant="secondary"
            icon={disabled ? <LockOpen size={12} /> : <PowerOff size={12} />}
            label={disabled ? "Enable" : "Disable"}
            aria-label={disabled ? `Enable ${label}` : `Disable ${label}`}
            disabled={update.isPending}
            onClick={toggleEnabled}
            title={disabled ? "Enable account" : "Disable account"}
          />
          {isRecoverable ? (
            <Button
              size="icon"
              variant="secondary"
              icon={<RotateCcw size={12} className={recover.isPending ? "animate-spin" : ""} />}
              label={recover.isPending ? "Recovering…" : "Recover"}
              aria-label={`Recover ${label}`}
              disabled={recover.isPending}
              onClick={() => recover.mutate({ providerId, accountId: account.id })}
              title="Clear cooldown / restore active status"
            />
          ) : null}
          <Button
            size="icon"
            variant="danger"
            icon={<Trash2 size={12} />}
            label="Delete"
            aria-label={`Delete ${label}`}
            onClick={() => onDelete(account)}
            title="Delete account"
          />
        </div>
      </div>
      {showHistory && (
        <HealthEventsModal
          summary={{
            providerId,
            accountId: account.id,
            title: account.label || account.id.slice(0, 8),
            status: account.status,
            errorCategory: account.lastErrorCategory ?? undefined,
            errorMessage: account.lastError ?? undefined,
            emptyMessage: "Status transitions, rate limits, and auto-recoveries will appear here.",
            staticToken: account.staticToken === true,
            credentialKind: account.credentialKind,
            credentialMode: account.credentialMode,
            jwtIssuer: account.jwtIssuer,
          }}
          onClose={() => setShowHistory(false)}
        />
      )}
      {editKeyOpen && (
        <EditAccountKeyModal
          providerId={providerId}
          account={account}
          onClose={() => setEditKeyOpen(false)}
        />
      )}
    </>
  );
}
