import { ChevronDown, Eye, EyeOff, LayoutGrid, Plus, Rows3, Server, Trash2 } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/classnames";
import { Link, useSearchParams } from "react-router-dom";
import {
  HeaderPairsEditor,
  pairsToHeaders,
  type HeaderPair,
} from "../../components/HeaderPairsEditor";
import { ProviderCardGrid } from "../../components/ProviderCardGrid";
import { ProviderIcon } from "../../components/ProviderIcon";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ListRow } from "../../components/ui/list-row";
import { Dialog } from "../../components/ui/dialog";
import { DialogActions } from "../../components/ui/dialog-actions";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { Switch } from "../../components/ui/switch";
import { PaginationControls } from "../../components/ui/pagination";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import { useHideUnconfiguredProviders } from "../../lib/privacy-mode";
const CARD_SHELL = cn(
  "relative flex flex-col min-w-0 border border-inner-border rounded-card",
  "transition-[transform,border-color,box-shadow]",
);

const CARD_LINK = cn("block flex-1 p-6 no-underline text-inherit");

const CARD_NAME = cn("text-body font-semibold overflow-hidden text-ellipsis whitespace-nowrap");

/**
 * Diagonal corner ribbon shared by the Friend sponsor mark and the Disabled
 * status mark. Same geometry as the founding ribbon so the cards stay one
 * visual family; only the tone and label change.
 */
function CornerRibbon({
  label,
  title,
  tone,
}: {
  readonly label: string;
  readonly title: string;
  readonly tone: "accent" | "danger";
}): ReactNode {
  return (
    <span
      aria-label={title}
      title={title}
      className="absolute top-0 right-0 z-2 w-36 h-36 overflow-hidden pointer-events-none"
    >
      <span
        className={cn(
          // DISABLED is two letters longer than Friend, so the danger arm is a
          // touch wider; the clip box stays the same so the corner cut is
          // identical across both marks.
          tone === "danger"
            ? "absolute top-9 -right-13 w-44 py-1 rotate-45 bg-red-soft text-red"
            : "absolute top-9 -right-11 w-38 py-1 rotate-45 bg-accent-soft text-accent",
          "text-micro font-extrabold tracking-tight leading-[1.05]",
          "text-center uppercase shadow-ribbon",
        )}
      >
        {label}
      </span>
    </span>
  );
}

import type {
  CreateProviderRequest,
  ProviderResponse,
} from "../../data/contracts";
import type { ServiceKind } from "../../../../src/protocol/canonical-model";

/** Advanced capability kinds offered in the Add Custom Provider modal. */
const ADVANCED_KIND_OPTIONS: readonly { readonly kind: ServiceKind; readonly label: string }[] = [
  { kind: "imageGeneration", label: "Image generation" },
  { kind: "videoGeneration", label: "Video generation" },
  { kind: "embedding", label: "Embeddings" },
  { kind: "audioSpeech", label: "Speech synthesis (TTS)" },
  { kind: "audioTranscription", label: "Audio transcription (STT)" },
  { kind: "websearch", label: "Web search" },
  { kind: "systemone", label: "System One (native routing)" },
];

function serviceKindLabel(kind: ServiceKind): string {
  return ADVANCED_KIND_OPTIONS.find((entry) => entry.kind === kind)?.label ?? kind;
}
import {
  useCreateProvider,
  useCreateProviderAccount,
  useDeleteProvider,
  useProviders,
  useSyncProviderModels,
  useTestByokConnection,
} from "../../hooks/providers";
import { getErrorMessage } from "../../data/api";

const wireFamilies = ["chat", "responses", "messages"] as const;
type WireFamily = (typeof wireFamilies)[number];
type DashboardServiceKind = "llm" | "websearch" | "imageGeneration" | "videoGeneration";



function providerServiceKinds(provider: ProviderResponse): readonly string[] {
  const kinds = provider.serviceKinds;
  return Array.isArray(kinds) && kinds.length > 0 ? kinds : ["llm"];
}

/**
 * Endpoint tails an operator pastes into the Base URL field instead of a root.
 * The same shape the server strips in `splitEndpointBaseUrl`; this copy is what
 * lets the form say so before a request is made.
 */
const ENDPOINT_TAIL = /\/(?:v\d+\/)?(?:messages|chat\/completions|responses|completions|embeddings|images\/generations)$/;

/**
 * The root to use when the typed Base URL ends at a per-request endpoint, or
 * null when it already looks like a root.
 *
 * Only the endpoint **tail** is stripped; any gateway prefix before it survives.
 * For `…/anthropic/v1/messages` the suggestion is `…/anthropic` (LongCat-style
 * prefix), matching the server's `splitEndpointBaseUrl` so the dashboard warns
 * about the same root the gateway would test against.
 */
function pastedEndpointRoot(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;
  let url: URL;
  let pathname: string;
  try {
    url = new URL(trimmed);
    pathname = url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
  const match = ENDPOINT_TAIL.exec(pathname);
  if (match === null) return null;
  const kept = pathname.slice(0, match.index);
  return `${url.origin}${kept}`;
}


// ── Custom Compatible Provider Modal ──────────────────────────────────────────

function AddCompatibleModal({
  variant,
  open,
  onClose,
}: {
  variant: "openai-compatible" | "anthropic-compatible";
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const create = useCreateProvider();
  const createAccount = useCreateProviderAccount();
  const syncModels = useSyncProviderModels();
  const testConnection = useTestByokConnection();
  const [label, setLabel] = useState("");
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [autoFetchModels, setAutoFetchModels] = useState(false);
  const [sendCliIdentity, setSendCliIdentity] = useState(true);
  const [headerPairs, setHeaderPairs] = useState<readonly HeaderPair[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    /** The server corrected a pasted endpoint path; shown beside the outcome. */
    warning?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  // Advanced capabilities: the operator opts into every non-agentic surface
  // their upstream actually answers. Default is agentic only — the modal
  // saves a list, not per-toggle churn.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [serviceKinds, setServiceKinds] = useState<readonly ServiceKind[]>(["llm"]);

  const isAnthropic = variant === "anthropic-compatible";
  const defaultWire: WireFamily = isAnthropic ? "messages" : "chat";
  const [wireFamily, setWireFamily] = useState<WireFamily>(defaultWire);
  // The root the field should hold, when what was typed ends at an endpoint.
  const pastedEndpoint = useMemo(() => pastedEndpointRoot(baseUrl), [baseUrl]);

  useEffect(() => {
    if (!open) return;
    setLabel("");
    setCredential("");
    setWireFamily(defaultWire);
    setBaseUrl("");
    setAutoFetchModels(false);
    setSendCliIdentity(true);
    setHeaderPairs([]);
    setError(null);
    setTestResult(null);
    setAdvancedOpen(false);
    setServiceKinds(["llm"]);
  }, [open]);

  const pasteInto = async (setter: (value: string) => void) => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setter(text.trim());
    } catch {
      setError("Clipboard access denied — paste manually instead.");
    }
  };

  const runTest = async () => {
    if (!baseUrl.trim()) {
      setTestResult({ ok: false, message: "Base URL is required to test the connection." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const extraHeaders = pairsToHeaders(headerPairs);
      const result = await testConnection.mutateAsync({
        baseUrl: baseUrl.trim(),
        apiKey: credential.trim(),
        wireFamily,
        cliIdentity: sendCliIdentity,
        ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
      });
      if (result.ok) {
        const models =
          typeof result.modelCount === "number" ? ` — upstream advertised ${result.modelCount} model(s)` : "";
        setTestResult({
          ok: true,
          message: `Connected successfully (${result.latencyMs}ms)${models}.`,
          ...(result.warning === undefined ? {} : { warning: result.warning }),
        });
      } else {
        setTestResult({
          ok: false,
          message: result.error ?? "Connection failed.",
          ...(result.warning === undefined ? {} : { warning: result.warning }),
        });
      }
    } catch (err) {
      setTestResult({ ok: false, message: getErrorMessage(err, "Connection test failed") });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError("Display Name is required");
      return;
    }
    if (!providerId.trim()) {
      setError("Provider ID (slug) is required");
      return;
    }
    if (!baseUrl.trim()) {
      setError("Base URL is required");
      return;
    }

    const extraHeaders = pairsToHeaders(headerPairs);
    const id = providerId.trim().toLowerCase();
    // Advanced capabilities: send the narrowed kind list only when the
    // operator opened the section and changed it. Absent = the historical
    // default (every kind enabled).
    const advancedKinds = advancedOpen ? serviceKinds : undefined;

    setSubmitting(true);
    setError(null);
    try {
      const req: CreateProviderRequest = {
        providerId: id,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        wireFamily,
        compatibilityProfile: {
          cli_identity: sendCliIdentity,
          ...(advancedKinds !== undefined ? { service_kinds: advancedKinds } : {}),
          ...(Object.keys(extraHeaders).length > 0 ? { extra_headers: extraHeaders } : {}),
        },
      };
      await create.mutateAsync(req);
      if (credential.trim()) {
        await createAccount.mutateAsync({
          providerId: id,
          request: { credentialKind: "api_key", secret: credential.trim() },
        });
      }
      if (autoFetchModels) {
        await syncModels.mutateAsync(id);
      }
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create provider"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isAnthropic ? "Add Custom Anthropic Provider" : "Add Custom OpenAI Provider"}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-compatible-provider" disabled={submitting}>
            {submitting ? "Creating..." : "Add Provider"}
          </Button>
        </>
      }
    >
      <form id="add-compatible-provider" onSubmit={submit} className="flex flex-col gap-6">
        {error ? <div className="text-red text-caption">{error}</div> : null}
        <Input
          label="Display Name"
          hint="Required. A friendly label for this node."
          id="compat-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={isAnthropic ? "Anthropic Compatible (Prod)" : "OpenAI Compatible (Prod)"}
          required
        />
        <Input
          label="Provider ID / Slug"
          hint="Required. Used as the provider prefix for model IDs."
          id="compat-slug"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          placeholder={isAnthropic ? "ac-prod" : "oc-prod"}
          required
        />
        <div className="form-group">
          <label className="form-label" htmlFor="compat-url">
            <span>Base URL</span>
            <span className="form-hint">
              The root only. Do not paste the full endpoint — leave off
              {isAnthropic ? " `/v1/messages`." : " `/chat/completions`."}
            </span>
          </label>
          <Inline gap="8px">
            <div className="flex-1 min-w-0">
              <Input
                id="compat-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"
                }
                required
              />
            </div>
            <Button type="button" variant="secondary" onClick={() => pasteInto(setBaseUrl)}>
              Paste
            </Button>
          </Inline>
          {pastedEndpoint === null ? null : (
            <p className="mt-1.5 text-caption text-orange">
              That looks like a full endpoint. Use{" "}
              <code className="font-mono">{pastedEndpoint}</code> instead — Cartethyia appends the
              endpoint path itself.
            </p>
          )}
        </div>
        {isAnthropic ? null : (
          <Select
            id="compat-wire"
            label="API format"
            value={wireFamily}
            onValueChange={(value) => setWireFamily(value as WireFamily)}
            options={[
              { value: "chat", label: "Chat completions" },
              { value: "responses", label: "Responses" },
            ]}
          />
        )}
        <div className="form-group">
          <label className="form-label" htmlFor="compat-credential">
            <span>API Key</span>
            <span className="form-hint">
              Optional — saved with this provider and used to authenticate every request.
            </span>
          </label>
          <Inline gap="8px">
            <div className="flex-1 min-w-0">
              <Input
                id="compat-credential"
                type="password"
                placeholder="sk-..."
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={testing}
              onClick={() => void runTest()}
            >
              {testing ? "Testing..." : "Test connection"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => pasteInto(setCredential)}>
              Paste
            </Button>
          </Inline>
          {testResult ? (
            <>
              <div
                className={cn(
                  "mt-3 text-caption leading-[1.4] break-words",
                  testResult.ok ? "text-green" : "text-red",
                )}
              >
                {testResult.ok ? "✓ " : "✗ "}
                {testResult.message}
              </div>
              {testResult.warning ? (
                <div className="mt-2 text-caption leading-snug break-words text-orange">
                  ⚠ {testResult.warning}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <ListRow
          actions={<Switch checked={autoFetchModels} onChange={setAutoFetchModels} id="compat-autofetch" />}
        >
          <div>
            <div className="text-body font-semibold">Auto-fetch models</div>
            <div className="mt-1 text-badge text-text-tertiary">
              Discover this provider's model list automatically after creation
            </div>
          </div>
        </ListRow>
        <ListRow
          actions={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? "Done" : "Configure"}
            </Button>
          }
        >
          <div>
            <div className="text-body font-semibold">Advanced capabilities</div>
            <div className="mt-1 text-badge text-text-tertiary">
              {advancedOpen
                ? "Check the surfaces this upstream answers. Agentic (LLM) is always on."
                : serviceKinds.length > 1
                  ? `${serviceKinds.length - 1} enabled · ${serviceKinds
                      .filter((kind) => kind !== "llm")
                      .map(serviceKindLabel)
                      .join(", ")}`
                  : "Agentic only (LLM) — enable image, video, embeddings, and audio here"}
            </div>
          </div>
        </ListRow>
        {advancedOpen ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-control border border-inner-border bg-surface-1 p-4">
            {ADVANCED_KIND_OPTIONS.map((entry) => {
              const checked = serviceKinds.includes(entry.kind);
              return (
                <label
                  key={entry.kind}
                  className="flex items-center gap-2.5 cursor-pointer text-caption text-text-secondary"
                >
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={checked}
                    onChange={() =>
                      setServiceKinds((prev) =>
                        checked
                          ? prev.filter((kind) => kind !== entry.kind)
                          : [...prev, entry.kind],
                      )
                    }
                  />
                  <span>{entry.label}</span>
                </label>
              );
            })}
          </div>
        ) : null}
        <ListRow
          actions={<Switch checked={sendCliIdentity} onChange={setSendCliIdentity} id="compat-cli-identity" />}
        >
          <div>
            <div className="text-body font-semibold">
              {isAnthropic ? "Send request as Claude CLI" : "Send request as Codex CLI"}
            </div>
            <div className="mt-1 text-badge text-text-tertiary">
              {isAnthropic
                ? "Emits official Claude CLI User-Agent and Stainless headers to upstream"
                : "Emits official codex_cli_rs User-Agent and originator headers to upstream"}
            </div>
          </div>
        </ListRow>
        <HeaderPairsEditor pairs={headerPairs} onChange={setHeaderPairs} />
      </form>
    </Dialog>
  );
}

// ── Custom Providers Section ──────────────────────────────────────────────────

function CustomProviderCard({ customProvider }: { customProvider: ProviderResponse }): ReactNode {
  const deleteMutation = useDeleteProvider();
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Connection and model badges come straight from the provider-list overview
  // fields (`accountCount` / `activeAccountCount` / `modelCount`), so a card
  // issues no per-provider accounts/models request. Collectorless custom
  // endpoints never refresh quota, so a stale manufactured error is not
  // rendered: the row shows "No quota data" on its detail page instead of a
  // red herring here.
  return (
    <Card
      className={CARD_SHELL}
    >
      <ProviderVersionBadge clientVersion={customProvider.clientVersion} />
      {!customProvider.enabled ? (
        <CornerRibbon label="Disabled" title="Provider disabled" tone="danger" />
      ) : null}
      <Link
        to={`/providers/${encodeURIComponent(customProvider.providerId)}`}
        // See the builtin card: `flex: 1` keeps the clickable area as tall as
        // the stretched card instead of only as tall as the content.
        className={cn(CARD_LINK, "pr-20 min-h-38")}
      >
        <Inline gap="10px">
          <ProviderIcon
            icon={customProvider.wireFamilyDefault === "messages" ? "anthropic" : "openai"}
            name={customProvider.label || customProvider.providerId}
            size={32}
            imageSize={24}
          />
          <div className="min-w-0 flex-1">
            <div
              className={CARD_NAME}
            >
              {customProvider.label || customProvider.providerId}
            </div>
            {customProvider.baseUrl ? (
              <div
                className="mt-1 min-w-0 truncate font-mono text-micro text-text-tertiary"
                title={customProvider.baseUrl}
              >
                <span className="font-semibold text-text-secondary">Base URL</span>{" "}
                {customProvider.baseUrl}
              </div>
            ) : null}
            <div className="mt-1.5 flex flex-wrap gap-2">
              {customProvider.accountCount === undefined ? (
                <SecondaryQueryBadge
                  kind="accounts"
                  isPending={false}
                  isError={false}
                  hasData={false}
                />
              ) : customProvider.accountCount === 0 ? (
                customProvider.requiresAccount === false ? (
                  <Badge tone="ok">Free Endpoint</Badge>
                ) : (
                  <Badge>No connections</Badge>
                )
              ) : (
                <AccountStatusBadges activeCount={customProvider.activeAccountCount} total={customProvider.accountCount} />
              )}
            </div>
          </div>

          <div
            className="flex flex-col items-end gap-1.5 shrink-0"
          >
            <span
              className="font-mono tabular-nums text-micro font-semibold bg-kbd-bg px-2.5 py-0.5 rounded-chip text-text-secondary"
            >
              {customProvider.providerId}/
            </span>
            {customProvider.modelCount !== undefined && customProvider.modelCount > 0 ? (
              <Badge tone="info">{customProvider.modelCount} models</Badge>
            ) : null}
            {customProvider.modelCount === undefined ? (
              <SecondaryQueryBadge
                kind="models"
                isPending={false}
                isError={false}
                hasData={false}
              />
            ) : customProvider.modelCount === 0 ? (
              <SecondaryQueryBadge
                kind="models"
                isPending={false}
                isError={false}
                hasData
                isEmpty
              />
            ) : null}
          </div>
        </Inline>
      </Link>
      <Button
        variant="ghost"
        size="sm"
        icon={<Trash2 size={12} />}
        onClick={() => setDeleteOpen(true)}
        className="absolute top-2 right-2 p-2 text-text-tertiary"
        title={`Delete ${customProvider.label || customProvider.providerId}`}
      />
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Custom Provider">
        <Stack gap="12px">
          <p className="text-body text-text-secondary">
            Are you sure you want to delete custom provider{" "}
            <strong>{customProvider.label || customProvider.providerId}</strong>? Its models,
            accounts, and routing preferences are deleted together, and requests to this
            provider will no longer route.
          </p>
          {deleteMutation.isError ? (
            <p className="text-caption text-red">
              {getErrorMessage(deleteMutation.error, "Delete failed")}
            </p>
          ) : null}
          <DialogActions>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                deleteMutation.mutate(customProvider.providerId, {
                  onSuccess: () => setDeleteOpen(false),
                  onError: () => undefined,
                });
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Provider"}
            </Button>
          </DialogActions>
        </Stack>
      </Dialog>
    </Card>
  );
}

function CustomProvidersSection({
  customProviders,
}: {
  customProviders: ProviderResponse[];
}): ReactNode {
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showOpenAI, setShowOpenAI] = useState(false);
  // Collapsed by operator choice, persisted per browser. Hidden providers are
  // unmounted (a cheap placeholder) — badges come from the provider-list
  // overview, so there are no per-card requests to keep warm while hidden.
  const [hidden, setHidden] = useState(() => {
    try {
      return window.localStorage.getItem("cartethyia.customProvidersHidden") === "1";
    } catch {
      return false;
    }
  });

  function toggleHidden(): void {
    setHidden((value) => {
      const next = !value;
      try {
        window.localStorage.setItem("cartethyia.customProvidersHidden", next ? "1" : "0");
      } catch {
        // Private mode: the toggle still works for this session.
      }
      return next;
    });
  }

  return (
    <section className="flex flex-col gap-5">
      <div
        className="flex items-center justify-between flex-wrap gap-4"
      >
        <button
          type="button"
          onClick={toggleHidden}
          aria-expanded={!hidden}
          title={hidden ? "Show custom providers" : "Hide custom providers"}
          className="inline-flex items-center gap-3 bg-transparent border-none p-0 cursor-pointer text-inherit"
        >
          <h2 className="text-body-lg font-bold tracking-[-0.01em]">
            Custom Providers{customProviders.length > 0 ? ` (${customProviders.length})` : ""}
          </h2>
          <ChevronDown
            size={14}
            className="text-text-tertiary transition-transform"
            style={{ transform: hidden ? "rotate(-90deg)" : undefined }}
          />
        </button>
        <Inline gap="8px">
          <Button
            size="sm"
            variant="ghost"
            icon={hidden ? <Eye size={13} /> : <EyeOff size={13} />}
            onClick={toggleHidden}
            title={hidden ? "Show custom providers" : "Hide custom providers"}
          >
            {hidden ? "Show" : "Hide"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            onClick={() => setShowAnthropic(true)}
          >
            Custom Anthropic
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            onClick={() => setShowOpenAI(true)}
          >
            Custom OpenAI
          </Button>
        </Inline>
      </div>

      {hidden ? null : customProviders.length === 0 ? (
        <Card>
          <CardBody
            className="text-center px-7 py-10 border border-dashed border-inner-border rounded-card"
          >
            <p className="text-body font-semibold text-text-primary">
              No custom providers yet
            </p>
            <p className="text-badge text-text-tertiary mt-1">
              Add an OpenAI- or Anthropic-compatible endpoint with the buttons above.
            </p>
          </CardBody>
        </Card>
      ) : (
        <ProviderCardGrid>
          {customProviders.map((cp) => (
            <CustomProviderCard key={cp.providerId} customProvider={cp} />
          ))}
        </ProviderCardGrid>
      )}

      <AddCompatibleModal
        variant="anthropic-compatible"
        open={showAnthropic}
        onClose={() => setShowAnthropic(false)}
      />
      <AddCompatibleModal
        variant="openai-compatible"
        open={showOpenAI}
        onClose={() => setShowOpenAI(false)}
      />
    </section>
  );
}

// ── Provider Card ─────────────────────────────────────────────────────────────

const FOUNDING_IDS = new Set(["inferhub"]);
/** Free tiers with a small daily allowance rather than a standing free tier. */
const FREE_LIMITED_IDS = new Set([
  "grok",
  "opencode",
  "cline",
  // Nous Research publishes a free allowance alongside its paid catalog, and
  // its `/v1/models` marks those rows at zero price, so discovery can keep the
  // list current instead of encoding it by hand.
  "hermes",
  // Kilo Code resells the OpenRouter catalog — `/api/openrouter`, the same
  // upstream Cline fronts — and serves a `kilo-auto/free` routing alias
  // alongside its paid rows, so its free allowance is metered against that
  // one reseller rather than a standing free tier.
  "kilo",
  // Inception Labs ships a standing free tier — mercury-3 at zero price —
  // rather than a daily allowance, but it belongs in the same section as the
  // other free-limited providers an operator reaches for first.
  "inception",
  // ZCode Start exposes account-specific, time-limited GLM grants.
  "zcode-start",
  // Free-pi is ad-funded: a daily USD/credit allowance (guest or GitHub
  // sign-in), with a small set of "Free Unlimited" rows on the free tier.
  "freepi",
  // Perch Starter is free with a Google/GitHub sign-in: Roost Standard and
  // Standard 1M tiers, a $20/month included-usage allowance.
  "perch",
  // Zro serves open models with a small per-key allowance; a key only sees
  // the models it may call, and the free allowance is metered per use.
  "zro",
  // Freebuff's plan is a metered free allowance (freebucks + per-model
  // sessions), surfaced with a small daily credit.
  "freebuff",
  // Clixad is ad-funded: a daily free tier (120k credits/day) plus account
  // credits earned from offers (grant_per_ad ~40k/survey, $5/day cap).
  "clixad",
]);
/**
 * The providers an operator reaches for first: household names with a
 * published API-key signup. Grouped so the long tail of compatible resellers
 * below does not bury the ones everybody has already heard of. `ollama` is
 * registered as `ollamacloud`.
 */
const WELL_KNOWN_API_KEY_IDS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "alibabacp",
  "ollamacloud",
  "opencode-zen",
  "opencode-go",
  "mistral",
  "meta",
  "deepseek",
  "commandcode",
  // Alibaba's OpenAI-compatible DashScope: a household-enough name that an
  // operator looks for beside the other majors rather than in "Other".
  "dashscope",
]);

function hasInteractiveOAuth(provider: ProviderResponse): boolean {
  return provider.oauthFlows?.browser === true || provider.oauthFlows?.device === true;
}

/**
 * True when the provider holds a credential that expires and renews.
 *
 * A provider with neither a browser redirect nor a device code still belongs
 * under OAuth when it imports a refreshable token pair: filing it with the API
 * keys hides that it expires, and the account's renewal is then unexplained.
 * Import-only clients that cannot refresh stay where they are.
 */
function hasRefreshableCredential(provider: ProviderResponse): boolean {
  return provider.oauthFlows?.refreshable === true;
}

/**
 * Connection badges for one provider's card.
 *
 * Rendered straight from the provider-list overview fields so a card issues
 * no per-provider accounts request. `activeAccountCount` is the count of
 * accounts whose status is not disabled/revoked (a `cooldown` account still
 * counts as connected), which is the fact the old per-card fetch could only
 * learn by loading every account and reducing them.
 *
 * The neutral badge only shows when every account is active.
 */
function AccountStatusBadges({
  activeCount,
  total,
}: {
  readonly activeCount: number | undefined;
  readonly total: number;
}): ReactNode {
  if (activeCount === undefined) {
    return <Badge tone="warn" dot>{total} Connected</Badge>;
  }
  if (activeCount === 0) {
    return <Badge tone="warn" dot>{total} Unhealthy</Badge>;
  }
  if (activeCount === total) {
    return <Badge tone="ok" dot>{total} Healthy</Badge>;
  }
  return (
    <>
      <Badge tone="ok" dot>{activeCount} Healthy</Badge>
      <Badge tone="warn" dot>{total - activeCount} Unhealthy</Badge>
    </>
  );
}

function SecondaryQueryBadge({
  kind,
  isPending,
  isError,
  hasData,
  isEmpty = false,
}: {
  kind: "models" | "accounts";
  isPending: boolean;
  isError: boolean;
  hasData: boolean;
  isEmpty?: boolean;
}): ReactNode {
  const label = kind === "models" ? "Models" : "Connections";
  if (isError) return <Badge tone="warn">{label} unavailable</Badge>;
  if (isPending && !hasData) return <Badge tone="info">Loading {label.toLowerCase()}…</Badge>;
  if (isEmpty) return <Badge>{kind === "models" ? "No models" : "No connections"}</Badge>;
  return null;
}

function ProviderVersionBadge({
  clientVersion,
}: {
  readonly clientVersion: ProviderResponse["clientVersion"];
}): ReactNode {
  if (!clientVersion) return null;
  return (
    <Badge
      className="provider-version-badge absolute -top-4.5 left-5 right-auto z-chip max-w-[calc(100%-var(--spacing)*10)] truncate px-3 py-1 text-micro leading-[1.15] shadow-card max-small:left-4 max-small:max-w-[calc(100%-var(--spacing)*8)]"
      tone={clientVersion.source === "latest" ? "teal" : "default"}
      title={
        clientVersion.source === "latest"
          ? "Latest discovered client version"
          : "Pinned fallback; background discovery has not succeeded yet"
      }
    >
      v{clientVersion.version} · {clientVersion.source}
    </Badge>
  );
}

const ProviderCard = memo(function ProviderCard({
  provider,
  serviceKind,
}: {
  provider: ProviderResponse;
  serviceKind?: DashboardServiceKind;
}): ReactNode {
  const isFounding = FOUNDING_IDS.has(provider.providerId.toLowerCase());
  const displayName = provider.label || provider.displayName;
  // Connection counts and the model badge come from the provider-list overview
  // fields, so this card issues no per-provider accounts/models request.
  // Disabled wins over Friend: a parked founding provider must still read as
  // disabled at a glance, or the operator forgets why it stopped routing.
  return (
    <Card
      className={CARD_SHELL}
    >
      <ProviderVersionBadge clientVersion={provider.clientVersion} />
      {!provider.enabled ? (
        <CornerRibbon label="Disabled" title="Provider disabled" tone="danger" />
      ) : isFounding ? (
        <CornerRibbon label="Friend" title="Friend sponsor" tone="accent" />
      ) : null}

      <Link
        to={`/providers/${encodeURIComponent(provider.providerId)}${
          serviceKind === undefined ? "" : `?service=${serviceKind}`
        }`}
        // `flex: 1` is what makes the whole card clickable. Grid rows stretch
        // every card to the tallest one, so a card whose content is shorter
        // than its row left a dead strip below the link — a click there hit
        // the card, not the link, and did nothing.
        className={CARD_LINK}
      >
        <Inline gap="10px">
          <ProviderIcon icon={provider.providerId} name={displayName} size={32} imageSize={24} />
          <div className="min-w-0 flex-1">
            <div
              className={CARD_NAME}
            >
              {displayName}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {provider.accountCount === undefined ? (
                <SecondaryQueryBadge
                  kind="accounts"
                  isPending={false}
                  isError={false}
                  hasData={false}
                />
              ) : provider.accountCount === 0 ? (
                provider.requiresAccount === false ? (
                  <Badge tone="ok">Free Endpoint</Badge>
                ) : (
                  <Badge>No connections</Badge>
                )
              ) : (
                <AccountStatusBadges activeCount={provider.activeAccountCount} total={provider.accountCount} />
              )}
            </div>
          </div>

          <div
            className="flex flex-col items-end gap-1.5 shrink-0"
          >
            <span
              className="font-mono tabular-nums text-micro font-semibold bg-kbd-bg px-2.5 py-0.5 rounded-chip text-text-secondary"
            >
              {provider.providerId}/
            </span>
            {provider.modelCount !== undefined && provider.modelCount > 0 ? (
              <Badge tone="info">{provider.modelCount} models</Badge>
            ) : null}
            {provider.modelCount === undefined ? (
              <SecondaryQueryBadge
                kind="models"
                isPending={false}
                isError={false}
                hasData={false}
              />
            ) : provider.modelCount === 0 ? (
              <SecondaryQueryBadge
                kind="models"
                isPending={false}
                isError={false}
                hasData
                isEmpty
              />
            ) : null}
          </div>
        </Inline>
      </Link>
    </Card>
  );
});

function compareConfiguredProviders(a: ProviderResponse, b: ProviderResponse): number {
  const configuredRank = Number(Boolean(b.configured)) - Number(Boolean(a.configured));
  if (configuredRank !== 0) return configuredRank;
  return (a.label || a.displayName).localeCompare(b.label || b.displayName);
}
const COLLAPSED_SECTIONS_KEY = "cartethyia.providerSectionsCollapsed";
const SHOW_ALL_SECTIONS_KEY = "cartethyia:providers:display-mode";

function readShowAllSections(): boolean | null {
  try {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(SHOW_ALL_SECTIONS_KEY);
    if (stored === "all") return true;
    if (stored === "paginated") return false;
    return null;
  } catch {
    return null;
  }
}

function writeShowAllSections(showAll: boolean): void {
  try {
    window.localStorage.setItem(SHOW_ALL_SECTIONS_KEY, showAll ? "all" : "paginated");
  } catch {
    // Keep the current in-memory choice when browser storage is unavailable.
  }
}

/**
 * The section default-collapsed on first visit (G-05 d1). It is the largest
 * one on a fresh installation, and its cards are pure markup — unmounting
 * them keeps the initial page render cheap. The collapse is a *default* only:
 * the moment the operator persists any choice, it is respected verbatim.
 */
const DEFAULT_COLLAPSED_SECTION = "Other API Key Providers";

function readCollapsedSections(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    if (raw === null) {
      // First visit: nothing persisted yet, so apply the default gate.
      return new Set([DEFAULT_COLLAPSED_SECTION]);
    }
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set([DEFAULT_COLLAPSED_SECTION]);
  }
}

/** Shared section heading, so new sections do not add styling debt. */
const SECTION_TITLE = "text-body font-bold tracking-[-0.01em]";

const SECTIONS = [
  {
    title: "Founding Friend & Sponsors",
    subtitle: "Super Cheap inference pool",
    filter: (p: ProviderResponse) =>
      FOUNDING_IDS.has(p.providerId.toLowerCase()),
  },
  {
    title: "Free Limited Providers",
    filter: (p: ProviderResponse) =>
      FREE_LIMITED_IDS.has(p.providerId.toLowerCase()),
  },
  {
    title: "OAuth & Agent Providers",
    // Import-only clients validate and store API keys; only browser/device
    // authorization belongs in this section — plus an import-only client whose
    // credential is a refreshable token pair, which is OAuth in every way the
    // operator experiences except the missing button.
    filter: (p: ProviderResponse) =>
      (hasInteractiveOAuth(p) || hasRefreshableCredential(p)) &&
      !FREE_LIMITED_IDS.has(p.providerId.toLowerCase()),
  },
  {
    title: "Well Known API Key Providers",
    subtitle: "The household names — sign up with a key and go",
    filter: (p: ProviderResponse) =>
      p.isBuiltIn &&
      WELL_KNOWN_API_KEY_IDS.has(p.providerId.toLowerCase()) &&
      !FOUNDING_IDS.has(p.providerId.toLowerCase()) &&
      !FREE_LIMITED_IDS.has(p.providerId.toLowerCase()) &&
      !hasInteractiveOAuth(p) &&
      !hasRefreshableCredential(p),
  },
  {
    title: "Other API Key Providers",
    subtitle: "Free tier friendly — no credit card",
    filter: (p: ProviderResponse) =>
      p.isBuiltIn &&
      !WELL_KNOWN_API_KEY_IDS.has(p.providerId.toLowerCase()) &&
      !FOUNDING_IDS.has(p.providerId.toLowerCase()) &&
      !FREE_LIMITED_IDS.has(p.providerId.toLowerCase()) &&
      !hasInteractiveOAuth(p) &&
      !hasRefreshableCredential(p),
  },
];

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Providers(): ReactNode {
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(readCollapsedSections);
  const q = useProviders();
  const hideUnconfigured = useHideUnconfiguredProviders();
  const hideUnconfiguredOn = hideUnconfigured.enabled;
  // A credential-less provider (OpenCode Free, Exa, Parallel) is usable with no
  // account, so hiding it would hide a working route rather than a dead one.
  const isVisible = (p: ProviderResponse) =>
    !hideUnconfiguredOn || p.configured === true || p.requiresAccount === false;
  const allProviders = useMemo(() => q.data ?? [], [q.data]);
  const customProviders = useMemo(
    () => [...allProviders.filter((p) => !p.isBuiltIn && isVisible(p))].sort(compareConfiguredProviders),
    [allProviders, hideUnconfiguredOn],
  );
  const searchProviders = useMemo(
    () => allProviders.filter((p) => providerServiceKinds(p).includes("websearch") && isVisible(p)),
    [allProviders, hideUnconfiguredOn],
  );
  const llmProviders = useMemo(
    () => allProviders.filter((p) => providerServiceKinds(p).includes("llm") && isVisible(p)),
    [allProviders, hideUnconfiguredOn],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab: "llm" | "search" | "media" =
    requestedTab === "search" || requestedTab === "media" ? requestedTab : "llm";
  const setTab = (next: "llm" | "search" | "media") => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === "llm") params.delete("tab");
      else params.set("tab", next);
      return params;
    });
  };
  const mediaProviders = useMemo(
    () =>
      allProviders.filter(
        (p) =>
          (providerServiceKinds(p).includes("imageGeneration") ||
            providerServiceKinds(p).includes("videoGeneration")) &&
          isVisible(p),
      ),
    [allProviders, hideUnconfiguredOn],
  );
  const orderedSearch = useMemo(
    () => [...searchProviders].sort((a, b) => (a.label || a.displayName).localeCompare(b.label || b.displayName)),
    [searchProviders],
  );
  const sortFn = (a: ProviderResponse, b: ProviderResponse) => {
    const configuredDiff = Number(Boolean(b.configured)) - Number(Boolean(a.configured));
    if (configuredDiff !== 0) return configuredDiff;
    return (a.label || a.displayName).localeCompare(b.label || b.displayName);
  };
  const sections = useMemo(() => {
    if (tab === "media") {
      return [
        {
          title: "Media Generation",
          subtitle: "Providers that can return an image or a video",
          providers: mediaProviders,
        },
      ].filter((s) => s.providers.length > 0);
    }
    if (tab === "search") {
      return [
        {
          title: "Search Providers",
          subtitle: "Providers that can answer a web search request",
          providers: orderedSearch,
        },
      ].filter((s) => s.providers.length > 0);
    }
    const source = llmProviders;
    return SECTIONS.map((section) => ({
      ...section,
      providers: source.filter(section.filter).sort(sortFn),
    })).filter((section) => section.providers.length > 0);
  }, [llmProviders, orderedSearch, mediaProviders, tab]);

  /** Providers shown per section; `section.providers` is sliced to the page
   *  so a large catalog never renders hundreds of cards at once. */
  const SECTION_PAGE_SIZE = 8;
  const [sectionPages, setSectionPages] = useState<Readonly<Record<string, number>>>({});
  // When set, every section renders all its providers (pagination disabled).
  const [showAllSections, setShowAllSections] = useState(() => readShowAllSections() ?? false);
  const toggleShowAllSections = () => {
    setShowAllSections((current) => {
      const next = !current;
      writeShowAllSections(next);
      return next;
    });
  };
  const pageFor = (title: string) => sectionPages[title] ?? 1;
  const setPageFor = (title: string) => (page: number) =>
    setSectionPages((current) => ({ ...current, [title]: page }));
  const visibleProvidersFor = (providers: readonly ProviderResponse[], title: string) => {
    if (showAllSections) {
      return { visible: providers, pageCount: 1, safePage: 1 };
    }
    const page = pageFor(title);
    const pageCount = Math.max(1, Math.ceil(providers.length / SECTION_PAGE_SIZE));
    const safePage = Math.min(page, pageCount);
    return {
      visible: providers.slice((safePage - 1) * SECTION_PAGE_SIZE, safePage * SECTION_PAGE_SIZE),
      pageCount,
      safePage,
    };
  };

  const state = q.isPending && !q.data
    ? <LoadingState label="Loading providers..." />
    : q.isError
      ? (
        <ErrorState
          message={getErrorMessage(q.error, "Failed to load providers")}
          onRetry={() => q.refetch()}
        />
      )
      : null;
  if (state) {
    return (
      <Card>
        <CardHeader title="Providers" icon={<Server size={16} />} />
        <CardBody className="flex flex-1">{state}</CardBody>
      </Card>
    );
  }

  return (
    <Stack gap="24px">
      <Card>
        <CardHeader title="Providers" subtitle="Connected pinned first · A–Z" icon={<Server size={16} />} />
        <CardBody className="flex flex-col gap-8">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex gap-2">
          {(["llm", "search", "media"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-6 py-3 rounded-inset text-caption font-semibold border cursor-pointer",
                tab === t
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-inner-border bg-surface-1 text-text-secondary",
              )}
            >
              {t === "llm" ? "LLM" : t === "search" ? "Search" : "Media"}
              {t === "search"
                ? ` (${searchProviders.length})`
                : t === "media"
                  ? ` (${mediaProviders.length})`
                  : ` (${llmProviders.length})`}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={hideUnconfiguredOn ? <EyeOff size={12} /> : <Eye size={12} />}
          onClick={() => hideUnconfigured.setEnabled(!hideUnconfiguredOn)}
          title={
            hideUnconfiguredOn
              ? "Show providers that have no account yet"
              : "Hide providers that have no account yet"
          }
        >
          {hideUnconfiguredOn ? "Show unconfigured" : "Hide unconfigured"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={showAllSections ? <Rows3 size={12} /> : <LayoutGrid size={12} />}
          onClick={toggleShowAllSections}
          title={
            showAllSections
              ? "Paginate each section (8 per page)"
              : "Show every provider in each section at once"
          }
        >
          {showAllSections ? "Paginated" : "Show All"}
        </Button>
        <span className="ml-auto text-micro text-text-tertiary">
          {tab === "search"
            ? "Fallback runs only when the model invokes Websearch"
            : tab === "media"
              ? "Image and video generation"
              : "Connected pinned first · A–Z"}
        </span>
      </div>
      
      {tab === "llm" ? (
        <CustomProvidersSection customProviders={customProviders} />
      ) : null}

      {sections.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState title="No providers found" message="No providers available." />
          </CardBody>
        </Card>
      ) : (
        sections.map((section) => {
          const collapsed = collapsedSections.has(section.title);
          return (
          <section
            key={section.title}
            className="flex flex-col gap-6"
          >
            <button
              type="button"
              className="flex items-start gap-4 border-0 bg-transparent p-0 text-left text-inherit"
              aria-expanded={!collapsed}
              onClick={() => setCollapsedSections((current) => {
                const next = new Set(current);
                if (next.has(section.title)) next.delete(section.title);
                else next.add(section.title);
                try { window.localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...next])); } catch {}
                return next;
              })}
            >
              <ChevronDown size={15} className={cn("mt-1 shrink-0 transition-transform", collapsed && "-rotate-90")} />
              <Stack gap="1px">
                <h2 className={SECTION_TITLE}>
                  {section.title} ({section.providers.length}){collapsed ? " (Hidden)" : ""}
                </h2>
                {!collapsed && section.subtitle ? (
                  <p className="mt-1 text-badge text-text-tertiary">
                    {section.subtitle}
                  </p>
                ) : null}
              </Stack>
            </button>

            {collapsed ? null : (
            <ProviderCardGrid>
              {visibleProvidersFor(section.providers, section.title).visible.map((p) => (
                <ProviderCard
                  key={p.providerId}
                  provider={p}
                  serviceKind={
                    tab === "search"
                      ? "websearch"
                      : tab === "media"
                        ? providerServiceKinds(p).includes("imageGeneration")
                          ? "imageGeneration"
                          : "videoGeneration"
                        : "llm"
                  }
                />
              ))}
            </ProviderCardGrid>
            )}
            {!collapsed ? (
              (() => {
                const { pageCount, safePage } = visibleProvidersFor(section.providers, section.title);
                return pageCount > 1 ? (
                  <PaginationControls
                    page={safePage}
                    pageCount={pageCount}
                    onPageChange={setPageFor(section.title)}
                    testId={`providers-section-pagination-${section.title}`}
                  />
                ) : null;
              })()
            ) : null}
          </section>
          );
        })
      )}
        </CardBody>
      </Card>
    </Stack>
  );
}
