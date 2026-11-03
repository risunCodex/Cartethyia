import {
  Copy,
  KeyRound,
  Pencil,
  Plus,
  RotateCw,
  Share2,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { Switch } from "./ui/switch";
import { ApiKeyForm, oneTimeSecretForMode, type KeyFormInput } from "./ApiKeyForm";
import { ApiKeySecretDialog } from "./ApiKeySecretDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { regenerateWarning, ShareManagementDialog } from "./ShareManagementDialog";
import { SortableList } from "./SortableList";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import { compactTokens, limitLabel } from "../lib/format/tokens";
import { useClipboard } from "../hooks/use-clipboard";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../hooks/settings";
import { PowerOff } from "lucide-react";
import { AlertTriangle, Eye, ShieldOff } from "lucide-react";
import type { ApiKeyResponse } from "../data/contracts";
import { BannedKeysDialog } from "./BannedKeysDialog";
import {
  useApiKeys,
  useCreateApiKey,
  useRegenerateApiKey,
  useReorderApiKeys,
  useRevealApiKey,
  useRevokeApiKey,
  useUnbanApiKey,
  useUpdateApiKey,
} from "../hooks/api-keys";

/**
 * API-key management panel: access, budgets, usage, and share links.
 *
 * Secrets are never returned by the list endpoint, so the panel shows only the
 * public prefix; a newly created key's secret is revealed exactly once.
 */
export function ApiKeysPanel(): ReactNode {
  const keysQuery = useApiKeys();
  const createKey = useCreateApiKey();
  const updateKey = useUpdateApiKey();
  const revokeKey = useRevokeApiKey();
  const unbanKey = useUnbanApiKey();
  const regenerateKey = useRegenerateApiKey();
  const revealKey = useRevealApiKey();
  const reorderKeys = useReorderApiKeys();
  const { copy } = useClipboard();
  const settings = useRuntimeSettings();
  const updateSettings = useUpdateRuntimeSettings();
  const invokeDisabled = settings.data?.invokeDisabled === true;
  const [invokeConfirmOpen, setInvokeConfirmOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKeyResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyResponse | null>(null);
  const [bansOpen, setBansOpen] = useState(false);
  const [seeReasonTarget, setSeeReasonTarget] = useState<ApiKeyResponse | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKeyResponse | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<ApiKeyResponse | null>(null);
  const [createActions, setCreateActions] = useState<ReactNode>(null);
  const [editActions, setEditActions] = useState<ReactNode>(null);

  const keys = keysQuery.data ?? [];
  // Bans are keyed on the client address, so they are cross-tenant: only a
  // platform admin may see or lift one, and the entry point is hidden for
  // everyone else. The endpoint enforces this too — the gate here is UX.

  const openShare = (key: ApiKeyResponse) => {
    setRevealedSecret(null);
    setShareTarget(key);
  };

  const copyApiKey = async (key: ApiKeyResponse) => {
    try {
      const { secret } = await revealKey.mutateAsync({ keyId: key.id });
      if (await copy(secret)) {
        toast.success("API key copied");
      } else {
        toast.error("Clipboard unavailable on this origin");
      }
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not reveal API key."));
    }
  };

  // A personal key rotates its own credential; a share template has none, so its
  // "rotate" lives in the share dialog (regenerating the link). Only the
  // personal path is offered from the row.
  const rotateWarning = regenerateWarning(true);
  // Global invoke kill switch. This is the tenant-wide "deny all keys"
  // breaker: when invoke is off, every /v1/* request is refused with 503 and
  // nothing upstream is dialed. The toggle is confirm-gated because the off
  // state takes the whole tenant's credentials offline.
  const flipInvoke = (next: boolean) => {
    updateSettings.mutate(
      { invokeDisabled: !next },
      {
        onSuccess: () =>
          toast.success(
            next
              ? "Invoke enabled — routing has resumed."
              : "Invoke disabled — every API key is now refused (503).",
          ),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save the setting"),
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title="API Credentials"
        subtitle="Manage tenant API keys, model access, budgets, and sharing."
        icon={<KeyRound size={16} />}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant={invokeDisabled ? "primary" : "secondary"}
              size="sm"
              loading={settings.isLoading || updateSettings.isPending}
              onClick={() => setInvokeConfirmOpen(true)}
              icon={<PowerOff size={13} />}
            >
              {invokeDisabled ? "Enable Invoke" : "Disable Invoke"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setBansOpen(true)}
              icon={<ShieldOff size={13} />}
            >
              Banned Users
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { setRevealedSecret(null); setCreateOpen(true); }}
              icon={<Plus size={13} />}
            >
              Create Key
            </Button>
          </div>
        }
      />
      <CardBody>
        {keysQuery.isPending && !keysQuery.data ? (
          <LoadingState label="Loading API keys…" />
        ) : keysQuery.isError && !keysQuery.data ? (
          <ErrorState
            message={getErrorMessage(keysQuery.error, "Could not load credentials.")}
            onRetry={() => void keysQuery.refetch()}
          />
        ) : keys.length === 0 ? (
          <EmptyState
            title="No API keys issued"
            message="Generate a secret key to authenticate your SDK or CLI client against the gateway."
            icon={<KeyRound size={20} />}
          />
        ) : (
          // The key list is the tallest thing on the page; bounding it keeps the
          // page chrome in place and scrolls only the rows, like the sidebar.
          <div className="scroll-region max-h-280 pr-1">
          <SortableList
            items={keys}
            label="API credentials"
            disabled={reorderKeys.isPending}
            onReorder={(ids) =>
              reorderKeys.mutate(ids, {
                onError: (error) =>
                  toast.error(getErrorMessage(error, "Could not save the new order.")),
              })
            }
            renderItem={(key) => (
              <div className="api-key-card flex items-start justify-between gap-6 px-6 py-4 rounded-chip border border-inner-border bg-surface-2 max-medium:flex-col max-medium:items-stretch max-medium:gap-4 max-medium:p-5 [&>div:last-child]:flex-wrap">
                <div className="min-w-0 flex-1">
                  <div
                    className="flex items-center gap-4 flex-wrap"
                  >
                    <strong className="text-body">
                      {key.label || "Unnamed credential"}
                    </strong>
                    <Badge tone={key.revokedAt ? "err" : key.bannedAt ? "err" : key.enabled ? "ok" : "warn"}>
                      {key.revokedAt ? "revoked" : key.bannedAt ? "banned" : key.enabled ? "enabled" : "disabled"}
                    </Badge>
                    {key.bannedAt && !key.revokedAt ? (
                      <Badge tone="err" title={key.banReason ?? "Banned"}>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 cursor-pointer bg-transparent border-0 p-0 text-inherit"
                          onClick={() => setSeeReasonTarget(key)}
                        >
                          <Eye size={11} aria-hidden="true" />
                          See reason
                        </button>
                      </Badge>
                    ) : null}
                    <Badge tone={key.keyMode === "share" ? "accent" : "default"}>
                      {key.keyMode === "share" ? "share template" : "personal"}
                    </Badge>
                    {key.isDefault ? (
                      <Badge tone="warn" title="Required by the gateway. Rotate it; it cannot be deleted.">
                        default · rotate only
                      </Badge>
                    ) : null}
                  </div>
                  <div className="api-key-facts flex items-center flex-wrap gap-2 mt-3 min-w-0 max-medium:grid max-medium:grid-cols-3 max-medium:gap-2 max-medium:mt-0">
                    <span className="inline-flex items-center gap-2.5 px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap max-medium:justify-between">
                      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Created</span>
                      {new Date(key.createdAt).toLocaleDateString()}
                    </span>
                    <span className="inline-flex items-center gap-2.5 px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap max-medium:justify-between">
                      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">{key.keyMode === "share" ? "Total usage" : "Usage"}</span>
                      {compactTokens(key.tokensConsumed)}
                    </span>
                    <span className="inline-flex items-center gap-2.5 px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap max-medium:justify-between">
                      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">RPM</span>
                      {limitLabel(key.requestsPerMinute)}
                    </span>
                  </div>
                  <div className="api-key-facts flex items-center flex-wrap gap-2 mt-3 min-w-0 max-medium:grid max-medium:grid-cols-3 max-medium:gap-2 max-medium:mt-0">
                    <span className="inline-flex items-center gap-2.5 px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap max-medium:justify-between">
                      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Daily</span>
                      {limitLabel(key.dailyTokenLimit)}
                    </span>
                    <span className="inline-flex items-center gap-2.5 px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap max-medium:justify-between">
                      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Monthly</span>
                      {limitLabel(key.monthlyTokenLimit)}
                    </span>
                    <span className="inline-flex items-center gap-2.5 px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap max-medium:justify-between">
                      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">One-time</span>
                      {limitLabel(key.lifetimeTokenBudget)}
                    </span>
                    <span className="inline-flex items-center gap-2.5 px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap max-medium:justify-between">
                      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Concurrent</span>
                      {limitLabel(key.maxConcurrentRequests)}
                      {key.keyMode === "share" ? (
                        <span className="font-semibold text-text-tertiary" title={key.concurrencyScope === "per_key" ? "Each recipient key has its own concurrency cap and counter." : "All recipients share one concurrency cap and counter."}>
                          {key.concurrencyScope === "per_key" ? "· per key" : "· family"}
                        </span>
                      ) : null}
                    </span>
                    <span className="inline-flex items-center gap-2.5 px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap max-medium:justify-between">
                      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">{key.modelAccessMode === "blacklist" ? "Blocked" : "Models"}</span>
                      {key.modelAccessMode === "blacklist"
                        ? (key.modelList?.length ?? 0)
                        : key.modelList?.length ? key.modelList.length : "All"}
                    </span>
                  </div>
                </div>
                <div className="flex gap-3 shrink-0 flex-wrap">
                  {!key.revokedAt ? (
                    <Switch
                      checked={key.enabled}
                      disabled={updateKey.isPending}
                      id={`api-key-enabled-${key.id}`}
                      label=""
                      aria-label={`${key.enabled ? "Disable" : "Enable"} ${key.label || "API credential"}`}
                      onChange={(enabled) =>
                        updateKey.mutate(
                          { keyId: key.id, request: { enabled } },
                          {
                            onSuccess: () =>
                              toast.success(
                                `${key.label || "API credential"} ${enabled ? "enabled" : "disabled"}`,
                              ),
                            onError: (error) =>
                              toast.error(getErrorMessage(error, "Could not update credential state.")),
                          },
                        )
                      }
                    />
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Pencil size={13} />}
                    onClick={() => { setRevealedSecret(null); setEditTarget(key); }}
                  >
                    Edit
                  </Button>
                  {!key.revokedAt && key.keyMode !== "share" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Copy size={13} />}
                      onClick={() => void copyApiKey(key)}
                      disabled={revealKey.isPending}
                    >
                      Copy
                    </Button>
                  ) : null}
                  {!key.revokedAt && <Button
                    variant="secondary"
                    size="sm"
                    icon={<Share2 size={13} />}
                    onClick={() => openShare(key)}
                  >
                    {key.keyMode === "share" ? "Recipients" : "Share"}
                  </Button>}
                  {!key.revokedAt && key.keyMode !== "share" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RotateCw size={13} />}
                      onClick={() => { setRevealedSecret(null); setRotateTarget(key); }}
                      disabled={regenerateKey.isPending}
                    >
                      Rotate
                    </Button>
                  )}
                  {!key.revokedAt && !key.isDefault && (
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Trash2 size={13} />}
                      onClick={() => setRevokeTarget(key)}
                      disabled={revokeKey.isPending}
                    >
                      Revoke
                    </Button>
                  )}
                  {key.bannedAt && !key.revokedAt ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<AlertTriangle size={13} />}
                      onClick={() => {
                        unbanKey.mutate(
                          { keyId: key.id },
                          {
                            onSuccess: () => toast.success(`Unbanned ${key.label || key.id}.`),
                            onError: (error) => toast.error(getErrorMessage(error, "Could not unban key.")),
                          },
                        );
                      }}
                      disabled={unbanKey.isPending}
                    >
                      Unban
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          />
          </div>
        )}
      </CardBody>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API Key"
        description="Create a tenant-scoped credential. Choose model access, permissions, limits, and optional blocked client routers."
        size="lg"
        footer={createActions}
      >
        <ApiKeyForm
          mode="create"
          record={null}
          busy={createKey.isPending}
          onClose={() => setCreateOpen(false)}
          actionsRef={setCreateActions}
          onDone={(input: KeyFormInput) => {
            createKey.mutate(input, {
              onSuccess: (res) => {
                setCreateOpen(false);
                setRevealedSecret(oneTimeSecretForMode(input.keyMode, res.secret));
                toast.success("API key created");
              },
              onError: (error) => toast.error(getErrorMessage(error, "Could not create API key.")),
            });
          }}
        />
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Edit API Key"
        description="Update the key's model access, permissions, limits, share notes, and optional public popup."
        size="lg"
        footer={editActions}
      >
        <ApiKeyForm
          mode="edit"
          record={editTarget}
          busy={updateKey.isPending}
          onClose={() => setEditTarget(null)}
          actionsRef={setEditActions}
          onDone={(input: KeyFormInput) => {
            if (!editTarget) return;
            updateKey.mutate(
              { keyId: editTarget.id, request: input },
              {
                onSuccess: (res) => {
                  setEditTarget(null);
                  setRevealedSecret(oneTimeSecretForMode(input.keyMode, res.secret));
                  toast.success("API key updated");
                },
                onError: (error) => toast.error(getErrorMessage(error, "Could not update API key.")),
              },
            );
          }}
        />
      </Dialog>

      {shareTarget ? (
        <ShareManagementDialog
          parent={shareTarget}
          onClose={() => setShareTarget(null)}
          onSecretRevealed={(secret) => {
            // Close the share dialog first: the reveal is its own modal, and a
            // modal must never open on top of another.
            setShareTarget(null);
            setRevealedSecret(secret);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={rotateTarget !== null}
        onClose={() => setRotateTarget(null)}
        onConfirm={async () => {
          if (!rotateTarget) return;
          const result = await regenerateKey.mutateAsync({ keyId: rotateTarget.id });
          setRevealedSecret(result.secret);
          toast.success(`Rotated ${rotateTarget.label || rotateTarget.id}.`);
          setRotateTarget(null);
        }}
        title={rotateWarning.title}
        message={rotateWarning.message}
        confirmLabel={rotateWarning.confirmLabel}
        danger
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={async () => {
          if (!revokeTarget) return;
          await revokeKey.mutateAsync(revokeTarget.id);
          toast.success(`Revoked ${revokeTarget.label || revokeTarget.id}.`);
          setRevokeTarget(null);
        }}
        title="Revoke API key?"
        message={
          revokeTarget
            ? `Revoke ${revokeTarget.label || revokeTarget.id}? Clients using it will be rejected.${revokeTarget.keyMode === "share" ? " All child keys and enrollment links will also be revoked." : ""}`
            : "Revoke this API key?"
        }
        confirmLabel="Revoke"
        danger
      />

      <ConfirmDialog
        open={invokeConfirmOpen}
        onClose={() => setInvokeConfirmOpen(false)}
        onConfirm={async () => {
          flipInvoke(invokeDisabled);
        }}
        title={invokeDisabled ? "Enable Invoke?" : "Disable Invoke?"}
        message={
          invokeDisabled
            ? "Allow this tenant's API keys to invoke /v1/* routes again. Traffic resumes immediately."
            : "Disable invocation for every API key in this tenant? All /v1/* requests will be refused with 503, and nothing upstream is dialed. No keys, accounts, or models are deleted — the dashboard stays reachable so you can re-enable."
        }
        confirmLabel={invokeDisabled ? "Enable Invoke" : "Disable Invoke"}
        danger={!invokeDisabled}
      />

      <ApiKeySecretDialog secret={revealedSecret} onClose={() => setRevealedSecret(null)} />

      {bansOpen ? <BannedKeysDialog onClose={() => setBansOpen(false)} /> : null}

      <Dialog
        open={seeReasonTarget !== null}
        onClose={() => setSeeReasonTarget(null)}
        title="Ban reason"
        size="sm"
        footer={
          <Button variant="secondary" size="sm" onClick={() => setSeeReasonTarget(null)}>
            Close
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-caption text-text-secondary">
            {seeReasonTarget?.label || "API key"} was banned.
          </p>
          <div className="rounded-control border border-warning-line bg-surface-2 px-4 py-5 text-caption text-text-primary">
            {seeReasonTarget?.banReason ?? "No reason recorded."}
          </div>
        </div>
      </Dialog>

    </Card>
  );
}
