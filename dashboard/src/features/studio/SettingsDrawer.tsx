import { useEffect, useState, type ReactNode } from "react";
import { ModelPickerModal, type FlatModelEntry } from "../../components/ModelPicker";
import { Button } from "../../components/ui/button";
import { Drawer } from "../../components/ui/drawer";
import { Input, Textarea } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import type { LabDraft } from "./session";

const EFFORT_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
] as const;

const IMAGE_SIZE_OPTIONS = [
  { value: "512x512", label: "512 × 512" },
  { value: "1024x1024", label: "1024 × 1024" },
  { value: "1536x1024", label: "1536 × 1024" },
  { value: "1024x1536", label: "1024 × 1536" },
] as const;

const VIDEO_SIZE_OPTIONS = [
  { value: "480p", label: "480p" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
] as const;

const COUNT_OPTIONS = Array.from({ length: 10 }, (_, index) => {
  const value = String(index + 1);
  return { value, label: value };
});

const CUSTOM_SIZE = "__custom_size__";
const PROVIDER_DEFAULT = "__provider_default__";

const PERSONAS = [
  { value: "cartethyia", label: "Cartethyia" },
  { value: "unset", label: "None" },
] as const;

const TOOL_PERMISSIONS = [
  { value: "ask", label: "Ask before running" },
  { value: "yolo", label: "YOLO (run automatically)" },
] as const;

/**
 * Chat settings stay inside the Model Lab card on desktop and use a drawer on mobile.
 *
 * The chat model remains selected on the composer; this panel configures its
 * role and independent native media workers.
 */
export function SettingsDrawer({
  open,
  onClose,
  draft,
  onChange,
  chatModel,
  catalog,
  effortDisabled,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly draft: LabDraft;
  readonly onChange: (patch: Partial<LabDraft>) => void;
  readonly chatModel: string;
  readonly catalog: readonly FlatModelEntry[];
  readonly effortDisabled?: boolean;
}): ReactNode {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const controls = (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-5">
        <h3 className="m-0 text-caption font-bold tracking-label uppercase text-text-tertiary">Request</h3>
        <div className="flex flex-col gap-2">
          <span className="text-caption font-medium text-text-secondary">Chat model (planner)</span>
          <p className="m-0 text-text-primary font-mono text-caption break-all">
            {chatModel.length > 0 ? chatModel : "Choose a chat model in the composer"}
          </p>
          <p className="m-0 text-text-tertiary text-caption leading-normal">
            The chat model plans and responds. Image and video workers are selected independently below.
          </p>
        </div>
        <Select
          label="Reasoning effort"
          aria-label="Reasoning effort"
          value={draft.effort}
          options={EFFORT_OPTIONS}
          disabled={effortDisabled}
          onValueChange={(effort) => onChange({ effort: effort as LabDraft["effort"] })}
        />
        <WorkerModelPicker
          label="Image generation model"
          description="Generates images requested in chat; leave unset when no image worker is configured."
          serviceKind="imageGeneration"
          value={draft.imageWorkerModel}
          catalog={catalog}
          onChange={(imageWorkerModel) => onChange({ imageWorkerModel })}
        />
        <div className="grid grid-cols-2 gap-4 max-small:grid-cols-1">
          <MediaSizeSelect
            kind="image"
            value={draft.imageSize}
            onChange={(imageSize) => onChange({ imageSize })}
          />
          <Select
            label="Image count"
            aria-label="Image count"
            value={draft.imageCount}
            options={COUNT_OPTIONS}
            onValueChange={(imageCount) => onChange({ imageCount })}
          />
        </div>
        <WorkerModelPicker
          label="Video generation model"
          description="Generates video clips requested in chat; leave unset when no video worker is configured."
          serviceKind="videoGeneration"
          value={draft.videoWorkerModel}
          catalog={catalog}
          onChange={(videoWorkerModel) => onChange({ videoWorkerModel })}
        />
        <div className="grid grid-cols-2 gap-4 max-small:grid-cols-1">
          <MediaSizeSelect
            kind="video"
            value={draft.videoSize}
            onChange={(videoSize) => onChange({ videoSize })}
          />
          <Select
            label="Video count"
            aria-label="Video count"
            value={draft.videoCount}
            options={COUNT_OPTIONS}
            onValueChange={(videoCount) => onChange({ videoCount })}
          />
        </div>
        <p className="m-0 text-text-tertiary text-caption leading-normal">
          Agent tools are always orchestrated through Chat Completions.
        </p>
        <Select
          label="Persona"
          aria-label="Persona"
          value={draft.persona}
          options={PERSONAS}
          onValueChange={(persona) => onChange({ persona: persona as LabDraft["persona"] })}
        />
        <Select
          label="Tool permission"
          aria-label="Tool permission"
          value={draft.toolPermission}
          options={TOOL_PERMISSIONS}
          onValueChange={(toolPermission) => onChange({ toolPermission: toolPermission as LabDraft["toolPermission"] })}
        />
        <p className="m-0 text-text-tertiary text-caption leading-normal">
          Ask pauses before web search or media generation. YOLO runs these tools without confirmation; user questions still wait for your answer.
        </p>
      </section>

      <section className="flex flex-col gap-5">
        <h3 className="m-0 text-caption font-bold tracking-label uppercase text-text-primary">Advanced</h3>
        <div className="flex flex-col gap-6">
          <p className="m-0 text-text-tertiary text-caption leading-normal">Empty fields leave the model default alone.</p>
          <div className="grid grid-cols-2 gap-5 max-medium:grid-cols-1">
            <Input
              label="Temperature"
              inputMode="decimal"
              value={draft.temperature}
              placeholder="0.7"
              onChange={(event) => onChange({ temperature: event.target.value })}
            />
            <Input
              label="Top P"
              inputMode="decimal"
              value={draft.topP}
              placeholder="1"
              onChange={(event) => onChange({ topP: event.target.value })}
            />
          </div>
          <Textarea
            label="System prompt"
            rows={6}
            value={draft.systemPrompt}
            placeholder="Optional instructions sent ahead of the conversation."
            onChange={(event) => onChange({ systemPrompt: event.target.value })}
          />
        </div>
      </section>
    </div>
  );

  return (
    <>
      <aside className="scroll-region flex-none w-128 min-h-0 overflow-y-auto border-l border-inner-border px-7 py-8 max-medium:hidden">
        <h2 className="m-0 mb-7 text-lead font-semibold text-text-primary">Chat settings</h2>
        {controls}
      </aside>
      <Drawer open={open && isMobile} onClose={onClose} title="Chat settings">{controls}</Drawer>
    </>
  );
}

function MediaSizeSelect({
  kind,
  value,
  onChange,
}: {
  readonly kind: "image" | "video";
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const presets = kind === "image" ? IMAGE_SIZE_OPTIONS : VIDEO_SIZE_OPTIONS;
  const isStandard = (size: string) =>
    (kind === "video" && size === "") || presets.some((option) => option.value === size);
  const [customSelected, setCustomSelected] = useState(() => !isStandard(value));
  const [customValue, setCustomValue] = useState(() => isStandard(value) ? "" : value);

  useEffect(() => {
    if (isStandard(value)) {
      setCustomSelected(false);
      return;
    }
    setCustomSelected(true);
    setCustomValue(value);
  }, [kind, value]);

  const options = [
    ...(kind === "video" ? [{ value: PROVIDER_DEFAULT, label: "Provider default" }] : []),
    ...presets,
    { value: CUSTOM_SIZE, label: "Custom" },
  ];
  const selectValue = customSelected
    ? CUSTOM_SIZE
    : kind === "video" && value === ""
      ? PROVIDER_DEFAULT
      : value;
  const label = kind === "image" ? "Image size" : "Video size";
  const customLabel = kind === "image" ? "Custom image size" : "Custom video size";

  return (
    <div className="flex flex-col gap-3">
      <Select
        label={label}
        aria-label={label}
        value={selectValue}
        options={options}
        onValueChange={(nextValue) => {
          if (nextValue === CUSTOM_SIZE) {
            setCustomSelected(true);
            if (customValue.length > 0 && customValue !== value) onChange(customValue);
          } else if (nextValue === PROVIDER_DEFAULT) {
            setCustomSelected(false);
            onChange("");
          } else {
            setCustomSelected(false);
            onChange(nextValue);
          }
        }}
      />
      {customSelected ? (
        <Input
          label={customLabel}
          value={customValue}
          placeholder={kind === "video" ? "e.g. 720p or 1280x720" : "e.g. 1024x1024"}
          maxLength={32}
          onChange={(event) => {
            setCustomValue(event.target.value);
            onChange(event.target.value);
          }}
        />
      ) : null}
    </div>
  );
}

function WorkerModelPicker({
  label,
  description,
  serviceKind,
  value,
  catalog,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly serviceKind: "imageGeneration" | "videoGeneration";
  readonly value: string;
  readonly catalog: readonly FlatModelEntry[];
  readonly onChange: (model: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const hasModels = catalog.some((entry) =>
    entry.kind === "model" && entry.entry.enabled && entry.entry.serviceKind === serviceKind,
  );

  return (
    <div className="flex flex-col gap-2">
      <span className="text-caption font-medium text-text-secondary">{label}</span>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        disabled={!hasModels}
        title={value.length > 0 ? value : `Choose ${label.toLowerCase()}`}
        onClick={() => setOpen(true)}
        className="w-full min-w-0 justify-between border border-inner-border bg-surface-2 text-left"
      >
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {value.length > 0 ? value : hasModels ? "Select a model" : "No enabled worker available"}
        </span>
      </Button>
      {value.length > 0 ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="w-fit border-0 bg-transparent px-0 text-caption text-text-tertiary underline cursor-pointer hover:text-text-primary"
        >
          Clear selection
        </button>
      ) : null}
      <p className="m-0 text-text-tertiary text-caption leading-normal">{description}</p>
      <ModelPickerModal
        open={open}
        onClose={() => setOpen(false)}
        selected={value.length > 0 ? [value] : []}
        onToggle={() => {}}
        onSelectOne={onChange}
        multi={false}
        title={`Select ${label.toLowerCase()}`}
        size="md"
        filter={(entry) =>
          entry.kind === "model" && entry.entry.enabled && entry.entry.serviceKind === serviceKind
        }
      />
    </div>
  );
}
