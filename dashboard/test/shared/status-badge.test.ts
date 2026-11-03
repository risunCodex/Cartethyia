/**
 * `StatusBadge` contract tests.
 *
 * The badge is the single "set / not set" pill shared across the dashboard.
 * These tests pin its text and tone so future callers get the same vocabulary.
 */
import { describe, expect, test } from "bun:test";
import { StatusBadge } from "../../src/components/ui/status-badge";

function render(node: ReturnType<typeof StatusBadge>): string {
  // The component returns a React element; we can't mount it without a test
  // renderer, so we assert on the element's props (tone, dot, children, title).
  const el = node as {
    props?: { tone?: string; dot?: boolean; children?: unknown; title?: string };
  };
  const children = el.props?.children;
  const text = Array.isArray(children) ? children.join("") : String(children ?? "");
  return `${el.props?.tone ?? "default"}|${String(el.props?.dot ?? "")}|${text}|${el.props?.title ?? ""}`;
}

describe("StatusBadge", () => {
  test("ok state renders the ok tone with the label + 'set'", () => {
    const out = render(StatusBadge({ ok: true, label: "Endpoint" }));
    expect(out).toContain("ok|true|");
    expect(out).toContain("Endpoint set");
  });

  test("missing state renders the warn tone with the label + 'not set'", () => {
    const out = render(StatusBadge({ ok: false, label: "API key" }));
    expect(out).toContain("warn|true|");
    expect(out).toContain("API key not set");
  });

  test("missingLabel overrides the missing text", () => {
    const out = render(StatusBadge({ ok: false, label: "Models", missingLabel: "No models" }));
    expect(out).toContain("No models not set");
  });

  test("title propagates to the badge", () => {
    const out = render(StatusBadge({ ok: false, label: "X", title: "explain" }));
    expect(out).toContain("explain");
  });
});
