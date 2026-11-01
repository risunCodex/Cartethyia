import { ShieldOff, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { DataTable } from "./ui/layout";
import { Inline } from "./ui/inline";
import { EmptyState } from "./ui/state";
import { ConfirmDialog } from "./ConfirmDialog";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import type { ApiKeyResponse } from "../data/contracts";
import { useUnbanApiKey } from "../hooks/api-keys";

/**
 * The banned API-key list, opened from the API Credentials header.
 *
 * Lists every key with an active ban (banned_at set and, for a timed ban,
 * banned_until still in the future). A timed ban lapses on its own; Unban
 * lifts one early — the escape hatch for a mistaken ban.
 */
function lapseLabel(key: ApiKeyResponse): string {
  if (!key.bannedUntil) return "Permanent — lift manually";
  const expiresAt = new Date(key.bannedUntil).getTime();
  if (!Number.isFinite(expiresAt)) return "—";
  const remaining = expiresAt - Date.now();
  const absolute = new Date(key.bannedUntil).toLocaleString();
  if (remaining <= 0) return `${absolute} (lapsed)`;
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${absolute} (in ${totalMinutes}m)`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${absolute} (in ${hours}h)`;
  return `${absolute} (in ${Math.floor(hours / 24)}d)`;
}

export function BannedKeysDialog({
  keys,
  onClose,
}: {
  readonly keys: readonly ApiKeyResponse[];
  readonly onClose: () => void;
}): ReactNode {
  const unban = useUnbanApiKey();
  const [unbanTarget, setUnbanTarget] = useState<ApiKeyResponse | null>(null);
  const now = Date.now();
  const bans = keys.filter((key) => {
    if (!key.bannedAt) return false;
    if (!key.bannedUntil) return true;
    return new Date(key.bannedUntil).getTime() > now;
  });

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title="Banned Users"
        description="API keys that have been banned. A timed ban lapses on its own; lifting one early is the escape hatch for a mistake."
        size="lg"
      >
        <div className="flex flex-col gap-7 min-w-0">
          <div className="min-w-0">
            <h4 className="text-caption font-semibold text-text-secondary mb-4">
              Active bans ({bans.length})
            </h4>
            {bans.length === 0 ? (
              <EmptyState
                compact
                title="No banned keys"
                message="No API key is currently banned."
                icon={<ShieldOff size={20} />}
              />
            ) : (
              <div className="rounded-inset border border-inner-border">
                <DataTable
                  maxHeight={480}
                  scrollRegion
                  headers={["API key", "Reason", "Lapses", ""]}
                >
                  {bans.map((key) => (
                    <tr key={key.id}>
                      <td className="font-mono tabular-nums text-badge text-text-primary whitespace-nowrap">
                        {key.label || key.id.slice(0, 8)}
                      </td>
                      <td className="text-badge text-text-secondary">
                        {key.banReason ?? "—"}
                      </td>
                      <td className="text-badge text-text-secondary whitespace-nowrap">
                        {lapseLabel(key)}
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Undo2 size={13} />}
                          disabled={unban.isPending}
                          onClick={() => setUnbanTarget(key)}
                        >
                          Unban
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              </div>
            )}
          </div>

          <Inline justify="flex-end" gap="0px">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </Inline>
        </div>
      </Dialog>

      <ConfirmDialog
        open={unbanTarget !== null}
        onClose={() => setUnbanTarget(null)}
        onConfirm={async () => {
          if (!unbanTarget) return;
          try {
            await unban.mutateAsync({ keyId: unbanTarget.id });
            toast.success(`Unbanned ${unbanTarget.label || unbanTarget.id.slice(0, 8)}.`);
            setUnbanTarget(null);
          } catch (error) {
            toast.error(getErrorMessage(error, "Could not unban key."));
          }
        }}
        title="Lift this ban?"
        message={`Lift the ban on ${unbanTarget?.label || "this key"}? The caller can reach the gateway again immediately.`}
        confirmLabel="Unban"
        danger
      />
    </>
  );
}
