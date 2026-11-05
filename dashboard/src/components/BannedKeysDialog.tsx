import { ShieldOff, Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { DataTable } from "./ui/layout";
import { Inline } from "./ui/inline";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { ConfirmDialog } from "./ConfirmDialog";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import type { ApiKeyResponse } from "../data/contracts";
import { API_KEY_BAN_REASONS } from "../data/contracts";
import { BAN_DURATION_CHOICES, DEFAULT_BAN_CHOICE } from "../lib/ban-durations";
import { useApiKeys, useBanApiKey, useBannedApiKeys, useUnbanApiKey } from "../hooks/api-keys";
import { useBanIp, useIpBans, useUnbanIp } from "../hooks/ip-bans";

/**
 * A "Banned Users" modal: manual API-key bans (with search) and manual IP bans.
 *
 * API keys: search by label/prefix and ban a row directly, or list active bans
 * and lift them. IP bans: ban an address by hand with a duration, list active
 * bans, and unban.
 */
function lapseLabel(bannedUntil: string | null): string {
  if (!bannedUntil) return "Permanent — lift manually";
  const expiresAt = new Date(bannedUntil).getTime();
  if (!Number.isFinite(expiresAt)) return "—";
  const remaining = expiresAt - Date.now();
  const absolute = new Date(bannedUntil).toLocaleString();
  if (remaining <= 0) return `${absolute} (lapsed)`;
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${absolute} (in ${totalMinutes}m)`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${absolute} (in ${hours}h)`;
  return `${absolute} (in ${Math.floor(hours / 24)}d)`;
}

type Tab = "keys" | "ips";

export function BannedKeysDialog({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [tab, setTab] = useState<Tab>("keys");
  const [search, setSearch] = useState("");
  const [banTarget, setBanTarget] = useState<ApiKeyResponse | null>(null);
  const [banReason, setBanReason] = useState<string>(API_KEY_BAN_REASONS[0]!.value);
  const [banMinutes, setBanMinutes] = useState<string>(String(DEFAULT_BAN_CHOICE.minutes ?? ""));
  const [unbanTarget, setUnbanTarget] = useState<ApiKeyResponse | null>(null);
  const [ipInput, setIpInput] = useState("");
  const [ipMinutes, setIpMinutes] = useState<string>(String(DEFAULT_BAN_CHOICE.minutes ?? ""));
  const [unbanIpTarget, setUnbanIpTarget] = useState<string | null>(null);

  const keysQuery = useApiKeys();
  const bannedQuery = useBannedApiKeys();
  const ban = useBanApiKey();
  const unban = useUnbanApiKey();

  const ipBansQuery = useIpBans();
  const banIp = useBanIp();
  const unbanIp = useUnbanIp();

  const now = Date.now();
  const bans = (bannedQuery.data ?? []).filter((key) => {
    if (!key.bannedAt) return false;
    if (!key.bannedUntil) return true;
    return new Date(key.bannedUntil).getTime() > now;
  });

  const allKeys = keysQuery.data ?? [];
  const normalized = search.trim().toLowerCase();
  const matchedKeys = useMemo(() => {
    if (!normalized) return allKeys;
    return allKeys.filter((key) => {
      const label = (key.label ?? "").toLowerCase();
      const id = key.id.toLowerCase();
      const prefix = (key.keyPrefix ?? "").toLowerCase();
      return label.includes(normalized) || id.startsWith(normalized) || prefix.startsWith(normalized);
    });
  }, [allKeys, normalized]);

  const selectedBanMinutes = banMinutes === "" ? null : Number(banMinutes);
  const selectedIpMinutes = ipMinutes === "" ? null : Number(ipMinutes);

  const doBan = async (key: ApiKeyResponse) => {
    try {
      await ban.mutateAsync({ keyId: key.id, reason: banReason, minutes: selectedBanMinutes });
      toast.success(`Banned ${key.label || key.id.slice(0, 8)}.`);
      setBanTarget(null);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not ban key."));
    }
  };

  const doBanIp = async () => {
    const ip = ipInput.trim();
    if (!ip) {
      toast.error("Enter an IP address to ban.");
      return;
    }
    try {
      await banIp.mutateAsync({ ip, minutes: selectedIpMinutes });
      toast.success(`Banned IP ${ip}.`);
      setIpInput("");
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not ban IP."));
    }
  };

  return (
    <>
      <Dialog open onClose={onClose} title="Banned Users" size="lg"
        description="Ban API keys or IP addresses manually, search keys, and lift bans.">
        {/* Tab switch */}
        <div className="flex items-center gap-2 border-b border-inner-border pb-3 mb-5">
          <div className="flex rounded-control border border-inner-border overflow-hidden">
            <button type="button"
              onClick={() => setTab("keys")}
              className={`px-4 py-2 text-badge font-semibold cursor-pointer ${tab === "keys" ? "bg-accent text-text-on-accent" : "text-text-secondary hover:bg-surface-hover"}`}>
              API Keys
            </button>
            <button type="button"
              onClick={() => setTab("ips")}
              className={`px-4 py-2 text-badge font-semibold cursor-pointer ${tab === "ips" ? "bg-accent text-text-on-accent" : "text-text-secondary hover:bg-surface-hover"}`}>
              IP Bans
            </button>
          </div>
        </div>

        {tab === "keys" ? (
          <div className="flex flex-col gap-6 min-w-0">
            {/* Search all API keys to ban manually */}
            <div className="min-w-0">
              <h4 className="text-caption font-semibold text-text-secondary mb-3">
                Search API keys
              </h4>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by label, prefix, or id…"
                aria-label="Search API keys"
              />
              {search.trim() !== "" ? (
                <div className="mt-3 rounded-inset border border-inner-border max-h-160 overflow-y-auto">
                  {matchedKeys.length === 0 ? (
                    <p className="p-4 text-badge text-text-secondary">No matching keys.</p>
                  ) : (
                    <DataTable headers={["Key", "Status", ""]}>
                      {matchedKeys.map((key) => (
                        <tr key={key.id}>
                          <td className="font-mono tabular-nums text-badge text-text-primary whitespace-nowrap">
                            {key.label || key.id.slice(0, 8)}
                          </td>
                          <td className="text-badge text-text-secondary">
                            {key.revokedAt ? "revoked" : key.bannedAt ? "banned" : key.enabled ? "enabled" : "disabled"}
                          </td>
                          <td className="text-right whitespace-nowrap">
                            <Button
                              variant="secondary" size="sm" icon={<ShieldOff size={13} />}
                              disabled={key.revokedAt ? true : key.bannedAt ? true : ban.isPending}
                              onClick={() => setBanTarget(key)}
                            >
                              {key.bannedAt ? "Banned" : "Ban"}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                  )}
                </div>
              ) : null}
            </div>

            {/* Active bans */}
            <div className="min-w-0">
              <h4 className="text-caption font-semibold text-text-secondary mb-4">
                Active bans ({bans.length})
              </h4>
              {bannedQuery.isPending && !bannedQuery.data ? (
                <LoadingState label="Loading active bans…" />
              ) : bannedQuery.isError && !bannedQuery.data ? (
                <ErrorState message={getErrorMessage(bannedQuery.error, "Could not load active bans.")}
                  onRetry={() => void bannedQuery.refetch()} />
              ) : bans.length === 0 ? (
                <EmptyState compact title="No banned keys" message="No API key is currently banned."
                  icon={<ShieldOff size={20} />} />
              ) : (
                <div className="rounded-inset border border-inner-border">
                  <DataTable maxHeight={280} scrollRegion headers={["API key", "Reason", "Lapses", ""]}>
                    {bans.map((key) => (
                      <tr key={key.id}>
                        <td className="font-mono tabular-nums text-badge text-text-primary whitespace-nowrap">
                          {key.label || key.id.slice(0, 8)}
                        </td>
                        <td className="text-badge text-text-secondary">{key.banReason ?? "—"}</td>
                        <td className="text-badge text-text-secondary whitespace-nowrap">{lapseLabel(key.bannedUntil ?? null)}</td>
                        <td className="text-right whitespace-nowrap">
                          <Button variant="secondary" size="sm" icon={<Undo2 size={13} />}
                            disabled={unban.isPending}
                            onClick={() => setUnbanTarget(key)}>
                            Unban
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6 min-w-0">
            {/* Ban IP form */}
            <div className="min-w-0">
              <h4 className="text-caption font-semibold text-text-secondary mb-3">
                Ban an IP address
              </h4>
              <div className="flex flex-col gap-3">
                <Input
                  value={ipInput}
                  onChange={(e) => setIpInput(e.target.value)}
                  placeholder="e.g. 203.0.113.7"
                  aria-label="IP address to ban"
                />
                <div className="flex items-end gap-3 flex-wrap">
                  <div className="w-48">
                    <Select
                      value={ipMinutes}
                      onValueChange={setIpMinutes}
                      options={BAN_DURATION_CHOICES.map((c) => ({ value: String(c.minutes ?? ""), label: c.label }))}
                      label="Duration"
                      aria-label="Ban duration"
                    />
                  </div>
                  <Button variant="primary" size="sm" icon={<ShieldOff size={13} />}
                    loading={banIp.isPending}
                    onClick={() => void doBanIp()}>
                    Ban IP
                  </Button>
                </div>
              </div>
            </div>

            {/* Active IP bans */}
            <div className="min-w-0">
              <h4 className="text-caption font-semibold text-text-secondary mb-4">
                Active IP bans ({ipBansQuery.data?.length ?? 0})
              </h4>
              {ipBansQuery.isPending && !ipBansQuery.data ? (
                <LoadingState label="Loading IP bans…" />
              ) : ipBansQuery.isError && !ipBansQuery.data ? (
                <ErrorState message={getErrorMessage(ipBansQuery.error, "Could not load IP bans.")}
                  onRetry={() => void ipBansQuery.refetch()} />
              ) : (ipBansQuery.data ?? []).length === 0 ? (
                <EmptyState compact title="No banned IPs" message="No IP address is currently banned."
                  icon={<ShieldOff size={20} />} />
              ) : (
                <div className="rounded-inset border border-inner-border">
                  <DataTable maxHeight={280} scrollRegion headers={["IP", "Lapses", ""]}>
                    {(ipBansQuery.data ?? []).map((b) => (
                      <tr key={b.ip}>
                        <td className="font-mono tabular-nums text-badge text-text-primary whitespace-nowrap">{b.ip}</td>
                        <td className="text-badge text-text-secondary whitespace-nowrap">{lapseLabel(b.bannedUntil)}</td>
                        <td className="text-right whitespace-nowrap">
                          <Button variant="secondary" size="sm" icon={<Undo2 size={13} />}
                            disabled={unbanIp.isPending}
                            onClick={() => setUnbanIpTarget(b.ip)}>
                            Unban
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                </div>
              )}
            </div>
          </div>
        )}

        <Inline justify="flex-end" gap="0px">
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </Inline>
      </Dialog>

      {/* Confirm ban key */}
      <ConfirmDialog
        open={banTarget !== null}
        onClose={() => setBanTarget(null)}
        onConfirm={() => (banTarget ? doBan(banTarget) : undefined)}
        title="Ban this API key?"
        message={`Ban ${banTarget?.label || banTarget?.id.slice(0, 8) || "this key"}? The caller can no longer reach the gateway.`}
        confirmLabel="Ban"
        danger
      >
        <div className="flex flex-col gap-3 mt-4">
          <Select
            value={banReason}
            onValueChange={setBanReason}
            options={API_KEY_BAN_REASONS.map((r) => ({ value: r.value, label: r.label }))}
            label="Reason"
          />
          <Select
            value={banMinutes}
            onValueChange={setBanMinutes}
            options={BAN_DURATION_CHOICES.map((c) => ({ value: String(c.minutes ?? ""), label: c.label }))}
            label="Duration"
          />
        </div>
      </ConfirmDialog>

      {/* Confirm unban key */}
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

      {/* Confirm unban IP */}
      <ConfirmDialog
        open={unbanIpTarget !== null}
        onClose={() => setUnbanIpTarget(null)}
        onConfirm={async () => {
          if (!unbanIpTarget) return;
          try {
            await unbanIp.mutateAsync({ ip: unbanIpTarget });
            toast.success(`Unbanned IP ${unbanIpTarget}.`);
            setUnbanIpTarget(null);
          } catch (error) {
            toast.error(getErrorMessage(error, "Could not unban IP."));
          }
        }}
        title="Lift this IP ban?"
        message={`Lift the ban on ${unbanIpTarget}? Requests from this address can reach the gateway again immediately.`}
        confirmLabel="Unban"
        danger
      />
    </>
  );
}
