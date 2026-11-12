import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  Cog,
  Copy,
  Eye,
  FlaskConical,
  Globe,
  Loader2,
  LockOpen,
  Pencil,
  PowerOff,
  Trash2,
  Wrench,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { useGatewaySignedModelTest } from "./gateway-model-test";
import { Button } from "../../../components/ui/button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import { Banner } from "../../../components/patterns/banner";
import {
  useCommitDiscoveredModels,
  useDeleteProviderModel,
  useDiscoverModelCandidates,
  useProbeModel,
  useRegisterProviderModels,
  useSetModelEnabled,
  useUpdateModelMetadata,
} from "../../../hooks/providers";
import { type DiscoverModelCandidate, type ModelProbeMode, type ModelWarning } from "../../../data/contracts";
import {
  formatModelTokens,
  parseTokenInput,
  UNKNOWN_LIMITS_TOOLTIP,
  ESTIMATED_LIMITS_TOOLTIP,
  FALLBACK_CONTEXT_TOKENS,
  FALLBACK_OUTPUT_TOKENS,
} from "../../../lib/format/tokens";
import { toast } from "../../../lib/toast";
import { useTrackedTimeout } from "../../../hooks/use-timeout";
import { PROBE_REASONING_EFFORTS, formatThinkingSuffix, type ModelCatalogEntry, type ProbeReasoningEffort } from "../../../data/contracts";
import { formatProbeDuration } from "../../../lib/format/numbers";



/**
 * The badge shown on a non-builtin card, naming where the row came from.
 *
 * `auto_free` is its own case rather than folded into "Fetched": a free-tier row
 * is discovered from a tier the provider publishes, and the section it sits in
 * says the same thing. Labelling it "Fetched" would make the badge disagree with
 * the section heading above it.
 */
function modelSourceTitle(source: string | null): string {
  if (source === "builtin") return "Built-in model";
  if (source === "auto_free") return "Free tier, discovered from the provider";
  if (source === "discovered") return "Fetched from provider";
  return "Added manually";
}

/** The badge label for a non-builtin source. */
function modelSourceBadge(source: string | null): string {
  if (source === "auto_free") return "Free tier";
  if (source === "discovered") return "Fetched";
  return "Manual";
}

/**
 * The four model groups, in the order the model list renders them.
 *
 * Order is a reading order, not a sort: the compiled catalog first (what ships),
 * then what the provider's free tier publishes, then the operator's own hand
 * additions, then the broad fetched tail. `source === null` is a row written
 * before the column existed; it is treated as built-in, which is the
 * conservative reading (disable, not delete) and matches the badge rule.
 *
 * Exported so a test can pin the grouping and its order without rendering.
 */
export const MODEL_GROUPS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly matches: (source: string | null) => boolean;
}> = [
  {
    key: "builtin",
    label: "Built-in models",
    hint: "Compiled catalog — can be disabled, not deleted",
    matches: (source) => source === null || source === "builtin",
  },
  {
    key: "auto_free",
    label: "Free models (auto)",
    hint: "Discovered from the provider's free tier",
    matches: (source) => source === "auto_free",
  },
  {
    key: "manual",
    label: "Manually added",
    hint: "Added by hand from the Add Model dialog",
    matches: (source) => source === "manual",
  },
  {
    key: "fetched",
    label: "Fetched from provider",
    hint: "Listed by the provider's /v1/models",
    matches: (source) => source !== null && source !== "builtin" && source !== "auto_free" && source !== "manual",
  },
];

/**
 * Disabled rows, rendered last and apart from their origin group.
 *
 * `source` and `enabled` are different axes: a built-in row can be disabled and
 * a fetched row can be too, so the two cannot be one partition. This is applied
 * as a filter rather than a fifth source group, because a disabled row has not
 * become a different kind of row — it is still catalog, free, manual, or
 * fetched, and only its routing state changed. Parking those rows at the end
 * keeps a group the operator has switched most of off from filling the top of
 * the list with entries that cannot be routed.
 */
export const DISABLED_GROUP = {
  key: "disabled",
  label: "Disabled models",
  hint: "Turned off — not routable until re-enabled",
} as const;

/** Severity ordering for the one colour the warning badge must pick (D34). */
export function worstWarningSeverity(
  warnings: readonly ModelWarning[],
): "info" | "warn" | "critical" {
  if (warnings.some((warning) => warning.severity === "critical")) return "critical";
  if (warnings.some((warning) => warning.severity === "warn")) return "warn";
  return "info";
}

/** Native hover text: every message, one per line, with its category. */
export function warningTooltip(warnings: readonly ModelWarning[]): string {
  return warnings
    .map((warning) => `[${warning.severity ?? "warn"}] ${warning.kind}: ${warning.message}`)
    .join("\n");
}

const WARNING_TONE: Record<"info" | "warn" | "critical", string> = {
  info: "text-status-info",
  warn: "text-orange",
  critical: "text-red",
};

/**
 * The reasoning effort a probe asks for.
 *
 * `auto` (the default) sends no reasoning intent at all, so the probe reflects
 * what the route does by itself — the right choice when the model's reasoning
 * support is exactly what is in question. A specific effort is sent only when
 * the operator picks one, which is how a probe can be made to follow a setting.
 *
 * The member list comes from the backend tuple (`PROBE_REASONING_EFFORTS`)
 * rather than a hand-written copy, so the selector cannot offer a value the
 * route schema rejects.
 */
/**
 * The options the thinking selector offers.
 *
 * Derived from the backend tuple (`PROBE_REASONING_EFFORTS`) rather than a
 * hand-written copy, so the selector cannot offer a value the route schema
 * rejects — a hand-written list drifts the moment the backend vocabulary does.
 * Exported so a test can pin the vocabulary without opening the Radix portal.
 */
export function probeThinkingOptions(): { value: ProbeReasoningEffort; label: string }[] {
  return PROBE_REASONING_EFFORTS.map((effort) => ({
    value: effort,
    label: effort === "auto" ? "Thinking: auto" : effort.charAt(0).toUpperCase() + effort.slice(1),
  }));
}

/** Per-provider probe mode is gone: the tenant-wide setting (Settings → Model
 * testing) decides fast vs detail for every provider. */

export function ThinkingSelect({
  value,
  onChange,
  disabled,
  size = "md",
  id = "probe-thinking-effort",
}: {
  readonly value: ProbeReasoningEffort;
  readonly onChange: (value: ProbeReasoningEffort) => void;
  readonly disabled?: boolean;
  /** Smaller height for a toolbar/header row; `md` for a form. */
  readonly size?: "sm" | "md";
  /** Distinct per call site: the section header and the Add-Model dialog can be
   * mounted at once, and two triggers sharing one DOM id is invalid. */
  readonly id?: string;
}): ReactNode {
  return (
    <div
      title="Reasoning effort every test in this section sends. Auto leaves the model's own reasoning default in place."
      className="min-w-74 shrink-0 max-sm:min-w-56"
    >
      <Select
        id={id}
        aria-label="Thinking effort"
        value={value}
        disabled={disabled}
        size={size}
        onValueChange={(next) => onChange(next as ProbeReasoningEffort)}
        options={probeThinkingOptions()}
      />
    </div>
  );
}

/** Which rows the Models grid shows. `all` is the default; `free` hides every
 * row the provider does not publish as free tier. */
export type ModelShowFilter = "all" | "free";

/** The display filter options, in the order the selector renders them. */
export function modelShowFilterOptions(): { value: ModelShowFilter; label: string }[] {
  return [
    { value: "all", label: "All models" },
    { value: "free", label: "Free tier" },
  ];
}

/** The "Show" filter in the Models card header, next to the Thinking effort
 * selector. `all` shows every registered model; `free` narrows the grid to the
 * provider's free-tier rows so the rest are hidden. */
export function ShowSelect({
  value,
  onChange,
  disabled,
  size = "md",
  id = "models-show-filter",
}: {
  readonly value: ModelShowFilter;
  readonly onChange: (value: ModelShowFilter) => void;
  readonly disabled?: boolean;
  /** Smaller height for a toolbar/header row; `md` for a form. */
  readonly size?: "sm" | "md";
  /** Distinct per call site, same rule as `ThinkingSelect`. */
  readonly id?: string;
}): ReactNode {
  return (
    <div
      title="Which models to show. Free tier hides every row the provider does not publish as free."
      className="min-w-46 shrink-0 max-sm:min-w-40"
    >
      <Select
        id={id}
        aria-label="Show models"
        value={value}
        disabled={disabled}
        size={size}
        onValueChange={(next) => onChange(next as ModelShowFilter)}
        options={modelShowFilterOptions()}
      />
    </div>
  );
}

export interface AddModelProviderInfo {
  readonly isBuiltIn?: boolean;
  readonly wireFamilyDefault?: string;
  /** When the console says the provider publishes no model directory, the
   * modal opens straight in manual mode instead of burning a doomed fetch. */
  readonly supportsModelDiscovery?: boolean;
  /** Families the backend resolved for this provider (registry for built-ins,
   * BYOK profile for custom). Used to order the wire choice so the provider's
   * own family comes first — not to restrict it: a manually added provider may
   * serve a protocol the gateway carries no bundled knowledge of, so the
   * operator must be able to select any wire family. */
  readonly supportedWireFamilies?: readonly string[];
}

/** Pure trim for the manual id, including the optional provider prefix. */
export function normalizeManualModelId(providerId: string, raw: string): string {
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith(`${providerId.toLowerCase()}/`) &&
    trimmed.length > providerId.length + 1
    ? trimmed.slice(providerId.length + 1)
    : trimmed;
}

/** The unchanged manual form, as one mode of the Add Model modal. */
function ManualAddModelForm({
  providerId,
  provider,
  onClose,
  onSwitchToProvider,
}: {
  readonly providerId: string;
  readonly provider?: AddModelProviderInfo;
  readonly onClose: () => void;
  readonly onSwitchToProvider?: () => void;
}): ReactNode {
  const probe = useProbeModel();
  const register = useRegisterProviderModels();
  const [modelId, setModelId] = useState("");
  // The full vocabulary is always selectable, with the provider's declared
  // families offered first so the sensible choice is the default one. Locking
  // the list to the derived set made a manually added provider unable to reach
  // any wire outside it, which is the one thing this selector exists to do.
  const declaredWires = provider?.supportedWireFamilies;
  const preferredWire =
    provider?.wireFamilyDefault !== undefined &&
    (declaredWires === undefined || declaredWires.includes(provider.wireFamilyDefault))
      ? provider.wireFamilyDefault
      : declaredWires?.[0];
  const wireOptions = useMemo(() => {
    const all = ["chat", "responses", "messages"];
    const preferred = (declaredWires ?? []).filter((value) => all.includes(value));
    return [...preferred, ...all.filter((value) => !preferred.includes(value))];
  }, [declaredWires]);
  const [wireFamily, setWireFamily] = useState(preferredWire ?? "chat");
  const [thinking, setThinking] = useState<ProbeReasoningEffort>("auto");
  const [testState, setTestState] = useState<"idle" | "testing" | "passed" | "failed">("idle");
  const [testError, setTestError] = useState("");
  const [testMeta, setTestMeta] = useState<Readonly<Record<string, unknown>> | null>(null);
  const [draft, setDraft] = useState<ModelMetadataDraft>(newModelDraft);

  const trimmed = modelId.trim();
  // Accept a pasted qualified id (`cline/cline-free/…`): the provider is
  // already selected by the page, so its prefix is stripped. Without this the
  // probe dispatches a literally-prefixed id upstream and always 404s.
  const normalized = normalizeManualModelId(providerId, trimmed);
  const wasPrefixed = normalized !== trimmed;

  const runTest = () => {
    if (!normalized) return;
    setTestState("testing");
    setTestError("");
    setTestMeta(null);
    // Qoder probes default to the legacy COSY surface (the only live chat
    // transport since 2026-11-07); the IDE `/model/v1` surface is dead and
    // answers 404 on every alive host.
    probe.mutate(
      {
        providerId,
        request: {
          modelId: normalized,
          wireFamily,
          reasoningEffort: thinking,
          serviceKind: "llm",
        },
      },
      {
        onSuccess: (result) => {
          if (result.ok) {
            setTestState("passed");
            setTestMeta(result.providerMetadata ?? null);
          } else {
            setTestState("failed");
            setTestError(result.error ?? "Model probe failed");
          }
        },
        onError: (err) => {
          setTestState("failed");
          setTestError((err as { message?: string }).message ?? "Model probe failed");
        },
      },
    );
  };

  const handleAdd = () => {
    if (!normalized) return;
    const contextLimit = parseTokenInput(draft.contextLimit);
    const outputLimit = parseTokenInput(draft.outputLimit);
    // Refuse unreadable input rather than persisting a wrong ceiling: a context
    // limit the operator mistyped makes every request against this model
    // truncate, which reads as the model being broken.
    if (contextLimit === null || outputLimit === null) {
      toast.error("Invalid limits", "Use a token count such as 512k, 200000, or 1.5m.");
      return;
    }
    register.mutate(
      {
        providerId,
        modelIds: [normalized],
        wireFamily,
        metadata: {
          contextLimit: contextLimit ?? null,
          outputLimit: outputLimit ?? null,
          passthrough: draft.passthrough,
          image: draft.passthrough ? true : draft.image,
          reasoning: draft.passthrough ? true : draft.reasoning,
          toolCall: draft.passthrough ? true : draft.toolCall,
        },
      },
      {
        onSuccess: () => {
          toast.success("Custom model added", `Sent to ${providerId}/${normalized}`);
          onClose();
        },
        onError: (err) =>
          toast.error(
            "Failed to add model",
            (err as { message?: string }).message ?? "Unable to register model",
          ),
      },
    );
  };

  return (
    <Dialog open={true} onClose={onClose} title="Add Custom Model" size="sm" footer={
      <>
        {onSwitchToProvider ? (
          <Button variant="secondary" size="sm" onClick={onSwitchToProvider}>
            From provider
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onClose} disabled={register.isPending}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={register.isPending || normalized.length === 0} onClick={handleAdd}>
          {register.isPending ? "Adding..." : "Add Model"}
        </Button>
      </>
    }>
      <Stack gap="10px">
        <Inline gap="8px" align="flex-end">
          <Input
            label="Model ID"
            autoFocus
            placeholder="e.g. gpt-4o, free-model-id"
            value={modelId}
            onChange={(event) => {
              setModelId(event.target.value);
              setTestState("idle");
              setTestError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && normalized.length > 0) runTest();
            }}
            className="flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            icon={
              testState === "testing" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FlaskConical size={13} />
              )
            }
            disabled={probe.isPending || normalized.length === 0}
            onClick={runTest}
            className="shrink-0"
          >
            {testState === "testing" ? "Testing..." : "Test"}
          </Button>
        </Inline>
        {wasPrefixed && (
          <div className="mt-1 text-badge text-text-tertiary">
            Using <span className="font-mono tabular-nums">{normalized}</span> (provider
            prefix removed).
          </div>
        )}
        <Select
          label="Wire family"
          id="add-model-wire-family"
          value={wireFamily}
          onValueChange={(value) => {
            setWireFamily(value);
            setTestState("idle");
            setTestError("");
          }}
          options={wireOptions.map((value) => ({ value, label: wireLabel(value) }))}
        />
        <div>
          <div
            className="text-badge font-semibold text-text-secondary mb-2"
          >
            Thinking
          </div>
          <ThinkingSelect
            id="add-model-thinking-effort"
            value={thinking}
            onChange={(next) => {
              setThinking(next);
              setTestState("idle");
              setTestError("");
            }}
            disabled={probe.isPending}
          />
          <div className="text-badge text-text-tertiary mt-2">
            Sent with the test. Auto leaves the model's own reasoning default in place.
          </div>
        </div>
        <ModelMetadataFields
          draft={draft}
          onChange={setDraft}
          idPrefix="add-model"
          disabled={register.isPending}
        />
        {declaredWires !== undefined && !declaredWires.includes(wireFamily) && (
          <div className="mt-1 text-badge text-text-tertiary">
            This provider does not declare the{" "}
            <span className="font-mono tabular-nums">{wireLabel(wireFamily)}</span> wire.
            The request is sent as chosen; the upstream decides whether it answers.
          </div>
        )}
        {testState === "passed" && (
          <Banner tone="success" live="status">
            Model test passed — ready to add.
            {testMeta !== null && (
              <span className="grid gap-1 mt-2 min-w-0">
                {Object.entries(testMeta)
                  .filter(([, value]) => value !== undefined && value !== null && value !== "")
                  .map(([key, value]) => (
                    <span key={key} className="flex items-center gap-2 min-w-0">
                      <span className="shrink-0 text-micro text-text-tertiary">{key}</span>
                      <span
                        className="truncate font-mono text-micro text-text-secondary"
                        title={String(value)}
                      >
                        {String(value)}
                      </span>
                    </span>
                  ))}
              </span>
            )}
          </Banner>
        )}
        {testState === "failed" && (
          <Banner tone="danger" live="alert">
            {testError || "Model test failed."}
          </Banner>
        )}
      </Stack>
    </Dialog>
  );
}

/** Pure client-side roster filter: case-insensitive substring over `modelId`. */
export function filterDiscoveredModels(
  candidates: readonly DiscoverModelCandidate[],
  search: string,
): readonly DiscoverModelCandidate[] {
  const q = search.trim().toLowerCase();
  return q ? candidates.filter((item) => item.modelId.toLowerCase().includes(q)) : candidates;
}

/**
 * Provider mode: the read-only upstream roster, searched client-side over
 * `modelId`, with multi-select chips and a disabled "Registered" state.
 * Nothing is written until commit, and the server re-runs discovery to reject
 * ids that are not in the live roster.
 */
function ProviderAddModelPanel({
  providerId,
  onClose,
  onManual,
}: {
  readonly providerId: string;
  readonly onClose: () => void;
  readonly onManual: () => void;
}): ReactNode {
  const query = useDiscoverModelCandidates(providerId);
  const commit = useCommitDiscoveredModels();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);

  const candidates = query.data?.candidates ?? [];
  // A console that reports no discovery support falls back to the manual form
  // through the same explicit "Add manually" affordance as a failed fetch.
  const unsupported = query.data?.supported === false;
  const filtered = useMemo(
    () => filterDiscoveredModels(candidates, search),
    [candidates, search],
  );
  const toggle = (modelId: string) => {
    setSelected((prev) =>
      prev.includes(modelId)
        ? prev.filter((id) => id !== modelId)
        : [...prev, modelId],
    );
  };
  const canCommit = selected.length > 0 && !commit.isPending && !unsupported;
  const handleCommit = () => {
    if (!canCommit) return;
    commit.mutate(
      { providerId, modelIds: selected },
      {
        onSuccess: () => onClose(),
        onError: (err) =>
          toast.error("Failed to add models", (err as { message?: string }).message ?? "Unable to commit models"),
      },
    );
  };
  const accountNote = query.data?.accountLabel
    ? `Using account ${query.data.accountLabel}`
    : "Using the first usable account";

  return (
    <Dialog open={true} onClose={onClose} title="Add Model" size="lg" footer={
      <>
        <Button variant="secondary" size="sm" onClick={onManual}>Add manually</Button>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={commit.isPending}>Cancel</Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canCommit}
          onClick={handleCommit}
          title={selected.length === 0 ? "Select at least one model" : `Add ${selected.length} model(s)`}
        >
          {commit.isPending ? "Adding..." : `Add selected (${selected.length})`}
        </Button>
      </>
    }>
      <Stack gap="10px">
        <div className="text-badge text-text-tertiary" data-testid="discover-account-label">
          {accountNote} · configs follow the provider listing.
        </div>
        {unsupported ? (
          <Banner tone="warning" surface="raised">
            This provider does not publish a model directory. Use{" "}
            <Button variant="ghost" size="sm" onClick={onManual}>Add manually</Button>{" "}
            to add a model by id.
          </Banner>
        ) : null}
        <div className="relative">
          <Search size={14} aria-hidden="true" className="absolute left-5 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            aria-label="Search discovered models"
            placeholder="Search models…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full max-w-full rounded-inset border border-inner-border bg-surface-2 py-4 pr-5 pl-16 text-caption text-text-primary"
          />
        </div>
        {selected.length > 0 ? (
          <div className="flex flex-wrap gap-3 rounded-inset border border-inner-border bg-surface-2 p-4">
            {selected.map((id) => (
              <span
                key={id}
                className="font-mono tabular-nums inline-flex items-center gap-2 text-badge bg-accent-soft text-accent py-1 px-3 rounded-chip border border-accent max-w-full overflow-hidden break-all"
              >
                <span className="overflow-hidden truncate whitespace-nowrap">{id}</span>
                <button
                  type="button"
                  aria-label={`Remove ${id}`}
                  onClick={() => toggle(id)}
                  className="bg-transparent border-none cursor-pointer p-0 flex shrink-0"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex min-h-160 max-h-320 flex-1 flex-col gap-3 overflow-y-auto rounded-control border border-inner-border bg-surface-1 p-6">
          {query.isPending ? (
            <div className="p-16 text-center text-caption text-text-tertiary">Fetching models from provider…</div>
          ) : unsupported ? (
            <div className="p-16 text-center text-caption text-text-tertiary">
              No provider listing available.
            </div>
          ) : query.isError ? (
            <div className="p-10 text-center text-caption">
              <Banner tone="danger" live="alert">
                Could not fetch the provider's model list. Add manually is still available.
              </Banner>
              <div className="flex gap-3 justify-center mt-4">
                <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>Retry</Button>
                <Button variant="primary" size="sm" onClick={onManual}>Add manually</Button>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-16 text-center text-caption text-text-tertiary">No models found.</div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filtered.map((item: DiscoverModelCandidate) => {
                const picked = selected.includes(item.modelId);
                const disabled = item.alreadyRegistered;
                return (
                  <label
                    key={item.modelId}
                    className={`block min-w-0 rounded-control border border-inner-border p-4 text-caption transition-colors ${disabled ? "opacity-60" : "cursor-pointer hover:bg-hover"}`}
                  >
                    <div className="flex items-center gap-4">
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.modelId}`}
                        checked={picked}
                        disabled={disabled}
                        onChange={() => toggle(item.modelId)}
                      />
                      <span className="font-mono tabular-nums truncate flex-1 min-w-0 text-badge font-medium" title={item.modelId}>
                        {item.modelId}
                      </span>
                      {item.freeTier === true ? (
                        <span className="shrink-0 rounded-pill border border-teal-soft px-3 py-0.5 text-micro text-teal">Free tier</span>
                      ) : null}
                      {item.proOnly === true ? (
                        <span className="shrink-0 rounded-tiny border border-orange bg-orange-soft px-3 py-0.5 text-micro text-orange">Pro</span>
                      ) : null}
                      {disabled ? (
                        <span className="shrink-0 rounded-pill border border-inner-border px-3 py-0.5 text-micro font-bold text-text-tertiary">Registered</span>
                      ) : null}
                      {picked ? <Check size={13} aria-hidden="true" className="shrink-0 text-accent" /> : null}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 pl-2 text-micro text-text-tertiary">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-text-quaternary">Context</span>
                        <span className="font-mono tabular-nums text-text-secondary">
                          {formatModelTokens(item.contextLimit)}
                        </span>
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-text-quaternary">Output</span>
                        <span className="font-mono tabular-nums text-text-secondary">
                          {formatModelTokens(item.outputLimit)}
                        </span>
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </Stack>
    </Dialog>
  );
}

/**
 * One modal, two modes: "From provider" by default, manual only as fallback.
 * A provider that answers `supported: false` from the wire is handled inside
 * the provider panel itself, so the modal only ever fetches once.
 */
export function AddModelModal({
  providerId,
  provider,
  onClose,
}: {
  readonly providerId: string;
  readonly provider?: AddModelProviderInfo;
  readonly onClose: () => void;
}): ReactNode {
  const [manual, setManual] = useState(provider?.supportsModelDiscovery === false);
  if (manual) {
    return (
      <ManualAddModelForm
        providerId={providerId}
        provider={provider}
        onClose={onClose}
        onSwitchToProvider={() => setManual(false)}
      />
    );
  }
  return (
    <ProviderAddModelPanel
      providerId={providerId}
      onClose={onClose}
      onManual={() => setManual(true)}
    />
  );
}

/** Operator-entered limits/capabilities for a model the catalog cannot size. */
interface ModelMetadataDraft {
  /** Empty string means "unknown" — the operator left it blank. */
  readonly contextLimit: string;
  readonly outputLimit: string;
  readonly passthrough: boolean;
  readonly image: boolean;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
}

/** Draft used when a model's own limits are already known (edit of a fetched row). */
function emptyDraft(): ModelMetadataDraft {
  return {
    contextLimit: "",
    outputLimit: "",
    passthrough: false,
    image: true,
    reasoning: true,
    toolCall: true,
  };
}

/**
 * The fallback ceilings, spelled so the input field reads them back exactly.
 *
 * The exact counts, not `formatModelTokens`' rounded `131k`: that spelling is
 * what a card shows, but parsing it back yields 131000, so a draft seeded from
 * it would persist a different number than the one on screen.
 */
const FALLBACK_CONTEXT_TEXT = String(FALLBACK_CONTEXT_TOKENS);
const FALLBACK_OUTPUT_TEXT = String(FALLBACK_OUTPUT_TOKENS);

/** Draft for a brand-new manual add: start on the documented fallback ceilings. */
function newModelDraft(): ModelMetadataDraft {
  return { ...emptyDraft(), contextLimit: FALLBACK_CONTEXT_TEXT, outputLimit: FALLBACK_OUTPUT_TEXT };
}

/**
 * Limits + capabilities editor, shared by the add and edit dialogs.
 *
 * `passthrough` disables the per-capability switches instead of clearing them:
 * it grants everything, so showing them unchecked would misrepresent the
 * result. They keep their last state so unchecking passthrough restores the
 * operator's own choices.
 */
function ModelMetadataFields({
  draft,
  onChange,
  idPrefix,
  disabled = false,
}: {
  readonly draft: ModelMetadataDraft;
  readonly onChange: (next: ModelMetadataDraft) => void;
  readonly idPrefix: string;
  readonly disabled?: boolean;
}): ReactNode {
  const passthrough = draft.passthrough;
  return (
    <Stack gap="10px">
      <div>
        <div className="text-badge font-semibold text-text-secondary mb-2">Limits</div>
        <Inline gap="8px">
          <Input
            label="Context"
            id={`${idPrefix}-context`}
            placeholder={FALLBACK_CONTEXT_TEXT}
            value={draft.contextLimit}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, contextLimit: event.target.value })
            }
            className="flex-1"
          />
          <Input
            label="Output"
            id={`${idPrefix}-output`}
            placeholder={FALLBACK_OUTPUT_TEXT}
            value={draft.outputLimit}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, outputLimit: event.target.value })}
            className="flex-1"
          />
        </Inline>
        <label className="inline-flex items-center gap-2 mt-2 text-badge text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            id={`${idPrefix}-fallback-limits`}
            checked={
              draft.contextLimit === FALLBACK_CONTEXT_TEXT &&
              draft.outputLimit === FALLBACK_OUTPUT_TEXT
            }
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? {
                      ...draft,
                      contextLimit: FALLBACK_CONTEXT_TEXT,
                      outputLimit: FALLBACK_OUTPUT_TEXT,
                    }
                  : { ...draft, contextLimit: "", outputLimit: "" },
              )
            }
          />
          Use fallback — {formatModelTokens(FALLBACK_CONTEXT_TOKENS)} ctx ·{" "}
          {formatModelTokens(FALLBACK_OUTPUT_TOKENS)} out
        </label>
      </div>
      <div>
        <div className="text-badge font-semibold text-text-secondary mb-2">Capabilities</div>
        <Stack gap="6px">
          {(
            [
              ["image", "Can image", draft.image],
              ["reasoning", "Reasoning", draft.reasoning],
              ["toolCall", "Tools", draft.toolCall],
            ] as const
          ).map(([field, label, checked]) => (
            <label
              key={field}
              className="inline-flex items-center gap-2 text-badge text-text-secondary"
              style={passthrough ? { opacity: 0.5 } : undefined}
            >
              <input
                type="checkbox"
                id={`${idPrefix}-${field}`}
                checked={passthrough ? true : checked}
                disabled={disabled || passthrough}
                onChange={(event) => onChange({ ...draft, [field]: event.target.checked })}
              />
              {label}
            </label>
          ))}
        </Stack>
        <label className="inline-flex items-center gap-2 mt-2 text-badge text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            id={`${idPrefix}-passthrough`}
            checked={draft.passthrough}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, passthrough: event.target.checked })}
          />
          Passthrough — accept every capability
        </label>
        {passthrough ? (
          <div className="text-badge text-text-tertiary mt-2">
            Passthrough grants all of the above, so they are locked on. Uncheck it to
            restore your own choices.
          </div>
        ) : null}
      </div>
    </Stack>
  );
}

/**
 * Warning editor for a non-builtin row (D33).
 *
 * `null` is a real value here: it clears `warning_metadata` on the server,
 * while an absent `warnings` field leaves the stored array alone. The editor
 * therefore always sends the field. Built-in rows never reach this component —
 * `ModelGrid` omits the pencil for them, since the seeder would overwrite any
 * operator edit on the next boot.
 */
function WarningEditor({
  warnings,
  onChange,
  idPrefix,
  disabled = false,
}: {
  readonly warnings: readonly ModelWarning[];
  readonly onChange: (next: readonly ModelWarning[]) => void;
  readonly idPrefix: string;
  readonly disabled?: boolean;
}): ReactNode {
  const updateAt = (index: number, patch: Partial<ModelWarning>): void => {
    onChange(warnings.map((warning, at) => (at === index ? { ...warning, ...patch } : warning)));
  };
  return (
    <Stack gap="6px">
      <div className="flex items-center justify-between gap-3">
        <div className="text-badge font-semibold text-text-secondary">Warnings</div>
        {warnings.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([])}
            aria-label="Clear all warnings"
            title="Clear all warnings"
          >
            Clear
          </Button>
        ) : null}
      </div>
      {warnings.length === 0 ? (
        <div className="text-badge text-text-tertiary">No warnings. Add one to flag a provider caveat on this model.</div>
      ) : null}
      {warnings.map((warning, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-inset border border-inner-border p-4">
          <div className="flex items-center gap-3 min-w-0">
            <Input
              id={`${idPrefix}-warning-kind-${index}`}
              aria-label={`Warning ${index + 1} kind`}
              placeholder="kind (e.g. fallback_model)"
              value={warning.kind}
              disabled={disabled}
              onChange={(event) => updateAt(index, { kind: event.target.value })}
              className="flex-1"
            />
            <Select
              id={`${idPrefix}-warning-severity-${index}`}
              aria-label={`Warning ${index + 1} severity`}
              value={warning.severity ?? "warn"}
              disabled={disabled}
              size="sm"
              onValueChange={(next) =>
                updateAt(index, { severity: next === "info" || next === "critical" ? next : "warn" })
              }
              options={[
                { value: "info", label: "Info" },
                { value: "warn", label: "Warn — default" },
                { value: "critical", label: "Critical" },
              ]}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={12} />}
              disabled={disabled}
              onClick={() => onChange(warnings.filter((_, at) => at !== index))}
              aria-label={`Remove warning ${index + 1}`}
              title="Remove warning"
            />
          </div>
          <Input
            id={`${idPrefix}-warning-message-${index}`}
            aria-label={`Warning ${index + 1} message`}
            placeholder="Message shown on hover"
            value={warning.message}
            disabled={disabled}
            onChange={(event) => updateAt(index, { message: event.target.value })}
          />
          {warning.updatedAt ? (
            <div className="text-micro text-text-tertiary">Updated {warning.updatedAt}</div>
          ) : null}
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() =>
          onChange([
            ...warnings,
            { kind: "", message: "", severity: "warn" },
          ])
        }
      >
        Add warning
      </Button>
    </Stack>
  );
}

/**
 * Edits one existing model's limits and capabilities.
 *
 * Only the fields the operator changes are sent: an absent field leaves the
 * stored value alone, so correcting a context ceiling cannot silently reset the
 * capability flags to their defaults.
 */
export function EditModelModal({
  providerId,
  model,
  onClose,
}: {
  readonly providerId: string;
  readonly model: ModelCatalogEntry;
  readonly onClose: () => void;
}): ReactNode {
  const update = useUpdateModelMetadata();
  // Seeded from the row so the form shows what is stored, not a blank slate —
  // an edit dialog that starts empty makes "I only wanted to fix the context
  // number" silently clear the capabilities too.
  const [draft, setDraft] = useState<ModelMetadataDraft>(() => ({
    contextLimit: model.contextLimit ? String(model.contextLimit) : "",
    outputLimit: model.outputLimit ? String(model.outputLimit) : "",
    passthrough: false,
    image: model.vision === true,
    reasoning: model.reasoning === true,
    toolCall: model.toolCall === true,
  }));
  const [warnings, setWarnings] = useState<readonly ModelWarning[]>(() => [...(model.warnings ?? [])]);
  const warningsChanged =
    JSON.stringify(warnings) !== JSON.stringify(model.warnings ?? []);

  const handleSave = () => {
    const contextLimit = parseTokenInput(draft.contextLimit);
    const outputLimit = parseTokenInput(draft.outputLimit);
    if (contextLimit === null || outputLimit === null) {
      toast.error("Invalid limits", "Use a token count such as 512k, 200000, or 1.5m.");
      return;
    }
    if (warnings.some((warning) => warning.kind.trim() === "" || warning.message.trim() === "")) {
      toast.error("Invalid warning", "Every warning needs a kind and a message.");
      return;
    }
    const now = new Date().toISOString();
    const payloadWarnings = warningsChanged
      ? warnings.length === 0
        ? null
        : warnings.map((warning) => ({ ...warning, updatedAt: now }))
      : undefined;
    update.mutate(
      {
        providerId,
        modelId: model.modelId,
        route: model.route ?? "",
        metadata: {
          contextLimit: contextLimit ?? null,
          outputLimit: outputLimit ?? null,
          passthrough: draft.passthrough,
          image: draft.passthrough ? true : draft.image,
          reasoning: draft.passthrough ? true : draft.reasoning,
          toolCall: draft.passthrough ? true : draft.toolCall,
          ...(payloadWarnings === undefined ? {} : { warnings: payloadWarnings }),
        },
      },
      {
        onSuccess: () => onClose(),
        onError: (err) =>
          toast.error(
            "Failed to update model",
            (err as { message?: string }).message ?? "Unable to update model",
          ),
      },
    );
  };

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="Edit Model"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={update.isPending} onClick={handleSave}>
            {update.isPending ? "Saving..." : "Save"}
          </Button>
        </>
      }
    >
      <Stack gap="10px">
        <div className="text-badge text-text-tertiary">
          Editing <span className="font-mono tabular-nums">{model.modelId}</span>
        </div>
        <ModelMetadataFields
          draft={draft}
          onChange={setDraft}
          idPrefix="edit-model"
          disabled={update.isPending}
        />
        <WarningEditor
          warnings={warnings}
          onChange={setWarnings}
          idPrefix="edit-model"
          disabled={update.isPending}
        />
      </Stack>
    </Dialog>
  );
}

function ModelCard({
  providerId,
  model,
  serviceKind,
  searchCapable,
  thinkingEffort,
  probeMode,
  onDeleteRequest,
  onEditRequest,
  deletePending,
  onRegisterProbe,
}: {
  readonly providerId: string;
  readonly model: ModelCatalogEntry;
  readonly serviceKind: "llm" | "websearch";
  /** Provider-level: the provider's adapter drives a hosted web-search tool. */
  readonly searchCapable: boolean;
  /** The section-wide reasoning effort, owned by the Models card header so one
   * setting governs every test in the section instead of each card carrying
   * its own — which is what made "set thinking, then test" need a per-card repeat. */
  readonly thinkingEffort: ProbeReasoningEffort;
  /** Section-wide probe mode; `fast` shortens the gateway test and the console probe. */
  readonly probeMode: ModelProbeMode;
  readonly onDeleteRequest: (model: ModelCatalogEntry) => void;
  /** Absent for a shared/built-in row, which the tenant cannot edit. */
  readonly onEditRequest?: ((model: ModelCatalogEntry) => void) | undefined;
  readonly deletePending: boolean;
  /** Registers this card's probe runner so the section's Test-all button can
   * fire every card's own Test at once — no separate batch API. */
  readonly onRegisterProbe?: (modelId: string, run: () => void) => void;
}): ReactNode {
  const gatewayTest = useGatewaySignedModelTest();
  const probeConsole = useProbeModel();
  const setEnabled = useSetModelEnabled();
  const [copied, setCopied] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; latencyMs: number } | null>(null);
  const [probeMeta, setProbeMeta] = useState<Readonly<Record<string, unknown>> | null>(null);
  const [showMetaDetails, setShowMetaDetails] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const scheduleCopyReset = useTrackedTimeout();
  const warnings = model.warnings ?? [];

  // The routable id for this model under the section's thinking setting. The
  // suffix is what a client writes to ask for that level (`model(high)`), and
  // the backend parses it back off the name — so the copy button hands the
  // operator exactly the id the probe just used. `auto` means "no reasoning
  // intent", which is the bare id, not a `(auto)` suffix.
  const qualifiedId =
    serviceKind === "llm"
      ? formatThinkingSuffix(model.modelId, thinkingEffort === "auto" ? null : thinkingEffort)
      : model.modelId;
  const copyId = `${providerId}/${qualifiedId}`;
  const pendingLabel = serviceKind === "websearch" ? "Searching…" : "Thinking…";
  const runProbe = () => {
    // Qoder's probe console path defaults to the legacy COSY surface (the
    // only live chat transport since 2026-11-07; the IDE `/model/v1` surface
    // answers 404 on every alive host). The gate test path sees the same
    // transport. For Qoder the console probe is the trusted source, so use it
    // directly.
    setShowMetaDetails(false);
    const qoder = providerId === "qoder" || providerId === "qodercn";
    if (qoder) {
      probeConsole.mutate(
        { providerId, request: { modelId: model.modelId, serviceKind: "llm", mode: probeMode } },
        {
          onSuccess: (result) => {
            setProbeResult({ ok: result.ok, latencyMs: result.latencyMs });
            setProbeMeta(result.providerMetadata ?? null);
            if (!result.ok) {
              toast.error(
                `${providerId}/${qualifiedId} test failed`,
                result.error ?? "Unknown error",
              );
              return;
            }
            const sample = result.sample ?? "";
            const reported = result.reportedModel?.trim() ?? "";
            const meta = result.providerMetadata;
            const metaEntries = meta
              ? Object.entries(meta).filter(([, value]) => value !== undefined && value !== null && value !== "")
              : [];
            toast.successRich(
              `${qualifiedId} · END ${formatProbeDuration(result.latencyMs)}`,
              <span className="grid gap-2 min-w-0">
                {reported ? (
                  <Inline gap="6px" align="center" className="min-w-0">
                    <Cog size={12} aria-hidden="true" className="shrink-0 text-text-tertiary" />
                    <span className="truncate font-mono text-badge text-text-secondary" title={reported}>
                      {reported}
                    </span>
                  </Inline>
                ) : null}
                {metaEntries.length > 0 ? (
                  <span className="grid gap-1 min-w-0">
                    {metaEntries.map(([key, value]) => (
                      <Inline key={key} gap="6px" align="center" className="min-w-0">
                        <span className="shrink-0 text-micro text-text-tertiary">{key}</span>
                        <span
                          className="truncate font-mono text-micro text-text-secondary"
                          title={String(value)}
                        >
                          {String(value)}
                        </span>
                      </Inline>
                    ))}
                  </span>
                ) : null}
                <span>{sample || "No sample text in the response."}</span>
              </span>,
              [reported, sample].filter(Boolean).join("\n") || "No sample text in the response.",
            );
          },
          onError: (err) => {
            setProbeResult({ ok: false, latencyMs: 0 });
            setProbeMeta(null);
            toast.error(
              `${providerId}/${qualifiedId} test failed`,
              (err as { message?: string }).message ?? "Model probe failed",
            );
          },
        },
      );
      return;
    }
    // D41: the gateway path stays. A console probe skips the routing ladder
    // and reports a false "Fail" for a model that routes fine on a credited
    // account, so `fast` is expressed as a small token budget + a short abort
    // deadline on the same signed /v1/chat/completions request.
    void gatewayTest.test(copyId, model.outputLimit ?? undefined, { fast: probeMode === "fast" }).then((result) => {
      setProbeResult({ ok: result.ok, latencyMs: result.latencyMs });
      setProbeMeta(null);
      if (!result.ok) {
        toast.error(
          `${providerId}/${qualifiedId} test failed`,
          result.error ?? "Unknown error",
        );
        return;
      }
      const sample = result.sample ?? "";
      const reported = result.reportedModel?.trim() ?? "";
      toast.successRich(
        `${qualifiedId} · END ${formatProbeDuration(result.latencyMs)}`,
        <span className="grid gap-2 min-w-0">
          {reported ? (
            // The model the upstream said it ran, verbatim. No prefix
            // stripping and no comparison: a test answered by a different
            // model than it asked for is the finding, and normalising it
            // would erase the only evidence.
            <Inline gap="6px" align="center" className="min-w-0">
              <Cog size={12} aria-hidden="true" className="shrink-0 text-text-tertiary" />
              <span className="truncate font-mono text-badge text-text-secondary" title={reported}>
                {reported}
              </span>
            </Inline>
          ) : null}
          <span>{sample || "No sample text in the response."}</span>
        </span>,
        [reported, sample].filter(Boolean).join("\n") || "No sample text in the response.",
      );
    });
  };

  // Expose this card's probe runner to the section's Test-all button. The
  // registry is keyed by model id; re-registering on every render keeps it
  // current (thinking/probe mode changes rebind the runner).
  useEffect(() => {
    onRegisterProbe?.(model.modelId, runProbe);
  });

  const toggleEnabled = () => {
    const nextEnabled = !model.enabled;
    setEnabled.mutate(
      { providerId, request: { modelId: model.modelId, route: model.route, enabled: nextEnabled } },
      {
        onSuccess: () =>
          toast.success(nextEnabled ? "Model enabled" : "Model disabled", model.modelId),
        onError: (err) =>
          toast.error(
            "Failed to update model",
            (err as { message?: string }).message ?? "Unable to update model",
          ),
      },
    );
  };
  return (
    <>
      <div
        className={`model-card box-border flex w-full min-w-0 flex-1-auto flex-col gap-5 rounded-panel border border-inner-border p-6 ${model.enabled ? "bg-surface-2" : "bg-surface-1 opacity-72"}`}
        data-model-id={model.modelId}
      >
        {/* Header: icon tile + name (single-line ellipsis, no mid-token wrap) + copy */}
        <div className="flex items-start gap-4 min-w-0">
          <span
            className="inline-flex items-center justify-center w-13 h-13 rounded-inset bg-teal-soft text-teal shrink-0"
          >
            <Bot size={14} />
          </span>
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div
              title={copyId}
              className="font-mono tabular-nums min-w-0 truncate text-caption font-semibold leading-[1.35]"
            >
              {qualifiedId}
            </div>
            <div
              className="flex items-center gap-3 min-w-0 text-micro text-text-tertiary"
            >
              <span
                title={`${model.wireFamily} · ${model.route ?? providerId}`}
                className="shrink-0 rounded-tiny px-3.5 py-0.5 text-micro font-bold"
                // The wire family is a runtime value from the catalog, so its
                // chip colours stay inline.
                style={{ ...wireChipStyle(model.wireFamily) }}
              >
                {wireLabel(model.wireFamily)}
              </span>
              {model.source !== null && model.source !== "builtin" ? (
                <span
                  title={modelSourceTitle(model.source)}
                  className="shrink-0 rounded-pill border border-teal-soft px-3 py-0.5 text-micro font-bold tracking-[0.04em] text-teal"
                >
                  {modelSourceBadge(model.source)}
                </span>
              ) : null}
              {model.proOnly === true ? (
                <span
                  title="Refused on a free plan. Nothing in the provider's model directory predicts it, so this comes from a real dispatch: the upstream answers that the model is not allowed for a free user type."
                  className="shrink-0 rounded-tiny border border-orange bg-orange-soft px-3.5 py-0.5 text-micro font-bold uppercase tracking-[0.04em] text-orange"
                >
                  Pro
                </span>
              ) : null}
              {/* Free tier for a static row, styled as the source badge so the
                  card keeps one visual vocabulary. Suppressed when the row is
                  already `auto_free` — that source badge says the same thing, and
                  showing both put two "Free tier" labels on one card. The flag
                  comes from the provider's directory (Qoder states `is_free` per
                  row), so the pill tracks plan changes. */}
              {model.freeTier === true && model.source !== "auto_free" ? (
                <span
                  title="Free on this provider's plan. Taken from the provider's own model directory, not a hardcoded list, so it tracks plan changes."
                  className="shrink-0 rounded-pill border border-teal-soft px-3 py-0.5 text-micro font-bold text-teal"
                >
                  Free tier
                </span>
              ) : null}

              {warnings.length > 0 ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Model warnings: ${warnings.length}`}
                  aria-expanded={showWarnings}
                  title={warningTooltip(warnings)}
                  onClick={() => setShowWarnings((open) => !open)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setShowWarnings((open) => !open);
                    }
                  }}
                  className={`estimate-dot inline-flex items-center justify-center rounded-full border border-inner-border bg-surface-2 cursor-help shrink-0 ${WARNING_TONE[worstWarningSeverity(warnings)]}`}
                  data-severity={worstWarningSeverity(warnings)}
                >
                  <AlertTriangle size={9} aria-hidden="true" />
                </span>
              ) : null}
              {model.enabled ? null : (
                <span
                  className="shrink-0 rounded-pill bg-red-soft px-3 py-0.5 text-micro font-bold tracking-[0.04em] text-red"
                >
                  Off
                </span>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={copied ? <Check size={12} /> : <Copy size={12} />}
            aria-label={`Copy ${copyId}`}
            title={`Copy ${copyId}`}
            onClick={() => {
              void navigator.clipboard?.writeText(copyId);
              setCopied(true);
              scheduleCopyReset(() => setCopied(false), 1500);
            }}
            className="shrink-0 p-2 opacity-70"
          />
        </div>

        {/* Meta: one quiet line — caps + latency live here, not inside the button */}
        <div
          className="flex items-center gap-3 min-w-0 text-badge text-text-secondary"
        >
          <span className="inline-flex gap-2.5">
            {model.reasoning ? (
              <span title="Reasoning" aria-label="Reasoning" className="inline-flex text-purple">
                <Brain size={12} />
              </span>
            ) : null}
            {model.vision ? (
              <span title="Vision" aria-label="Vision" className="inline-flex text-status-info">
                <Eye size={12} />
              </span>
            ) : null}
            {model.toolCall ? (
              <span title="Tool calling" aria-label="Tool calling" className="inline-flex text-orange">
                <Wrench size={12} />
              </span>
            ) : null}
            {searchCapable ? (
              <span title="Web search" aria-label="Web search" className="inline-flex text-teal">
                <Globe size={12} />
              </span>
            ) : null}
          </span>
          <span className="whitespace-nowrap">
            {model.limitsEstimated ? (
              <span
                title={ESTIMATED_LIMITS_TOOLTIP}
                aria-label="Limits are a fallback estimate"
                className="estimate-dot inline-flex items-center justify-center rounded-full border border-inner-border bg-surface-2 text-orange cursor-help mr-1 align-middle"
              >
                <AlertCircle size={9} aria-hidden="true" />
              </span>
            ) : null}
            {model.contextLimit ? (
              `${formatModelTokens(model.contextLimit)} ctx`
            ) : (
              <span title={UNKNOWN_LIMITS_TOOLTIP} className="cursor-help">
                n/a ctx
              </span>
            )}
            {model.outputLimit ? (
              ` · ${formatModelTokens(model.outputLimit)} out`
            ) : (
              <span title={UNKNOWN_LIMITS_TOOLTIP} className="cursor-help">
                {` · n/a out`}
              </span>
            )}
          </span>
          {/* Edit sits on the meta line, right after the limits it changes —
              not in the action row below, where it would read as another
              test/delete action rather than as editing these numbers. */}
          {onEditRequest ? (
            <button
              type="button"
              className="shrink-0 grid place-items-center w-6 h-6 p-0 border-0 bg-transparent text-text-tertiary cursor-pointer rounded-tiny hover:bg-inner-border hover:text-text-primary"
              title="Edit limits and capabilities"
              aria-label={`Edit ${model.modelId} limits and capabilities`}
              onClick={() => onEditRequest(model)}
            >
              <Pencil size={11} />
            </button>
          ) : null}
        </div>

        {/* Actions: equal-weight buttons; the thinking setting lives in the
            section header so it applies to the whole section at once. */}
        <div className="flex gap-3 items-center flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            disabled={gatewayTest.testing || probeConsole.isPending}
            onClick={runProbe}
            aria-label={`Test ${qualifiedId}`}
            title={
              gatewayTest.testing || probeConsole.isPending
                ? `Probing ${qualifiedId}…`
                : probeResult?.ok
                  ? `Last probe OK in ${formatProbeDuration(probeResult.latencyMs)} — click to re-test${probeMeta ? `\n${Object.entries(probeMeta).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}: ${String(v)}`).join("\n")}` : ""}`
                  : probeResult
                    ? "Last probe failed — click to retry"
                    : `Test ${qualifiedId}`
            }
            className="flex-1 justify-center"
            icon={
              gatewayTest.testing || probeConsole.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : probeResult ? (
                probeResult.ok ? (
                  <span className="inline-flex text-green">
                    <CheckCircle2 size={12} />
                  </span>
                ) : (
                  <span className="inline-flex text-red">
                    <AlertTriangle size={12} />
                  </span>
                )
              ) : (
                <FlaskConical size={12} />
              )
            }
          >
            {gatewayTest.testing || probeConsole.isPending
              ? pendingLabel
              : probeResult?.ok
                ? formatProbeDuration(probeResult.latencyMs)
                : probeResult
                  ? "Fail"
                  : "Test"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={setEnabled.isPending}
            onClick={toggleEnabled}
            icon={model.enabled ? <PowerOff size={12} /> : <LockOpen size={12} />}
            aria-label={model.enabled ? `Disable ${model.modelId}` : `Enable ${model.modelId}`}
            title={model.enabled ? "Disable model" : "Enable model"}
            className={`flex-1 justify-center ${model.enabled ? "text-red" : "text-green"}`}
          >
            {model.enabled ? "Disable" : "Enable"}
          </Button>
          {/* Built-in models are immutable catalog: disable only, never delete. */}
          {model.source === "builtin" ? null : (
            <Button
              variant="ghost"
              size="sm"
              disabled={deletePending}
              onClick={() => onDeleteRequest(model)}
              icon={<Trash2 size={12} />}
              aria-label={`Delete ${model.modelId}`}
              title="Delete model"
              className="model-card-delete shrink-0 px-4 py-3 text-text-tertiary"
            />
          )}
        </div>
        {showWarnings ? (
          <div className="grid gap-1 pt-1 min-w-0" data-testid="model-warning-details">
            {warnings.map((warning, index) => (
              <div key={`${warning.kind}-${index}`} className="flex flex-col gap-0.5 min-w-0">
                <span className="text-micro font-semibold text-text-secondary">
                  {warning.kind} · {warning.severity ?? "warn"}
                  {warning.updatedAt ? ` · ${warning.updatedAt}` : ""}
                </span>
                <span className="text-micro text-text-tertiary wrap-break-word">{warning.message}</span>
              </div>
            ))}
          </div>
        ) : null}
        {probeMeta !== null && (
          <div className="grid gap-1 pt-1 min-w-0">
            {(() => {
              const entries = Object.entries(probeMeta).filter(
                ([, value]) => value !== undefined && value !== null && value !== "",
              );
              if (entries.length === 0) return null;
              const visible = showMetaDetails ? entries : entries.slice(0, 1);
              return (
                <>
                  {visible.map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2 min-w-0">
                      <span className="shrink-0 text-micro text-text-tertiary">{key}</span>
                      <span
                        className="truncate font-mono text-micro text-text-secondary"
                        title={String(value)}
                      >
                        {String(value)}
                      </span>
                    </div>
                  ))}
                  {entries.length > 1 ? (
                    <button
                      type="button"
                      className="mt-0.5 w-fit text-micro font-semibold text-text-tertiary hover:text-text-primary cursor-pointer bg-transparent border-0 p-0"
                      aria-expanded={showMetaDetails}
                      onClick={() => setShowMetaDetails((open) => !open)}
                    >
                      {showMetaDetails ? "(close)" : `(show more · ${entries.length - 1} more)`}
                    </button>
                  ) : null}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </>
  );
}

const MemoModelCard = memo(ModelCard);

/** Wire-family chip colors: chat = teal, responses = purple, messages = orange. */
function wireChipStyle(wireFamily: string): { color: string; background: string } {
  if (wireFamily === "responses") return { color: "var(--purple)", background: "var(--purple-soft)" };
  if (wireFamily === "messages") {
    return {
      color: "var(--orange)",
      background: "color-mix(in srgb, var(--orange) 14%, transparent)",
    };
  }
  return { color: "var(--teal)", background: "var(--teal-soft)" };
}

function wireLabel(wireFamily: string): string {
  const lower = wireFamily.toLowerCase();
  if (lower === "responses") return "Responses";
  if (lower === "messages") return "Messages";
  return "Chat";
}

/**
 * Per-model outcome of the provider-wide run, in a collapsible panel below the
 * grid. One row each: verdict + latency, plus the upstream's own error text on
 * failure — the run is a diagnostic, not a rewrite of the catalog.
 */
export function TestAllModelsPanel({
  results,
}: {
  readonly results: readonly { readonly modelId: string; readonly ok: boolean; readonly latencyMs: number; readonly error?: string }[];
}): ReactNode {
  const [open, setOpen] = useState(true);
  const passed = results.filter((row) => row.ok).length;
  return (
    <div className="flex flex-col gap-3 rounded-control border border-inner-border bg-surface-2 p-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center justify-between gap-4 text-caption font-semibold text-text-secondary bg-transparent border-0 p-0 cursor-pointer"
      >
        <span>{`Test all models · ${passed}/${results.length} passed`}</span>
        <span className="text-badge text-text-tertiary">{open ? "(close)" : "(show)"}</span>
      </button>
      {open ? (
        <div className="grid gap-1 max-h-160 overflow-y-auto" data-testid="test-all-models-results">
          {results.length === 0 ? (
            <div className="text-badge text-text-tertiary">No models returned by the probe.</div>
          ) : (
            results.map((row) => (
              <div key={row.modelId} className="flex items-center gap-3 min-w-0 text-badge">
                <span className={`shrink-0 font-bold ${row.ok ? "text-green" : "text-red"}`}>
                  {row.ok ? "OK" : "Fail"}
                </span>
                <span className="font-mono tabular-nums truncate min-w-0 flex-1" title={row.modelId}>
                  {row.modelId}
                </span>
                <span className="shrink-0 tabular-nums text-text-tertiary">{formatProbeDuration(row.latencyMs)}</span>
                {row.error ? (
                  <span className="truncate max-w-100 text-micro text-text-tertiary" title={row.error}>{row.error}</span>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ModelGrid({
  providerId,
  models,
  thinkingEffort,
  probeMode = "detail",
  showFilter = "all",
  serviceKind = "llm",
  searchCapable = false,
  testAll,
  onReady,
}: {
  readonly providerId: string;
  readonly models: readonly ModelCatalogEntry[];
  readonly thinkingEffort: ProbeReasoningEffort;
  /** Section-wide probe mode; default `detail` keeps the old behaviour. */
  readonly probeMode?: ModelProbeMode;
  /** `free` hides every row the provider does not publish as free tier. */
  readonly showFilter?: ModelShowFilter;
  readonly serviceKind?: "llm" | "websearch";
  readonly searchCapable?: boolean;
  /** Wired only on the LLM section, where the header button lives. */
  readonly testAll?: {
    readonly pending: boolean;
    readonly onRun: () => void;
    readonly results: readonly { readonly modelId: string; readonly ok: boolean; readonly latencyMs: number; readonly error?: string }[] | null;
  };
  /** Receives the aggregate "run every card's probe" callback for the header button. */
  readonly onReady?: (runAll: () => void) => void;
}): ReactNode {
  const deleteModel = useDeleteProviderModel();
  const [deleteTarget, setDeleteTarget] = useState<ModelCatalogEntry | null>(null);
  const [editTarget, setEditTarget] = useState<ModelCatalogEntry | null>(null);
  // Built-in catalog rows and provider-sourced rows are different things: a
  // built-in row is the compiled catalog and can only be disabled, while a
  // fetched or manually added row is this deployment's own data and can be
  // deleted. Rendering them as one undifferentiated grid made a catalog entry
  // and an operator's own addition look alike, so the groups are labelled and
  // ordered — see `MODEL_GROUPS`.
  // A disabled row leaves its origin group and lands in `DISABLED_GROUP` at the
  // end, so each of the four source sections shows only what can actually be
  // routed. `enabled` defaults to true for a row written before the column
  // existed, matching the backend's own reading.
  const isRoutable = (model: ModelCatalogEntry): boolean => model.enabled !== false;
  // Registry of each card's probe runner, keyed by model id. Test-all fires
  // every card's own Test button (no separate batch API, no extra route): the
  // cards already own their test state, so the results paint in place.
  const probeRunnersRef = useRef(new Map<string, () => void>());
  const registerProbe = useCallback((modelId: string, run: () => void) => {
    probeRunnersRef.current.set(modelId, run);
  }, []);
  const runAllProbes = useCallback(() => {
    for (const run of probeRunnersRef.current.values()) {
      try {
        run();
      } catch {
        // A single card's runner must never break the whole batch.
      }
    }
  }, []);
  // Expose the aggregate runner to the header's Test-all button (outside this
  // component) so one click fires every card's own probe — verdicts paint in
  // place on each card, no separate batch API.
  useEffect(() => {
    if (onReady !== undefined) onReady(runAllProbes);
  }, [onReady, runAllProbes]);
  // The visible Show filter applies before grouping, so a hidden row never reaches any
  // section — including the disabled group at the end.
  const visibleModels =
    showFilter === "free" ? models.filter((model) => model.freeTier === true) : models;
  const groups = MODEL_GROUPS.map((group) => ({
    ...group,
    rows: visibleModels.filter((model) => isRoutable(model) && group.matches(model.source)),
  })).filter((group) => group.rows.length > 0);
  const disabledRows = visibleModels.filter((model) => !isRoutable(model));
  const renderCard = (model: ModelCatalogEntry) => (
    <MemoModelCard
      key={`${model.modelId}::${model.route}`}
      providerId={providerId}
      model={model}
      serviceKind={serviceKind}
      searchCapable={searchCapable}
      thinkingEffort={thinkingEffort}
      probeMode={probeMode}
      deletePending={deleteModel.isPending}
      onDeleteRequest={setDeleteTarget}
      // A built-in row is the compiled catalog shared by every tenant, so the
      // backend refuses to edit it. Offering the pencil there would let the
      // operator fill in a form that always fails.
      onEditRequest={model.source === "builtin" ? undefined : setEditTarget}
      onRegisterProbe={registerProbe}
    />
  );
  return (
    <>
      <Stack gap="16px">
        {groups.map((group) => (
          <section key={group.key} className="flex flex-col gap-4">
            <div className="flex items-baseline gap-4 min-w-0">
              <span className="text-caption font-bold text-text-secondary">
                {group.label}
              </span>
              <span className="mt-1 text-badge text-text-tertiary">
                {group.rows.length}
              </span>
              <span
                title={group.hint}
                className="text-micro text-text-tertiary overflow-hidden truncate"
              >
                · {group.hint}
              </span>
            </div>
            <div className="provider-grid grid gap-4 items-stretch">
              {group.rows.map(renderCard)}
            </div>
          </section>
        ))}
        {testAll?.results ? (
          <TestAllModelsPanel results={testAll.results} />
        ) : null}
        {disabledRows.length === 0 ? null : (
          <section className="flex flex-col gap-4">
            <div className="flex items-baseline gap-4 min-w-0">
              <span className="text-caption font-bold text-text-secondary">
                {DISABLED_GROUP.label}
              </span>
              <span className="mt-1 text-badge text-text-tertiary">
                {disabledRows.length}
              </span>
              <span
                title={DISABLED_GROUP.hint}
                className="text-micro text-text-tertiary overflow-hidden truncate"
              >
                · {DISABLED_GROUP.hint}
              </span>
            </div>
            <div className="provider-grid grid gap-4 items-stretch">
              {disabledRows.map(renderCard)}
            </div>
          </section>
        )}
      </Stack>
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleteModel.isPending) setDeleteTarget(null);
        }}
        onConfirm={async () => {
          if (deleteTarget === null) return;
          await deleteModel.mutateAsync({
            providerId,
            request: { modelId: deleteTarget.modelId, route: deleteTarget.route },
          });
          toast.success("Model deleted", `${providerId}/${deleteTarget.modelId}`);
          setDeleteTarget(null);
        }}
        title="Delete model?"
        message={`Delete ${providerId}/${deleteTarget?.modelId ?? ""} from the provider catalog?`}
        confirmLabel="Delete"
        danger
      />
      {editTarget !== null ? (
        <EditModelModal
          providerId={providerId}
          model={editTarget}
          onClose={() => setEditTarget(null)}
        />
      ) : null}
    </>
  );
}
