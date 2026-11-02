/**
 * Central client-version sources and resolvers for provider integrations.
 *
 * Every entry follows the same discovered → pinned fallback order.
 * Provider-specific header builders remain next to their integrations, while
 * the network source and resolver state live in this table.
 */
import {
  createClientVersionResolver,
  isSemverish,
  type ClientVersionResolver,
  type ClientVersionSnapshot,
} from "./client-version-resolver";
import {
  buildGrokAuthUserAgent as buildGrokAuthUserAgentString,
  buildGrokShellUserAgent,
} from "./cli-platform";

async function qoderVersion(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.json()) as { version?: unknown };
    return isSemverish(parsed.version) ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Newest Trae IDE version from the official changelog.
 *
 * Trae publishes no npm package and no release API, so the changelog is the
 * only machine-readable source of the current client version. It matters
 * upstream: intl `llm_raw_chat` answers `4015` unless the request carries the
 * *current* client version, so a stale pin is an outage, not a cosmetic drift.
 *
 * The page embeds its content as JSON, and its newest entry is the first dated
 * heading — not the highest semver, because this vendor's hotfix line numbers
 * past its feature line (3.5.104 shipped after 3.5.97). Taking `max(semver)`
 * would report an old build as current, so this walks the document in order and
 * returns the first version following a dated release heading.
 */
async function traeVersion(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    const heading =
      /"insert":"((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\s*\([^)]*\))\\n"/g;
    for (const match of text.matchAll(heading)) {
      const window = text.slice(match.index ?? 0, (match.index ?? 0) + 900);
      // A release line may name a *range* ("TRAE v3.6.1 ~ 3.6.4 are released"),
      // and the newest entry is the newest build in it. Taking the first number
      // reported 3.6.1 while 3.6.4 was already shipping — and on an entry whose
      // heading carried no version at all the old pattern matched nothing, so
      // discovery fell through to the next (older) entry and the pin drifted
      // backwards on every refresh.
      const range = window.match(/(\d+\.\d+\.\d+)\s*[~–-]\s*(\d+\.\d+\.\d+)/);
      if (range) {
        const high = range[2] ?? range[1];
        if (high && isSemverish(high)) return high.trim();
      }
      const found = window.match(/TraeCode\s+v?(\d+\.\d+\.\d+)|v?(\d+\.\d+\.\d+)\s+is\s+released/i);
      const version = found?.[1] ?? found?.[2];
      if (version && isSemverish(version)) return version.trim();
    }
    return null;
  } catch {
    return null;
  }
}

async function clineClientVersion(response: Response): Promise<string | null> {
  const data = (await response.json()) as { version?: unknown };
  return isSemverish(data.version) ? data.version.trim() : null;
}

/**
 * Newest Cursor build from the official download API, as the IDE's own header
 * spells it.
 *
 * Cursor's `x-cursor-client-version` is not the IDE semver on its own: the wire
 * value is `cli-<version>-<sha7>` (observed live as `cli-2026.10.19-6bbf2c4`).
 * The download API is the only source that returns both halves — `version` and
 * `commitSha` — so they are joined here rather than guessed. A semver alone
 * would be a different identity than the one the IDE sends.
 */
async function cursorVersion(response: Response): Promise<string | null> {
  try {
    const data = (await response.json()) as { version?: unknown; commitSha?: unknown };
    const version = data.version;
    if (!isSemverish(version)) return null;
    const sha = typeof data.commitSha === "string" ? data.commitSha.trim() : "";
    const short = sha.length >= 7 ? sha.slice(0, 7) : "";
    return short.length > 0 ? `cli-${version.trim()}-${short}` : version.trim();
  } catch {
    return null;
  }
}

async function clineSdkVersion(response: Response): Promise<string | null> {
  const data = (await response.json()) as {
    version?: unknown;
    "dist-tags"?: { latest?: unknown };
  };
  const candidate = data.version ?? data["dist-tags"]?.latest;
  return isSemverish(candidate) ? candidate.trim() : null;
}

async function kimiVersion(response: Response): Promise<string | null> {
  const data = (await response.json()) as { info?: { version?: unknown } };
  return isSemverish(data.info?.version) ? data.info.version.trim() : null;
}

async function workbuddyDesktopVersion(response: Response): Promise<string | null> {
  try {
    const data = (await response.json()) as { version?: unknown; productVersion?: unknown };
    const candidate = data.productVersion ?? data.version;
    return typeof candidate === "string" && /^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/.test(candidate.trim())
      ? candidate.trim()
      : null;
  } catch {
    return null;
  }
}

async function kiroCaskVersion(response: Response): Promise<string | null> {
  try {
    const data = (await response.json()) as { version?: unknown };
    return isSemverish(data.version) ? data.version.trim() : null;
  } catch {
    return null;
  }
}

async function codeBuddyCnVersion(response: Response): Promise<string | null> {
  try {
    const data = (await response.json()) as { version?: unknown };
    if (typeof data.version !== "string") return null;
    const match = /^\d+\.\d+\.\d+\.\d+/.exec(data.version.trim());
    return match?.[0] ?? null;
  } catch {
    return null;
  }
}

async function kiroVersion(response: Response): Promise<string | null> {
  const body = await response.text();
  const version =
    /currentVersion["\\]*\s*:\s*["\\]*([\d.]+)/.exec(body)?.[1] ??
    /\bIDE\s+([\d.]+)[^<]*Latest/.exec(body)?.[1];
  return isSemverish(version) ? version : null;
}

async function antigravityVersion(response: Response): Promise<string | null> {
  const body = await response.text();
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    return isSemverish(version) ? version : null;
  }
  return null;
}
/**
 * GitHub release tag (`v3.14.3` → `3.14.3`). Tags carry the leading `v`
 * by convention while the gateway stamps bare versions, so the prefix is
 * stripped rather than rejected by the semver check.
 */
async function githubReleaseVersion(response: Response): Promise<string | null> {
  try {
    const data = (await response.json()) as { tag_name?: unknown; name?: unknown };
    const raw = data.tag_name ?? data.name;
    const candidate = typeof raw === "string" && raw.startsWith("v") ? raw.slice(1) : raw;
    return isSemverish(candidate) ? (candidate as string).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Runtime SDK version stamped into the Kiro data-plane User-Agent.
 *
 * Pinned rather than discovered: the generation surface is served by the client
 * the IDE ships, not by a release we can track, so the shipped build is the
 * only source of truth. The agent compiles its generation client from
 * `@aws/codewhisperer-streaming-client`, and that package's own version is the
 * value the client stamps.
 *
 * How to rediscover it — take it from the shipped build, never from guesswork:
 *   1. The IDE installer is published on the vendor's download feed under a
 *      path that repeats the version:
 *      `https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/<v>/kiro-ide-<v>-stable-win32-x64.exe`
 *   2. Unpack it. The exe's payload is an LZMA stream behind a 4-byte tag:
 *      `7z x` the exe, drop the 4-byte tag from the extracted `[0]`, then
 *      `7z x` that as LZMA.
 *   3. In the unpacked payload, locate the agent bundle — the region defining
 *      `getCodeWhispererStreamingClient` — and read the aliased package
 *      metadata inside it: `"@aws/codewhisperer-streaming-client" … version:"x.y.z"`.
 *      Use that one. One installer also embeds other bundles carrying older
 *      copies of the same package, so a bare version match is not evidence.
 *
 * The discovery source below only supplies the *IDE* version that follows the
 * `KiroIDE` device marker.
 */
const KIRO_RUNTIME_SDK_VERSION = "1.0.44";

/**
 * AWS SSO OIDC SDK version stamped into login and token-refresh User-Agents.
 *
 * Distinct from the runtime SDK above because the upstream sees them as two
 * different AWS SDK clients: `oidc.{region}.amazonaws.com` is served by
 * `aws-sdk-js` sso-oidc, while the generation surface reports the
 * `codewhispererstreaming` client.
 */
const KIRO_SSO_SDK_VERSION = "3.980.0";

/**
 * Runtime segments the observed Kiro client reports.
 *
 * `win32#<build>` is the host Windows release, so it varies by machine and this
 * is the shape a Windows 11 client produces.
 *
 * The `md/nodejs#` segment is the runtime the client executes under, not the
 * host's Node: the IDE is an Electron app, so it is Electron's bundled Node.
 * Rediscover both from the same unpacked payload — the app's `package.json`
 * pins `"electron": "<version>"`, and that Electron release's metadata gives
 * the Node version to stamp here.
 */
const KIRO_SYSTEM_VERSION = "win32#10.0.22631";
/** Node version the observed Kiro client reports (Electron's bundled Node). */
const KIRO_NODE_VERSION = "24.18.0";

/** Ordered upstream sources and pinned fallbacks for every client version. */
export const VERSION_SOURCES = {
  antigravity: {
    key: "antigravity",
    fallback: "2.28.2",
    sources: [
      {
        url: "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml",
        extract: antigravityVersion,
      },
    ],
  },
  qoder: {
    key: "qoder",
    fallback: "1.1.81",
    sources: [
      {
        url: "https://registry.npmjs.org/@qoder-ai/qodercli/latest",
        extract: qoderVersion,
      },
    ],
  },
  opencode: {
    key: "opencode",
    // The v1 package (`opencode-ai`) stopped at 1.18. The v2 line publishes
    // under `@opencode/cli`, and this feed is what its own installer reads.
    // Fallback = the current latest release; raise it whenever the package
    // moves so a cold process does not present a stale client build.
    fallback: "2.2.5",
    minVersion: "2.0.0",
    sources: [{ url: "https://opencode.ai/update/api/latest/cli/npm" }],
  },
  commandcode: {
    key: "commandcode",
    // npm `command-code` latest as of 2026-10-30. The CLI sends this as
    // `x-command-code-version`, so a stale fallback presents a client build
    // the upstream no longer ships — raise it whenever the package moves.
    fallback: "1.88.2",
    sources: [{ url: "https://registry.npmjs.org/command-code/latest" }],
  },
  grok: {
    key: "grok",
    fallback: "1.0.70",
    sources: [
      { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable" },
      { url: "https://registry.npmjs.org/@xai-official/grok/latest" },
    ],
  },
  clineClient: {
    key: "cline-client",
    fallback: "4.1.26",
    minVersion: "4.1.23",
    sources: [
      {
        url: "https://raw.githubusercontent.com/cline/cline/main/apps/vscode/package.json",
        extract: clineClientVersion,
      },
    ],
  },
  clineSdk: {
    key: "cline-sdk",
    fallback: "0.2.0",
    sources: [{ url: "https://registry.npmjs.org/@cline/sdk/latest", extract: clineSdkVersion }],
  },
  clineCli: {
    key: "cline-cli",
    fallback: "3.0.74",
    sources: [{ url: "https://registry.npmjs.org/cline/latest", extract: clineSdkVersion }],
  },
  codex: {
    key: "codex",
    fallback: "0.166.0",
    sources: [{ url: "https://registry.npmjs.org/@openai/codex/latest" }],
  },
  workbuddyClient: {
    key: "workbuddy-client",
    fallback: "5.9.4.42593613",
    sources: [
      {
        url: "https://www.workbuddy.ai/v2/update?platform=workbuddy-win32-x64-user",
        extract: workbuddyDesktopVersion,
      },
      {
        url: "https://www.workbuddy.ai/v2/update?platform=workbuddy-darwin-arm64",
        extract: workbuddyDesktopVersion,
      },
    ],
  },
  workbuddyCnClient: {
    key: "workbuddy-cn-client",
    fallback: "5.9.3.42398134",
    sources: [
      {
        url: "https://www.workbuddy.cn/v2/update?platform=workbuddy-win32-x64-user",
        extract: workbuddyDesktopVersion,
      },
      {
        url: "https://www.workbuddy.cn/v2/update?platform=workbuddy-darwin-arm64",
        extract: workbuddyDesktopVersion,
      },
    ],
  },
  workbuddyCli: {
    key: "workbuddy",
    fallback: "2.178.1",
    sources: [
      { url: "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest" },
      { url: "https://registry.npmmirror.com/@tencent-ai/codebuddy-code/latest" },
    ],
  },
  kimiCli: {
    key: "kimi-cli",
    fallback: "1.52.0",
    sources: [{ url: "https://pypi.org/pypi/kimi-cli/json", extract: kimiVersion }],
  },
  kiro: {
    key: "kiro",
    fallback: "1.4.62",
    sources: [
      {
        // Kiro's downloads page exposes no stable version string. Homebrew
        // tracks the official installer URL and exposes its version as JSON;
        // keep the product page parser as a fallback.
        url: "https://formulae.brew.sh/api/cask/kiro.json",
        extract: kiroCaskVersion,
      },
      { url: "https://kiro.dev/downloads/", extract: kiroVersion },
    ],
  },
  codebuddy: {
    key: "codebuddy",
    fallback: "2.178.1",
    sources: [
      { url: "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest" },
      { url: "https://registry.npmmirror.com/@tencent-ai/codebuddy-code/latest" },
    ],
  },
  codebuddyCn: {
    key: "codebuddy-cn",
    fallback: "4.12.2.41207131",
    sources: [
      {
        // Official CN builds are listed by Homebrew's maintained cask feed;
        // its version points at the current Tencent CN desktop artifact.
        url: "https://formulae.brew.sh/api/cask/codebuddy-cn.json",
        extract: codeBuddyCnVersion,
      },
    ],
  },
  claudeCli: {
    key: "claude-cli",
    // Current `@anthropic-ai/claude-code` release, so the billing
    // `cc_version=` suffix and the `claude-cli/` User-Agent stay on what
    // upstream ships.
    fallback: "2.1.314",
    sources: [{ url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest" }],
  },
  claudeSdk: {
    key: "claude-sdk",
    // The `@anthropic-ai/sdk` version *bundled inside the Claude Code
    // release* — the value stamped into the OAuth refresh User-Agent template
    // (`anthropic-sdk-typescript/{claude_code_sdk_version} userOAuthProvider`).
    // npm's standalone SDK is a different release line and is deliberately not
    // discovered: it would advertise a version Claude Code never bundled. Bump
    // alongside the CLI. Read it from the shipped native binary, which defines
    // the version string the template interpolates — never from guesswork.
    fallback: "0.128.0",
    sources: [],
  },
  github: {
    key: "github-copilot-chat",
    fallback: "0.43.0",
    sources: [
      {
        url: "https://api.github.com/repos/microsoft/vscode-copilot-chat/releases/latest",
        extract: githubReleaseVersion,
      },
    ],
  },
  kilo: {
    key: "kilo-code",
    fallback: "7.8.25",
    sources: [{ url: "https://open-vsx.org/api/kilocode/kilo-code" }],
  },
  muse: {
    key: "muse-code",
    fallback: "1.4.14-R7309.1",
    sources: [{ url: "https://api.meta.ai/muse-code/channels/muse-stable" }],
  },
  trae: {
    key: "trae",
    // Fallback = the newest release the changelog names, which is the *high*
    // end of its newest line ("TRAE v3.6.1 ~ 3.6.4"). Discovery replaces it
    // within one monitor tick; it is only what a cold process sends before
    // the first successful fetch.
    fallback: "3.6.4",
    sources: [
      {
        url: "https://docs.trae.ai/ide/changelog?_lang=en",
        extract: traeVersion,
      },
    ],
  },
  cursor: {
    key: "cursor",
    // Fallback = the last observed wire version. Discovery replaces it within
    // one monitor tick; it is only what a cold process sends before the first
    // successful fetch.
    fallback: "cli-3.27.22-b1aa50c",
    sources: [
      {
        url: "https://cursor.com/api/download?platform=win32-x64-user&releaseTrack=stable",
        extract: cursorVersion,
      },
    ],
  },
  hermes: {
    key: "hermes",
    // Hermes DOES publish a semver: the GitHub release tag is `v0.22.2`. The
    // comment this replaced claimed no semver existed and pinned a date tag
    // (`v2026.9.24`) as the version — a tag, not a release, and not the
    // identity the client sends.
    fallback: "0.22.5",
    sources: [
      {
        url: "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest",
        extract: githubReleaseVersion,
      },
    ],
  },
  zcode: {
    key: "zcode",
    fallback: "3.14.3",
    sources: [
      {
        url: "https://api.github.com/repos/zai-org/ZCode/releases/latest",
        extract: githubReleaseVersion,
      },
    ],
  },
} as const;

const resolvers = {
  antigravity: createClientVersionResolver({ ...VERSION_SOURCES.antigravity, client: "antigravity" }),
  qoder: createClientVersionResolver({ ...VERSION_SOURCES.qoder, client: "qoder" }),
  hermes: createClientVersionResolver({ ...VERSION_SOURCES.hermes, client: "hermes" }),
  trae: createClientVersionResolver({ ...VERSION_SOURCES.trae, client: "trae" }),
  cursor: createClientVersionResolver({ ...VERSION_SOURCES.cursor, client: "cursor" }),
  opencode: createClientVersionResolver({ ...VERSION_SOURCES.opencode, client: "opencode" }),
  commandcode: createClientVersionResolver({ ...VERSION_SOURCES.commandcode, client: "command-code" }),
  grok: createClientVersionResolver({ ...VERSION_SOURCES.grok, client: "grok" }),
  clineClient: createClientVersionResolver({ ...VERSION_SOURCES.clineClient, client: "cline" }),
  clineSdk: createClientVersionResolver({ ...VERSION_SOURCES.clineSdk, client: "cline-sdk" }),
  clineCli: createClientVersionResolver({ ...VERSION_SOURCES.clineCli, client: "cline-cli" }),
  codex: createClientVersionResolver({ ...VERSION_SOURCES.codex, client: "codex" }),
  workbuddyClient: createClientVersionResolver({ ...VERSION_SOURCES.workbuddyClient, client: "workbuddy" }),
  workbuddyCnClient: createClientVersionResolver({ ...VERSION_SOURCES.workbuddyCnClient, client: "workbuddy-cn" }),
  workbuddyCli: createClientVersionResolver({ ...VERSION_SOURCES.workbuddyCli, client: "codebuddy" }),
  kimiCli: createClientVersionResolver({ ...VERSION_SOURCES.kimiCli, client: "kimi" }),
  codebuddy: createClientVersionResolver({ ...VERSION_SOURCES.codebuddy, client: "codebuddy" }),
  codebuddyCn: createClientVersionResolver({ ...VERSION_SOURCES.codebuddyCn, client: "codebuddy" }),
  claudeCli: createClientVersionResolver({ ...VERSION_SOURCES.claudeCli, client: "claude" }),
  claudeSdk: createClientVersionResolver({ ...VERSION_SOURCES.claudeSdk, client: "claude-sdk" }),
  kiro: createClientVersionResolver({ ...VERSION_SOURCES.kiro, client: "kiro" }),
  github: createClientVersionResolver({ ...VERSION_SOURCES.github, client: "github-copilot" }),
  kilo: createClientVersionResolver({ ...VERSION_SOURCES.kilo, client: "kilo" }),
  muse: createClientVersionResolver({ ...VERSION_SOURCES.muse, client: "muse" }),
  zcode: createClientVersionResolver({ ...VERSION_SOURCES.zcode, client: "zcode" }),
} satisfies Record<keyof typeof VERSION_SOURCES, ClientVersionResolver>;
const PROVIDER_VERSION_RESOLVERS: Readonly<Record<string, ClientVersionResolver>> = {
  antigravity: resolvers.antigravity,
  grok: resolvers.grok,
  xai: resolvers.grok,
  opencode: resolvers.opencode,
  "opencode-zen": resolvers.opencode,
  "opencode-go": resolvers.opencode,
  // The identity this provider is dispatched under is the CLI's, so the route
  // identity reports the CLI version, not the VS Code extension manifest
  // (`clineClient`).
  cline: resolvers.clineCli,
  codex: resolvers.codex,
  qoder: resolvers.qoder,
  hermes: resolvers.hermes,
  trae: resolvers.trae,
  traecn: resolvers.trae,
  cursor: resolvers.cursor,
  commandcode: resolvers.commandcode,
  workbuddy: resolvers.workbuddyClient,
  workbuddycn: resolvers.workbuddyCnClient,
  cb: resolvers.codebuddy,
  cbcn: resolvers.codebuddyCn,
  kimi: resolvers.kimiCli,
  kiro: resolvers.kiro,
  anthropic: resolvers.claudeCli,
  claude: resolvers.claudeCli,
  github: resolvers.github,
  kilo: resolvers.kilo,
  muse: resolvers.muse,
  zcode: resolvers.zcode,
};

/** Returns the current client version without performing network I/O. */
export function getProviderClientVersion(providerId: string): ClientVersionSnapshot | undefined {
  return PROVIDER_VERSION_RESOLVERS[providerId.trim().toLowerCase()]?.snapshot();
}

/** Live Codex and Claude CLI versions for route-identity choices. */
export function getRouteIdentityVersions(): {
  readonly codex: string;
  readonly claude: string;
} {
  return { codex: getCodexVersion(), claude: getClaudeCliVersion() };
}

/** Refreshes every provider version resolver in parallel; failures keep fallbacks. */
export async function refreshProviderClientVersions(): Promise<void> {
  const resolversToRefresh = [...new Set(Object.values(PROVIDER_VERSION_RESOLVERS))];
  await Promise.allSettled(resolversToRefresh.map((resolver) => resolver.ensure()));
}

/** One client identity still running on its pinned fallback. */
export interface PinnedClientVersion {
  readonly client: string;
  /** The fallback in force, which is what every request is currently sending. */
  readonly version: string;
  /** The lowest version the upstream accepted when it last answered. */
  readonly minVersion?: string;
}

/**
 * Client identities whose version discovery has not succeeded.
 *
 * Every header this module builds is version-aware, and a provider that starts
 * gating on it refuses with wording indistinguishable from a dead credential —
 * Cline's is "please make sure you're using the latest version and
 * re-authenticate". That makes a stuck fallback an operational fact an operator
 * needs *before* it presents as an auth failure, and until now nothing could
 * tell a pinned fallback from a discovered version: only the synchronous getter
 * was exported, so the `source` the resolver already tracked was unreadable
 * outside this module.
 *
 * Read-only and never fetched: this reports what is in force right now, for the
 * same reason the getters never fetch. An empty list is the healthy answer.
 */
export function pinnedClientVersions(): readonly PinnedClientVersion[] {
  const pinned: PinnedClientVersion[] = [];
  for (const resolver of new Set(Object.values(PROVIDER_VERSION_RESOLVERS))) {
    const snapshot = resolver.snapshot();
    if (snapshot.source !== "fallback") continue;
    pinned.push({
      client: snapshot.client,
      version: snapshot.version,
      ...(resolver.minVersion === undefined ? {} : { minVersion: resolver.minVersion }),
    });
  }
  return pinned;
}

/**
 * The accessors every table entry needs, generated from its resolver.
 *
 * Request paths only use the synchronous getter. Network discovery belongs to
 * `refreshProviderClientVersions`, so dispatch and OAuth flows never wait on a
 * version endpoint.
 */
function accessor<K extends keyof typeof resolvers>(name: K): {
  readonly get: () => string;
  readonly adopt: (version: string) => void;
  readonly reset: (version?: string | null) => void;
} {
  const resolver = resolvers[name];
  return {
    get: () => resolver.get(),
    adopt: (version: string) => {
      resolver.adopt(version);
    },
    reset: (version?: string | null) => {
      resolver.reset(version);
    },
  };
}

export const getQoderVersion = accessor("qoder").get;
export const getHermesVersion = accessor("hermes").get;
export const getTraeVersion = accessor("trae").get;
export const getAntigravityVersion = accessor("antigravity").get;

export const getOpenCodeVersion = accessor("opencode").get;

export const getCommandCodeVersion = accessor("commandcode").get;

export const getGrokVersion = accessor("grok").get;

export function buildGrokUserAgent(version = getGrokVersion()): string {
  return buildGrokShellUserAgent(version);
}

export function buildGrokAuthUserAgent(version = getGrokVersion()): string {
  return buildGrokAuthUserAgentString(version);
}


export const getClineClientVersion = accessor("clineClient").get;
export const getClineSdkVersion = accessor("clineSdk").get;
export const getClineCliVersion = accessor("clineCli").get;
export const _resetClineClientVersionCache = accessor("clineClient").reset;
export const _resetClineSdkVersionCache = accessor("clineSdk").reset;
export const _resetClineCliVersionCache = accessor("clineCli").reset;

export const getCodexVersion = accessor("codex").get;

export const getWorkBuddyClientVersion = accessor("workbuddyClient").get;
export const getWorkBuddyCnClientVersion = accessor("workbuddyCnClient").get;
export const getWorkBuddyCliVersion = accessor("workbuddyCli").get;

export function buildWorkBuddyUserAgent(
  identity = "WB",
  clientVersion = getWorkBuddyClientVersion(),
  cliVersion = getWorkBuddyCliVersion(),
): string {
  // 1:1 with codebuddy2api. The CLI profile is `CLI/<v> CodeBuddy/<v>` and the
  // WorkBuddy profile is `WorkBuddy/<wb> workbuddy-ai/<wb> CLI/<cli>`, which
  // sends NO SDK headers — two separate profiles, not one string with a switch.
  // Whether SDK headers ride along is decided by `workbuddyHeaders`, not here, so
  // this builder only decides the UA text.
  //
  // The second token is the wire spelling `workbuddy-ai`, NOT the display
  // brand `WorkBuddy AI`. This is what an official client actually sends; the
  // product is branded with a space in the UI and in docs, and copying that
  // branding into the header produced a UA no real client emits — which the
  // intl gateway answers with 403 `11140`, the same refusal it gives a
  // wrong-brand header. Product name ≠ wire token.
  if (identity === "CLI") return `CLI/${cliVersion} CodeBuddy/${cliVersion}`;
  return `WorkBuddy/${clientVersion} workbuddy-ai/${clientVersion} CLI/${cliVersion}`;
}

export const _resetWorkBuddyCnClientVersionCache = accessor("workbuddyCnClient").reset;

export const getKimiCliVersion = accessor("kimiCli").get;

export const getCodeBuddyVersion = accessor("codebuddy").get;
export const getCodeBuddyCnVersion = accessor("codebuddyCn").get;
/**
 * The CodeBuddy User-Agent.
 *
 * Both identities share the CLI *package* version, which is why `codebuddy`
 * (the npm `@tencent-ai/codebuddy-code` pin, `2.169.0` — the value both
 * references use for CLI) is the version for each. `codebuddyCn` is the CN
 * *desktop* build (`4.12.2.…`), and using it here produced
 * `CLI/4.12.2.41207131 CodeBuddy/4.12.2.41207131` — a CLI claiming a desktop
 * version, which no official client emits.
 */
export function buildCodeBuddyUserAgent(
  identity: "IDE" | "CLI",
  version = getCodeBuddyVersion(),
  cnVersion = getCodeBuddyCnVersion(),
): string {
  // 1:1 with codebuddy2api's identity_headers(): the CLI profile uses ONE version
  // (the npm CLI package pin) for both halves, and the IDE profile uses the other
  // product's version. Using `version` for both would make "CLI" produce
  // `CLI/<ide> CodeBuddy/<ide>` — a CLI claiming the desktop build.
  const resolved = identity === "CLI" ? cnVersion : version;
  return `${identity}/${resolved} CodeBuddy/${resolved}`;
}

export const _resetCodeBuddyVersionCache = accessor("codebuddy").reset;
export const _resetCodeBuddyCnVersionCache = accessor("codebuddyCn").reset;

export const getClaudeCliVersion = accessor("claudeCli").get;
export const adoptClaudeCliVersion = accessor("claudeCli").adopt;
export const _resetClaudeCliVersionCache = accessor("claudeCli").reset;
export const getClaudeSdkVersion = accessor("claudeSdk").get;

export const getKiroVersion = accessor("kiro").get;

/**
 * Builds the `x-amz-user-agent` companion header for the generation surface.
 *
 * The upstream pairs this with `user-agent` on every generation request; the
 * short form carries the SDK identity and the `KiroIDE-{version}-{machineId}`
 * device marker and nothing else.
 */
export function buildKiroAmzUserAgent(version = getKiroVersion(), machineId = ""): string {
  return `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} KiroIDE-${version}-${machineId}`;
}

/**
 * Builds the full data-plane `user-agent`.
 *
 * Shape: SDK version, `ua/2.1`, the OS and node segments, the API and module
 * markers, and the `KiroIDE-{version}-{machineId}` device marker. The device
 * marker is the part the upstream correlates on, so it is never omitted — a
 * blank machine id advertises the account as a device with no identity, which
 * is a shape no real client produces.
 */
export function buildKiroUserAgent(version = getKiroVersion(), machineId = ""): string {
  return (
    `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} ua/2.1 ` +
    `os/${KIRO_SYSTEM_VERSION} lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/codewhispererstreaming#${KIRO_RUNTIME_SDK_VERSION} m/E ` +
    `KiroIDE-${version}-${machineId}`
  );
}

/**
 * Builds the `x-amz-user-agent` companion for an AWS SSO OIDC request.
 *
 * The login and token-refresh surfaces are served by a different AWS SDK
 * client, so they carry that client's version and no device marker — the
 * observed client does not send one there.
 */
export function buildKiroSsoAmzUserAgent(): string {
  return `aws-sdk-js/${KIRO_SSO_SDK_VERSION} KiroIDE`;
}

/** Builds the full `user-agent` for an AWS SSO OIDC request. */
export function buildKiroSsoUserAgent(): string {
  return (
    `aws-sdk-js/${KIRO_SSO_SDK_VERSION} ua/2.1 ` +
    `os/${KIRO_SYSTEM_VERSION} lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/sso-oidc#${KIRO_SSO_SDK_VERSION} m/E KiroIDE`
  );
}

/**
 * Builds the `user-agent` the model-catalog and usage surfaces expect.
 *
 * Their observed client identifies as `codewhispererruntime` rather than
 * `codewhispererstreaming`, and carries the `m/N,E` module marker.
 */
export function buildKiroRuntimeUserAgent(version = getKiroVersion(), machineId = ""): string {
  return (
    `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} ua/2.1 ` +
    `os/${KIRO_SYSTEM_VERSION} lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/codewhispererruntime#${KIRO_RUNTIME_SDK_VERSION} m/N,E ` +
    `KiroIDE-${version}-${machineId}`
  );
}
