import {
  Ban,
  Boxes,
  ChevronDown,
  Database,
  Eye,
  Fingerprint,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Repeat2,
  Route,
  Search,
  Server,
  Share2,
  Shield,
  ShieldCheck,
  ShieldX,
  StickyNote,
  Pencil,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { FileInput, Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Select } from "./ui/select";
import { ModelPickerModal } from "./ModelPicker";
import { useResetToolMappings, useSaveToolMappings, useToolMappings, useToolRegistry } from "../hooks/cli-tools";
import { useUpdateApiKey } from "../hooks/api-keys";
import { useDialogDirty } from "../hooks/use-dialog-dirty";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import {
  CLIENT_ROUTERS,
  SHARE_POPUP_IMAGE_MAX_BYTES,
  SHARE_POPUP_IMAGE_MIMES,
  TENANT_KEY_SCOPES,
  normalizeClientRouterId,
  type ApiKeyResponse,
  type ConcurrencyScope,
  type TenantScope,
  type ToolRegistryEntry,
} from "../data/contracts";

/**
 * Human-readable descriptions of the authority granted by each tenant scope.
 * Keeping these beside their toggle rows makes the consequences of each
 * permission visible while operators review access.
 */
const SCOPE_DESCRIPTIONS: Record<TenantScope, string> = {
  "routing:invoke": "Call /v1/* gateway routes within this tenant.",
  "routing:cli_mapping": "Resolve persisted CLI source→target model mappings.",
  "search:invoke": "Call POST /v1/search with exa.",
  "dashboard:read": "Read this tenant's configuration and usage.",
  "dashboard:write": "Modify this tenant's configuration.",
  "providers:read": "Read provider rows, including accounts.",
  "providers:write": "Add, modify, or delete provider rows and their credentials.",
  "models:read": "Read catalog model rows.",
  "models:write": "Add, modify, or delete catalog model rows.",
};
const SCOPE_ICONS: Record<TenantScope, LucideIcon> = {
  "routing:invoke": Route,
  "routing:cli_mapping": Route,
  "search:invoke": Search,
  "dashboard:read": Eye,
  "dashboard:write": Pencil,
  "providers:read": Server,
  "providers:write": LockKeyhole,
  "models:read": Boxes,
  "models:write": Database,
};

type TokenBudgetMode = "recurring" | "one-time";
const TOKEN_SUFFIX: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  t: 1_000_000_000_000,
};
/** Quick-pick token budgets offered next to every token limit input. */
const TOKEN_BUDGET_PRESETS = [
  { label: "1M", amount: 1_000_000, description: "1 million" },
  { label: "100M", amount: 100_000_000, description: "100 million" },
  { label: "1B", amount: 1_000_000_000, description: "1 billion" },
  { label: "1T", amount: 1_000_000_000_000, description: "1 trillion" },
] as const;
function parseTokenLimit(value: string): number | undefined {
  const raw = value.trim().toLowerCase();
  if (!raw) return undefined;
  const m = raw.match(/^([\d.]+)\s*([kmbt])?$/);
  if (!m) return undefined;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const mul = m[2] ? (TOKEN_SUFFIX[m[2]] ?? 1) : 1;
  return Math.round(num * mul);
}
function tokenInputValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const preset = TOKEN_BUDGET_PRESETS.find((entry) => entry.amount === value);
  if (preset) return preset.label;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}
function parseLimit(value: string): number | undefined {
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}
function parseLimitOrNull(value: string): number | null | undefined {
  const n = parseLimit(value);
  // Empty input clears an existing limit; a parsed value is kept.
  return value.trim() === "" ? null : n;
}

/** Token limit input with 1M/100M/1B/1T quick-pick presets. */
function TokenBudgetField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const parsed = parseTokenLimit(value);
  const selected = TOKEN_BUDGET_PRESETS.find((preset) => preset.amount === parsed)?.label;
  return (
    <div>
      <Input
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. 1M, 500K"
        disabled={disabled}
      />
      <div
        className="flex flex-wrap gap-2 mt-2"
        role="group"
        aria-label={`${label} presets`}
      >
        {TOKEN_BUDGET_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            aria-pressed={selected === preset.label}
            aria-label={`${preset.label}, ${preset.description} tokens`}
            onClick={() => onChange(preset.label)}
            disabled={disabled}
            className="py-0.5 px-3 rounded-chip text-micro font-semibold"
            style={{
              cursor: disabled ? "not-allowed" : "pointer",
              border: `1px solid ${selected === preset.label ? "var(--accent)" : "var(--inner-border)"}`,
              background: selected === preset.label ? "var(--accent-soft)" : "transparent",
              color: selected === preset.label ? "var(--accent)" : "var(--text-tertiary)",
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One Remote Routing control for a single remote-mapping tool.
 *
 * Remote routing is two persisted facts that always travel together: the
 * per-(tool, key) `cli_tool_settings.mappings_enabled` flag and the
 * `routing:cli_mapping` scope that lets the key consume its routes. They are
 * surfaced as one switch — on grants the scope and enables the routes, off
 * clears the scope and disables them — so the operator never has to reason
 * about which half is missing. Route rows are preserved across an off/on
 * toggle; only Reset clears them.
 */
function RemoteRoutingRow({
  tool,
  keyId,
  busy,
  scopeGranted,
  onScopeChange,
}: {
  tool: ToolRegistryEntry;
  keyId: string;
  busy: boolean;
  scopeGranted: boolean;
  onScopeChange: (next: boolean) => void;
}): ReactNode {
  const mappings = useToolMappings(tool.id, keyId);
  const save = useSaveToolMappings();
  const reset = useResetToolMappings();
  const routesEnabled = mappings.data?.enabled ?? false;
  const enabled = scopeGranted && routesEnabled;
  const rowCount = mappings.data?.mappings.length ?? 0;
  const pending = save.isPending || reset.isPending;

  const setEnabled = (next: boolean) => {
    if (next !== scopeGranted) onScopeChange(next);
    save.mutate(
      { toolId: tool.id, keyId, input: { enabled: next, mappings: mappings.data?.mappings ?? [] } },
      {
        onSuccess: () => toast.success(`Saved remote routing for ${tool.name}.`),
        onError: (error) => toast.error(getErrorMessage(error, "Could not save remote routing.")),
      },
    );
  };

  return (
    <div
      className="flex items-center justify-between gap-4 py-1.5 px-4 rounded-inset"
      style={{
        minHeight: "38px",
        border: "1px solid var(--inner-border)",
        background: enabled ? "var(--accent-soft)" : "var(--surface-1)",
      }}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Route size={16} className="mt-1 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0">
        <div className="text-caption font-semibold text-text-primary">
          {tool.name}
        </div>
        <p className="mt-1 text-badge text-text-tertiary">
          {enabled
            ? `Remote routing on — ${rowCount} route${rowCount === 1 ? "" : "s"} active, routing:cli_mapping granted.`
            : "Remote routing off — this key's requests go straight to the provider."}
        </p>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <Switch
          checked={enabled}
          disabled={busy || pending || mappings.isLoading}
          aria-label={`Enable remote routing for ${tool.name}`}
          onChange={setEnabled}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || pending || (!routesEnabled && rowCount === 0)}
          onClick={() =>
            reset.mutate(
              { toolId: tool.id, keyId },
              {
                onSuccess: () => toast.success(`Cleared remote routes for ${tool.name}.`),
                onError: (error) => toast.error(getErrorMessage(error, "Could not reset remote routes.")),
              },
            )
          }
        >
          {reset.isPending ? "Resetting…" : "Reset"}
        </Button>
      </div>
    </div>
  );
}

/** Remote-routing switches for every tool that supports persisted mapping.
 * Hidden while creating a key: routes are stored per key, so there is nothing
 * to attach them to until the key exists. */
function RemoteRoutingSection({
  keyId,
  busy,
  scopeGranted,
  onScopeChange,
  persistScope,
}: {
  keyId: string;
  busy: boolean;
  scopeGranted: boolean;
  onScopeChange: (next: boolean) => void;
  persistScope: (next: boolean) => void;
}): ReactNode {
  const registry = useToolRegistry();
  const tools = (registry.data ?? []).filter((tool) => tool.mappingSupported);
  return (
    <section aria-labelledby="remote-routing-heading" className="flex flex-col gap-3">
      <div>
    <h4 id="remote-routing-heading" className="inline-flex items-center gap-2 text-caption font-bold text-text-primary">
      <Route size={15} className="text-accent" aria-hidden="true" />
      Remote routing
    </h4>
        <p className="mt-1 text-badge text-text-tertiary">
          Route this key's CLI model calls through persisted mappings and grant routing:cli_mapping. Applies immediately — no save needed.
        </p>
      </div>
      {keyId.length === 0 ? (
        <p className="text-badge text-text-tertiary m-0">
          Save the key first to configure per-tool remote routing mappings.
        </p>
      ) : tools.length === 0 ? (
        <p className="text-badge text-text-tertiary m-0">
          No CLI tools with mapping support are currently registered.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {tools.map((tool) => (
            <RemoteRoutingRow
              key={tool.id}
              tool={tool}
              keyId={keyId}
              busy={busy}
              scopeGranted={scopeGranted}
              onScopeChange={(next) => {
                onScopeChange(next);
                persistScope(next);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export interface KeyFormInput {
  label: string;
  keyMode: ApiKeyResponse["keyMode"];
  keyPrefix?: string;
  key?: string;
  modelAccessMode: "whitelist" | "blacklist";
  modelList: string[];
  clientRouterDenylist: string[];
  scopes: string[];
  requestsPerMinute?: number | null;
  maxConcurrentRequests?: number | null;
  concurrencyScope?: ConcurrencyScope;
  /** Share-template recipient slot cap; null/undefined = unlimited. */
  maxChildren?: number | null;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  lifetimeTokenBudget?: number | null;
  notesTitle?: string;
  notesSubtitle?: string;
  notesBody?: string;
  /** Toggle for the single share-page popup; the owner edits its copy freely. */
  sharePopupEnabled: boolean;
  /** Uploaded art as a data URL; `null` clears it, omitted leaves it unchanged. */
  sharePopupImage?: string | null;
  sharePopupTitle: string;
  sharePopupBody: string;
}
interface KeyFormProps {
  mode: "create" | "edit";
  record: ApiKeyResponse | null;
  busy: boolean;
  onDone: (input: KeyFormInput) => void;
  onClose: () => void;
  /** Receives the action row so the dialog can pin it below the scrolling body. */
  actionsRef?: (actions: ReactNode) => void;
}
export function keyCredentialFields(
  keyMode: ApiKeyResponse["keyMode"],
  customKey: string,
  keyPrefix: string,
): Pick<KeyFormInput, "keyMode" | "key" | "keyPrefix"> {
  const key = keyMode === "personal" ? customKey.trim() : "";
  return {
    keyMode,
    keyPrefix: keyPrefix.trim() || undefined,
    ...(key ? { key } : {}),
  };
}
export function oneTimeSecretForMode(keyMode: ApiKeyResponse["keyMode"], secret: string | undefined): string | null {
  return keyMode === "personal" ? secret ?? null : null;
}
export function initialApiKeyScopes(
  record: { readonly isDefault?: boolean; readonly scopes?: readonly string[] } | null,
): string[] {
  // For the default key: use whatever is stored on the record (so removals
  // survive re-open); fall back to the full set only when no scopes are saved yet.
  const savedScopes = record?.scopes;
  if (record?.isDefault) {
    return savedScopes && savedScopes.length > 0 ? [...savedScopes] : [...TENANT_KEY_SCOPES];
  }
  return savedScopes && savedScopes.length > 0
    ? [...savedScopes]
    : ["routing:invoke", "search:invoke"];
}
export function ApiKeyForm({ mode, record, busy, onDone, onClose, actionsRef }: KeyFormProps): ReactNode {
  const [label, setLabel] = useState(record?.label ?? "");
  const [prefix, setPrefix] = useState(record?.keyPrefix ?? "");
  const [customKey, setCustomKey] = useState("");
  const [rpm, setRpm] = useState(record?.requestsPerMinute?.toString() ?? "");
  const [daily, setDaily] = useState(
    tokenInputValue(
      (record as unknown as { dailyTokenLimit?: number | null })?.dailyTokenLimit ?? null,
    ),
  );
  const [monthly, setMonthly] = useState(
    tokenInputValue(
      (record as unknown as { monthlyTokenLimit?: number | null })?.monthlyTokenLimit ?? null,
    ),
  );
  const [lifetime, setLifetime] = useState(
    tokenInputValue(
      (record as unknown as { lifetimeTokenBudget?: number | null })?.lifetimeTokenBudget ?? null,
    ),
  );
  const [budgetMode, setBudgetMode] = useState<TokenBudgetMode>(
    (record as unknown as { lifetimeTokenBudget?: number | null })?.lifetimeTokenBudget != null
      ? "one-time"
      : "recurring",
  );
  const [concurrent, setConcurrent] = useState(record?.maxConcurrentRequests?.toString() ?? "");
  const [concurrencyScope, setConcurrencyScope] = useState<ConcurrencyScope>(
    record?.concurrencyScope ?? "family",
  );
  const [maxChildren, setMaxChildren] = useState(
    (record as unknown as { maxChildren?: number | null })?.maxChildren?.toString() ?? "",
  );
  const [scopes, setScopes] = useState<string[]>(() => initialApiKeyScopes(record));
  const [modelAccessMode, setModelAccessMode] = useState<"whitelist" | "blacklist">(
    (record as unknown as { modelAccessMode?: "whitelist" | "blacklist" | null })?.modelAccessMode ??
      "whitelist",
  );
  const [models, setModels] = useState<string[]>(() => {
    const m = (record as unknown as { modelList?: string[] | null })?.modelList;
    return m ? [...m] : [];
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [blockedRouters, setBlockedRouters] = useState<string[]>(() => {
    const list = (record as unknown as { clientRouterDenylist?: string[] | null })
      ?.clientRouterDenylist;
    return list
      ? [...new Set(list.map(normalizeClientRouterId).filter((id): id is string => id !== undefined))]
      : [];
  });
  const [notesTitle, setNotesTitle] = useState(() => {
    const t = (record as unknown as { notesTitle?: string | null })?.notesTitle;
    return t ?? "";
  });
  const [notesSubtitle, setNotesSubtitle] = useState(() => {
    const s = (record as unknown as { notesSubtitle?: string | null })?.notesSubtitle;
    return s ?? "";
  });
  const [notesBody, setNotesBody] = useState(() => {
    const b = (record as unknown as { notesBody?: string | null })?.notesBody;
    return b ?? "";
  });
  const [sharePopupEnabled, setSharePopupEnabled] = useState(record?.sharePopupEnabled ?? true);
  // Tri-state upload: no pick yet, a freshly picked data URL, or an explicit
  // removal of the art already stored on the key.
  const [sharePopupImageDataUrl, setSharePopupImageDataUrl] = useState<string | null>(null);
  const [sharePopupImageRemoved, setSharePopupImageRemoved] = useState(false);
  const [sharePopupImageError, setSharePopupImageError] = useState<string | null>(null);
  const hasStoredImage = record?.sharePopupImageMime !== undefined;
  const popupImagePreview =
    sharePopupImageDataUrl ??
    (hasStoredImage && !sharePopupImageRemoved && record !== null
      ? `/console/api/api-keys/${record.id}/share-popup-image`
      : null);
  // Pre-fill QRIS image when there is no stored image and user hasn't picked one yet.
  useEffect(() => {
    if (hasStoredImage || sharePopupImageDataUrl !== null || sharePopupImageRemoved) return;
    fetch("/donation/qris-risun-marke.webp")
      .then((r) => r.ok ? r.blob() : Promise.reject(r.status))
      .then((blob) => {
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
        return promise;
      })
      .then((dataUrl) => setSharePopupImageDataUrl(dataUrl))
      .catch(() => { /* silently skip if asset not reachable */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [sharePopupTitle, setSharePopupTitle] = useState(
    record?.sharePopupTitle ??
    "Support via QRIS"
  );
  const [sharePopupBody, setSharePopupBody] = useState(
    record?.sharePopupBody ??
    "Scan the QR code above with any QRIS-compatible banking or e-wallet app to support this gateway's upkeep. Every contribution helps keep the service running — thank you! 🙏"
  );
  const [keyMode, setKeyMode] = useState<ApiKeyResponse["keyMode"]>(
    record?.keyMode ?? "personal",
  );
  const isOneTime = budgetMode === "one-time";
  // A credential's mode is fixed once the key exists: converting a share
  // template to a personal key (or back) revokes its children and links, so the
  // edit form shows the mode but never lets it change.
  const modeLocked = mode === "edit";

  // Dirty = any editable field differs from the record's initial value. Used by
  // the parent to block closing the dialog while edits are unsaved.
  const dirty = useMemo(() => {
    if (mode === "create") {
      return (
        label.trim().length > 0 ||
        customKey.trim().length > 0 ||
        prefix.trim().length > 0 ||
        rpm.trim().length > 0 ||
        daily.trim().length > 0 ||
        monthly.trim().length > 0 ||
        lifetime.trim().length > 0 ||
        concurrent.trim().length > 0 ||
        maxChildren.trim().length > 0 ||
        notesTitle.trim().length > 0 ||
        notesSubtitle.trim().length > 0 ||
        notesBody.trim().length > 0 ||
        scopes.length > 0 ||
        models.length > 0 ||
        blockedRouters.length > 0 ||
        sharePopupImageDataUrl !== null ||
        sharePopupImageRemoved
      );
    }
    const r = record;
    if (r === null) return false;
    return (
      label.trim() !== (r.label ?? "") ||
      rpm.trim() !== (r.requestsPerMinute?.toString() ?? "") ||
      daily.trim() !== tokenInputValue((r as unknown as { dailyTokenLimit?: number | null })?.dailyTokenLimit ?? null) ||
      monthly.trim() !== tokenInputValue((r as unknown as { monthlyTokenLimit?: number | null })?.monthlyTokenLimit ?? null) ||
      lifetime.trim() !== tokenInputValue((r as unknown as { lifetimeTokenBudget?: number | null })?.lifetimeTokenBudget ?? null) ||
      budgetMode !== ((r as unknown as { lifetimeTokenBudget?: number | null })?.lifetimeTokenBudget != null ? "one-time" : "recurring") ||
      concurrent.trim() !== (r.maxConcurrentRequests?.toString() ?? "") ||
      concurrencyScope !== (r.concurrencyScope ?? "family") ||
      maxChildren.trim() !== ((r as unknown as { maxChildren?: number | null })?.maxChildren?.toString() ?? "") ||
      notesTitle.trim() !== ((r as unknown as { notesTitle?: string | null })?.notesTitle ?? "") ||
      notesSubtitle.trim() !== ((r as unknown as { notesSubtitle?: string | null })?.notesSubtitle ?? "") ||
      notesBody.trim() !== ((r as unknown as { notesBody?: string | null })?.notesBody ?? "") ||
      scopes.join(",") !== initialApiKeyScopes(r).join(",") ||
      modelAccessMode !== ((r as unknown as { modelAccessMode?: "whitelist" | "blacklist" | null })?.modelAccessMode ?? "whitelist") ||
      models.join(",") !== (r.modelList ?? []).join(",") ||
      blockedRouters.join(",") !== ((r as unknown as { clientRouterDenylist?: string[] | null })?.clientRouterDenylist ?? []).join(",") ||
      sharePopupEnabled !== (r.sharePopupEnabled ?? true) ||
      sharePopupImageDataUrl !== null ||
      sharePopupImageRemoved ||
      sharePopupTitle.trim() !== (r.sharePopupTitle ?? "Support via QRIS") ||
      sharePopupBody.trim() !== (r.sharePopupBody ?? "Scan the QR code above with any QRIS-compatible banking or e-wallet app to support this gateway's upkeep. Every contribution helps keep the service running — thank you! 🙏")
    );
  }, [
    mode,
    record,
    label,
    customKey,
    prefix,
    rpm,
    daily,
    monthly,
    lifetime,
    budgetMode,
    concurrent,
    concurrencyScope,
    maxChildren,
    scopes,
    modelAccessMode,
    models,
    blockedRouters,
    notesTitle,
    notesSubtitle,
    notesBody,
    sharePopupEnabled,
    sharePopupImageDataUrl,
    sharePopupImageRemoved,
    sharePopupTitle,
    sharePopupBody,
  ]);

  useDialogDirty(dirty);
  // Persists the routing scope the instant the Remote routing switch flips,
  // rather than deferring it to "Save changes".
  const updateKey = useUpdateApiKey();
  const toggleScope = (scope: string) =>
    setScopes((cur) => (cur.includes(scope) ? cur.filter((s) => s !== scope) : [...cur, scope]));
  const submit = () => {
    onDone({
      label: label.trim(),
      ...keyCredentialFields(keyMode, customKey, prefix),
      scopes,
      modelAccessMode,
      modelList: models,
      clientRouterDenylist: blockedRouters,
      requestsPerMinute: parseLimitOrNull(rpm),
      maxConcurrentRequests: parseLimitOrNull(concurrent),
      concurrencyScope: keyMode === "share" ? concurrencyScope : undefined,
      maxChildren: keyMode === "share" ? parseLimitOrNull(maxChildren) : null,
      dailyTokenLimit: isOneTime ? null : (parseTokenLimit(daily) ?? null),
      monthlyTokenLimit: isOneTime ? null : (parseTokenLimit(monthly) ?? null),
      lifetimeTokenBudget: isOneTime ? (parseTokenLimit(lifetime) ?? null) : null,
      notesTitle: notesTitle.trim(),
      notesSubtitle: notesSubtitle.trim(),
      notesBody: notesBody.trim(),
      sharePopupEnabled,
      ...(sharePopupImageDataUrl !== null
        ? { sharePopupImage: sharePopupImageDataUrl }
        : sharePopupImageRemoved
          ? { sharePopupImage: null }
          : {}),
      sharePopupTitle: sharePopupTitle.trim(),
      sharePopupBody: sharePopupBody.trim(),
    });
  };
  useEffect(() => {
    actionsRef?.(
      <>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={busy || (mode === "create" && !label.trim())} onClick={submit}>
          {busy ? "Saving…" : mode === "create" ? "Create API key" : "Save changes"}
        </Button>
      </>
    );
  });
  return (
    <div className="flex flex-col gap-3 min-w-0 pb-2">
      <section className="flex flex-col gap-3 min-w-0 p-4 border border-inner-border rounded-card bg-surface-2 col-span-full">
        <h3 className="inline-flex items-center gap-2 text-caption font-bold text-text-primary">
          <KeyRound size={16} className="text-accent" aria-hidden="true" />
          Credential mode
        </h3>
        <div role="group" aria-label="Credential mode" className="flex gap-4">
          {(["personal", "share"] as const).map((modeOption) => (
            <button key={modeOption} type="button" aria-pressed={keyMode === modeOption}
              disabled={busy || modeLocked} onClick={() => setKeyMode(modeOption)}
              title={modeLocked ? "Credential mode cannot change after creation" : undefined}
              className="rounded-inset py-1.5 px-5"
              style={{ border: "1px solid var(--inner-border)",
                color: keyMode === modeOption ? "var(--accent)" : "var(--text-secondary)",
                background: keyMode === modeOption ? "var(--accent-soft)" : "var(--surface-2)",
                cursor: modeLocked ? "not-allowed" : "pointer", opacity: modeLocked && keyMode !== modeOption ? 0.5 : 1 }}>
              <span className="inline-flex items-center gap-2">
                {modeOption === "personal" ? <UserRound size={14} aria-hidden="true" /> : <UsersRound size={14} aria-hidden="true" />}
                {modeOption === "personal" ? "Personal" : "Share template"}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-1 text-badge text-text-tertiary">
          {keyMode === "share"
            ? "A share template does not authenticate requests. Recipients generate their own child key from its public enrollment page."
            : "A personal key authenticates requests directly; its secret is shown once when created or rotated."}
        </p>
      </section>
      <div className="grid grid-cols-2 gap-3 min-w-0 max-medium:grid-cols-1">
      {mode === "create" && (
        <section className="flex flex-col gap-3 min-w-0 p-4 border border-inner-border rounded-card bg-surface-2">
          <div>
            <h3 className="inline-flex items-center gap-2 text-caption font-bold text-text-primary">
              <Fingerprint size={16} className="text-accent" aria-hidden="true" />
              Identity
            </h3>
            <p className="mt-1 text-badge text-text-tertiary">
              Give this credential a recognizable name.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4 items-start min-w-0 max-medium:grid-cols-1">
            <Input label="Name" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="ci-key…" disabled={busy} autoFocus />
            <Input label="Key prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)}
              placeholder="pn-carte- (default)…" disabled={busy || customKey.trim().length > 0} />
          </div>
          {keyMode === "personal" && (
            <Input label="Custom API key value (optional)" value={customKey}
              onChange={(e) => setCustomKey(e.target.value)} placeholder="Leave blank to generate…" disabled={busy} />
          )}
        </section>
      )}
      {mode === "edit" && (
        <section className="flex flex-col gap-3 min-w-0 p-4 border border-inner-border rounded-card bg-surface-2">
          <div>
            <h3 className="text-caption font-bold text-text-primary">
              <Fingerprint size={16} className="mr-2 inline text-accent" aria-hidden="true" />
              Identity
            </h3>
            <p className="mt-1 text-badge text-text-tertiary">
              {record?.isDefault
                ? "The default key's name is fixed. Limits, access, and everything else can still change."
                : "Update the label for this credential."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4 items-start min-w-0 max-medium:grid-cols-1">
            <Input
              label="Name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="ci-key…"
              disabled={busy || record?.isDefault === true}
              title={record?.isDefault ? "The default gateway key keeps its name" : undefined}
              autoFocus
            />
          </div>
        </section>
      )}
      <section className="flex flex-col gap-3 min-w-0 p-4 border border-inner-border rounded-card bg-surface-2">
        <div>
          <h3 className="text-caption font-bold text-text-primary">
            <StickyNote size={16} className="mr-2 inline text-accent" aria-hidden="true" />
            Share notes
          </h3>
          <p className="mt-1 text-badge text-text-tertiary">
            Optional copy shown on the public share page.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4 items-start min-w-0 max-medium:grid-cols-1">
        <Input
          label="Title"
          value={notesTitle}
          onChange={(e) => setNotesTitle(e.target.value)}
          placeholder="e.g. Bansos Token"
          disabled={busy}
        />
        <Input
          label="Subtitle"
          value={notesSubtitle}
          onChange={(e) => setNotesSubtitle(e.target.value)}
          placeholder="e.g. Come and save your tokens"
          disabled={busy}
        />
        <div className="col-span-full">
        <Input
          label="Body"
          value={notesBody}
          onChange={(e) => setNotesBody(e.target.value)}
          placeholder="Free-form notes for the recipient"
          disabled={busy}
        />
        </div>
        </div>
      </section>
      <section className="flex flex-col gap-3 min-w-0 p-4 border border-inner-border rounded-card bg-surface-2 col-span-full">
        <div>
          <h3 className="text-caption font-bold text-text-primary">
            <Gauge size={16} className="mr-2 inline text-accent" aria-hidden="true" />
            Limits
          </h3>
          <p className="mt-1 text-badge text-text-tertiary">
            Keep this credential predictable under load.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4 items-start min-w-0 max-medium:grid-cols-1">
          <Input
            label="Requests per minute"
            type="number"
            min="0"
            value={rpm}
            onChange={(e) => setRpm(e.target.value)}
            placeholder="Unlimited…"
            disabled={busy}
          />
          <Input
            label="Max concurrent requests"
            type="number"
            min="0"
            value={concurrent}
            onChange={(e) => setConcurrent(e.target.value)}
            placeholder="Unlimited…"
            disabled={busy}
          />
          {keyMode === "share" ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="api-key-concurrency-scope" className="form-label text-caption font-semibold text-text-primary">
                Concurrency scope
              </label>
              <Select
                id="api-key-concurrency-scope"
                aria-label="Concurrency scope"
                value={concurrencyScope}
                onValueChange={(next) => setConcurrencyScope(next as ConcurrencyScope)}
                options={[
                  { value: "family", label: "Whole share family (all recipients together)" },
                  { value: "per_key", label: "Per recipient key (each has its own cap)" },
                ]}
                size="md"
              />
            </div>
          ) : null}
          {keyMode === "share" ? (
            <Input
              label="Recipient slots (max children)"
              type="number"
              min="0"
              value={maxChildren}
              onChange={(e) => setMaxChildren(e.target.value)}
              placeholder="Unlimited…"
              disabled={busy}
            />
          ) : null}
        </div>
        {/*
          * The limit is the number a refusal names. The allowance above it is
          * tenant-wide — set once in Settings, not per key — so it is named
          * here only to point at where it lives. Editing it per key was the
          * double logic this replaced: one number, two places, and the one in
          * this modal silently won.
          */}
        <p className="text-micro leading-normal text-text-tertiary">
          {concurrent === ""
            ? "No concurrency limit, so the tenant allowance does nothing."
            : keyMode === "share"
              ? concurrencyScope === "family"
                ? `Limit ${concurrent} concurrent across the whole share family — all recipients share this one cap.`
                : `Limit ${concurrent} concurrent per recipient key — each key gets its own independent cap.`
              : `Limit ${concurrent} concurrent for this key. Refusals name this number; the allowance above it is tenant-wide and set in Settings.`}
        </p>
        <div
          className="flex items-center justify-between gap-4 rounded-panel border border-inner-border px-4 py-3 bg-surface-2"
        >
          <div>
            <div className="text-caption font-bold text-text-primary">
              <Gauge size={14} className="mr-2 inline text-accent" aria-hidden="true" />
              Token budget
            </div>
            <p className="mt-1 text-text-tertiary text-micro">
              {isOneTime
                ? "One-time cap; it does not reset."
                : "Daily and monthly limits reset automatically."}
            </p>
          </div>
          <div
            className="flex gap-2 rounded-inset border border-inner-border bg-surface-1 p-1"
          >
            <button
              type="button"
              onClick={() => setBudgetMode("recurring")}
              disabled={busy}
              className="py-1.5 px-4 rounded-chip font-semibold border-0 cursor-pointer"
              style={{
                fontSize: "10px",
                background: !isOneTime ? "var(--accent-soft)" : "transparent",
                color: !isOneTime ? "var(--accent)" : "var(--text-tertiary)",
              }}
            >
              <span className="inline-flex items-center gap-2">
                <Repeat2 size={13} aria-hidden="true" />
              Recurring
              </span>
            </button>
            <button
              type="button"
              onClick={() => setBudgetMode("one-time")}
              disabled={busy}
              className="py-1.5 px-4 rounded-chip font-semibold border-0 cursor-pointer"
              style={{
                fontSize: "10px",
                background: isOneTime ? "var(--accent-soft)" : "transparent",
                color: isOneTime ? "var(--accent)" : "var(--text-tertiary)",
              }}
            >
              <span className="inline-flex items-center gap-2">
                <LockKeyhole size={13} aria-hidden="true" />
              One-time
              </span>
            </button>
          </div>
        </div>
        {isOneTime ? (
          <TokenBudgetField
            label="One-time token limit"
            value={lifetime}
            onChange={setLifetime}
            disabled={busy}
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 items-start min-w-0 max-medium:grid-cols-1">
            <TokenBudgetField
              label="Daily token limit"
              value={daily}
              onChange={setDaily}
              disabled={busy}
            />
            <TokenBudgetField
              label="Monthly token limit"
              value={monthly}
              onChange={setMonthly}
              disabled={busy}
            />
          </div>
        )}
      </section>
      </div>
      <section className="flex flex-col gap-3 min-w-0 p-4 border border-inner-border rounded-card bg-surface-2 col-span-full" aria-labelledby="share-popup-heading">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h3 id="share-popup-heading" className="text-caption font-bold text-text-primary">
              <Share2 size={16} className="mr-2 inline text-accent" aria-hidden="true" />
              Share page popup
            </h3>
            <p className="mt-1 text-badge text-text-tertiary">
              Optional card visitors open from the Base URL card on your share page.
            </p>
          </div>
          <Switch
            checked={sharePopupEnabled}
            onChange={(checked) => setSharePopupEnabled(checked)}
            disabled={busy}
            label="Enable popup"
          />
        </div>
        {sharePopupEnabled ? (
          <div className="flex gap-7 items-start mt-2 min-w-0 max-medium:flex-col max-medium:items-stretch">
            <div className="flex flex-col gap-4 min-w-0 w-100 shrink-0 max-medium:w-auto">
              {popupImagePreview ? (
                <img className="block w-full h-66 object-cover border border-inner-border rounded-control bg-surface-1 max-medium:h-80" src={popupImagePreview} alt="Popup image preview" />
              ) : (
                <div className="flex items-center justify-center w-full h-66 object-cover border border-dashed border-inner-border rounded-control bg-surface-1 text-text-tertiary text-badge max-medium:h-80" aria-hidden="true">
                  <span>No image</span>
                </div>
              )}
              <FileInput
                id="share-popup-image"
                accept={SHARE_POPUP_IMAGE_MIMES.join(",")}
                aria-label="Popup image"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  setSharePopupImageError(null);
                  if (file.size > SHARE_POPUP_IMAGE_MAX_BYTES) {
                    setSharePopupImageDataUrl(null);
                    setSharePopupImageError("Image must be 2 MB or smaller.");
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => {
                    setSharePopupImageDataUrl(String(reader.result));
                    setSharePopupImageRemoved(false);
                  };
                  reader.onerror = () => setSharePopupImageError("Could not read that file.");
                  reader.readAsDataURL(file);
                }}
              />
              {popupImagePreview ? (
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={busy}
                  className="h-14 px-5 text-badge self-start"
                  onClick={() => {
                    setSharePopupImageDataUrl(null);
                    setSharePopupImageRemoved(true);
                    setSharePopupImageError(null);
                  }}
                >
                  Remove image
                </Button>
              ) : null}
              {sharePopupImageError ? <p className="form-error">{sharePopupImageError}</p> : null}
              <p className="m-0 text-text-tertiary text-badge leading-normal">PNG, JPEG, WebP, or GIF up to 2 MB.</p>
            </div>
            <div className="flex flex-col gap-4 min-w-0 flex-1 [&_.form-group]:gap-2">
              <Input label="Popup title" value={sharePopupTitle} onChange={(event) => setSharePopupTitle(event.target.value)} maxLength={120} placeholder="Support this gateway" disabled={busy} />
              <div className="form-group">
                <label className="form-label" htmlFor="share-popup-copy">Message</label>
                <textarea className="form-textarea" id="share-popup-copy" value={sharePopupBody} onChange={(event) => setSharePopupBody(event.target.value)} maxLength={1200} rows={3} placeholder="If this service helps you, consider supporting its upkeep…" disabled={busy} />
              </div>
            </div>
          </div>
        ) : null}
      </section>
      <details className="group min-w-0 col-span-full rounded-card border border-inner-border bg-surface-2">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-inset bg-accent-soft text-accent">
              <Shield size={18} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-body font-bold text-text-primary">Access</span>
              <span className="mt-1 block text-badge text-text-tertiary">
                {record?.isDefault
                  ? "Default gateway key · all tenant permissions, including gateway routing and remote debugging."
                  : "Choose model, router, and dashboard permissions for this key."}
              </span>
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-2 rounded-control border border-inner-border bg-surface-1 px-3 py-2 text-micro font-semibold text-text-secondary">
            {scopes.length}/{TENANT_KEY_SCOPES.length} grants
            <ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" />
          </span>
        </summary>
        <div className="flex flex-col gap-4 border-t border-inner-border p-4">
          {record?.isDefault ? (
            <div className="flex items-start gap-3 rounded-control border border-accent/30 bg-accent-soft p-4 text-badge text-text-secondary">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <p className="m-0">
                This default API key is provisioned with every tenant permission, including <code>routing:invoke</code> and
                {" "}<code>routing:cli_mapping</code>. Those grant gateway access and authorization to use remote CLI mappings;
                each client's mapping toggle below still controls whether those routes are active. You can remove individual
                grants here.
              </p>
            </div>
          ) : null}
          {/* Two-column layout: Model Access left, everything else right. Collapses to single column on medium screens. */}
          <div className="grid grid-cols-access gap-5 min-w-0 max-medium:grid-cols-1">
            {/* ── Left column: Model access ── */}
            <section aria-labelledby="model-access-heading" className="flex flex-col gap-3 min-w-0 rounded-card border border-inner-border bg-surface-1 p-4">
              <h4 id="model-access-heading" className="inline-flex items-center gap-2 text-caption font-bold text-text-primary">
                <Boxes size={15} className="text-accent" aria-hidden="true" />
                Model access
              </h4>
              <div role="group" aria-label="Model access mode" className="flex gap-2">
                {(["whitelist", "blacklist"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={modelAccessMode === option}
                    disabled={busy}
                    onClick={() => setModelAccessMode(option)}
                    title={
                      option === "whitelist"
                        ? "Only the listed models may be used. An empty list allows every model."
                        : "The listed models are refused. Everything else is allowed."
                    }
                    className="flex-1 py-2 px-3 text-badge font-semibold"
                    style={{
                      borderRadius: "7px",
                      border: `1px solid ${modelAccessMode === option ? "var(--accent)" : "var(--inner-border)"}`,
                      background: modelAccessMode === option ? "var(--accent-soft)" : "var(--surface-2)",
                      color: modelAccessMode === option ? "var(--accent)" : "var(--text-secondary)",
                      cursor: busy ? "not-allowed" : "pointer",
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {option === "whitelist" ? "Whitelist" : "Blacklist"}
                    {option === "whitelist"
                      ? <ShieldCheck size={13} className="ml-1.5 inline" aria-hidden="true" />
                      : <ShieldX size={13} className="ml-1.5 inline" aria-hidden="true" />}
                  </button>
                ))}
              </div>
              <p className="text-badge text-text-tertiary m-0">
                {modelAccessMode === "whitelist"
                  ? "Only these models may be called. Empty = all allowed."
                  : "These models are refused. Everything else is allowed."}
              </p>
              <div className="flex gap-1.5 flex-wrap min-h-6">
                {models.length === 0 ? (
                  <span className="text-badge text-text-tertiary">
                    {modelAccessMode === "whitelist" ? "All models allowed" : "No models blocked"}
                  </span>
                ) : (
                  models.map((m) => (
                    <span key={m} className="font-mono tabular-nums inline-flex items-center gap-1.5 text-badge bg-accent-soft text-accent py-1 px-3 rounded-chip border border-accent">
                      {m}
                      <button
                        type="button"
                        aria-label={`Remove ${m} from the model list`}
                        onClick={() => setModels((prev) => prev.filter((x) => x !== m))}
                        disabled={busy}
                        className="bg-transparent border-0 cursor-pointer p-0 flex"
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
              <Button variant="secondary" size="sm" type="button" onClick={() => setPickerOpen(true)} disabled={busy}>
                Browse models
              </Button>
              <ModelPickerModal
                open={pickerOpen}
                onClose={() => setPickerOpen(false)}
                selected={models}
                onToggle={(v) =>
                  setModels((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))
                }
                title={modelAccessMode === "whitelist" ? "Select allowed models" : "Select blocked models"}
                multi
              />
            </section>

            {/* ── Right column: 2 bordered cards ── */}
            <div className="flex flex-col gap-4 min-w-0">

              {/* ── Card 1: Routing & Client Blocking ── */}
              <section aria-labelledby="routing-blocking-heading" className="flex flex-col gap-0 min-w-0 rounded-card border border-inner-border bg-surface-1 overflow-hidden">
                <div className="px-4 pt-4 pb-3 border-b border-inner-border">
                  <h4 id="routing-blocking-heading" className="inline-flex items-center gap-2 text-caption font-bold text-text-primary">
                    <Route size={15} className="text-accent" aria-hidden="true" />
                    Routing &amp; Client Blocking
                  </h4>
                  <p className="mt-1 mb-0 text-badge text-text-tertiary">
                    Control which gateway routes this key can call and which client apps are blocked before routing.
                  </p>
                </div>

                <div className="flex flex-col divide-y divide-inner-border">
                  {/* Gateway routing */}
                  <div className="flex flex-col gap-2 px-4 py-3">
                    <p className="text-badge font-semibold text-text-secondary m-0">Gateway routing</p>
                    {TENANT_KEY_SCOPES.filter((scope) => scope === "routing:invoke").map((scope) => (
                      <div
                        key={scope}
                        className="flex items-center justify-between gap-4 py-1.5 px-4 rounded-inset"
                        style={{
                          minHeight: "38px",
                          border: "1px solid var(--inner-border)",
                          background: scopes.includes(scope) ? "var(--accent-soft)" : "var(--surface-2)",
                        }}
                      >
                        <div className="flex items-start gap-3">
                          <Route size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                          <div className="min-w-0">
                            <div className="text-caption font-semibold text-text-primary">{scope}</div>
                            <p className="mt-0.5 mb-0 text-badge text-text-tertiary">{SCOPE_DESCRIPTIONS[scope]}</p>
                          </div>
                        </div>
                        <Switch checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} disabled={busy} aria-label={`Grant ${scope}`} />
                      </div>
                    ))}
                  </div>

                  {/* Blocked client apps */}
                  <div className="flex flex-col gap-2 px-4 py-3">
                      <p className="text-badge font-semibold text-text-secondary m-0">Blocked client apps</p>
                    <div className="flex flex-col gap-2">
                      {CLIENT_ROUTERS.map((router) => (
                        <div
                          key={router.id}
                          className="flex items-center justify-between gap-4 py-1.5 px-4 rounded-inset"
                          style={{
                            minHeight: "38px",
                            border: "1px solid var(--inner-border)",
                            background: blockedRouters.includes(router.id) ? "var(--accent-soft)" : "var(--surface-2)",
                          }}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <Ban size={14} className="shrink-0 text-orange" aria-hidden="true" />
                            <div className="min-w-0">
                              <div className="text-caption font-semibold text-text-primary">Block {router.label} Client</div>
                              <p className="mt-0.5 mb-0 text-badge text-text-tertiary">
                                {router.id === "9router"
                                  ? "9router, Omniroute, and Baazar Probes"
                                  : "Fingerprint-based detection — best-effort; unrecognised clients are never matched"}
                      </p>
                    </div>
                          </div>
                          <Switch
                            checked={blockedRouters.includes(router.id)}
                            onChange={(checked) =>
                              setBlockedRouters((current) =>
                                checked ? [...current, router.id] : current.filter((entry) => entry !== router.id),
                              )
                            }
                            disabled={busy}
                            aria-label={`Block ${router.label} client`}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                  {/* Remote routing */}
                  <div className="px-4 py-3">
                    <RemoteRoutingSection
                      keyId={mode === "edit" && record ? record.id : ""}
                      busy={busy}
                      scopeGranted={scopes.includes("routing:cli_mapping")}
                      onScopeChange={(next) => {
                        if (next === scopes.includes("routing:cli_mapping")) return;
                        toggleScope("routing:cli_mapping");
                      }}
                      persistScope={(next) => {
                        if (mode !== "edit" || !record) return;
                        const nextScopes = next
                          ? [...new Set([...scopes, "routing:cli_mapping"])]
                          : scopes.filter((scope) => scope !== "routing:cli_mapping");
                        updateKey.mutate(
                          { keyId: record.id, request: { scopes: nextScopes } },
                          {
                            onError: (error) =>
                              toast.error(getErrorMessage(error, "Could not update the key's routing scope.")),
                          },
                        );
                      }}
                    />
                  </div>
              </section>

              {/* ── Card 2: Dashboard / Resources ── */}
              <section aria-labelledby="dashboard-scopes-heading" className="flex flex-col gap-0 min-w-0 rounded-card border border-inner-border bg-surface-1 overflow-hidden">
                <div className="px-4 pt-4 pb-3 border-b border-inner-border">
                  <h4 id="dashboard-scopes-heading" className="inline-flex items-center gap-2 text-caption font-bold text-text-primary">
                    <LayoutDashboard size={15} className="text-accent" aria-hidden="true" />
                    Dashboard / Resources
                  </h4>
                  <p className="mt-1 mb-0 text-badge text-text-tertiary">
                    Grants read or write access to console data — providers, models, configuration, and usage stats. No routing is implied by these scopes.
                  </p>
                </div>

                <div className="flex flex-col gap-2 p-4">
                  {TENANT_KEY_SCOPES.filter((scope) => !scope.startsWith("routing:")).map((scope) => (
                    <div
                      key={scope}
                      className="flex items-center justify-between gap-4 py-1.5 px-4 rounded-inset"
                      style={{
                        minHeight: "38px",
                        border: "1px solid var(--inner-border)",
                        background: scopes.includes(scope) ? "var(--accent-soft)" : "var(--surface-2)",
                      }}
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        {(() => {
                          const ScopeIcon = SCOPE_ICONS[scope];
                          return <ScopeIcon size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />;
                        })()}
                        <div className="min-w-0">
                          <div className="text-caption font-semibold text-text-primary">{scope}</div>
                          <p className="mt-0.5 mb-0 text-badge text-text-tertiary">{SCOPE_DESCRIPTIONS[scope]}</p>
                        </div>
                      </div>
                      <Switch checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} disabled={busy} aria-label={`Grant ${scope}`} />
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
