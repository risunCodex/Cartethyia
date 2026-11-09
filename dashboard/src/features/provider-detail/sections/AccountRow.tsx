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
import { activeModelCooldowns, lastModelCooldownAt } from "../../../components/AccountCooldown";
import { Button } from "../../../components/ui/button";
import { HealthEventsModal } from "../../../components/HealthEventsModal";
import { ClaimGiftsButton } from "../../../components/ClaimGiftsButton";
import { ClaimQoderCreditsButton } from "../../../components/ClaimQoderCreditsButton";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import {
  formatResetDistance,
  isGrokHeaderQuotaWindow,
  quotaPillSummary,
  quotaWindowState,
} from "../../../lib/format/quota";
import { toast } from "../../../lib/toast";
import { usePoolHealthEvents, usePoolProviderProbe } from "../../../hooks/network";
import { EmptyState, LoadingState, ErrorState } from "../../../components/ui/state";
import type { ProviderAccountResponse } from "../../../data/contracts";
import { AccountStatusBadge } from "./AccountStatusBadge";
import { authMethodPill } from "./account-auth-method";

function credentialExpiryLabel(expiresAt: string | undefined): string | undefined {
  if (expiresAt === undefined) return undefined;
  const timestamp = new Date(expiresAt).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  if (timestamp <= Date.now()) return `Expired ${new Date(expiresAt).toLocaleDateString()}`;
  return formatResetDistance(expiresAt, false);
}

/** Shared balance and model availability, followed by information-only grants. */
function QuotaPill({
  windows,
}: {
  readonly windows: readonly QuotaWindow[] | undefined;
}): ReactNode {
  const all = (windows ?? []).filter((window) => !isGrokHeaderQuotaWindow(window));
  const sessionWindows = all.filter((window) => window.kind === "session_active");
  const summary = quotaPillSummary(all.filter((window) => window.kind !== "session_active"));
  const inactive = all.filter((window) => quotaWindowState(window) !== "current" && window.kind !== "session_active");
  // Live countdown for session-active pills: re-render once a minute so the
  // "Expires in Nh Nm" text tracks wall-clock time without polling the backend.
  const [, setCountdownTick] = useState(0);
  useEffect(() => {
    if (sessionWindows.length === 0) return;
    const id = setInterval(() => setCountdownTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [sessionWindows.length]);
  return (
    <>
      {sessionWindows.map((window, index) => (
        <span
          key={`session-active:${window.modelIds?.join(",") ?? window.label}:${index}`}
          className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap"
          data-tone="accent"
          title={`Session is locked to ${window.modelIds?.join(", ") ?? "this model"} until it expires`}
        >
          <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Session</span>
          {window.modelIds?.join(", ") ?? window.label} · {formatResetDistance(window.resetsAt, false)}
        </span>
      ))}
      {summary.text !== null && (
        <span className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap" data-tone={summary.low ? "warn" : undefined} title={summary.hasCredits ? `${trimNumber(summary.remaining)} credits available` : "Current model grants and account-wide quota limits"}>
          <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Quota</span>
          {summary.text}
        </span>
      )}
      {inactive.map((window, index) => (
        <span key={`${window.kind ?? window.label}:${window.startsAt}:${index}`} className="text-badge text-text-tertiary">
          {window.label}{window.modelIds?.length ? ` · ${window.modelIds.join(", ")}` : ""} · {quotaWindowState(window) === "expired" ? "Expired" : `Not started yet · Starts ${new Date(window.startsAt!).toLocaleString()}`}
        </span>
      ))}
    </>
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
  const poolProbe = usePoolProviderProbe();
  const isPool = account.kind === "pool";
  const poolId = account.networkPoolId;
  const poolHealth = usePoolHealthEvents(isPool ? poolId : undefined);
  const disabled = account.status === "disabled";
  const cooldownUntilMs = account.cooldownUntil ? new Date(account.cooldownUntil).getTime() : NaN;
  const hasActiveCooldown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > Date.now();
  // An account with per-model cooldowns is recoverable too: the account is
  // active for other models, but these entries still exclude the (account,
  // model) pairs through routing. Recover clears every one of them, so the
  // button must appear whenever any per-model backoff is in force — not only
  // when the account-wide status/cooldown says so.
  const hasActiveModelCooldowns = activeModelCooldowns(account) !== undefined;
  // An account carrying a recorded failure category is recoverable even when
  // it is not in an account-wide cooldown: the quota-check path can stamp
  // `rate_limit_transient` without moving status/cooldownUntil, and a stale
  // category would otherwise render "Rate limited" with no way to clear it.
  // `auth_invalidated` is the one category recover cannot fix (a re-login is
  // required), so it stays excluded.
  const hasRecoverableError =
    typeof account.lastErrorCategory === "string" &&
    account.lastErrorCategory.length > 0 &&
    account.lastErrorCategory !== "auth_invalidated";
  const isRecoverable = account.status === "cooldown" || hasActiveCooldown || hasActiveModelCooldowns || hasRecoverableError;
  const [showHistory, setShowHistory] = useState(false);
  const [showPoolHistory, setShowPoolHistory] = useState(false);
  const [editKeyOpen, setEditKeyOpen] = useState(false);
  const [, setTick] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const privacy = useMysteriousAccounts(providerId);
  const shown =
    account.accountEmail ??
    account.accountName ??
    (account.label?.match(/[^\s@]+@[^\s@]+/)?.[0] ?? account.label) ??
    account.id.slice(0, 8);
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
                {isPool ? (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 border border-inner-border rounded-tiny bg-surface-1 text-micro font-bold uppercase tracking-label text-text-secondary"
                    title="Proxy pool routing as an account for this ip-scoped provider"
                  >
                    Pool
                  </span>
                ) : null}
                {(() => {
                  const pill = authMethodPill(account.authMethod);
                  if (pill === null) return null;
                  return (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 border rounded-tiny text-micro font-bold uppercase tracking-label ${
                        pill.tone === "accent"
                          ? "border-accent bg-accent-soft text-accent"
                          : "border-inner-border bg-surface-1 text-text-secondary"
                      }`}
                      title={`Signed in via ${pill.label}`}
                    >
                      {pill.label}
                    </span>
                  );
                })()}
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
          {providerId === "zcode-start" && !isPool && (
            <ClaimGiftsButton accountId={account.id} accountName={label} />
          )}
          {(providerId === "qoder" || providerId === "qodercn") && !isPool && (
            <ClaimQoderCreditsButton accountId={account.id} accountName={label} />
          )}
          {!isPool ? (
            <Button
              size="icon"
              variant="secondary"
              icon={<Activity size={12} />}
              label="Health"
              aria-label={`Health for ${label}`}
              onClick={() => setShowHistory(true)}
              title="View Health & Error History"
            />
          ) : (
            <Button
              size="icon"
              variant="secondary"
              icon={<Activity size={12} />}
              label="Health"
              aria-label={`Health for ${label}`}
              onClick={() => setShowPoolHistory(true)}
              title="View pool health & error history"
            />
          )}
          {!isPool ? (
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
          ) : (
            <Button
              size="icon"
              variant="secondary"
              icon={
                poolProbe.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <FlaskConical size={12} />
                )
              }
              label={poolProbe.isPending ? "Testing…" : "Test"}
              aria-label={`Test ${label}`}
              disabled={poolProbe.isPending || poolId === undefined}
              onClick={() => {
                if (!poolId) return;
                poolProbe.mutate(
                  { poolId, providerId },
                  {
                    onSuccess: (result) => {
                      if (result.status === "allowed") toast.success("Pool probe passed", label);
                      else if (result.status === "blocked") toast.error("Pool blocked", result.reason ?? "Upstream refused this egress");
                      else if (result.status === "throttled") toast.error("Pool rate-limited", result.reason ?? "Address accepted; rate limit spent");
                      else toast.error("Pool unreachable", result.reason ?? "Probe could not complete");
                    },
                    onError: (err) =>
                      toast.error("Pool probe failed", (err as { message?: string }).message ?? "Probe failed"),
                  },
                );
              }}
              title="Probe this pool against the provider"
            />
          )}
          {!isPool ? (
            <Button
              size="icon"
              variant="secondary"
              icon={<KeyRound size={12} />}
              label="Edit key"
              aria-label={`Replace API key for ${label}`}
              onClick={() => setEditKeyOpen(true)}
              title="Replace API key"
            />
          ) : null}
          {!isPool ? (
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
          ) : null}
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
          {!isPool ? (
            <Button
              size="icon"
              variant="danger"
              icon={<Trash2 size={12} />}
              label="Delete"
              aria-label={`Delete ${label}`}
              onClick={() => onDelete(account)}
              title="Delete account"
            />
          ) : null}
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
      {showPoolHistory && (
        <Dialog open title="Pool Health & Error History" onClose={() => setShowPoolHistory(false)} width={640} footer={
          <Button variant="secondary" size="sm" onClick={() => setShowPoolHistory(false)}>
            Close
          </Button>
        }>
          <div className="flex flex-col gap-3 min-h-40">
            {poolHealth.isPending ? (
              <LoadingState label="Loading pool health events…" />
            ) : poolHealth.isError ? (
              <ErrorState
                message="Failed to load pool health events"
                onRetry={() => void poolHealth.refetch()}
              />
            ) : (poolHealth.data ?? []).length === 0 ? (
              <EmptyState compact title="No health events recorded" message="Status transitions, rate limits, and auto-recoveries will appear here." />
            ) : (
              <div className="scroll-region max-h-160 overflow-y-auto pr-1 flex flex-col gap-3">
                {(poolHealth.data ?? []).map((event) => (
                  <div
                    key={event.id}
                    className="rounded-control border border-inner-border bg-surface-2 px-4 py-3 text-badge"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-mono tabular-nums text-micro text-text-tertiary">
                        {new Date(event.createdAt).toLocaleString()}
                      </span>
                      <span className="inline-flex items-center gap-2">
                        <span className="text-text-tertiary text-micro uppercase tracking-label">
                          {event.fromStatus ?? "—"} → {event.toStatus}
                        </span>
                        {event.errorCategory ? (
                          <span className="rounded-pill border border-warning-line bg-surface-2 px-2.5 py-px font-mono text-micro text-status-warning">
                            {event.errorCategory}
                          </span>
                        ) : null}
                      </span>
                    </div>
                    {event.reason ? (
                      <p className="mt-2 text-micro text-text-secondary [overflow-wrap:anywhere] break-words">
                        {event.reason}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
