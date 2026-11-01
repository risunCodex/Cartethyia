import { useMemo, useState, type ReactNode } from "react";
import {
  Ban as BanIcon,
  Check,
  CheckCircle2,
  Copy,
  Database,
  Download,
  Image as ImageIcon,
  LogIn,
  Paperclip,
  Route,
  Server,
  Wrench,
} from "lucide-react";
import { consoleRequest, getErrorMessage } from "../../../data/api";
import { cn } from "../../../lib/classnames";
import { downloadTextFile } from "../../../lib/download";
import { toast } from "../../../lib/toast";
import { Button } from "../../../components/ui/button";
import { Drawer } from "../../../components/ui/drawer";
import { Stack } from "../../../components/ui/stack";
import { Select } from "../../../components/ui/select";
import { Banner } from "../../../components/patterns/banner";
import { ErrorState } from "../../../components/ui/state";
import { useProviderAccounts } from "../../../hooks/providers";
import { useUsageRequestDetail } from "../../../hooks/system";
import { useTrackedTimeout } from "../../../hooks/use-timeout";
import { useBanApiKey } from "../../../hooks/api-keys";
import { API_KEY_BAN_REASONS } from "../../../data/contracts";
import { BAN_DURATION_CHOICES } from "../../../lib/ban-durations";
import { formatBytes, formatDuration, formatNumber } from "../../../lib/format/numbers";
import { formatSpeed, formatUsd } from "./formatters";
import { errorLabel, statusCode, STATUS_TONE_COLOR } from "./status";

/**
 * Payload panels shown in the request inspector. The client leg (what the
 * client sent / what Cartethyia produced / what the client actually received)
 * comes first; the provider leg (what was forwarded upstream / what the
 * upstream returned) follows so proxy and server legs are readable separately.
 * Provider internals stay redacted and bounded at the source
 * (`completeAttempt` capture), never raw secrets.
 */
type PayloadKind = "request" | "clientResponse" | "providerRequest" | "providerResponse";

function formatPayload(value: unknown): { readonly text: string; readonly bytes: number } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(value) as unknown;
        const text = JSON.stringify(parsed, null, 2);
        return { text, bytes: new TextEncoder().encode(value).byteLength };
      } catch {
        return { text: value, bytes: new TextEncoder().encode(value).byteLength };
      }
    }
    return { text: value, bytes: new TextEncoder().encode(value).byteLength };
  }
  const text = JSON.stringify(value, null, 2);
  return { text, bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength };
}

function FlowNode({
  title,
  meta,
  icon,
  tone,
  last,
}: {
  readonly title: string;
  readonly meta: string;
  readonly icon: ReactNode;
  readonly tone?: string;
  readonly last?: boolean;
}): ReactNode {
  return (
    <div className="flex gap-5 min-w-0">
      <div className="flex flex-col items-center shrink-0">
        <span
          aria-hidden="true"
          className="grid place-items-center w-11 h-11 rounded-pill"
          style={{
            color: tone ?? "var(--accent)",
            background: `color-mix(in srgb, ${tone ?? "var(--accent)"} 16%, var(--surface-2))`,
          }}
        >
          {icon}
        </span>
        {last ? null : (
          <span aria-hidden="true" className="w-1 flex-1 min-h-7 bg-inner-border" />
        )}
      </div>
      <div className="min-w-0 flex-1" style={{ paddingBottom: last ? 0 : "12px" }}>
        <div className="text-caption font-bold">{title}</div>
        <div
          className="select-text mt-1 whitespace-pre-line text-badge text-text-secondary [overflow-wrap:anywhere] break-words"
        >
          {meta}
        </div>
      </div>
    </div>
  );
}

export function RequestDetailDrawer({
  requestId,
  onClose,
}: {
  readonly requestId: string | null;
  readonly onClose: () => void;
}): ReactNode {
  const detailQuery = useUsageRequestDetail(requestId);
  const detail = detailQuery.data;
  const banKey = useBanApiKey();
  const [banReasonOpen, setBanReasonOpen] = useState(false);
  const [banReason, setBanReason] = useState<string>(API_KEY_BAN_REASONS[0]!.value);
  const [banMinutes, setBanMinutes] = useState<number | null>(BAN_DURATION_CHOICES[0]!.minutes);
  const providerAccounts = useProviderAccounts(detail?.providerId);
  const accountLabel = (item: { readonly accountId?: string } | null | undefined): string => {
    const accountId = item?.accountId;
    if (!accountId) return "—";
    const found = (providerAccounts.data ?? []).find((account) => account.id === accountId);
    return found?.label || `${accountId.slice(0, 8)}…`;
  };
  const apiKeyName = detail?.apiKeyLabel ?? (detail?.apiKeyId ? `${detail.apiKeyId.slice(0, 8)}…` : "—");
  const isProbe = detail?.userAgent === "Cartethyia Probe";
  const displayApiKeyName = isProbe ? "Probe" : apiKeyName;
  const [copiedRequestId, setCopiedRequestId] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState<PayloadKind | null>(null);
  const [downloading, setDownloading] = useState(false);
  const scheduleReset = useTrackedTimeout();
  const copyRequestId = () => {
    void navigator.clipboard?.writeText(detail?.requestId ?? "");
    setCopiedRequestId(true);
    scheduleReset(() => setCopiedRequestId(false), 1500);
  };
  const copyPayload = (kind: PayloadKind, payload: unknown) => {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    void navigator.clipboard?.writeText(text);
    setCopiedPayload(kind);
    scheduleReset(() => setCopiedPayload(null), 1500);
  };
  const downloadTelemetry = async () => {
    if (!detail) return;
    setDownloading(true);
    try {
      const telemetry = await consoleRequest<unknown>(
        `/system/usage/requests/${encodeURIComponent(detail.requestId)}/download`,
      );
      downloadTextFile(
        `telemetry-${detail.requestId}.json`,
        JSON.stringify(telemetry, null, 2),
        "application/json",
      );
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not download telemetry."));
    } finally {
      setDownloading(false);
    }
  };

  const payloadViews = useMemo(
    () =>
      (["request", "clientResponse", "providerRequest", "providerResponse"] as const).map((kind) => {
        const payload = detail?.payloads?.[kind];
        if (payload === undefined) return { kind, text: null, bytes: null };
        try {
          const formatted = formatPayload(payload);
          return { kind, text: formatted.text, bytes: formatted.bytes };
        } catch {
          return { kind, text: null, bytes: null };
        }
      }),
    [detail?.payloads],
  );
  const payloadView = (kind: PayloadKind) =>
    payloadViews.find((view) => view.kind === kind) ?? { kind, text: null, bytes: null };

  return (
    <Drawer open={requestId !== null} onClose={onClose} title="Request Detail">
      {/* `compact` on the error branch: the detail renders in a drawer body,
          not on a route, so it must not reserve the route-level centering
          floor. */}
      {detailQuery.isPending ? (
        <Stack gap="12px">
          <div className="animate-pulse h-12 w-[66%] rounded-inset bg-surface-2" />
          <div className="animate-pulse h-48 rounded-control bg-surface-2" />
          <div className="animate-pulse h-48 rounded-control bg-surface-2" />
        </Stack>
      ) : detailQuery.isError || !detail ? (
        // A missing raw event is absent; there is no compacted-detail state.
        <ErrorState
          compact
          message={getErrorMessage(detailQuery.error, "Failed to load request detail.")}
          onRetry={() => void detailQuery.refetch()}
        />
      ) : (
        <Stack gap="12px">
          <div className="flex items-center gap-4 rounded-control border border-inner-border bg-surface-2 px-6 py-4 min-w-0">
            <span
              className="select-text font-mono tabular-nums min-w-0 flex-1 [overflow-wrap:anywhere] break-words text-badge"
              title={detail.requestId}
            >
              request_id {detail.requestId}
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={copiedRequestId ? <Check size={12} /> : <Copy size={12} />}
              aria-label="Copy request ID"
              title="Copy request ID"
              onClick={copyRequestId}
              className="shrink-0 p-1.5"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Download size={13} />}
              disabled={downloading}
              title="Download all captured telemetry for this request as JSON"
              onClick={() => void downloadTelemetry()}
              className="w-full"
            >
              Download telemetry
            </Button>
            {detail.apiKeyId && detail.apiKeyLabel ? (
              <Button
                variant="danger"
                size="sm"
                icon={<BanIcon size={13} />}
                disabled={banKey.isPending}
                title="Ban the API key that made this request"
                onClick={() => setBanReasonOpen((open) => !open)}
                className="w-full"
              >
                {banKey.isPending ? "Banning…" : "Ban key"}
              </Button>
            ) : null}
          </div>
          {banReasonOpen && detail.apiKeyId ? (
            <div className="flex flex-col gap-3 rounded-control border border-warning-line bg-surface-2 px-4 py-4">
              <Select
                label="Reason"
                id="request-ban-reason"
                value={banReason}
                onValueChange={(value) => setBanReason(value)}
                options={API_KEY_BAN_REASONS.map((r) => ({ value: r.value, label: r.label }))}
              />
              <Select
                label="Duration"
                id="request-ban-duration"
                value={banMinutes === null ? "null" : String(banMinutes)}
                onValueChange={(value) => setBanMinutes(value === "null" ? null : Number(value))}
                options={BAN_DURATION_CHOICES.map((choice) => ({
                  value: choice.minutes === null ? "null" : String(choice.minutes),
                  label: choice.label,
                }))}
              />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setBanReasonOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    const option = API_KEY_BAN_REASONS.find((r) => r.value === banReason);
                    banKey.mutate(
                      {
                        keyId: detail.apiKeyId as string,
                        reason: banReason,
                        reasonLabel: option?.label,
                        minutes: banMinutes,
                      },
                      {
                        onSuccess: () => {
                          toast.success("API key banned");
                          setBanReasonOpen(false);
                        },
                        onError: (error) =>
                          toast.error(getErrorMessage(error, "Could not ban key.")),
                      },
                    );
                  }}
                >
                  {banKey.isPending ? "Banning…" : "Confirm ban"}
                </Button>
              </div>
            </div>
          ) : null}

          {detail.errorKind ? (
            <Banner tone="danger" live="alert" className="flex flex-col gap-2 [overflow-wrap:anywhere] break-words">
              <strong className="text-caption">
                {errorLabel(detail.status, detail.errorKind, detail.errorOrigin, detail.httpStatus)}
              </strong>
              <span className="font-mono tabular-nums text-text-tertiary text-micro [overflow-wrap:anywhere]">
                {detail.errorKind}
              </span>
            </Banner>
          ) : null}
          <section className="border border-inner-border rounded-control overflow-hidden">
            <div className="border-b border-inner-border px-6 py-5 text-caption font-bold">
              Flow and Detail
            </div>
            <div className="flex flex-col p-6">
              <FlowNode
                icon={<LogIn size={13} />}
                title="Client request in"
                meta={`Client IP : ${detail.clientIp ?? "—"}\n${detail.clientName ?? "—"} · ${detail.userAgent ?? "—"} · ${detail.surface ?? "—"} · ${detail.mode === "stream" ? "streaming" : "non-streaming"}`}
              />
              <FlowNode
                icon={<Route size={13} />}
                title="Gateway"
                meta={`${formatDuration(detail.durationMs)} total · TTFT ${formatDuration(detail.ttfbMs)} · ${formatSpeed(detail.tokensPerSec)} · ${detail.cachedTokens !== undefined ? formatNumber(detail.cachedTokens) : "—"} from cache`}
              />
              <FlowNode
                icon={<Server size={13} />}
                title={`Upstream · ${detail.providerId ?? "—"}`}
                meta={`${[accountLabel(detail), detail.model ?? "—"].filter((part) => part !== "—").join(" · ") || "—"}\nApi Key : ${displayApiKeyName}\nProxy : ${detail.proxy ?? "direct"}${detail.networkPoolLabel && detail.networkPoolLabel !== detail.proxy ? `\nPool : ${detail.networkPoolLabel}` : ""}`}
              />
              <FlowNode
                icon={<CheckCircle2 size={13} />}
                last
                title="Response out"
                meta={`${statusCode(detail.status, detail.httpStatus).code}${payloadView("clientResponse").bytes !== null ? ` · ${formatBytes(payloadView("clientResponse").bytes)}` : ""}${detail.estimatedCost ? ` · ${formatUsd(detail.estimatedCost)}` : ""}`}
                tone={STATUS_TONE_COLOR[statusCode(detail.status, detail.httpStatus).tone]}
              />
            </div>
          </section>
          {(() => {
            const signals = detail.payloadSignals;
            const signalItems = [
              { label: "Tool calls", value: signals?.toolCalls ?? "—", icon: Wrench },
              { label: "Images", value: signals?.images ?? "—", icon: ImageIcon },
              { label: "Attachments", value: signals?.attachments ?? "—", icon: Paperclip },
            ] as const;
            return (
              <section
                aria-label="Session signals"
                className="signal-grid grid gap-4 border border-inner-border rounded-control p-5 bg-surface-2"
              >
                {signalItems.map(({ label, value, icon: Icon }) => (
                  <div
                    key={label}
                    className="flex items-center gap-3.5 min-w-0 text-text-secondary"
                  >
                    <Icon size={14} aria-hidden="true" className="shrink-0 text-accent" />
                    <span className="min-w-0 [overflow-wrap:anywhere] text-badge">
                      {label}: <strong className="text-text-primary">{value}</strong>
                    </span>
                  </div>
                ))}
              </section>
            );
          })()}


          {(
            [
              ["request", "1. Client Request (Input)", detail.payloads?.request, LogIn],
              ["providerRequest", "2. Provider Request (Translated)", detail.payloads?.providerRequest, Route],
              ["providerResponse", "3. Provider Response (Raw)", detail.payloads?.providerResponse, Server],
              ["clientResponse", "4. Client Response (Final)", detail.payloads?.clientResponse, CheckCircle2],
            ] as const
          ).map(([kind, label, payload, Icon]) => (
            <details
              key={kind}
              className="rounded-control border border-inner-border bg-surface-2 overflow-hidden"
            >
              <summary
                className="flex items-center justify-between gap-4 cursor-pointer px-6 py-5 text-caption font-bold"
              >
                <span className="inline-flex items-center gap-3.5 min-w-0">
                  <Icon size={14} className={cn("shrink-0", kind === "request" ? "text-accent" : "text-green")} />
                  <span className="[overflow-wrap:anywhere] break-words">{label}</span>
                </span>
                <span className="font-mono tabular-nums shrink-0 text-text-tertiary text-micro font-medium">
                  {formatBytes(payloadView(kind).bytes)}
                </span>
              </summary>
              {payload === undefined ? (
                <div
                  className="flex items-start gap-5 border-t border-inner-border bg-surface-1 px-6 py-7"
                >
                  <Database size={15} className="shrink-0 text-text-tertiary mt-0.5" />
                  <div className="min-w-0 flex flex-col gap-1.5">
                    <strong className="text-caption text-text-secondary">No payload captured</strong>
                    <span className="text-badge text-text-tertiary [overflow-wrap:anywhere] break-words">
                      {label} is unavailable for this request.
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex justify-end border-t border-inner-border pt-2.5 px-4">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={copiedPayload === kind ? <Check size={11} /> : <Copy size={11} />}
                      aria-label={`Copy ${label}`}
                      title={`Copy ${label}`}
                      onClick={() => copyPayload(kind, payload)}
                      className="p-1"
                    />
                  </div>
                  <pre
                    className="select-text font-mono tabular-nums max-h-128 overflow-auto whitespace-pre-wrap [overflow-wrap:break-word] break-words m-0 border-t border-inner-border pt-4 px-6 pb-6 text-micro text-text-secondary"
                  >
                    {payloadView(kind).text}
                  </pre>
                </>
              )}
            </details>
          ))}
        </Stack>
      )}
    </Drawer>
  );
}
