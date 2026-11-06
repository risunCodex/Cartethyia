/**
 * CodeBuddy CN model roster, isolated in a leaf module.
 *
 * `buddy-chat-shared` needs the raw table to answer output-limit lookups for
 * CN-only ids, and `cn-provider` builds its catalog from it. Keeping the table
 * here — instead of inside `cn-provider` — removes the load-time import cycle
 * between `buddy-chat-shared` ⇄ `cn-provider` (and its buddy-media/provider
 * variants): both sides import this module, and this module imports nothing
 * back.
 */
import type { BuddyRawEntry } from "../buddy-catalog-shared";

export const CODEBUDDY_CN_RAW: readonly BuddyRawEntry[] = [
  ["glm-5.1", "GLM 5.1", true, true, 200_000, 48_000],
  ["glm-5.2", "GLM 5.2", true, true, 1_000_000, 64_000],
  ["glm-5.3", "GLM 5.3", true, true, 1_000_000, 64_000],
  ["glm-5.3-flash", "GLM 5.3 Flash", true, true, 1_000_000, 131_072],
  ["glm-5v-turbo", "GLM 5v Turbo", true, true, 200_000, 64_000],
  ["minimax-m3", "MiniMax M3", true, true, 512_000, 64_000],
  // 1M context, reasoning always on (upstream states both); vision inherited
  // from the M3 row, which is the same family.
  ["minimax-m3.1-flash", "MiniMax M3.1 Flash", true, true, 1_000_000, 128_000],
  ["mimo-v2.6-pro", "MiMo V2.6 Pro", true, true, 1_000_000, 128_000],
  ["kimi-k2.8-preview", "Kimi K2.8 Preview", true, true, 1_000_000, 64_000],
  ["kimi-k3.1-pro", "Kimi K3.1 Pro", true, true, 1_000_000, 32_000],
  ["hy3", "Hy3", true, true, 192_000, 64_000],
  ["hy4", "Hy4", true, true, 960_000, 64_000],
  ["hy4free", "Hy4 Free", true, true, 960_000, 64_000],
  ["space-bunny", "Space Bunny", true, true, 1_000_000, 128_000],
  ["step-5-preview", "Step 5 Preview", true, true, 1_000_000, 64_000],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", true, true, 1_000_000, 128_000],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", true, true, 1_000_000, 128_000],
  // Live on the CN roster but absent here, so a request for it resolved to
  // nothing. Limits as published by /v3/config.
  ["kimi-k3-1", "Kimi K3-1", true, true, 1_000_000, 32_000],
  ["minimax-m2.7", "MiniMax M2.7", true, true, 200_000, 48_000],
];
