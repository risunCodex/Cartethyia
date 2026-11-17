import { describe, expect, test } from "bun:test";
import {
  allowsCliToolMappings,
  detectRemoteCliToolId,
  type CliClientProbe,
} from "../../src/security/cli-client-fingerprint";
import {
  cliMappingSourceKeys,
} from "../../src/transport/routing/route-catalog-helpers";

const probe = (userAgent?: string): CliClientProbe =>
  userAgent === undefined ? {} : { userAgent };

describe("detectRemoteCliToolId", () => {
  test("recognises codex-tui user agents", () => {
    expect(
      detectRemoteCliToolId(
        probe("codex-tui/0.165.0 (Windows 10.0.22631; x86_64) herdr/0.9.5 (codex-tui; 0.165.0)"),
      ),
    ).toBe("codex");
    expect(detectRemoteCliToolId(probe("codex-cli/0.165.0"))).toBe("codex");
  });

  test("still recognises Claude Code", () => {
    expect(detectRemoteCliToolId(probe("claude-cli/2.1.312 (external, cli)"))).toBe("claude");
    expect(detectRemoteCliToolId(probe("claude-code/2.1.312"))).toBe("claude");
  });

  test("an unknown caller stays unlabelled", () => {
    expect(detectRemoteCliToolId(probe("opencode/latest/2.2.0/cli"))).toBeNull();
    expect(detectRemoteCliToolId(probe("OpenAI/Python 1.40.0"))).toBeNull();
    expect(detectRemoteCliToolId(probe())).toBeNull();
  });
});

describe("allowsCliToolMappings", () => {
  test("requires the routing:cli_mapping scope", () => {
    expect(allowsCliToolMappings(null, probe("codex-tui/0.165.0"))).toBe(false);
    expect(allowsCliToolMappings([], probe("codex-tui/0.165.0"))).toBe(false);
    expect(
      allowsCliToolMappings(["routing:cli_mapping"], probe("codex-tui/0.165.0")),
    ).toBe(true);
    expect(allowsCliToolMappings(["routing:cli_mapping"], probe("curl/8"))).toBe(false);
  });
});

describe("cliMappingSourceKeys for codex", () => {
  test("the Guardian auto-review model resolves to the canonical spelling", () => {
    expect(cliMappingSourceKeys("codex", "codex-auto-review")).toEqual(["codex-auto-review"]);
    // A non-canonical casing still carries the exact source spelling so the
    // operator's stored slot matches; the canonical form is appended for the
    // real wire spelling.
    expect(cliMappingSourceKeys("codex", "CODEX-AUTO-REVIEW")).toEqual([
      "CODEX-AUTO-REVIEW",
      "codex-auto-review",
    ]);
  });

  test("other codex model ids pass through verbatim", () => {
    expect(cliMappingSourceKeys("codex", "acme/deepseek-v4.1-flash")).toEqual([
      "acme/deepseek-v4.1-flash",
    ]);
    expect(cliMappingSourceKeys("codex", "gpt-5.6-sol")).toEqual(["gpt-5.6-sol"]);
  });
});
