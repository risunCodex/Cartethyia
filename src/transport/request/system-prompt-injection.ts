/**
 * Tenant system-prompt injection at the canonical level.
 *
 * Runs inside `applyTenantPreferences`, after reasoning/thinking shaping and
 * before RTK/PonyTail, so the injected text composes with (and is then
 * appended-to by) the compression directive. Wire-agnostic: one transform
 * covers messages/chat/responses/gemini/codex/kiro; provider-native
 * injection (Claude identity/billing prepend, buddy fixed system turn,
 * antigravity identity) happens later, in the adapters, and is untouched.
 *
 * Resolution is most-specific-wins: alias/combo (when the caller's requested
 * name matches one) > model > provider > global. A scope either references a
 * named preset, carries a custom setting, or follows the global prompt.
 * Failure is non-fatal — an unusable configuration must not fail a
 * dispatchable request.
 */
import type { CanonicalRequest } from "../../protocol/canonical-model";
import type { ServiceKind } from "../../protocol/canonical-model";
import type {
  PromptSetting,
  ScopePromptRef,
  TenantSystemPrompts,
} from "../../console/system-prompt/contracts";
import {
  systemPromptModelKey,
} from "../../console/system-prompt/contracts";

/** The route facts the resolution needs. */
export interface SystemPromptRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly serviceKind: ServiceKind;
  /** The model name the client asked for (pre-alias/combo resolution), when
   * it differs from the resolved `modelId` — lets a combo/alias carry its
   * own injection reference. */
  readonly requestedModel?: string;
}

/**
 * Resolves one scope reference to a concrete prompt setting. Returns
 * `undefined` when the scope has nothing to say (no entry, global disabled,
 * preset missing/disabled, custom disabled). `undefined` here means "skip
 * this scope" — the caller decides the final global fallback.
 */
function resolveRef(
  prompts: TenantSystemPrompts,
  ref: ScopePromptRef | undefined,
  global: PromptSetting | null,
): PromptSetting | undefined {
  if (ref === undefined) return undefined;
  if (ref.kind === "global") {
    return global !== null && global.enabled ? global : undefined;
  }
  if (ref.kind === "preset") {
    const preset = prompts.presets[ref.presetId];
    if (preset === undefined || !preset.enabled) return undefined;
    return { enabled: true, mode: preset.mode, text: preset.text };
  }
  return ref.setting.enabled ? ref.setting : undefined;
}

/**
 * Resolves the effective prompt for a route: the most-specific enabled scope
 * wins. Alias/combo scopes (keyed by the requested name) beat the model scope;
 * a provider scope honours its reference; model scope is always explicit.
 * Returns `undefined` when nothing applies.
 */
export function resolveTenantSystemPrompt(
  prompts: TenantSystemPrompts | undefined,
  route: Pick<SystemPromptRoute, "providerId" | "modelId" | "requestedModel">,
): PromptSetting | undefined {
  if (prompts === undefined) return undefined;
  const global = prompts.global;

  const requested = route.requestedModel;
  if (requested !== undefined && requested.length > 0 && requested !== route.modelId) {
    const aliasRef = prompts.aliases[requested];
    if (aliasRef !== undefined) {
      const aliasSetting = resolveRef(prompts, aliasRef, global);
      if (aliasSetting !== undefined) return aliasSetting;
    }
    const comboRef = prompts.combos[requested];
    if (comboRef !== undefined) {
      const comboSetting = resolveRef(prompts, comboRef, global);
      if (comboSetting !== undefined) return comboSetting;
    }
  }

  const model = prompts.models[systemPromptModelKey(route.providerId, route.modelId)];
  const modelSetting = resolveRef(prompts, model, global);
  if (modelSetting !== undefined) return modelSetting;

  const provider = prompts.providers[route.providerId];
  const providerSetting = resolveRef(prompts, provider, global);
  if (providerSetting !== undefined) return providerSetting;

  return global !== null && global.enabled ? global : undefined;
}

/** Marker text guard so retries never double-inject. */
function carriesText(system: readonly { kind: string }[] | undefined, text: string): boolean {
  return (system ?? []).some((part) => part.kind === "text" && (part as { text?: string }).text === text);
}

/**
 * Applies the resolved tenant prompt to the canonical request. Appends after
 * existing system content (or replaces the caller's system content for
 * `override` — provider-native identity injection later re-adds the fixed
 * provider prompt, so override is never a bare wire).
 */
export function applyInjectSystemPrompt(
  request: CanonicalRequest,
  prompts: TenantSystemPrompts | undefined,
  route: SystemPromptRoute,
): CanonicalRequest {
  // Non-chat native protocols have no system surface to inject into.
  if (route.serviceKind !== "llm") return request;
  const setting = resolveTenantSystemPrompt(prompts, route);
  if (setting === undefined || setting.text.length === 0) return request;

  const text = setting.text;
  // `override` replaces only the CALLER's system content: the adapters later
  // prepend their mandatory identity/billing blocks (claude, antigravity) or
  // install their fixed system turn (buddy), so the wire always keeps the
  // provider-native prompt. For wrapped-injection providers the override
  // cannot survive the replace at all — the identity must stay the opener —
  // so it degrades to append there.
  const existing = request.system ?? [];
  if (setting.mode === "override" && existing.length > 0) {
    return { ...request, system: [{ kind: "text", text }] };
  }
  if (carriesText(existing, text)) return request;
  return { ...request, system: [...existing, { kind: "text", text }] };
}
