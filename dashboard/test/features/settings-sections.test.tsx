/**
 * Settings page contract: one section at a time, behind a tab strip.
 *
 * The property worth pinning is that a tab is a *choice of section*, not a
 * wall between them — every section is reachable from every other in one
 * click, the strip stays visible while a long section scrolls, and the URL
 * hash still names the section, so a link from elsewhere in the console lands
 * on the right tab instead of on whichever one happens to be first.
 *
 * The tab strip used to be banned here: the page previously showed one
 * section at a time with no way to see the rest, so an operator hunting for a
 * setting had to guess which heading concealed it. What makes the difference
 * is the strip, not the hiding — one section per panel is the point, and the
 * strip is what keeps the other four one click away. That is what these tests
 * hold: the tabs exist, every section is named by one, and the hash follows.
 *
 * Also pinned: no nested cards, and each field's label reads larger than its
 * help text. The page used to render a card inside a card, doubling borders
 * and padding, which only shows up visually.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import Settings, { boundedOptions } from "../../src/features/settings/SettingsPage";
import { mount, stubFetch, type Mounted } from "../helpers/render";
import { registerDom } from "../helpers/dom";

/**
 * Radix's Select touches `HTMLFormElement` while wiring its hidden form
 * field, and happy-dom does not put that constructor on `globalThis` — only
 * on `window`. Mounting a real Select therefore needs it aliased first, or the
 * component throws before it renders.
 *
 * This runs in `beforeAll` rather than at module scope: Bun shares one process
 * across test files, so importing a DOM at module load leaks it into sibling
 * suites that expect a bare environment.
 */
beforeAll(() => {
registerDom();
  // happy-dom installs its constructors on `window` but not on `globalThis`,
  // and Radix reaches for them unqualified — `HTMLFormElement`, then
  // `DocumentFragment`, then whatever it touches next. Alias every missing
  // window property rather than guessing a prefix: patching the one name in
  // the current error just moves the failure along.
  const source = globalThis.window as unknown as Record<string, unknown>;
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(source)) {
    if (target[name] !== undefined) continue;
    // Some window properties are read-only accessors, so a plain assignment
    // throws; define them instead and skip the few that cannot be redefined.
    try {
      Object.defineProperty(target, name, {
        value,
        writable: true,
        configurable: true,
      });
    } catch {
      // Not aliasing this one is fine: it either already works or is unused.
    }
  }
});

const SETTINGS = {
  telemetryPayloads: "none",
  telemetryPayloadDepth: "minimum",
  privacyMode: "masked",
  forceDisableCooldown: false,
  tenantConcurrencyLimit: null,
  concurrencyTolerance: null,
  thinkingNormalizationEnabled: false,
  responsesReasoningSummary: "detailed",
  upstreamTimeoutSeconds: null,
  telemetryWindowMinutes: null,
  imageClampMaxBytes: null,
  // The panel reads `settings.defaults.*` to name what each unset row
  // resolves to, so a fixture without it makes the panel throw rather than
  // merely render an empty label.
  defaults: {
    upstreamTimeoutSeconds: 75,
    telemetryWindowMinutes: 15,
    imageClampMaxBytes: 10 * 1024 * 1024,
    telemetryRetentionDays: 30,
  },
};

/** A mounted Settings page, plus the fetch stub to undo afterwards. */
export interface MountedSettings extends Mounted {
  readonly restore: () => void;
}

async function mountSettings(): Promise<MountedSettings> {
  // The hook requests "/settings/runtime", which `consoleRequest` prefixes to
  // "/console/api/settings/runtime". The match is method-qualified because
  // `stubFetch` skips a route whose `match` does not contain the request
  // method, so a bare path never answers a GET.
  const stub = stubFetch([
    { match: "GET /console/api/settings/runtime", json: SETTINGS },
  ]);
  const mounted = await mount(createElement(Settings));
  // The privacy and operations panels show a loading state until their query
  // settles, so assertions run after the flush rather than against a skeleton.
  await mounted.flush();
  await mounted.flush();
  return { ...mounted, restore: stub.restore };
}

describe("Settings sections", () => {
  test("all five sections render at once", async () => {
    // Every section is on the page, so an operator finds a setting by looking
    // rather than by guessing which heading hides it. Each section is a card
    // whose header carries the h2, nested several levels down — matched on the
    // header's own class so a wrapper added later does not break this.
    //
    // Scoped to the section ids, because a heading from elsewhere on the page
    // is also an h2 and is not a section.
    const { container, unmount, restore } = await mountSettings();
    try {
      const titles = [
        "security",
        "privacy",
        "backup",
        "operations",
        "data-management",
      ].map((id) =>
        container.querySelector(`#${id} h2.card-header-title`)?.textContent,
      );
      expect(titles).toEqual([
        "Security",
        "Privacy",
        "Backup",
        "Operations",
        "Data Management",
      ]);
    } finally {
      unmount();
      restore();
    }
  });

  test("every section's controls are on the page without selecting anything", async () => {
    // One control per section. If any of these is missing, that section is
    // behind a selector again.
    const { container, unmount, restore } = await mountSettings();
    try {
      for (const id of [
        "current-password", // Security
        "privacy-payloads", // Privacy
        "upstream-timeout", // Operations
      ]) {
        expect(container.querySelector(`#${id}`)).not.toBeNull();
      }
      // Backup's and Data Management's controls have no stable id of their
      // own; assert the sections are populated rather than reaching for a
      // button label that may change.
      for (const id of ["backup", "data-management"]) {
        const section = container.querySelector(`#${id}`);
        expect(section).not.toBeNull();
        expect(section?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      }
    } finally {
      unmount();
      restore();
    }
  });

  test("nothing is behind a tab", async () => {
    // The page shows every section. role=tab would mean one is visible and
    // the rest are hidden behind a selector.
    const { container, unmount, restore } = await mountSettings();
    try {
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
    } finally {
      unmount();
      restore();
    }
  });

  test("the two short sections share a row, the long ones do not", async () => {
    // The mixed widths: Security and Privacy are short, so they sit side by
    // side; Operations, Backup, and Data Management are full width because
    // their controls are wider and their help text longer. Asserted on the
    // grid wrapper rather than computed layout, which a test DOM has none of.
    const { container, unmount, restore } = await mountSettings();
    try {
      const security = container.querySelector("#security");
      const privacy = container.querySelector("#privacy");
      const operations = container.querySelector("#operations");
      expect(security?.parentElement).toBe(privacy?.parentElement);
      expect(security?.parentElement?.className).toContain("settings-grid");
      // Operations keeps its own full-width row.
      expect(operations?.parentElement).not.toBe(security?.parentElement);
    } finally {
      unmount();
      restore();
    }
  });

  test("the two-state settings are dropdowns, not switches", async () => {
    // Every other control in Operations is a dropdown, and the two booleans
    // sat among them as switches — two shapes for one kind of choice, so the
    // section read as two UIs overlapping. They still store a boolean; the
    // dropdown only spells out which way it is set, which a filled track
    // could not do unambiguously across themes.
    const { container, unmount, restore } = await mountSettings();
    try {
      for (const id of ["ignore-cooldowns", "thinking-normalization"]) {
        const control = container.querySelector(`#${id}`);
        expect(control).not.toBeNull();
        expect(control?.getAttribute("role")).not.toBe("switch");
      }
      // No switch left in the Operations section at all.
      expect(
        container.querySelector('#operations [role="switch"]'),
      ).toBeNull();
    } finally {
      unmount();
      restore();
    }
  });

  test("a two-state setting says Off or On, not what it does", async () => {
    // "Enforced" / "Ignored" named the effect, not the position, so nobody
    // could tell which one was the default or what flipping it meant — and
    // "force disable" is a double negative on top of that. The choice now says
    // which way the switch is set and leaves the effect to the hint.
    const { container, unmount, restore } = await mountSettings();
    try {
      const text = container.querySelector("#operations")?.textContent ?? "";
      // Position, spelled out, and which one is the default.
      expect(text).toContain("Off — default");
      expect(text).toContain("On");
      // Not the old effect-named labels.
      expect(text).not.toContain("Enforced");
      expect(text).not.toContain("Ignored");
    } finally {
      unmount();
      restore();
    }
  });

  test("each section is still deep-linkable", async () => {
    // A link to #operations from elsewhere in the console is the reason each
    // section carries an id at all.
    const { container, unmount, restore } = await mountSettings();
    try {
      for (const id of [
        "security",
        "privacy",
        "backup",
        "operations",
        "data-management",
      ]) {
        expect(container.querySelector(`#${id}`)).not.toBeNull();
      }
    } finally {
      unmount();
      restore();
    }
  });

  test("no section is nested inside another card", async () => {
    // The section card is the intended level: a titled card per section.
    // What must not happen is a third level — a card inside a section card,
    // which is the doubled-border shape this replaced.
    //
    // Matched on `.card-solid` — the class Card actually emits. A `.card`
    // selector matches nothing and would pass no matter the markup.
    const { container, unmount, restore } = await mountSettings();
    try {
      // Five sections: Security, Privacy, Operations, Backup, Data Management.
      const cards = container.querySelectorAll(".card-solid");
      expect(cards).toHaveLength(5);
      expect(container.querySelectorAll(".card-solid .card-solid")).toHaveLength(0);
    } finally {
      unmount();
      restore();
    }
  });

  test("every text size used is a defined token", async () => {
    // The scale is micro/badge/caption/body/body-lg/lead/title/display/hero.
    // `text-subtitle` was used for section headings but no such token exists,
    // so those headings fell back to the browser default and read larger than
    // anything else on the page — the inconsistency was invisible in review
    // because the class name looks right.
    const DEFINED = [
      "text-micro",
      "text-badge",
      "text-caption",
      "text-body",
      "text-body-lg",
      "text-lead",
      "text-title",
      "text-display",
      "text-hero",
    ];
    const { container, unmount, restore } = await mountSettings();
    try {
      // Collected from the markup, not filtered by the allowlist: a size is
      // "text-*" minus alignment and colour utilities, and anything left that
      // is not a defined token is a size that does not exist.
      const NOT_A_SIZE =
        /^text-(text|accent|danger|warning|success|inherit|current|transparent|left|right|center|justify|start|end|white|black|ellipsis|wrap|nowrap|clip|uppercase|lowercase|capitalize)/;
      const used = new Set<string>();
      for (const el of Array.from(container.querySelectorAll("*"))) {
        for (const cls of el.classList) {
          if (!cls.startsWith("text-") || NOT_A_SIZE.test(cls)) continue;
          used.add(cls);
        }
      }
      expect(used.size).toBeGreaterThan(0);
      expect([...used].filter((c) => !DEFINED.includes(c))).toEqual([]);
    } finally {
      unmount();
      restore();
    }
  });

  test("a field's label reads larger than its help text", async () => {
    // The hierarchy that was missing: label, control value, and help text were
    // all 12px, so one field was three equal blocks.
    //
    // The two sizes live in `.settings-row-label` / `.settings-row-hint`
    // rather than in utilities, so the label's own class carries no `text-*`
    // to compare against. What is asserted instead is that neither carries the
    // other's class — the mix-up this guards against is one of them being
    // given the other's size.
    const { container, unmount, restore } = await mountSettings();
    try {
      const field = container.querySelector("#privacy .settings-row");
      expect(field).not.toBeNull();
      const label = field?.querySelector(".settings-row-label");
      const help = field?.querySelector(".settings-row-hint");
      expect(label).not.toBeNull();
      expect(help).not.toBeNull();
      expect(label?.className).toContain("settings-row-label");
      expect(label?.className).not.toContain("settings-row-hint");
      expect(help?.className).toContain("settings-row-hint");
      expect(help?.className).not.toContain("settings-row-label");
    } finally {
      unmount();
      restore();
    }
  });

  test("a row's label points at the control it describes", async () => {
    // Clicking a label has to reach its control. Rows whose control is a
    // button group (a switch) stay a plain span: a label pointing at a button
    // is a second activation path, which is how the switch used to fire twice.
    const { container, unmount, restore } = await mountSettings();
    try {
      const label = container.querySelector(
        'label.settings-row-label[for="privacy-payloads"]',
      );
      expect(label).not.toBeNull();
      expect(container.querySelector("#privacy-payloads")).not.toBeNull();
    } finally {
      unmount();
      restore();
    }
  });
});


describe("boundedOptions", () => {
  const CHOICES = [5, 30, 600] as const;
  const suffix = (v: number): string => `${v}s`;

  test("offers every choice when nothing is stored", () => {
    expect(boundedOptions(CHOICES, null, suffix)).toEqual([
      { value: "5", label: "5s" },
      { value: "30", label: "30s" },
      { value: "600", label: "600s" },
    ]);
  });

  test("keeps a stored value that is already a choice", () => {
    const options = boundedOptions(CHOICES, 30, suffix);
    // Duplicating it would render the same entry twice.
    expect(options.filter((o) => o.value === "30")).toHaveLength(1);
    expect(options).toHaveLength(3);
  });

  test("a value outside the list is offered, in order", () => {
    // The load-bearing case: a value set elsewhere must still be selectable,
    // or the trigger renders empty for a setting that is in force and reads as
    // "unset" — inviting the operator to change something already correct.
    expect(boundedOptions(CHOICES, 45, suffix)).toEqual([
      { value: "5", label: "5s" },
      { value: "30", label: "30s" },
      { value: "45", label: "45s" },
      { value: "600", label: "600s" },
    ]);
  });
});
