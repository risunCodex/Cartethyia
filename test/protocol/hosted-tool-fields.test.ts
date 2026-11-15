/**
 * F-9: hosted/native tool declarations keep their wire fields.
 *
 * An `mcp` tool's `server_label`/`server_url`/`allowed_tools` and a
 * `web_search` tool's `search_context_size`/`filters` were dropped at parse —
 * the type was forwarded unconfigured, so a search request arrived search-less
 * and an MCP tool arrived server-less. The ingress allowlist captures the
 * fields per native family; the supporting encoder re-emits them on the wire
 * that carries them and debug-drops the rest.
 */
import { describe, expect, test } from "bun:test";
import { chatAdapter } from "../../src/transport/surface/chat/adapter";
import { responsesAdapter } from "../../src/transport/surface/responses/adapter";
import { canonicalToResponsesPayload } from "../../src/protocol/request/responses";

describe("F-9: hosted tool fields survive ingress", () => {
  test("an mcp declaration captures its server configuration", () => {
    const parsed = responsesAdapter.parse({
      model: "m",
      input: "hi",
      tools: [
        {
          type: "mcp",
          server_label: "deepwiki",
          server_url: "https://mcp.deepwiki.com/mcp",
          allowed_tools: ["read_documentation"],
          require_approval: "never",
        },
      ],
    });
    expect(parsed.tools?.[0]).toMatchObject({
      tool_type: "mcp",
      hosted_fields: {
        server_label: "deepwiki",
        server_url: "https://mcp.deepwiki.com/mcp",
        allowed_tools: ["read_documentation"],
        require_approval: "never",
      },
    });
  });

  test("a web_search declaration captures its tuning fields", () => {
    const parsed = responsesAdapter.parse({
      model: "m",
      input: "hi",
      tools: [{ type: "web_search", search_context_size: "low", filters: { allowed_domains: ["a.com"] } }],
    });
    expect(parsed.tools?.[0]?.hosted_fields).toMatchObject({
      search_context_size: "low",
      filters: { allowed_domains: ["a.com"] },
    });
  });

  test("an unallowlisted field on a hosted tool is dropped, not forwarded", () => {
    const parsed = responsesAdapter.parse({
      model: "m",
      input: "hi",
      tools: [{ type: "web_search", evil_field: "x" }],
    });
    expect(parsed.tools?.[0]?.hosted_fields).toBeUndefined();
  });

  test("the Responses encoder re-emits the configuration", () => {
    const request = responsesAdapter.parse({
      model: "m",
      input: "hi",
      tools: [
        { type: "web_search", search_context_size: "low" },
        { type: "mcp", server_label: "deepwiki", server_url: "https://mcp.deepwiki.com/mcp" },
      ],
    });
    const payload = canonicalToResponsesPayload(request);
    const tools = payload["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: "web_search_preview", search_context_size: "low" });
    expect(tools[1]).toEqual({
      type: "mcp",
      server_label: "deepwiki",
      server_url: "https://mcp.deepwiki.com/mcp",
    });
  });

  test("a field captured for another wire's vocabulary is debug-dropped, not sent", () => {
    // An Anthropic-shaped max_uses crossing onto the Responses wire must not
    // reach Codex as an unknown field.
    const request = responsesAdapter.parse({
      model: "m",
      input: "hi",
      tools: [{ type: "web_search", max_uses: 3 }],
    });
    const payload = canonicalToResponsesPayload(request);
    const tools = payload["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: "web_search_preview" });
  });

  test("function tools are unaffected", () => {
    const parsed = chatAdapter.parse({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "f", parameters: { type: "object", properties: {} } }],
    });
    expect(parsed.tools?.[0]?.hosted_fields).toBeUndefined();
    // A bare function declaration carries no native family.
    expect(parsed.tools?.[0]?.tool_type).toBeUndefined();
  });
});
