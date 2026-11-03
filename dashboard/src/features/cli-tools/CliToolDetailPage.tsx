import { ArrowLeft, CheckCircle2, Download, Eye, Plus, Search, Settings2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "../../components/ui/badge";
import { StatusBadge } from "../../components/ui/status-badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Dialog } from "../../components/ui/dialog";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { ModelPickerModal, useAllModelsCatalog, type FlatModelEntry } from "../../components/ModelPicker";
import { Switch } from "../../components/ui/switch";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import { downloadTextFile } from "../../lib/download";
import { toast } from "../../lib/toast";
import { useApiKeys, useUpdateApiKey } from "../../hooks/api-keys";
import {
  useApplyTool,
  useDownloadTool,
  useResetToolMappings,
  useSaveToolMappings,
  useToolMappings,
  useToolRegistry,
  useToolStatuses,
} from "../../hooks/cli-tools";
import type { ApiKeyResponse, ApplyInput, CliMappingInput, ToolRegistryEntry, ToolStatus } from "../../data/contracts";
import { sdkOptionLabel, sdkOptionsFor, sdkPairLabel } from "./sdk-choices";
import { ToolIcon } from "./icons/ToolIcon";
import { getErrorMessage } from "../../data/api";
import { isModelAllowed } from "../../../../src/security/model-access-rule";
import type { ApiKeyModelAccessMode } from "../../../../src/persistence/schema";

export default function CliToolDetail(): ReactNode {
  const { toolId } = useParams();
  const registryQuery = useToolRegistry();
  const statusesQuery = useToolStatuses();
  const apiKeysQuery = useApiKeys();

  const tool = useMemo(
    () => registryQuery.data?.find((entry) => entry.id === toolId) ?? null,
    [registryQuery.data, toolId],
  );

  const status = useMemo(() => {
    const data = statusesQuery.data as Record<string, ToolStatus> | ToolStatus[] | undefined;
    if (!data) return undefined;
    if (Array.isArray(data))
      return (data as ToolStatus[]).find((s) => (s as { toolId?: string }).toolId === toolId) as
        ToolStatus | undefined;
    return (data as Record<string, ToolStatus>)[toolId as string];
  }, [statusesQuery.data, toolId]);

  if (registryQuery.isLoading) return <LoadingState label="Loading tool details…" />;
  if (registryQuery.isError) {
    return (
      <ErrorState
        title="Unable to load tool"
        message={registryQuery.error?.message ?? "Could not load the CLI tool registry."}
        onRetry={() => void registryQuery.refetch()}
      />
    );
  }
  if (!tool) {
    return (
      <Stack gap="12px">
        <Link to="/cli-tools" className="text-caption text-accent">
          ← Back to CLI Tools
        </Link>
        <ErrorState title="Tool not found" message="Unknown CLI tool id." />
      </Stack>
    );
  }
  return <CliToolDetailBody tool={tool} status={status} apiKeys={apiKeysQuery.data ?? []} />;
}

/**
 * Semi-flat JSON renderer for the config preview.
 *
 * Structure stays readable: every container (provider, settings, models, each
 * model entry) renders multi-line exactly like a hand-written OpenCode config.
 * Only *small detail* values collapse to one line — `limit`, `cost`,
 * `reasoning`, short arrays — so the preview does not eat vertical space the
 * way a full pretty-print does.
 */
export function stringifyFlat(value: unknown): string {
  const MAX_INLINE = 85;

  /**
   * Keys whose values always expand multi-line, even when they would fit on
   * one line. `settings` (and siblings) carry credentials like `apiKey` —
   * keeping them inline makes the secret read as part of a long one-liner;
   * each field on its own line is easier to scan and matches hand-written
   * configs, where provider settings are always expanded.
   */
  const ALWAYS_EXPAND = new Set(["settings", "options", "headers", "body"]);

  const isObjectLike = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);

  /** True when the object (or any nested object) carries an always-expand key. */
  const containsExpandKey = (v: unknown): boolean => {
    if (!isObjectLike(v)) return false;
    return Object.entries(v).some(([k, val]) => {
      if (ALWAYS_EXPAND.has(k) && isObjectLike(val)) return true;
      return containsExpandKey(val);
    });
  };

  /** One-line rendering of any value (used for both small containers and leaf values). */
  const inline = (v: unknown): string => {
    if (v === null) return "null";
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[${v.map(inline).join(", ")}]`;
    }
    if (isObjectLike(v)) {
      const entries = Object.entries(v);
      if (entries.length === 0) return "{}";
      return `{ ${entries.map(([k, val]) => `${JSON.stringify(k)}: ${inline(val)}`).join(", ")} }`;
    }
    return JSON.stringify(v);
  };

  const render = (v: unknown, indent: number, selfExpand = false): string => {
    const pad = "  ".repeat(indent);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (v.every((x) => !isObjectLike(x))) return inline(v);
      // Array of objects: one entry per line, collapsing small entries.
      const lines = v.map((item) => {
        const rendered = isObjectLike(item) && inline(item).length <= MAX_INLINE ? inline(item) : render(item, indent + 1);
        return `${pad}  ${rendered},`;
      });
      return `[\n${lines.join("\n")}\n${pad}]`;
    }
    if (isObjectLike(v)) {
      const entries = Object.entries(v);
      if (entries.length === 0) return "{}";
      // An object containing an always-expand key (anywhere in its subtree)
      // must itself expand, otherwise its settings/options would be swallowed
      // into the parent inline line.
      const hasExpandKey = containsExpandKey(v);
      // Top-level object always renders multi-line; nested objects collapse when
      // the whole thing fits on one short line.
      if (indent > 0 && !hasExpandKey && !selfExpand && inline(v).length <= MAX_INLINE) return inline(v);
      const lines = entries.map(([k, val]) => {
        const forceExpand = ALWAYS_EXPAND.has(k) && isObjectLike(val);
        const rendered =
          forceExpand || (!hasExpandKey && isObjectLike(val) && inline(val).length <= MAX_INLINE)
            ? forceExpand
              ? render(val, indent + 1, true)
              : inline(val)
            : render(val, indent + 1);
        return `${pad}  ${JSON.stringify(k)}: ${rendered}`;
      });
      return `{\n${lines.join(",\n")}\n${pad}}`;
    }
    return inline(v);
  };

  return render(value, 0);
}

/**
 * Tiny "satisfied" status pill — warn when a required field is unset, ok
 * when it is set. Makes it obvious what still needs attention.
 */
function FieldStatus({ ok, label }: { readonly ok: boolean; readonly label: string }): ReactNode {
  return <StatusBadge ok={ok} label={label} />;
}

function CliToolDetailBody({
  tool,
  status,
  apiKeys,
}: {
  tool: ToolRegistryEntry;
  status:
    | {
        installed: boolean;
        configured: boolean;
        settingsPath: string | null;
        currentEndpoint: string | null;
        currentApiKeyPrefix: string | null;
        currentModels: readonly string[] | null;
        message?: string;
      }
    | undefined;
  apiKeys: readonly ApiKeyResponse[];
}): ReactNode {
  // User MUST manually select the API key — no auto-select.
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [endpoint, setEndpoint] = useState(() =>
    typeof window === "undefined" ? "http://localhost:12800" : window.location.origin,
  );
  const [slotModels, setSlotModels] = useState<Record<string, string>>({});
  const [mappingEnabled, setMappingEnabled] = useState(false);
  const [mappingTargets, setMappingTargets] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [pickerMode, setPickerMode] = useState<"slot" | "target">("slot");
  const sdkOptions = useMemo(() => sdkOptionsFor(tool.id), [tool.id]);
  const [sdk, setSdk] = useState<string>(sdkOptions.defaultSdk);
  const [websearchProvider, setWebsearchProvider] = useState<string>("carte");
  /** YOLO / auto-approve mode (default on). */
  const [yoloMode, setYoloMode] = useState(true);
  /** Extra free-form models for tools with an open model list (opencode/kilo). */
  const [extraModels, setExtraModels] = useState<string[]>([]);
  const [pickerMultiOpen, setPickerMultiOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const { items: modelCatalog } = useAllModelsCatalog(true);

  // Track the last-saved mapping state to avoid re-saving unchanged data.
  const lastSavedRef = useRef<string | null>(null);

  // One dropdown picks the credential *and* the mapping profile: a personal key
  // carries a recoverable secret, a share template has none but owns the routes
  // every child key inherits.
  const selectableKeys = useMemo(
    () =>
      apiKeys.filter(
        (key) => key.keyMode === "personal" || (key.keyMode === "share" && key.parentKeyId === undefined),
      ),
    [apiKeys],
  );

  // Mappings are per-(tool, key): reload whenever the user picks a different key.
  const mappingsQuery = useToolMappings(tool.id, selectedKeyId);
  const saveMappings = useSaveToolMappings();
  const resetMappings = useResetToolMappings();
  const updateApiKey = useUpdateApiKey();
  const downloadTool = useDownloadTool();
  const applyTool = useApplyTool();

  const selectedKey = selectableKeys.find((key) => key.id === selectedKeyId);
  const cliEligible = selectedKey?.scopes?.includes("routing:cli_mapping") === true;
  // Only a personal key can supply the secret written into a CLI config.
  const canAct = selectedKey?.keyMode === "personal";

  // The selected key's model-access policy, evaluated locally so a mapping that
  // the key may not reach is flagged before it silently 404s at request time.
  // `modelRejectionReason` (via `isModelAllowed`) is the exact rule the gateway
  // enforces, imported from the shared pure module — a preview can never
  // disagree with enforcement.
  const accessMode: ApiKeyModelAccessMode = selectedKey?.modelAccessMode ?? "whitelist";
  const accessList = selectedKey?.modelList;
  const modelAllowed = (name: string): boolean =>
    isModelAllowed({ model_access_mode: accessMode, model_list: accessList }, name);

  /** Aliases whose resolved target the selected key may not use. */
  const blockedMappings = useMemo(() => {
    const out = new Set<string>();
    if (!tool.mappingSupported) return out;
    for (const model of tool.defaultModels) {
      const target = mappingTargets[model.alias] ?? "";
      if (target.length === 0) continue;
      // The caller asks for the source name, so authorization is judged on both
      // the requested (source) and the resolved (target) name, as dispatch does.
      const source = slotModels[model.alias] ?? model.defaultValue ?? model.id;
      if (!modelAllowed(target) && !modelAllowed(source)) out.add(model.alias);
    }
    return out;
    // `modelAllowed` closes over `selectedKey`, so the key's identity is the
    // stable dependency; the list itself is re-read from it on each run.
  }, [tool.defaultModels, tool.mappingSupported, mappingTargets, slotModels, selectedKey]);

  // One-click repair: allow the model on the key (append in whitelist mode,
  // remove in blacklist mode) so the operator need not leave for the API-key
  // page. The write goes through the same PATCH the key editor uses.
  const allowModelForKey = (target: string) => {
    if (!selectedKey) return;
    const current = accessList ?? [];
    const next =
      accessMode === "blacklist"
        ? current.filter((entry) => entry !== target)
        : [...new Set([...current, target])];
    updateApiKey.mutate(
      { keyId: selectedKey.id, request: { modelAccessMode: accessMode, modelList: next } },
      {
        onSuccess: () =>
          toast.success(
            accessMode === "blacklist" ? "Model unblocked for this key" : "Model allowed for this key",
          ),
        onError: (error) => toast.error(getErrorMessage(error, "Could not update the API key.")),
      },
    );
  };

  useEffect(() => {
    // When switching tool or key: reset local draft to tool defaults.
    const defaults = Object.fromEntries(
      tool.defaultModels.map((model) => [model.alias, model.defaultValue ?? model.id]),
    );
    setSlotModels(defaults);
    setMappingTargets({});
    lastSavedRef.current = null;
  }, [tool, selectedKeyId]);

  useEffect(() => {
    const settings = mappingsQuery.data;
    if (!settings || settings.apiKeyId !== selectedKeyId) return;
    setMappingEnabled(settings.enabled);
    if (settings.mappings.length > 0) {
      setSlotModels((prev) => ({
        ...prev,
        ...Object.fromEntries(settings.mappings.map((row) => [row.slotKey, row.sourceModel])),
      }));
      setMappingTargets((prev) => ({
        ...prev,
        ...Object.fromEntries(settings.mappings.map((row) => [row.slotKey, row.targetModel])),
      }));
    } else {
      const defaults = Object.fromEntries(
        tool.defaultModels.map((model) => [model.alias, model.defaultValue ?? model.id]),
      );
      setSlotModels(defaults);
      setMappingTargets({});
    }
    lastSavedRef.current = JSON.stringify({ enabled: settings.enabled, mappings: settings.mappings });
  }, [selectedKeyId, mappingsQuery.data, tool.defaultModels]);

  const installed = status?.installed ?? false;
  const configured = status?.configured ?? false;

  const activeModels = useMemo(
    () =>
      tool.defaultModels.map((model) => slotModels[model.alias] ?? model.defaultValue ?? model.id),
    [slotModels, tool.defaultModels],
  );

  const allModels = useMemo(
    () => [...activeModels, ...extraModels.filter((m) => m.trim().length > 0)],
    [activeModels, extraModels],
  );

  const satisfiedCount = [
    selectedKeyId.length > 0,
    endpoint.trim().length > 0,
    allModels.length > 0,
  ].filter(Boolean).length;
  const requiredCount = 3;

  const buildMappingInput = useCallback((): CliMappingInput | undefined => {
    if (!tool.mappingSupported) return undefined;
    // The route rows are sent even while Remote Routing is off: the snapshot
    // gates on the enabled flag, so keeping them lets the operator flip the
    // switch back on and find the routes intact. Only the explicit Reset
    // action clears them.
    return {
      enabled: mappingEnabled,
      mappings: tool.defaultModels
        .filter((model) => (mappingTargets[model.alias] ?? "").length > 0)
        .map((model) => ({
          slotKey: model.alias,
          sourceModel: slotModels[model.alias] ?? model.defaultValue ?? model.id,
          targetModel: mappingTargets[model.alias] ?? "",
          enabled: true,
        }))
        .filter((row) => row.targetModel.length > 0),
    };
  }, [mappingEnabled, mappingTargets, slotModels, tool.defaultModels, tool.mappingSupported]);

  // Auto-save mappings against the selected key: a personal key's own bucket, or
  // the share template whose children inherit it.
  useEffect(() => {
    if (!tool.mappingSupported || selectedKeyId.length === 0) return;
    const server = mappingsQuery.data;
    if (!server || server.apiKeyId !== selectedKeyId) return;
    const input = buildMappingInput();
    if (!input) return;
    const fingerprint = JSON.stringify({ enabled: input.enabled, mappings: input.mappings });
    if (fingerprint === lastSavedRef.current) return;
    const timer = setTimeout(() => {
      saveMappings.mutate(
        { toolId: tool.id, keyId: selectedKeyId, input },
        {
          onSuccess: () => {
            lastSavedRef.current = fingerprint;
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not save mappings.")),
        },
      );
    }, 600);
    return () => clearTimeout(timer);
  }, [buildMappingInput, selectedKeyId, mappingsQuery.data, saveMappings, tool.id, tool.mappingSupported]);

  const buildApplyInput = useCallback((): ApplyInput => {
    const modelSlots = Object.fromEntries(
      tool.defaultModels.map((model) => [
        model.alias,
        slotModels[model.alias] ?? model.defaultValue ?? model.id,
      ]),
    );
    const subagent = tool.defaultModels.find((model) => model.roleKind === "subagent");
    const allModelIds = [
      ...activeModels,
      ...extraModels.filter((m) => m.trim().length > 0),
    ];
    return {
      endpoint,
      apiKey: "",
      modelIds: tool.id === "claude" ? [] : allModelIds,
      modelSlots,
      ...(allModelIds[0] ? { activeModel: allModelIds[0] } : {}),
      ...(subagent
        ? { subagentModel: slotModels[subagent.alias] ?? subagent.defaultValue ?? subagent.id }
        : {}),
      mappingOwnerId: selectedKeyId,
      ...(tool.mappingSupported ? { mapping: buildMappingInput() } : {}),
      // Tools whose config carries a runtime-package field expose an SDK
      // picker; sending it for the rest is harmless but noise.
      ...(tool.id === "opencode" || tool.id === "kilo" ? { sdk } : {}),
      // OpenCode's config carries the websearch provider selection.
      ...(tool.id === "opencode" ? { websearch: websearchProvider } : {}),
      // YOLO / auto-approve mode, written into the tool's permission config.
      ...(tool.id === "opencode" || tool.id === "kilo" ? { bypassPermissions: yoloMode } : {}),
    };
  }, [
    activeModels,
    buildMappingInput,
    selectedKeyId,
    endpoint,
    slotModels,
    tool,
    sdk,
    extraModels,
    websearchProvider,
    yoloMode,
  ]);

  // Live JSON preview of what would be written, mirroring the injector's
  // shape (one provider entry named `cartethyia`, everything else preserved).
  // Model entries are enriched from the Cartethyia catalog — limit, cost,
  // capabilities (tools / input / output / reasoning / vision) are taken from
  // the roster when known, not invented.
  const previewConfig = useMemo(() => {
    const input = buildApplyInput();
    const allModels = [...activeModels, ...extraModels.filter((m) => m.trim().length > 0)];
    const providerId = "cartethyia";
    const baseUrl = input.endpoint.replace(/\/+$/, "") + "/v1";

    const byQualified = new Map<string, FlatModelEntry>();
    for (const entry of modelCatalog) byQualified.set(entry.qualified, entry);

    const modelEntryFor = (name: string): Record<string, unknown> => {
      const entry = byQualified.get(name);
      if (!entry) {
        // Unknown model — emit the minimal entry OpenCode accepts.
        return { name };
      }
      const c = entry.entry;
      const model: Record<string, unknown> = { name: c.modelId };
      if (c.contextLimit !== null && c.outputLimit !== null) {
        model.limit = {
          context: c.contextLimit,
          ...(c.outputLimit !== null ? { output: c.outputLimit } : {}),
        };
      }
      const inputModalities: string[] = ["text"];
      if (c.vision) inputModalities.push("image");
      if (c.audio) inputModalities.push("audio");
      if (c.document) inputModalities.push("pdf");
      model.capabilities = {
        tools: c.toolCall,
        input: inputModalities,
        output: ["text"],
        ...(c.mediaGeneration ? { image: true } : {}),
        ...(c.reasoning ? { reasoning: { supported: true } } : {}),
      };
      return model;
    };

    let config: Record<string, unknown> = {};
    if (tool.id === "opencode") {
      config = {
        $schema: "https://opencode.ai/config.json",
        ...(yoloMode
          ? {
              permissions: [
                { action: "shell", resource: "*", effect: "allow" },
                { action: "external_directory", resource: "*", effect: "allow" },
                { action: "question", resource: "*", effect: "deny" },
              ],
            }
          : {}),
        provider: {
          [providerId]: {
            package: sdk,
            settings: {
              baseURL: baseUrl,
              apiKey: "•••••••• (selected key)",
            },
            models: Object.fromEntries(allModels.map((m) => [m, modelEntryFor(m)])),
          },
        },
        model: allModels[0] ? `${providerId}/${allModels[0]}` : "",
        ...(websearchProvider ? { websearch: { provider: websearchProvider } } : {}),
      };
    } else if (tool.id === "kilo") {
      config = {
        provider: {
          [providerId]: {
            npm: sdk,
            options: {
              baseURL: input.endpoint,
              apiKey: "•••••••• (selected key)",
            },
            models: Object.fromEntries(allModels.map((m) => [m, modelEntryFor(m)])),
          },
        },
        model: allModels[0] ? `${providerId}/${allModels[0]}` : "",
      };
    } else {
      config = { note: "No config preview for this tool." };
    }
    return stringifyFlat(config);
  }, [tool.id, sdk, activeModels, extraModels, websearchProvider, yoloMode, buildApplyInput, modelCatalog]);

  return (
    <Stack gap="16px">
      <Link
        to="/cli-tools"
        className="inline-flex items-center gap-3 text-caption text-accent"
      >
        <ArrowLeft size={14} />
        Back to CLI Tools
      </Link>

      <Card>
        <CardBody className="flex flex-col gap-5">
          <Inline gap="14px" align="flex-start" className="flex-wrap">
            <ToolIcon toolId={tool.id} name={tool.name} color={tool.color} size={46} />
            <Inline gap="8px" className="flex-wrap">
              <h1 className="text-title font-bold m-0">{tool.name}</h1>
              {installed ? (
                <Badge tone="ok">Installed</Badge>
              ) : (
                <Badge tone="disabled">Not installed</Badge>
              )}
              {configured ? <Badge tone="accent">Configured</Badge> : null}
            </Inline>
          </Inline>
          <p className="m-0 text-caption text-text-secondary">
            {tool.description}
          </p>
          {tool.docsUrl ? (
            <a
              href={tool.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-caption text-accent"
            >
              Official documentation →
            </a>
          ) : null}

          {status?.settingsPath ? (
            <div
              className="font-mono tabular-nums px-6 py-4 rounded-inset bg-surface-2 border border-inner-border text-badge text-text-secondary break-all"
            >
              Config file: {status.settingsPath}
            </div>
          ) : null}

          {status?.message ? (
            <div
              className={`flex items-center gap-3 text-badge ${configured ? "text-green" : "text-orange"}`}
            >
              {configured ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              {status.message}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="CLI tool configuration"
          subtitle="Pick the API key, endpoint and models, then apply or download. The key's secret is read server-side — you never paste it."
          subtitleAddon={
            <span className={satisfiedCount === requiredCount ? "text-green" : "text-orange"}>
              {satisfiedCount}/{requiredCount} set ·{" "}
              {satisfiedCount === requiredCount ? "ready to apply" : "complete the missing fields"}
            </span>
          }
          icon={<Settings2 size={16} />}
        />
        <CardBody>
          <Stack gap="20px">
            {/* ── Section: Account & endpoint ───────────────────────────── */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <h3 className="text-body font-semibold m-0">Account</h3>
                <div className="flex items-center gap-3 flex-wrap">
                  <FieldStatus ok={selectedKeyId.length > 0} label="API key" />
                  <FieldStatus ok={endpoint.trim().length > 0} label="Endpoint" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 items-start min-w-0 max-medium:grid-cols-1">
                <div className="flex flex-col gap-3 min-w-0">
                  <Select
                    label="Apikey Name"
                    id="api-key-select"
                    value={selectedKeyId}
                    onValueChange={setSelectedKeyId}
                    options={[
                      { value: "", label: "Select…" },
                      ...selectableKeys.map((key) => ({
                        value: key.id,
                        label: `${key.label} — ${key.keyMode === "personal" ? "Personal" : "Share template"}`,
                      })),
                    ]}
                  />
                  <div className="flex items-center gap-3 flex-wrap">
                    {selectedKey === undefined ? (
                      <span className="mt-1 text-badge text-text-tertiary">
                        Choose the Apikey Name whose routes this CLI session should use.
                      </span>
                    ) : cliEligible ? (
                      <>
                        <Badge tone="ok">routing:cli_mapping</Badge>
                        <span className="mt-1 text-badge text-text-tertiary">
                          Remote routes work with this key.
                        </span>
                      </>
                    ) : (
                      <>
                        <Badge tone="warn" title="This key cannot resolve persisted CLI mappings on /v1/*. Turn on Remote Routing below to enable it.">
                          no CLI scope
                        </Badge>
                        <span className="mt-1 text-badge text-text-tertiary">
                          Remote routes stay inert on this key — turning on Remote Routing below will activate it.
                        </span>
                      </>
                    )}
                  </div>
                  {selectedKey?.keyMode === "share" ? (
                    <span className="mt-1 text-badge text-text-tertiary">
                      Share template: its child keys inherit these routes automatically.
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0">
                  <Input
                    label="Endpoint"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                  />
                </div>
              </div>
            </section>

            {/* ── Section: Runtime & web search ─────────────────────────── */}
            {(tool.id === "opencode" || tool.id === "kilo") ? (
              <section className="flex flex-col gap-3 border-t border-inner-border pt-5">
                <h3 className="text-body font-semibold m-0">Runtime & web search</h3>
                <div className="grid grid-cols-2 gap-4 items-start min-w-0 max-medium:grid-cols-1">
                  <div className="flex flex-col gap-2 min-w-0">
                    <Select
                      label="Runtime package (SDK)"
                      id="sdk-select"
                      value={sdk}
                      onValueChange={setSdk}
                      options={sdkOptions.choices.map((choice) => ({
                        value: choice.id,
                        label: sdkOptionLabel(choice),
                      }))}
                    />
                    <p className="text-micro text-text-tertiary m-0">
                      {sdkOptions.choices.find((c) => c.id === sdk)?.description ??
                        "Runtime package used in the provider config."}
                    </p>
                    <p className="text-micro font-mono text-text-tertiary m-0 break-all">
                      {sdkPairLabel(sdkOptions.choices.find((c) => c.id === sdk)!) ??
                        (tool.id === "opencode"
                          ? "Native package — bundled with OpenCode"
                          : "")}
                    </p>
                  </div>
                  {tool.id === "opencode" ? (
                    <div className="flex flex-col gap-2 min-w-0">
                      <Select
                        label="Web search provider"
                        id="websearch-select"
                        value={websearchProvider}
                        onValueChange={setWebsearchProvider}
                        options={[
                          { value: "carte", label: "Via Cartethyia (default)" },
                          { value: "random", label: "Native OpenCode Console" },
                        ]}
                      />
                      <p className="text-micro text-text-tertiary m-0">
                        {websearchProvider === "carte"
                          ? "Search routes through the Cartethyia gateway — no extra key needed."
                          : "OpenCode's own provider selection (may require an API key or Console billing)."}
                      </p>
                    </div>
                  ) : null}
                  {(tool.id === "opencode" || tool.id === "kilo") ? (
                    <div className="flex flex-col gap-2 min-w-0">
                      <Switch
                        checked={yoloMode}
                        onChange={setYoloMode}
                        label={yoloMode ? "YOLO mode on" : "YOLO mode off"}
                      />
                      <p className="text-micro text-text-tertiary m-0">
                        {yoloMode
                          ? "Auto-approve shell/read/write — permission prompts are skipped (dangerous but convenient)."
                          : "Keep OpenCode's built-in permission prompts (default ask/deny)."}
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* ── Section: Model routing ────────────────────────────────── */}
            <section className="flex flex-col gap-3 border-t border-inner-border pt-5">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <h3 className="text-body font-semibold m-0">Model routing</h3>
                <FieldStatus ok={allModels.length > 0} label="Models" />
                {tool.mappingSupported ? (
                  <div className="flex items-center gap-4">
                    <Switch
                      checked={mappingEnabled}
                      disabled={!selectedKeyId}
                      onChange={(enabled) => {
                        setMappingEnabled(enabled);
                        if (!selectedKeyId) {
                          toast.error("Select an API key first to configure its Remote Routing.");
                          return;
                        }
                        // When Remote Routing is turned ON: auto-grant the routing:cli_mapping
                        // scope to this specific key so the routes immediately take effect.
                        if (enabled && selectedKey && !cliEligible) {
                          const nextScopes = [...new Set([...(selectedKey.scopes ?? []), "routing:cli_mapping"])];
                          updateApiKey.mutate(
                            { keyId: selectedKey.id, request: { scopes: nextScopes } },
                            {
                              onSuccess: () => {
                                toast.success(`Activated routing:cli_mapping on "${selectedKey.label}".`);
                              },
                              onError: (error) => {
                                toast.error(getErrorMessage(error, "Could not update key scope."));
                              },
                            },
                          );
                        }
                        const input = buildMappingInput();
                        if (input) {
                          saveMappings.mutate(
                            { toolId: tool.id, keyId: selectedKeyId, input: { ...input, enabled } },
                            {
                              onError: (error) =>
                                toast.error(getErrorMessage(error, "Could not save mappings.")),
                            },
                          );
                        }
                      }}
                      label={mappingEnabled ? "Remote Routing on" : "Remote Routing off"}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!selectedKeyId || resetMappings.isPending}
                      onClick={() => {
                        if (!selectedKeyId) {
                          toast.error("Select an API key first.");
                          return;
                        }
                        resetMappings.mutate(
                          { toolId: tool.id, keyId: selectedKeyId },
                          {
                            onSuccess: () => {
                              setMappingEnabled(false);
                              setMappingTargets({});
                              toast.success("Remote routes cleared and Remote Routing turned off.");
                            },
                            onError: (error) =>
                              toast.error(getErrorMessage(error, "Could not reset remote routes.")),
                          },
                        );
                      }}
                    >
                      {resetMappings.isPending ? "Resetting…" : "Reset"}
                    </Button>
                  </div>
                ) : null}
              </div>

              <p className="text-badge text-text-tertiary m-0">
                {tool.mappingSupported
                  ? "Left is the model name the CLI asks for. Right is the route Cartethyia sends it to. Leave a target empty to send that slot straight to the provider."
                  : "The model names written into this tool's config."}
              </p>

              {!selectedKeyId ? (
                <p className="text-badge text-text-tertiary">
                  Select an API key above to load and save remote routes for that key. You can still set models below to apply or download a config file.
                </p>
              ) : null}

              {tool.mappingSupported ? (
                <div className="mb-5 flex items-center gap-4 rounded-inset border border-inner-border bg-surface-2 px-5 py-3 text-micro text-text-tertiary">
                  <span className="flex-1">CLI asks for</span>
                  <span className="w-9 text-center">→</span>
                  <span className="flex-1">Cartethyia routes to</span>
                </div>
              ) : null}

              <Stack gap="6px">
                {tool.defaultModels.map((model) => {
                  const slotValue = slotModels[model.alias] ?? model.defaultValue ?? model.id;
                  const targetValue = mappingTargets[model.alias] ?? "";
                  const sameAsSource = targetValue === slotValue;
                  return (
                    <div
                      key={model.alias}
                      className={`grid items-center gap-4 ${tool.mappingSupported ? "grid-cols-2" : "grid-cols-1"}`}
                    >
                      <div className="flex flex-col gap-1 min-w-0">
                        <button
                          type="button"
                          onClick={() => {
                            setPickerFor(model.alias);
                            setPickerMode("slot");
                          }}
                          className="font-mono tabular-nums flex w-full min-w-0 cursor-pointer items-center justify-between gap-4 rounded-inset border border-inner-border bg-surface-2 px-5 py-3.5 text-left text-badge text-text-primary"
                        >
                          <span className="overflow-hidden truncate whitespace-nowrap">
                            {slotValue}
                          </span>
                          <Search size={12} className="text-text-tertiary shrink-0" />
                        </button>
                        <span className="text-micro text-text-tertiary pl-1">
                          {model.roleLabel ?? model.name}
                        </span>
                      </div>

                      {tool.mappingSupported ? (
                        <div className="flex flex-col gap-1 min-w-0">
                          <button
                            type="button"
                            onClick={() => {
                              setPickerFor(model.alias);
                              setPickerMode("target");
                            }}
                            className={`font-mono tabular-nums flex w-full min-w-0 cursor-pointer items-center justify-between gap-4 rounded-inset border px-5 py-3.5 text-left text-badge ${sameAsSource ? "border-inner-border bg-surface-2 text-text-tertiary" : "border-accent bg-accent-soft text-text-primary"}`}
                          >
                            <span className="overflow-hidden truncate whitespace-nowrap">
                              {targetValue.length > 0 ? targetValue : "Not routed"}
                            </span>
                            <Search size={12} className="text-text-tertiary shrink-0" />
                          </button>
                          <span
                            className={`pl-1 text-micro ${targetValue.length === 0 ? "text-text-tertiary" : "text-accent"}`}
                          >
                            {targetValue.length === 0 ? "not routed" : "rerouted"}
                            {targetValue.length > 0 ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setMappingTargets((prev) => ({ ...prev, [model.alias]: "" }))
                                }
                                className="ml-3 border-none bg-none p-0 text-micro text-text-tertiary cursor-pointer underline"
                              >
                                clear
                              </button>
                            ) : null}
                          </span>
                          {blockedMappings.has(model.alias) ? (
                            <span className="mt-1 flex items-center gap-3 text-micro text-orange">
                              <span>
                                {accessMode === "blacklist"
                                  ? "This key blocks the target model."
                                  : "This key does not allow the target model."}
                              </span>
                              <button
                                type="button"
                                disabled={updateApiKey.isPending}
                                onClick={() => allowModelForKey(targetValue)}
                                className={`border-none bg-none p-0 text-micro font-semibold text-accent underline ${updateApiKey.isPending ? "cursor-not-allowed" : "cursor-pointer"}`}
                              >
                                {accessMode === "blacklist" ? "Unblock" : "Allow this model"}
                              </button>
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                {(tool.id === "opencode" || tool.id === "kilo") ? (
                  <>
                    <div className="flex flex-col gap-2">
                      {extraModels.map((modelName, index) => (
                        <div
                          key={`extra-${index}`}
                          className="flex items-center gap-3 rounded-inset border border-inner-border bg-surface-2 px-4 py-2.5"
                        >
                          <span className="font-mono tabular-nums text-badge text-text-primary flex-1 truncate">
                            {modelName || "\u00A0"}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setExtraModels((prev) => prev.filter((_, i) => i !== index))
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Plus size={14} />}
                        onClick={() => setPickerMultiOpen(true)}
                      >
                        Add models…
                      </Button>
                    </div>
                  </>
                ) : null}
              </Stack>
            </section>

            {/* ── Section: Apply / download ─────────────────────────────── */}
            <section className="flex flex-col gap-3 border-t border-inner-border pt-5">
              <h3 className="text-body font-semibold m-0">Write config</h3>
              <p className="text-badge text-text-tertiary m-0">
                Write the config on this machine (with a .bak backup), or download it for manual placement. The selected API key secret is decrypted automatically.
              </p>
              <div className="flex gap-4 flex-wrap justify-end">
                <Button
                  variant="ghost"
                  icon={<Eye size={14} />}
                  onClick={() => setPreviewOpen(true)}
                  disabled={!selectedKeyId}
                >
                  Preview config
                </Button>
                <Button
                  variant="secondary"
                  icon={<CheckCircle2 size={14} />}
                  onClick={() => {
                    if (!selectedKeyId) {
                      toast.error("Select an API key first.");
                      return;
                    }
                    applyTool.mutate(
                      { toolId: tool.id, keyId: selectedKeyId, input: { ...buildApplyInput(), mode: "both" } },
                      {
                        onSuccess: (result) => {
                          toast.success(
                            result.wroteFile
                              ? `Config written${result.settingsPath ? ` to ${result.settingsPath}` : ""} (backup .bak created).`
                              : result.message,
                          );
                        },
                        onError: (error) =>
                          toast.error(getErrorMessage(error, "Could not apply config.")),
                      },
                    );
                  }}
                  disabled={applyTool.isPending || !canAct}
                >
                  {applyTool.isPending ? "Applying…" : "Apply & cek"}
                </Button>
                <Button
                  variant="primary"
                  icon={<Download size={14} />}
                  onClick={() => {
                    if (!selectedKeyId) {
                      toast.error("Select an API key first.");
                      return;
                    }
                    downloadTool.mutate(
                      { toolId: tool.id, keyId: selectedKeyId, input: buildApplyInput() },
                      {
                        onSuccess: (result) => {
                          downloadTextFile(result.filename, result.content, result.mimeType);
                          toast.success(`Downloaded ${result.filename}.`);
                        },
                        onError: (error) =>
                          toast.error(getErrorMessage(error, "Could not download config.")),
                      },
                    );
                  }}
                  disabled={downloadTool.isPending || !canAct}
                >
                  {downloadTool.isPending ? "Downloading…" : "Download config"}
                </Button>
              </div>
              {!canAct ? (
                <p className="text-badge text-text-tertiary text-right">
                  {selectedKey?.keyMode === "share"
                    ? "A share template has no secret to write into a config. Select a personal key to write or download the config file."
                    : "Select an Apikey Name above to enable applying or downloading the config file."}
                </p>
              ) : null}
            </section>
          </Stack>
        </CardBody>
      </Card>

      <ModelPickerModal
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        selected={
          pickerFor
            ? [
                pickerMode === "target"
                  ? (mappingTargets[pickerFor] ?? slotModels[pickerFor] ?? "")
                  : (slotModels[pickerFor] ?? ""),
              ]
            : []
        }
        onToggle={() => {}}
        onSelectOne={(v) => {
          if (pickerFor) {
            if (pickerMode === "target") setMappingTargets((prev) => ({ ...prev, [pickerFor]: v }));
            else if (pickerFor.startsWith("extra-")) {
              const index = Number(pickerFor.slice("extra-".length));
              if (Number.isFinite(index)) {
                setExtraModels((prev) => {
                  const next = [...prev];
                  next[index] = v;
                  return next;
                });
              }
            } else setSlotModels((prev) => ({ ...prev, [pickerFor]: v }));
          }
          setPickerFor(null);
        }}
        title={pickerFor ? `Select ${pickerFor} model` : "Select model"}
        multi={false}
      />
      <ModelPickerModal
        open={pickerMultiOpen}
        onClose={() => setPickerMultiOpen(false)}
        selected={extraModels}
        onToggle={(value) => {
          setExtraModels((prev) =>
            prev.includes(value) ? prev.filter((m) => m !== value) : [...prev, value],
          );
        }}
        title="Select models"
        multi
      />

      <Dialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="Config preview"
        size="lg"
      >
        <div className="flex flex-col gap-3">
          <p className="text-micro text-text-tertiary m-0">
            This is the JSON that will be written (or downloaded) for {tool.name}. Existing
            providers in your config are kept as-is — only{" "}
            <span className="font-mono">cartethyia</span> is added/updated.
          </p>
          <pre className="m-0 max-h-[60vh] overflow-auto rounded-inset border border-inner-border bg-surface-2 p-5 font-mono text-badge text-text-primary whitespace-pre-wrap break-all">
            {previewConfig}
          </pre>
        </div>
      </Dialog>
    </Stack>
  );
}
