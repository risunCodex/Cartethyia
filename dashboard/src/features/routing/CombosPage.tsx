import { ArrowRight, Copy, CopyPlus, Image as ImageIcon, Layers, Pencil, Plus, Route, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { DialogActions } from "../../components/ui/dialog-actions";
import { Input } from "../../components/ui/input";
import { ListRow } from "../../components/ui/list-row";
import { Select } from "../../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { Inline, CardActions } from "../../components/ui/inline";
import { ModelPickerModal, type FlatModelEntry } from "../../components/ModelPicker";
import { SortableList } from "../../components/SortableList";
import { ScopeInjectionField } from "../../components/ScopeInjectionField";
import { Stack } from "../../components/ui/stack";
import { CodeChip } from "../../components/ui/code-chip";
import { getErrorMessage } from "../../data/api";
import { useTrackedTimeout } from "../../hooks/use-timeout";
import { useClipboard } from "../../hooks/use-clipboard";
import { toast } from "../../lib/toast";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../../hooks/settings";
import type { ComboStrategy, ModelAliasRow, ModelComboRow, UpdateRuntimeSettingsRequest } from "../../data/contracts";
import { COMBO_STRATEGY_OPTIONS } from "./combo-strategy";
import {
  useCloneModelCombo,
  useCreateModelAlias,
  useCreateModelCombo,
  useDeleteModelAlias,
  useDeleteModelCombo,
  useModelAliases,
  useModelCombos,
  useReorderModelAliases,
  useReorderModelCombos,
  useUpdateModelAlias,
  useUpdateModelCombo,
} from "../../hooks/routing";

/** A stable id for a chip in the dialog's SortableList. Browser sessions need
 *  not be unique across page lifetime — they only need to survive one drag. */
const makeId = (): string =>
  `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── Aliases Section ──────────────────────────────────────────────────────────

function AliasesSection(): ReactNode {
  const aliasesQuery = useModelAliases();
  const createMutation = useCreateModelAlias();
  const updateMutation = useUpdateModelAlias();
  const deleteMutation = useDeleteModelAlias();
  const reorderMutation = useReorderModelAliases();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAlias, setEditingAlias] = useState<ModelAliasRow | null>(null);
  const [aliasName, setAliasName] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ModelAliasRow | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const { copy } = useClipboard();
  const scheduleCopyReset = useTrackedTimeout();

  const aliases = useMemo(() => aliasesQuery.data ?? [], [aliasesQuery.data]);

  const openCreate = () => {
    setEditingAlias(null);
    setAliasName("");
    setTargetModel("");
    setDialogOpen(true);
  };

  const openEdit = (a: ModelAliasRow) => {
    setEditingAlias(a);
    setAliasName(a.alias);
    setTargetModel(a.targetModel);
    setDialogOpen(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!aliasName.trim() || !targetModel.trim()) return;

    if (editingAlias) {
      // Both fields are editable now: the alias name rides along with the
      // target, and the backend cascades a rename through alias chains and
      // combo members that referenced the old name.
      updateMutation.mutate(
        {
          id: editingAlias.id,
          request: { alias: aliasName.trim(), targetModel: targetModel.trim() },
        },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditingAlias(null);
            toast.success("Alias updated");
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not save the alias.")),
        },
      );
    } else {
      createMutation.mutate(
        { alias: aliasName.trim(), targetModel: targetModel.trim() },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setAliasName("");
            setTargetModel("");
            toast.success("Alias created");
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not create the alias.")),
        },
      );
    }
  };

  const handleCopy = (text: string, id: string) => {
    void copy(text).then((ok) => {
      if (!ok) {
        toast.error("Copy failed");
        return;
      }
      setCopiedKey(id);
      scheduleCopyReset(() => setCopiedKey(null), 1500);
    });
  };

  return (
    <Card>
      <CardHeader
        title="Model Aliases"
        subtitle="Map readable names to real models (e.g. claude-mythos-5 → claude-opus-5)"
        icon={<Route size={16} />}
        action={
          <CardActions>
            <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={openCreate}>
              New Alias
            </Button>
          </CardActions>
        }
      />
      <CardBody>
        {aliasesQuery.isPending ? (
          <LoadingState label="Loading aliases..." />
        ) : aliasesQuery.isError ? (
          <ErrorState message="Failed to load aliases" onRetry={() => aliasesQuery.refetch()} />
        ) : aliases.length === 0 ? (
          <EmptyState
            title="No aliases defined"
            message="Create an alias to route short or friendly names to real provider model IDs."
          />
        ) : (
          <SortableList
            items={aliases}
            label="Model aliases"
            gap="8px"
            disabled={reorderMutation.isPending}
            onReorder={(ids) =>
              reorderMutation.mutate(ids, {
                onError: (error) =>
                  toast.error(getErrorMessage(error, "Could not save the new order.")),
              })
            }
            renderItem={(a) => (
              <ListRow
                className="items-start flex-col sm:flex-row"
                actions={
                  <Inline gap="4px" className="w-full justify-start sm:w-auto sm:justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Copy size={13} />}
                      onClick={() => handleCopy(a.alias, a.id)}
                      title={copiedKey === a.id ? "Copied!" : "Copy alias"}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Pencil size={13} />}
                      onClick={() => openEdit(a)}
                      title="Edit target model"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 size={13} />}
                      onClick={() => setDeleteConfirm(a)}
                      title="Delete alias"
                      className="text-red"
                    />
                  </Inline>
                }
              >
                <div
                  className="flex items-center gap-4 flex-wrap min-w-0"
                >
                  <CodeChip value={a.alias} tone="accent" />
                  <ArrowRight size={13} className="text-text-tertiary shrink-0" />
                  <CodeChip value={a.targetModel} tone="plain" />
                </div>
              </ListRow>
            )}
          />
        )}
      </CardBody>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingAlias ? "Edit Model Alias" : "New Model Alias"}
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="alias-form" disabled={createMutation.isPending || updateMutation.isPending || !aliasName.trim() || !targetModel.trim()}>
              {editingAlias ? "Save Changes" : "Create Alias"}
            </Button>
          </>
        }
      >
        <form
          id="alias-form"
          onSubmit={handleSave}
          className="flex flex-col gap-6"
        >
          <Input
            label="Alias name"
            id="alias-name-input"
            value={aliasName}
            onChange={(e) => setAliasName(e.target.value)}
            placeholder="e.g. fast, sonnet, smart"
            required
          />
          <Inline gap="8px" align="flex-end">
            <div className="flex-1">
              <Input
                label="Target model"
                id="target-model-input"
                value={targetModel}
                onChange={(e) => setTargetModel(e.target.value)}
                placeholder="e.g. codex/gpt-5.5, claude/claude-sonnet-5"
                required
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setPickerOpen(true)}
              icon={<Search size={13} />}
            >
              Browse
            </Button>
          </Inline>
          <ModelPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            selected={targetModel ? [targetModel] : []}
            onToggle={() => {}}
            onSelectOne={(v) => setTargetModel(v)}
            title="Select target model"
            multi={false}
          />
          {editingAlias ? (
            <ScopeInjectionField kind="alias" name={editingAlias.alias} />
          ) : null}
        </form>
      </Dialog>

      <Dialog
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        title="Delete Model Alias"
      >
        <Stack gap="12px">
          <p className="text-body text-text-secondary">
            Are you sure you want to delete alias <strong>{deleteConfirm?.alias}</strong>? Clients
            requesting this name will need their full model path.
          </p>
          <DialogActions>
            <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleteConfirm) {
                  deleteMutation.mutate(deleteConfirm.id, {
                    onSuccess: () => setDeleteConfirm(null),
                  });
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Alias"}
            </Button>
          </DialogActions>
        </Stack>
      </Dialog>
    </Card>
  );
}

// ── Vision Handoff Section ───────────────────────────────────────────────────

/** The vision-only model filter used by the picker. */
function isVisionModel(entry: FlatModelEntry): boolean {
  return entry.kind === "model" && entry.entry.vision === true;
}

/**
 * The global ordered vision-handoff model list. When a request carries images
 * but the chosen model cannot see them, the gateway sends the image to the
 * first model on this list and injects its description as text — the chosen
 * model still answers. The first healthy model wins; if it fails (cooldown,
 * quota, upstream error) the handoff falls to the next entry. Empty = the
 * legacy `[image]` placeholder behavior. The list is ordered by dragging, and
 * the picker only offers image-capable chat models.
 */
export function VisionHandoffSection(): ReactNode {
  const settingsQuery = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const [pickerOpen, setPickerOpen] = useState(false);
  const settings = settingsQuery.data;
  const models = settings?.visionHandoffModels ?? [];
  // Mirrors the server setting. Deliberately not a `useState` initializer: the
  // settings query can resolve after mount (cold cache), and freezing the list
  // on the first render kept a just-saved model invisible until a hard refresh.
  // Re-syncing on every settings change keeps local order authoritative while
  // still reflecting the persisted list once it arrives.
  const [list, setList] = useState<readonly { id: string; value: string }[]>([]);
  useEffect(() => {
    setList(models.map((value) => ({ id: `v${value}`, value })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const save = (
    patch: UpdateRuntimeSettingsRequest,
    message: string,
  ): void => {
    mutation.mutate(patch, {
      onSuccess: () => toast.success(message),
      onError: (error) =>
        toast.error(getErrorMessage(error, "Could not update vision handoff.")),
    });
  };

  const toggle = (value: string) => {
    const next = list.some((m) => m.value === value)
      ? list.filter((m) => m.value !== value)
      : [...list, { id: `v${value}-${list.length}`, value }];
    setList(next);
    save(
      { visionHandoffModels: next.map((m) => m.value) },
      "Vision handoff models updated.",
    );
  };

  const reorder = (ids: string[]) => {
    const byId = new Map(list.map((m) => [m.id, m]));
    const next = ids
      .map((id) => byId.get(id))
      .filter((m): m is { id: string; value: string } => Boolean(m));
    setList(next);
    save(
      { visionHandoffModels: next.map((m) => m.value) },
      "Vision handoff order updated.",
    );
  };

  if (settingsQuery.isPending)
    return <LoadingState label="Loading vision handoff settings…" />;
  if (settingsQuery.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(
          settingsQuery.error,
          "Failed to load runtime settings",
        )}
        onRetry={() => void settingsQuery.refetch()}
      />
    );
  }

  return (
    <Card>
      <CardHeader
        title="Vision Handoff"
        subtitle="When the selected model cannot see images, describe them with a vision model first"
        icon={<ImageIcon size={16} />}
        action={
          <CardActions>
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={13} />}
              onClick={() => setPickerOpen(true)}
            >
              Pick models
            </Button>
          </CardActions>
        }
      />
      <CardBody>
        {list.length === 0 ? (
          <EmptyState
            title="No vision handoff models"
            message="Add an ordered list of image-capable models. When a request carries an image but the chosen model cannot see it, the gateway will ask the first healthy model on this list to describe it and pass that description to the chosen model as text."
          />
        ) : (
          <SortableList
            items={list}
            label="Vision handoff models"
            gap="6px"
            onReorder={reorder}
            renderItem={(m) => (
              <ListRow
                density="compact"
                actions={
                  <button
                    type="button"
                    aria-label={`Remove ${m.value}`}
                    onClick={() => toggle(m.value)}
                    className="grid size-7 cursor-pointer place-items-center rounded-control text-text-tertiary hover:bg-hover"
                  >
                    <X size={12} />
                  </button>
                }
              >
                <div className="flex items-center gap-3 min-w-0">
                  <ImageIcon size={14} className="shrink-0 text-text-tertiary" />
                  <CodeChip value={m.value} tone="accent" />
                </div>
              </ListRow>
            )}
          />
        )}
      </CardBody>
      <ModelPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={list.map((m) => m.value)}
        onToggle={toggle}
        title="Select vision models"
        multi
        filter={isVisionModel}
      />
    </Card>
  );
}

// ── Combos Section ───────────────────────────────────────────────────────────

function CombosSection(): ReactNode {
  const combosQuery = useModelCombos();
  const createMutation = useCreateModelCombo();
  const cloneMutation = useCloneModelCombo();
  const updateMutation = useUpdateModelCombo();
  const deleteMutation = useDeleteModelCombo();
  const reorderMutation = useReorderModelCombos();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCombo, setEditingCombo] = useState<ModelComboRow | null>(null);
  const [comboName, setComboName] = useState("");
  /**
   * The combo's members in the order the operator arranges them. Each one keeps
   * a stable id so drag reordering stays cheap (a remount would lose the grip
   * the operator is holding). A `Member` value lives only in this state; the
   * server contract and the wire payload carry just the string, so we strip the
   * id when persisting.
   */
  const [members, setMembers] = useState<readonly { id: string; value: string }[]>([]);
  const [strategy, setStrategy] = useState<ComboStrategy>("fallback");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ModelComboRow | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const { copy } = useClipboard();
  const scheduleCopyReset = useTrackedTimeout();

  const memberValues = useMemo(() => members.map((m) => m.value), [members]);

  /**
   * Toggle a member in/out of the combo. Picker rows are not aware of ordering,
   * so a newly-toggled value lands at the end of whatever order the operator
   * had built — that is the least surprising place when "add" means append and
   * "remove" means drop the chip that already exists.
   */
  const handlePickerToggle = (value: string) => {
    if (memberValues.includes(value))
      setMembers(members.filter((m) => m.value !== value));
    else setMembers([...members, { id: makeId(), value: value.trim() }]);
  };

  const combos = combosQuery.data ?? [];

  const openCreate = () => {
    setEditingCombo(null);
    setComboName("");
    setMembers([]);
    setStrategy("fallback");
    setDialogOpen(true);
  };

  const openEdit = (c: ModelComboRow) => {
    setEditingCombo(c);
    setComboName(c.name);
    // A fresh id per row keeps SortableList stable across dialog (re)opens —
    // reusing ids from a prior open would let React's reconciliation reorder
    // lookups hit a stale tree and lose the chip an operator is mid-drag.
    setMembers(c.members.map((value) => ({ id: makeId(), value })));
    setDialogOpen(true);
  };

  /**
   * Clones a combo server-side: same members and strategy, named `${name}-clone`
   * (suffixed when taken). The server resolves the name so concurrent clones
   * cannot collide, and drops members that no longer resolve to a model, alias,
   * or combo — the clone still lands, and the toast names what was left out.
   */
  const handleClone = (c: ModelComboRow) => {
    cloneMutation.mutate(c.id, {
      onSuccess: (result) => {
        const skipped = result.skippedMembers;
        if (skipped.length > 0)
          toast.success(
            "Combo cloned",
            `${result.combo.name} — skipped unresolvable member${skipped.length > 1 ? "s" : ""}: ${skipped.join(", ")}`,
          );
        else toast.success("Combo cloned", result.combo.name);
      },
      onError: (error) => toast.error(getErrorMessage(error, "Could not clone the combo.")),
    });
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!comboName.trim() || memberValues.length === 0) return;

    if (editingCombo) {
      // Rename rides along with the member/strategy edit; the backend cascades
      // the name change through aliases and nested combos.
      updateMutation.mutate(
        {
          id: editingCombo.id,
          request: {
            name: comboName.trim(),
            members: memberValues,
            strategy,
          },
        },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditingCombo(null);
            toast.success("Combo saved");
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not save the combo.")),
        },
      );
    } else {
      createMutation.mutate(
        { name: comboName.trim(), members: memberValues, strategy },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setComboName("");
            setMembers([]);
            toast.success("Combo created");
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not create the combo.")),
        },
      );
    }
  };

  const handleStrategyChange = (combo: ModelComboRow, nextStrategy: ComboStrategy) => {
    updateMutation.mutate(
      {
        id: combo.id,
        request: { strategy: nextStrategy },
      },
      {
        onSuccess: () => toast.success("Combo strategy updated"),
        onError: (error) => toast.error(getErrorMessage(error, "Could not update the combo strategy.")),
      },
    );
  };

  const handleCopy = (text: string, id: string) => {
    void copy(text).then((ok) => {
      if (!ok) {
        toast.error("Copy failed");
        return;
      }
      setCopiedKey(id);
      scheduleCopyReset(() => setCopiedKey(null), 1500);
    });
  };

  return (
    <Card>
      <CardHeader
        title="Combos"
        subtitle="Combine multiple models with fallback or round-robin rotation"
        icon={<Layers size={16} />}
        action={
          <CardActions>
            <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={openCreate}>
              New Combo
            </Button>
          </CardActions>
        }
      />
      <CardBody>
        {combosQuery.isPending ? (
          <LoadingState label="Loading combos..." />
        ) : combosQuery.isError ? (
          <ErrorState message="Failed to load combos" onRetry={() => combosQuery.refetch()} />
        ) : combos.length === 0 ? (
          <EmptyState
            title="No combos defined"
            message="Create a model combo to distribute requests across multiple models."
          />
        ) : (
          <SortableList
            items={combos}
            label="Model combos"
            disabled={reorderMutation.isPending}
            onReorder={(ids) =>
              reorderMutation.mutate(ids, {
                onError: (error) =>
                  toast.error(getErrorMessage(error, "Could not save the new order.")),
              })
            }
            renderItem={(c) => (
              <ListRow
                className="items-start flex-col sm:flex-row"
                actions={
                  <Inline gap="8px" className="w-full justify-between sm:w-auto sm:justify-start">
                    <Select
                      value={c.strategy}
                      onValueChange={(v) => handleStrategyChange(c, v as ComboStrategy)}
                      options={COMBO_STRATEGY_OPTIONS}
                    />
                    <Inline gap="4px" className="flex-wrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Copy size={13} />}
                        onClick={() => handleCopy(c.name, c.id)}
                        title={copiedKey === c.id ? "Copied!" : "Copy combo name"}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<CopyPlus size={13} />}
                        onClick={() => handleClone(c)}
                        disabled={cloneMutation.isPending}
                        title="Clone combo (same members and strategy)"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Pencil size={13} />}
                        onClick={() => openEdit(c)}
                        title="Edit combo"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Trash2 size={13} />}
                        onClick={() => setDeleteConfirm(c)}
                        title="Delete combo"
                        className="text-red"
                      />
                    </Inline>
                  </Inline>
                }
              >
                <div
                  className="flex items-center justify-between gap-6 flex-wrap"
                >
                  {/* The strategy is already shown by the Select beside it; a
                      badge repeating the same value was redundant. */}
                  <strong className="text-body">{c.name}</strong>
                </div>

                <Inline gap="6px" className="w-full flex-wrap">
                  {c.members.map((m) => (
                    <CodeChip key={m} value={m} />
                  ))}
                </Inline>
              </ListRow>
            )}
          />
        )}
      </CardBody>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingCombo ? "Edit Model Combo" : "New Model Combo"}
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="combo-form" disabled={createMutation.isPending || updateMutation.isPending || !comboName.trim() || memberValues.length === 0}>
              {editingCombo ? "Save Changes" : "Create Combo"}
            </Button>
          </>
        }
      >
        <form
          id="combo-form"
          onSubmit={handleSave}
          className="flex flex-col gap-6"
        >
          <Input
            label="Combo name"
            id="combo-name-input"
            value={comboName}
            onChange={(e) => setComboName(e.target.value)}
            placeholder="e.g. smart-combo, fast-pool"
            required
          />
          <Select
            label="Strategy"
            id="combo-strategy-select"
            value={strategy}
            onValueChange={(v) => setStrategy(v as ComboStrategy)}
            options={COMBO_STRATEGY_OPTIONS}
          />
          {editingCombo ? (
            <ScopeInjectionField kind="combo" name={editingCombo.name} />
          ) : null}
          <Stack gap="6px">
            <div className="flex items-center justify-between">
              <label className="text-caption font-semibold text-text-secondary">
                Member models — use arrows or drag to reorder
              </label>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                icon={<Search size={12} />}
                onClick={() => setPickerOpen(true)}
              >
                Browse models
              </Button>
            </div>
            {/* The drop zone keeps its dashed outline and minimum height while
                empty; it only pads once members are inside it. */}
            <div
              role="list"
              aria-label="Combo members"
              data-testid="combo-members-list"
              className={`flex min-h-22 flex-col gap-2 rounded-control border border-dashed border-inner-border ${members.length === 0 ? "p-0" : "p-3"}`}
            >
              {members.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="flex-1 cursor-pointer font-inherit text-caption text-text-tertiary"
                >
                  Pick models to add
                </button>
              ) : (
                <SortableList
                  items={members}
                  label="Combo members"
                  gap="4px"
                  onReorder={(ids) => {
                    const byId = new Map(members.map((m) => [m.id, m]));
                    setMembers(ids.map((id) => byId.get(id)!).filter(Boolean));
                  }}
                  renderItem={(m) => (
                    <ListRow
                      density="compact"
                      actions={
                        <button
                          type="button"
                          onClick={() => handlePickerToggle(m.value)}
                          aria-label={`Remove ${m.value}`}
                          className="flex shrink-0 cursor-pointer text-text-tertiary"
                        >
                          <X size={12} />
                        </button>
                      }
                    >
                      <CodeChip value={m.value} tone="accent" />
                    </ListRow>
                  )}
                />
              )}
            </div>
          </Stack>
          <ModelPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            selected={memberValues}
            onToggle={handlePickerToggle}
            title="Select combo members"
            multi
          />
        </form>
      </Dialog>

      <Dialog
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        title="Delete Model Combo"
      >
        <Stack gap="12px">
          <p className="text-body text-text-secondary">
            Are you sure you want to delete combo <strong>{deleteConfirm?.name}</strong>? Any
            aliases pointing to it will fail to resolve.
          </p>
          <DialogActions>
            <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleteConfirm) {
                  deleteMutation.mutate(deleteConfirm.id, {
                    onSuccess: () => setDeleteConfirm(null),
                  });
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Combo"}
            </Button>
          </DialogActions>
        </Stack>
      </Dialog>
    </Card>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function Combos(): ReactNode {
  return (
    <Stack gap="16px">
      <CombosSection />
      <AliasesSection />
      <VisionHandoffSection />
    </Stack>
  );
}
