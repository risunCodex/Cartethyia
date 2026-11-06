// Trae model rosters.
//
// Each realm has its own roster because upstream really does serve different
// models per deployment — CN is domestic (Doubao/DeepSeek/GLM/Kimi/Qwen),
// intl is frontier (Gemini/Claude/GPT/Grok). Merging them would offer a CN
// account models its realm refuses, which is a runtime failure rather than a
// cosmetic one.
//
// The static rosters are the fallback, not the truth: `discoverTraeModels`
// replaces them with the live `/api/ide/v1/model_list` answer when that
// endpoint works. It works on CN only — intl answers `403 no schema found`, so
// intl stays on its static roster and says so via `modelListSupported`.

import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import { TRAE_AGENT_CHAT_PATH, TRAE_CHAT_PATH } from "./trae-realm";

/** One roster row, as upstream describes it. */
export interface TraeModelRow {
  /** Upstream key, sent as `model_name`. */
  readonly id: string;
  readonly displayName: string;
  /** Context window, preferring the selectable maximum. */
  readonly ctx: number;
  readonly out: number;
  readonly vision: boolean;
  readonly reasoning: boolean;
  /**
   * Surface this row belongs to.
   *
   * Defaults to `"chat"`. The picker's models must be `"agent"`: they are
   * absent from `model_list` and answer `4023 model is unknown` on the chat
   * path no matter which host is tried.
   */
  readonly surface?: TraeSurface;
}

/** Which upstream endpoint serves a row. */
export type TraeSurface = "chat" | "agent";

/** CN roster: 20 chat-face models from the client-state snapshot. */
const TRAE_CN_ROWS: readonly TraeModelRow[] = [
  { id: "Doubao-Seed-Code", displayName: "Seed-Code", ctx: 256000, out: 224000, vision: true, reasoning: true },
  { id: "DeepSeek-V4-Flash-Official", displayName: "DeepSeek-V4-Flash", ctx: 1000000, out: 936000, vision: false, reasoning: true },
  { id: "DeepSeek-V4-Pro-Official", displayName: "DeepSeek-V4-Pro", ctx: 1000000, out: 936000, vision: false, reasoning: true },
  { id: "deepseek-v4.1-flash", displayName: "DeepSeek-V4.1-Flash", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "glm-5.2", displayName: "GLM-5.2", ctx: 1000000, out: 936000, vision: false, reasoning: true },
  { id: "glm-5.3", displayName: "GLM-5.3", ctx: 1000000, out: 936000, vision: false, reasoning: true },
  { id: "glm-5.3-flash", displayName: "GLM-5.3-Flash", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "glm-5.3-flashx", displayName: "GLM-5.3-FlashX", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "kimi-k2.8-preview", displayName: "Kimi-K2.8-Preview", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "kimi-k3", displayName: "Kimi-K3", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "mimo-v2.6-flash", displayName: "MiMo-V2.6-Flash", ctx: 981504, out: 917504, vision: true, reasoning: false },
  { id: "mimo-v2.6-pro", displayName: "MiMo-V2.6-Pro", ctx: 981504, out: 917504, vision: true, reasoning: false },
  { id: "minimax-m3", displayName: "MiniMax-M3", ctx: 1000000, out: 936000, vision: true, reasoning: false },
  { id: "qwen-3.7-plus", displayName: "Qwen3.7-Plus", ctx: 1000000, out: 936000, vision: true, reasoning: false },
  { id: "qwen3.8-flash", displayName: "Qwen3.8-Flash", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "qwen3.8-max", displayName: "Qwen3.8-Max", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "Doubao-Seed-2.1-Pro", displayName: "Seed-2.1-Pro-0915", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "Doubao-Seed-2.1-Turbo", displayName: "Seed-2.1-Turbo", ctx: 256000, out: 224000, vision: true, reasoning: true },
  { id: "Doubao-Seed-Evolving", displayName: "Seed-Evolving", ctx: 1000000, out: 936000, vision: true, reasoning: false },
  { id: "step-5-preview", displayName: "Step-5-Preview", ctx: 1000000, out: 936000, vision: true, reasoning: true },
];

/**
 * Intl roster: the IDE picker's models, every row confirmed by a real
 * completion on a live SG account.
 *
 * Agent-only, and that is a deliberate narrowing rather than an oversight.
 * Trae serves two disjoint surfaces and the legacy chat roster (`gpt-4o`,
 * `gemini_2.5_flash`, `deepseek-V3`, …) belongs to the other one: those ids
 * are rejected here with `4001 param is invalid`, and the agent ids are
 * rejected there with `4023 model is unknown`. There is no call that serves
 * both, so a single-surface catalog is the only honest one; offering the chat
 * ids would advertise models this provider's dispatch cannot reach.
 *
 * `ctx` is the **selectable maximum** (`context_window_tokens.max`), not the
 * active `dev` window. Upstream advertises both and they differ by up to 5x
 * (DeepSeek-V4 rows: 200k active, 1M selectable), so reading `dev` makes a
 * client under-request the window it is entitled to. The maximum is per model
 * and is **not** uniform: the GPT rows cap at 272k and Kimi-K2.5 / MiniMax-M2.7
 * offer no selectable upgrade at all, staying at 200k. `gpt-5.4` is the
 * exception: upstream raised its selectable maximum to 1M, so it is filed at
 * 1M while the rest of the GPT rows stay at 272k.
 *
 * `out` is what the same model is filed at in the CodeBuddy roster where that
 * roster carries it (DeepSeek-V4 384k, MiniMax-M3 512k, Kimi-K2.5 262k,
 * Kimi-K3 131k, Gemini-3.1-Pro and Kimi-K2.7 65k, the GPT rows 128k), and 131k
 * for models absent there. It is deliberately **not** Trae's
 * `model_detail_list[0].max_tokens`: upstream states that as the cap it applies
 * to its own output, which collapsed the whole roster onto 32k/64k and is far
 * below what these models actually return elsewhere.
 *
 * `glm-5.2` is absent: it is in the harness's id map but not in any account
 * config list, and answers `4001` identically to a bogus id.
 *
 * Rows report their real upstream in `timing_cost.provider_model_name`, which
 * is usually not the id sent (DeepSeek-V4.1-Flash resolves to
 * `ep-2026…-69njn`), so the id is always the config name, never the resolved
 * one.
 */
const TRAE_INTL_ROWS: readonly TraeModelRow[] = [
  { id: "gpt-5.4", displayName: "GPT-5.4", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, surface: "agent" },
  { id: "gpt-5.2-codex-paygo", displayName: "GPT-5.2-Codex", ctx: 272000, out: 128_000, vision: true, reasoning: true, surface: "agent" },
  { id: "Dola-Seed-2.0-Code", displayName: "Seed-2.1-Turbo", ctx: 1000000, out: 131_072, vision: true, reasoning: true, surface: "agent" },
  { id: "gemini-3.1-pro-paygo", displayName: "Gemini-3.1-Pro-PayGo", ctx: 1000000, out: 65_536, vision: true, reasoning: true, surface: "agent" },
  // Search-agent configs from the live picker (batch_get_detail_param). They
  // resolve to real chat models — gpt-5.4 / gpt-5.3-codex / gemini-3-flash —
  // and accept the same tool-calling wire as any agent row, so their specs
  // mirror the model they resolve to (verified live 2026-11-06).
  { id: "search_agent_gpt-5.4", displayName: "Search Agent (GPT-5.4)", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, surface: "agent" },
  { id: "search_agent_gpt-5.3-codex", displayName: "Search Agent (GPT-5.3-Codex)", ctx: 272000, out: 128_000, vision: true, reasoning: true, surface: "agent" },
  { id: "search_agent_gemini_3_pro_with_g3f", displayName: "Search Agent (Gemini-3-Flash)", ctx: 1000000, out: 65_536, vision: true, reasoning: true, surface: "agent" },
];

function traeModels(rows: readonly TraeModelRow[], providerId: string): readonly ModelDefinition[] {
  return rows.map((row) =>
    defineModel({
      id: row.id,
      providerId,
      wireFamily: "chat",
      endpoint: row.surface === "agent" ? TRAE_AGENT_CHAT_PATH : TRAE_CHAT_PATH,
      ctx: row.ctx,
      out: row.out,
      vision: row.vision,
      reasoning: row.reasoning,
    }),
  );
}

export const TRAE_CN_MODELS: readonly ModelDefinition[] = traeModels(TRAE_CN_ROWS, "traecn");
export const TRAE_INTL_MODELS: readonly ModelDefinition[] = traeModels(TRAE_INTL_ROWS, "trae");

/**
 * Reads the largest context window out of one upstream model object.
 *
 * Upstream reports two independent numbers and they are not the same thing:
 * `context_window_size.default` is the window that is active, while
 * `context_window_size.max` is a *list* of selectable windows. Reading only
 * the default is what made the fetcher always pick the smaller number — CN
 * DeepSeek advertises 116k active but 1M selectable, so a client told 116k
 * never asks for the window the account is entitled to.
 *
 * `context_window_tokens` is the older sibling spelling; `dev` pairs with
 * `default` and `max` pairs with `max`.
 */
export function traeMaxContextWindow(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const candidates: number[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(collect);
  };

  const size = record["context_window_size"];
  if (typeof size === "object" && size !== null) {
    const sized = size as Record<string, unknown>;
    collect(sized["max"]);
  }
  const tokens = record["context_window_tokens"];
  if (typeof tokens === "object" && tokens !== null) {
    collect((tokens as Record<string, unknown>)["max"]);
  }
  if (candidates.length > 0) return Math.max(...candidates);

  // No selectable maximum: the active window is all we honestly know.
  if (typeof size === "object" && size !== null) {
    const fallback = (size as Record<string, unknown>)["default"];
    if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  }
  if (typeof tokens === "object" && tokens !== null) {
    const fallback = (tokens as Record<string, unknown>)["dev"];
    if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  }
  const prompt = record["prompt_max_tokens"];
  if (typeof prompt === "number" && Number.isFinite(prompt) && prompt > 0) return prompt;
  return undefined;
}
