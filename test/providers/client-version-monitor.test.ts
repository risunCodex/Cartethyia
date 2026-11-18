import { describe, expect, test } from "bun:test";
import { createClientVersionResolver } from "../../src/providers/operations/client-version-resolver";
import {
  _resetCodeBuddyCnVersionCache,
  _resetCodeBuddyVersionCache,
  _resetClineCliVersionCache,
  buildCodeBuddyUserAgent,
  buildKiroAmzUserAgent,
  buildKiroSsoAmzUserAgent,
  buildKiroSsoUserAgent,
  buildKiroUserAgent,
  getCodeBuddyCnVersion,
  getCodeBuddyVersion,
  getDeepAIVersion,
  getProviderClientVersion,
  pinnedClientVersions,
  VERSION_SOURCES,
} from "../../src/providers/operations/client-versions";

describe("trae client version stays pinned", () => {
  // Trae publishes no npm package and no release API, and the docs changelog is
  // an SPA that no longer embeds release data — the parser that once read it
  // returned null against every live page and was removed. intl `llm_raw_chat`
  // answers `4015` unless the request carries the current version, so the pin
  // is a live dependency, not cosmetic metadata: raise it when the desktop
  // build moves.
  test("no discovery source exists, and the fallback is the current desktop release", () => {
    expect(VERSION_SOURCES.trae.sources).toEqual([]);
    expect(VERSION_SOURCES.trae.fallback).toMatch(/^\d+\.\d+\.\d+$/);
    expect(getProviderClientVersion("trae")?.version).toBe(VERSION_SOURCES.trae.fallback);
    expect(getProviderClientVersion("trae")?.source).toBe("fallback");
  });

  test("trae and traecn share one resolver", () => {
    // One upstream client version, two deployments: CN and intl ship the same
    // build line, so they must not drift onto different pins.
    expect(VERSION_SOURCES.trae.fallback).toMatch(/^\d+\.\d+\.\d+$/);
    expect(getProviderClientVersion("traecn")?.version).toBe(VERSION_SOURCES.trae.fallback);
  });
});

describe("factory droid client version discovery", () => {
  // The official CLI publishes to npm as `droid` (repo Factory-AI/factory);
  // the discovery source follows that feed and the provider id `factory`
  // resolves to it.
  test("npm `droid` is the discovery source, with a semver fallback", () => {
    expect(VERSION_SOURCES.factoryDroid.sources).toEqual([
      { url: "https://registry.npmjs.org/droid/latest" },
    ]);
    expect(VERSION_SOURCES.factoryDroid.fallback).toMatch(/^\d+\.\d+\.\d+$/);
    expect(getProviderClientVersion("factory")?.client).toBe("factory-droid");
    expect(getProviderClientVersion("factory")?.version).toBe(VERSION_SOURCES.factoryDroid.fallback);
  });
});

describe("clixad client version discovery", () => {
  // The gateway publishes its paired CLI build as `cli_latest` on the
  // unauthenticated `/v1/models` listing.
  const source = VERSION_SOURCES.clixad.sources[0];
  const extract = source?.extract;

  test("the source is the gateway's model listing", () => {
    expect(source?.url).toContain("clixad.onrender.com/v1/models");
  });

  test("reads cli_latest from the listing", async () => {
    const page = new Response(JSON.stringify({ cli_latest: "0.0.1-beta.50", data: [] }), {
      headers: { "content-type": "application/json" },
    });
    expect(await extract?.(page)).toBe("0.0.1-beta.50");
  });

  test("missing cli_latest means no answer", async () => {
    const page = new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json" },
    });
    expect(await extract?.(page)).toBeNull();
  });

  test("a non-semver cli_latest is rejected", async () => {
    const page = new Response(JSON.stringify({ cli_latest: "latest" }), {
      headers: { "content-type": "application/json" },
    });
    expect(await extract?.(page)).toBeNull();
  });

  test("fallback pins the shipped bundle version", () => {
    expect(VERSION_SOURCES.clixad.fallback).toBe("0.0.1-beta.50");
  });

  test("the resolver is wired into getProviderClientVersion", () => {
    expect(getProviderClientVersion("clixad")?.client).toBe("clixad");
  });
});

describe("opencode client version fallback", () => {
  test("the source is the CLI's own npm feed", () => {
    expect(VERSION_SOURCES.opencode.sources[0]?.url).toContain(
      "opencode.ai/update/api/latest/cli/npm",
    );
  });

  test("the fallback is the current latest release", () => {
    // A cold process sends this before discovery resolves; if it lags the
    // upstream release the UA advertises a client build that no longer ships.
    expect(VERSION_SOURCES.opencode.fallback).toBe("2.3.0");
  });
});

describe("client version monitor snapshot", () => {
  test("starts on fallback and reports latest after background refresh", async () => {
    const resolver = createClientVersionResolver({
      key: `test-version-${crypto.randomUUID()}`,
      client: "test-client",
      fallback: "1.0.0",
      sources: [{ url: "https://version.test/latest", extract: async () => "1.2.3" }],
      ttlMs: 1,
    });

    expect(resolver.snapshot()).toEqual({ client: "test-client", version: "1.0.0", source: "fallback" });
    await resolver.ensure(async () => new Response("{}"));
    expect(resolver.snapshot()).toEqual({ client: "test-client", version: "1.2.3", source: "latest" });
  });

  test("keeps CodeBuddy International and CN client identities separate", () => {
    // Read the pins from the resolver's own declaration rather than restating
    // them: the assertion this test earns is that the two identities stay
    // distinct and independent, and a restated version number rots the moment
    // the pin is bumped without saying anything about the seam it guards.
    const international = VERSION_SOURCES.codebuddy.fallback;
    const cn = VERSION_SOURCES.codebuddyCn.fallback;
    expect(VERSION_SOURCES.codebuddy.sources[0]?.url).toContain("registry.npmjs.org");
    expect(VERSION_SOURCES.codebuddyCn.sources[0]?.url).toContain("codebuddy-cn.json");

    _resetCodeBuddyVersionCache(international);
    _resetCodeBuddyCnVersionCache(cn);
    try {
      expect(getCodeBuddyVersion()).toBe(international);
      expect(getCodeBuddyCnVersion()).toBe(cn);
      expect(buildCodeBuddyUserAgent("IDE")).toBe(`IDE/${international} CodeBuddy/${international}`);
      // Each identity carries its own version: IDE the international pin, CLI the
      // CN pin. The reference issues the CLI from the CN package, so a CLI
      // claiming the international desktop build is a client no reference emits.
      expect(buildCodeBuddyUserAgent("CLI")).toBe(`CLI/${cn} CodeBuddy/${cn}`);
    } finally {
      _resetCodeBuddyVersionCache();
      _resetCodeBuddyCnVersionCache();
    }
  });

  test("uses current client feeds for Claude Code and Kiro", async () => {
    expect(VERSION_SOURCES.claudeCli.fallback).toBe("2.1.325");
    expect(VERSION_SOURCES.claudeCli.sources[0]?.url).toBe(
      "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
    );
    expect(VERSION_SOURCES.claudeSdk.fallback).toBe("0.128.0");
    expect(VERSION_SOURCES.claudeSdk.sources).toEqual([]);
    expect(VERSION_SOURCES.kiro.fallback).toBe("1.4.178");
    expect(VERSION_SOURCES.kiro.sources[0]?.url).toBe(
      "https://formulae.brew.sh/api/cask/kiro.json",
    );
    // The cask source uses the default extractor (no bespoke `extract`), which
    // reads the JSON `version` field — prove the effective path resolves it.
    const resolver = createClientVersionResolver({
      key: `test-kiro-cask-${crypto.randomUUID()}`,
      client: "kiro",
      fallback: "1.4.178",
      sources: [VERSION_SOURCES.kiro.sources[0]!],
    });
    await resolver.ensure(
      async () =>
        new Response(JSON.stringify({ version: "1.2.56" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(resolver.snapshot().version).toBe("1.2.56");
  });

  test("matches Claude and Kiro SDK fingerprints embedded in their current clients", () => {
    expect(VERSION_SOURCES.claudeSdk.fallback).toBe("0.128.0");
    expect(buildKiroUserAgent("1.2.56", "device")).toContain("aws-sdk-js/1.0.44");
    expect(buildKiroAmzUserAgent("1.2.56", "device")).toBe(
      "aws-sdk-js/1.0.44 KiroIDE-1.2.56-device",
    );
    expect(buildKiroSsoUserAgent()).toContain("aws-sdk-js/3.980.0");
    expect(buildKiroSsoAmzUserAgent()).toBe("aws-sdk-js/3.980.0 KiroIDE");
  });
});

describe("default extractor covers the consolidated sources", () => {
  // M-27: cline client, cline sdk, kiro cask, and kimi used to carry
  // bespoke extractors that were exact subsets of the resolver's default; they
  // now rely on it. Each must still resolve its source's newer version through
  // `ensure()` — the same pin the old extractor produced.
  const cases: readonly {
    readonly name: string;
    readonly key: string;
    readonly source: { url: string };
    readonly body: unknown;
    readonly expected: string;
  }[] = [
    {
      name: "cline vscode extension",
      key: "test-cline-client",
      source: { url: "https://raw.githubusercontent.com/cline/cline/main/apps/vscode/package.json" },
      body: { name: "cline", version: "4.1.27" },
      expected: "4.1.27",
    },
    {
      name: "cline sdk npm",
      key: "test-cline-sdk",
      source: VERSION_SOURCES.clineSdk.sources[0]!,
      body: { version: "0.2.1", "dist-tags": { latest: "0.2.1" } },
      expected: "0.2.1",
    },
    {
      name: "kiro cask",
      key: "test-kiro-cask",
      source: VERSION_SOURCES.kiro.sources[0]!,
      body: { version: "1.4.122" },
      expected: "1.4.122",
    },
    {
      name: "kimi pypi",
      key: "test-kimi",
      source: VERSION_SOURCES.kimiCli.sources[0]!,
      body: { info: { version: "1.52.1" } },
      expected: "1.52.1",
    },
    {
      name: "freepi npm",
      key: "test-freepi",
      source: VERSION_SOURCES.freepi.sources[0]!,
      body: { version: "0.6.19", "dist-tags": { latest: "0.6.19" } },
      expected: "0.6.19",
    },
  ];

  for (const { name, key, source, body, expected } of cases) {
    test(`${name} resolves through the default extractor`, async () => {
      const resolver = createClientVersionResolver({
        key: `${key}-${crypto.randomUUID()}`,
        client: key,
        fallback: "0.0.0",
        sources: [source],
      });
      await resolver.ensure(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      expect(resolver.snapshot().version).toBe(expected);
    });
  }
});

describe("pinnedClientVersions", () => {
  // The report exists so an operator can see a stuck fallback *before* it
  // presents as an auth failure: Cline's refusal for an implausible client
  // identity is worded exactly like a dead credential. Two properties matter,
  // and a report that omits either is the false assurance the resolver's
  // `source` was written to prevent.
  test("a seeded version reads as latest and leaves the report", () => {
    // Discovery succeeded: nothing to warn about. This is the healthy answer,
    // and it is what stops the report from crying wolf on every client.
    _resetClineCliVersionCache("3.0.73");
    try {
      expect(pinnedClientVersions().some((p) => p.client === "cline-cli")).toBe(false);
    } finally {
      _resetClineCliVersionCache();
    }
  });

  test("a fallback in force is reported with the version actually being sent", () => {
    // Resetting to null restores discovery behaviour, so the resolver is on its
    // fallback until the next background refresh — exactly the state an
    // operator must be able to see, with the number requests are carrying.
    _resetClineCliVersionCache(null);
    const entry = pinnedClientVersions().find((p) => p.client === "cline-cli");
    expect(entry?.version).toBe(VERSION_SOURCES.clineCli.fallback);
  });

  test("the floor travels with a pinned fallback, because it explains which of two things happened", () => {
    // A pinned version means either discovery never answered, or it answered
    // with something below `minVersion` and was discarded. The second is the
    // interesting one — an artifact the provider does not gate on — and it is
    // indistinguishable from the first unless the floor is reported with it.
    // The CLI identity carries no floor: the upstream accepted an arbitrary
    // version when probed, so there is no minimum to report.
    _resetClineCliVersionCache(null);
    const entry = pinnedClientVersions().find((p) => p.client === "cline-cli");
    expect(entry?.version).toBe(VERSION_SOURCES.clineCli.fallback);
    expect(entry?.minVersion).toBeUndefined();
  });
});

describe("freepi rides the client-version refresh cycle", () => {
  test("freepi is wired into PROVIDER_VERSION_RESOLVERS", () => {
    // `refreshProviderClientVersions()` only refreshes resolvers reachable from
    // `PROVIDER_VERSION_RESOLVERS`; a provider missing from that map silently
    // keeps its pin forever. Freepi publishes its CLI on npm, so it must be
    // wired.
    expect(getProviderClientVersion("freepi")?.client).toBe("freepi");
  });

  test("the feed is the official npm package", () => {
    expect(VERSION_SOURCES.freepi.sources[0]?.url).toBe(
      "https://registry.npmjs.org/free-pi-cli/latest",
    );
    expect(VERSION_SOURCES.freepi.fallback).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("deepai client version tracks the auto-updater feed", () => {
  test("the Electron-updater generic feed is the discovery source", () => {
    // The DeepAI Code desktop app polls its own updater feed
    // (`downloads.deepai.org/deepai-code/releases/latest.yml`) — the same
    // feed this resolver reads, so discovery cannot go stale while the
    // vendor ships. The fallback is the version verified live on 2026-11-14.
    expect(VERSION_SOURCES.deepai.fallback).toBe("0.3.37");
    expect(VERSION_SOURCES.deepai.sources).toHaveLength(1);
    expect(VERSION_SOURCES.deepai.sources[0]?.url).toBe(
      "https://downloads.deepai.org/deepai-code/releases/latest.yml",
    );
  });

  test("the identity is wired into the refresh cycle on the new fallback", () => {
    expect(getProviderClientVersion("deepai")?.client).toBe("deepai");
    expect(getProviderClientVersion("deepai")?.version).toBe("0.3.37");
    expect(getDeepAIVersion()).toBe("0.3.37");
  });
});
