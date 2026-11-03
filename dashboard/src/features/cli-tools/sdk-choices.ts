/**
 * SDK choices for the CLI tools page.
 *
 * Kept here, in the dashboard, rather than in the backend `contracts.ts`:
 * importing that module from the browser pulls `node:os` (via `fs-ops`) and
 * Vite externalizes it, crashing the page. The list is pure data, so it can
 * live safely in the dashboard.
 *
 * The two tools that expose a runtime-package picker use different package
 * families:
 * - OpenCode: its native `@opencode/ai/providers/*` packages (bundled with
 *   OpenCode itself) — never the AI SDK.
 * - Kilo Code: the AI SDK `@ai-sdk/*` packages (Kilo is a fork of OpenCode
 *   but moved to the AI SDK runtime; the native OpenCode packages are not
 *   supported there).
 */

export interface SdkChoice {
  /** The package id actually written into the tool's config. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** OpenCode native package equivalent (when this choice is an AI SDK package). */
  readonly native?: string;
  readonly protocol: "openai-compatible" | "openai-responses" | "anthropic-messages" | "gemini";
}

export const OPENCODE_SDK_CHOICES: readonly SdkChoice[] = [
  {
    id: "@opencode/ai/providers/openai-compatible",
    label: "OpenAI Compatible",
    protocol: "openai-compatible",
    description: "OpenAI chat-completions wire — the default for a gateway like Cartethyia.",
  },
  {
    id: "@opencode/ai/providers/openai/responses",
    label: "OpenAI Responses",
    protocol: "openai-responses",
    description: "OpenAI Responses wire (Responses API).",
  },
  {
    id: "@opencode/ai/providers/anthropic",
    label: "Anthropic Messages (official)",
    protocol: "anthropic-messages",
    description: "Anthropic Messages wire — for Anthropic-compatible endpoints.",
  },
  {
    id: "@opencode/ai/providers/google",
    label: "Gemini",
    protocol: "gemini",
    description: "Google GenerateContent wire — when your gateway exposes Gemini.",
  },
];

export const KILO_SDK_CHOICES: readonly SdkChoice[] = [
  {
    id: "@ai-sdk/openai-compatible",
    label: "OpenAI Compatible",
    protocol: "openai-compatible",
    native: "@opencode/ai/providers/openai-compatible",
    description: "Kilo's bundled OpenAI-compatible runtime (OpenAI chat format).",
  },
  {
    id: "@ai-sdk/openai",
    label: "OpenAI / Responses",
    protocol: "openai-responses",
    native: "@opencode/ai/providers/openai/responses",
    description: "Kilo's bundled OpenAI runtime (Responses API).",
  },
  {
    id: "@ai-sdk/anthropic",
    label: "Anthropic Messages",
    protocol: "anthropic-messages",
    native: "@opencode/ai/providers/anthropic",
    description: "Kilo's bundled Anthropic runtime (Messages API).",
  },
  {
    id: "@ai-sdk/google",
    label: "Google Gemini",
    protocol: "gemini",
    native: "@opencode/ai/providers/google",
    description: "Kilo's bundled Google runtime (GenerateContent).",
  },
];

export const OPENCODE_DEFAULT_SDK = "@opencode/ai/providers/openai-compatible";
export const KILO_DEFAULT_SDK = "@ai-sdk/openai-compatible";

export interface SdkOptions {
  readonly choices: readonly SdkChoice[];
  readonly defaultSdk: string;
}

export function sdkOptionsFor(toolId: string): SdkOptions {
  if (toolId === "kilo") {
    return { choices: KILO_SDK_CHOICES, defaultSdk: KILO_DEFAULT_SDK };
  }
  return { choices: OPENCODE_SDK_CHOICES, defaultSdk: OPENCODE_DEFAULT_SDK };
}

/** Dropdown label — always includes the exact package id so the operator knows which "@" is written. */
export function sdkOptionLabel(choice: SdkChoice): string {
  return `${choice.label} · ${choice.id}`;
}

/**
 * The "by @ … @ …" pairing for AI-SDK-based tools (Kilo). Returns null for
 * OpenCode: its choices are native-only and should never mention the AI SDK.
 */
export function sdkPairLabel(choice: SdkChoice): string | null {
  if (choice.native) return `AI SDK ${choice.id} ↔ native ${choice.native}`;
  return null;
}
