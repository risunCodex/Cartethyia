/**
 * CLI config-preview formatting tests.
 *
 * `stringifyFlat` renders the JSON preview for the CLI tools page. The form
 * was iterated with the user until it matched hand-written configs, so these
 * tests pin the shape:
 * - Structure (provider → settings → models → each model) always multi-line.
 * - Credential-bearing containers (`settings`, `options`, `headers`, `body`)
 *   always expand, so `apiKey` sits on its own line.
 * - Small detail values (`limit`, `reasoning`, short arrays, `websearch`)
 *   stay on one line.
 * - `cost` is never emitted (the roster does not carry it).
 */
import { describe, expect, test } from "bun:test";
import { stringifyFlat } from "../../src/features/cli-tools/CliToolDetailPage";

describe("stringifyFlat (CLI config preview)", () => {
  test("structure always expands, small leaf values stay inline", () => {
    const config = {
      provider: {
        cartethyia: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "http://127.0.0.1:12800/v1", apiKey: "sk-secret" },
          models: {
            "claude/claude-sonnet-5": { name: "claude/claude-sonnet-5" },
          },
        },
      },
      model: "cartethyia/claude/claude-sonnet-5",
      websearch: { provider: "carte" },
    };
    const out = stringifyFlat(config);

    // Provider block and settings expand.
    expect(out).toContain('"provider": {');
    expect(out).toContain('"cartethyia": {');
    expect(out).toContain('"settings": {');
    expect(out).toContain('"baseURL": "http://127.0.0.1:12800/v1"');
    // apiKey on its own line, never glued to baseURL.
    expect(out).toContain('"apiKey": "sk-secret"');
    expect(out).not.toContain('"baseURL": "http://127.0.0.1:12800/v1", "apiKey"');

    // Leaf values collapse.
    expect(out).toContain('"model": "cartethyia/claude/claude-sonnet-5"');
    expect(out).toContain('"websearch": { "provider": "carte" }');
  });

  test("settings/options always expand even when short", () => {
    const out = stringifyFlat({
      provider: { x: { settings: { apiKey: "k" } } },
    });
    expect(out).toContain('"settings": {');
    expect(out).toContain('"apiKey": "k"');
    expect(out).not.toContain('"settings": { "apiKey": "k" }');
  });

  test("model entries include limit and capabilities but never cost", () => {
    const model = {
      name: "claude-sonnet-4-6",
      limit: { context: 250000, output: 64000 },
      capabilities: {
        tools: true,
        input: ["text", "image"],
        output: ["text"],
        reasoning: { supported: true },
      },
    };
    const out = stringifyFlat(model);
    expect(out).toContain('"limit": { "context": 250000, "output": 64000 }');
    expect(out).toContain('"input": ["text", "image"]');
    expect(out).toContain('"reasoning": { "supported": true }');
    expect(out).not.toContain("cost");
  });

  test("empty models object renders as {}", () => {
    expect(stringifyFlat({ models: {} })).toContain('"models": {}');
  });

  test("permissions array renders each rule multi-line like a hand-written config", () => {
    const out = stringifyFlat({
      permissions: [
        { action: "shell", resource: "*", effect: "allow" },
        { action: "question", resource: "*", effect: "deny" },
      ],
    });
    expect(out).toContain('"permissions": [');
    expect(out).toContain('{ "action": "shell", "resource": "*", "effect": "allow" }');
    expect(out).toContain('{ "action": "question", "resource": "*", "effect": "deny" }');
    expect(out).not.toContain('"permissions": [{ "action"');
  });

  test("mcp servers block keeps its nested structure", () => {
    const out = stringifyFlat({
      mcp: {
        servers: {
          codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] },
        },
      },
    });
    expect(out).toContain('"mcp": {');
    expect(out).toContain('"servers": {');
    expect(out).toContain('"codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"] }');
  });
});
