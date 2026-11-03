// Declarative file injector driver and lifecycle contracts.

import { dirname } from "node:path";
import type {
  ApplyInput,
  ApplyResult,
  DownloadResult,
  InjectorSpec,
  ToolId,
  ToolInjector,
  ToolStatus,
} from "../contracts";
import { TOOL_IDS } from "../contracts";
import { checkBinaryInstalled, ensureDir, fileExists, keyPrefix } from "../fs-ops";
import { claudeSpec } from './claude';
import { codexSpec } from './codex';
import { kiloSpec } from './kilo';
import { opencodeSpec } from './opencode';

// ── injectors/driver.ts ──
/**
 * Generic driver and declarative spec types for CLI tool injectors.
 *
 * Implements the probe -> read -> apply -> write lifecycle for file-based
 * CLI tool injectors, eliminating repetitive boilerplate while allowing
 * tool-specific escape hatches.
 */

/**
 * Create a ToolInjector from a declarative InjectorSpec.
 */
export function createFileInjector(spec: InjectorSpec): ToolInjector {
  return {
    toolId: spec.toolId,
    async getStatus(): Promise<ToolStatus> {
      const path = spec.resolvePath();
      const installed = spec.checkInstalled
        ? await spec.checkInstalled(path)
        : spec.binary
          ? await checkBinaryInstalled(spec.binary)
          : await fileExists(path);

      const exists = await fileExists(path);
      if (!installed && !exists) {
        return {
          toolId: spec.toolId,
          installed: false,
          configured: false,
          settingsPath: spec.keepSettingsPathOnMissing ? path : null,
          currentEndpoint: null,
          currentApiKeyPrefix: null,
          currentModels: null,
        };
      }

      if (!exists) {
        return {
          toolId: spec.toolId,
          installed,
          configured: false,
          settingsPath: path,
          currentEndpoint: null,
          currentApiKeyPrefix: null,
          currentModels: null,
        };
      }

      const details = await spec.readStatus(path);
      return {
        toolId: spec.toolId,
        installed: true,
        configured: details.configured,
        settingsPath: path,
        currentEndpoint: details.currentEndpoint ?? null,
        currentApiKeyPrefix: details.currentApiKeyPrefix ?? keyPrefix(details.rawApiKey) ?? null,
        currentModels: details.currentModels ?? null,
        ...(details.message ? { message: details.message } : {}),
      };
    },

    async apply(input: ApplyInput): Promise<ApplyResult> {
      const path = spec.resolvePath();
      const dir = spec.resolveDir ? spec.resolveDir() : dirname(path);
      await ensureDir(dir);
      const warnings = await spec.apply(input, path);
      return {
        success: true,
        settingsPath: path,
        message: spec.messages?.applied ?? `${spec.displayName ?? spec.toolId} settings applied`,
        ...(Array.isArray(warnings) && warnings.length > 0 ? { warnings } : {}),
      };
    },

    async reset(): Promise<ApplyResult> {
      const path = spec.resolvePath();
      const exists = await fileExists(path);
      if (!exists && !spec.resetEvenIfMissing) {
        return {
          success: true,
          message: spec.messages?.resetMissing ?? `No settings file to reset`,
        };
      }
      const resetResult = await spec.reset(path);
      if (resetResult === false) {
        return {
          success: true,
          message: spec.messages?.resetMissing ?? `No settings file to reset`,
        };
      }
      return {
        success: true,
        settingsPath: path,
        message:
          spec.messages?.reset ??
          `Cartethyia settings removed from ${spec.displayName ?? spec.toolId}`,
      };
    },

    async download(input: ApplyInput): Promise<DownloadResult> {
      return spec.download(input);
    },
  };
}

// ── injectors/index.ts ──
/**
 * Single dispatch point for CliToolService: given a toolId, look up the
 * injector and call getStatus/apply/reset/download.
 *
 * File-based injectors are driven by a generic driver (createFileInjector)
 * configured via declarative specs. The map is built exhaustively from that
 * registry so a tool without an injector fails loudly at import, never
 * silently at lookup time.
 */
const FILE_INJECTORS: Partial<Record<ToolId, ToolInjector>> = {
  claude: createFileInjector(claudeSpec),
  codex: createFileInjector(codexSpec),
  opencode: createFileInjector(opencodeSpec),
  kilo: createFileInjector(kiloSpec),
};

export const INJECTORS: Record<ToolId, ToolInjector> = Object.fromEntries(
  TOOL_IDS.map((id) => {
    const injector = FILE_INJECTORS[id];
    if (injector === undefined) {
      throw new Error(`No injector registered for tool: ${id}`);
    }
    return [id, injector];
  }),
) as Record<ToolId, ToolInjector>;
