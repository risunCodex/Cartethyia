// DeepAI model catalog + discovery.
//
// All 22 rows below were fetched live from `GET /deepai_code/models` on
// 2026-11-11 (see `documentation/research/deepai/2026-11-11-deepai-code-live-wire-verification.md`).
// The 11 zero-Theos rows carry the daily free-tier allowance (`freeTier: true`
// + `free: true` — they bill zero and do not draw from the balance). The
// metered rows keep their `theosPerRequest` price as a per-request cost
// estimate for the operator.
//
// Wire routing: every row is a chat-wire model except `gpt-6-astra`, which the
// upstream serves only on `/responses` (verified live: it answers 400
// `model_not_found` on `/chat/completions`, and the rest answer 400 on
// `/responses`).
import type { ModelDefinition } from "../../provider-model-definition";
import { defineModel } from "../../provider-model-definition";
import {
  DEEPAI_CHAT_PATH,
  DEEPAI_HEADER_INSTANCE,
  DEEPAI_HEADER_THEOS,
  DEEPAI_LANE_VERSION,
  DEEPAI_MODELS_PATH,
  DEEPAI_RESPONSES_PATH,
  deepAIInstanceId,
} from "./deepai-common";

interface DeepAIRosterRow {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly ctx: number;
  readonly out: number;
  readonly theosPerRequest: number;
  readonly responsesWire?: boolean;
}

const DEEPAI_ROSTER: readonly DeepAIRosterRow[] = [
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 0 },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash 1017", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 0 },
  { id: "mimo-2.6-flash", name: "MiMo 2.6 Flash", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 0 },
  { id: "qwen-3.8-flash", name: "Qwen 3.8 Flash", reasoning: true, vision: true, ctx: 991_000, out: 128_000, theosPerRequest: 0 },
  { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 0 },
  { id: "solar-mini-4", name: "Solar Mini 4", reasoning: true, vision: false, ctx: 524_288, out: 131_072, theosPerRequest: 0 },
  { id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true, vision: true, ctx: 1_048_576, out: 128_000, theosPerRequest: 0 },
  { id: "mimo-2.6-pro", name: "MiMo 2.6 Pro", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 0 },
  { id: "crouton-alpha", name: "Crouton Alpha", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 0 },
  { id: "glyph-cluster", name: "Glyph Cluster", reasoning: true, vision: false, ctx: 256_000, out: 131_072, theosPerRequest: 0 },
  { id: "deepai-cyber", name: "DeepAI Cyber", reasoning: true, vision: false, ctx: 1_048_576, out: 131_072, theosPerRequest: 0 },
  { id: "minimax-m3", name: "MiniMax M3", reasoning: true, vision: false, ctx: 512_000, out: 131_000, theosPerRequest: 2 },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoning: true, vision: true, ctx: 1_048_576, out: 128_000, theosPerRequest: 10 },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 10 },
  { id: "glm-5.3", name: "GLM 5.3", reasoning: true, vision: false, ctx: 1_048_576, out: 131_072, theosPerRequest: 3 },
  { id: "kimi-k3", name: "Kimi K3", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 3 },
  { id: "muse-spark-1.3", name: "Muse Spark 1.3", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 6 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true, vision: true, ctx: 1_000_000, out: 64_000, theosPerRequest: 15 },
  { id: "muse-wonder", name: "Muse Wonder", reasoning: true, vision: true, ctx: 1_048_576, out: 131_072, theosPerRequest: 15 },
  { id: "qwen-3.8-max-prime", name: "Qwen 3.8 Max Prime", reasoning: true, vision: true, ctx: 1_000_000, out: 131_072, theosPerRequest: 15 },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", reasoning: true, vision: true, ctx: 1_000_000, out: 64_000, theosPerRequest: 20 },
  { id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: true, vision: true, ctx: 1_048_576, out: 128_000, theosPerRequest: 50, responsesWire: true },
];

function rowToModel(row: DeepAIRosterRow): ModelDefinition {
  const free = row.theosPerRequest === 0;
  return defineModel({
    id: row.id,
    providerId: "deepai",
    wireFamily: row.responsesWire === true ? "responses" : "chat",
    endpoint: row.responsesWire === true ? DEEPAI_RESPONSES_PATH : DEEPAI_CHAT_PATH,
    ctx: row.ctx,
    out: row.out,
    vision: row.vision,
    reasoning: row.reasoning,
    toolCall: true,
    ...(free ? { free: true, freeTier: true } : {}),
  });
}

/** Static roster — the live-verified free tier plus metered rows. */
export const DEEPAI_DEFAULT_MODELS: readonly ModelDefinition[] =
  DEEPAI_ROSTER.map(rowToModel);

/** Live `/deepai_code/models` listing. */
export async function discoverDeepAIModels(options: {
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}${DEEPAI_MODELS_PATH}`;
  try {
    const response = await fetcher(url, {
      headers: {
        accept: "application/json",
        // The catalog is lane-aware: the 22-row roster only comes back with the
        // lane headers (verified live 2026-11-11 — bare GET returns a smaller
        // 9-row default roster).
        [DEEPAI_HEADER_THEOS]: DEEPAI_LANE_VERSION,
        [DEEPAI_HEADER_INSTANCE]: deepAIInstanceId(),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const list = payload !== null && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
      ? ((payload as { models: unknown }).models as readonly Record<string, unknown>[])
      : null;
    if (list === null || list.length === 0) return null;
    const rows: DeepAIRosterRow[] = [];
    for (const entry of list) {
      const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : null;
      if (id === null) continue;
      // `theosPerRequest` arrives as a string ("0", "2", "50") or a number.
      const theosNumber = parseTheosAmount(entry.theosPerRequest);
      const input = entry.input;
      const hasImage = Array.isArray(input) && input.some((m) => m === "image");
      rows.push({
        id,
        name: typeof entry.name === "string" ? entry.name : id,
        reasoning: entry.reasoning === true,
        vision: hasImage,
        ctx: positiveInt(entry.contextWindow) ?? positiveInt(entry.context_window) ?? 1_048_576,
        out: positiveInt(entry.maxTokens) ?? positiveInt(entry.max_completion_tokens) ?? 131_072,
        theosPerRequest: theosNumber,
        responsesWire: entry.api === "openai-responses",
      });
    }
    if (rows.length === 0) return null;
    return rows.map(rowToModel);
  } catch {
    return null;
  }
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** Parses `theosPerRequest` — a numeric string ("0"/"50") or a number. */
function parseTheosAmount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return Math.max(0, n);
    }
  }
  // Absent / unparseable means the server did not meter it → free.
  return 0;
}
