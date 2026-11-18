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

/** Clixad gateway's own CLI version: `cli_latest` on `/v1/models`. */
async function clixadVersion(response: Response): Promise<string | null> {
  const body = await response.text().catch(() => "");
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body) as { cli_latest?: unknown };
    const candidate = parsed.cli_latest;
    return typeof candidate === "string" && isSemverish(candidate) ? candidate.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Electron-updater generic feed: `latest.yml` / `latest-mac.yml` carry a
 * `version:` key with the current desktop release. This is the same feed the
 * app's own auto-updater polls, so it cannot go stale while the vendor ships.
 */
async function electronUpdaterVersion(response: Response): Promise<string | null> {
  const body = await response.text();
  const match = /^version:\s*["']?([A-Za-z0-9][A-Za-z0-9.\-]*)/m.exec(body);
  return match && isSemverish(match[1]) ? match[1] : null;
}

/**
 * Newest Cursor build from the official download API, as the CLI's own header
 * spells it.
 *
 * Cursor's `x-cursor-client-version` is not the IDE semver on its own: the wire
 * value is `cli-<date>-<sha7>` (observed live as `cli-2026.11.05-86047df`).
 * The download API is the only source that returns both halves — `version` and
 * `commitSha` — so they are joined here rather than guessed. A semver alone
 * would be a different identity than the one the CLI sends.
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

/** Ordered upstream sources and pinned fallbacks for every client version. */
export const VERSION_SOURCES = {
  antigravity: {
    key: "antigravity",
    fallback: "2.32.1",
    sources: [
      {
        url: "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml",
        extract: antigravityVersion,
      },
    ],
  },
  qoder: {
    key: "qoder",
    // The chat surface identity is the worker-core build line: the desktop
    // 0.5.12 core sends `cosy-version: 1.1.86-hotfix.5` (capture 2026-11-17)
    // and its runtime-info names the product `qodercli` — the npm
    // `@qoder-ai/qodercli` package ships that same runtime, so its latest tag
    // is the freshest build of the family. The fallback is the version the
    // real desktop core sends today; the resolver only ever adopts a
    // *newer* discovered value, so discovery lifts the pin without ever
    // presenting a build older than the captured core.
    fallback: "1.1.86-hotfix.5",
    sources: [{ url: "https://registry.npmjs.org/@qoder-ai/qodercli/latest" }],
  },
  opencode: {
    key: "opencode",
    // The v1 package (`opencode-ai`) stopped at 1.18. The v2 line publishes
    // under `@opencode/cli`, and this feed is what its own installer reads.
    // Fallback = the current latest release; raise it whenever the package
    // moves so a cold process does not present a stale client build.
    fallback: "2.3.0",
    minVersion: "2.0.0",
    sources: [{ url: "https://opencode.ai/update/api/latest/cli/npm" }],
  },
  commandcode: {
    key: "commandcode",
    // npm `command-code` latest as of 2026-11-14. The CLI sends this as
    // `x-command-code-version`, so a stale fallback presents a client build
    // the upstream no longer ships — raise it whenever the package moves.
    fallback: "1.89.1",
    sources: [{ url: "https://registry.npmjs.org/command-code/latest" }],
  },
  grok: {
    key: "grok",
    fallback: "1.0.77",
    sources: [
      { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable" },
      { url: "https://registry.npmjs.org/@xai-official/grok/latest" },
    ],
  },
  clineSdk: {
    key: "cline-sdk",
    fallback: "0.2.0",
    sources: [{ url: "https://registry.npmjs.org/@cline/sdk/latest" }],
  },
  clineCli: {
    key: "cline-cli",
    fallback: "3.0.74",
    sources: [{ url: "https://registry.npmjs.org/cline/latest" }],
  },
  codex: {
    key: "codex",
    fallback: "0.169.0",
    sources: [{ url: "https://registry.npmjs.org/@openai/codex/latest" }],
  },
  kimiCli: {
    key: "kimi-cli",
    fallback: "1.52.0",
    sources: [{ url: "https://pypi.org/pypi/kimi-cli/json" }],
  },
  kiro: {
    key: "kiro",
    fallback: "1.4.178",
    sources: [
      {
        // Kiro's downloads page exposes no stable version string. Homebrew
        // tracks the official installer URL and exposes its version as JSON;
        // keep the product page parser as a fallback.
        url: "https://formulae.brew.sh/api/cask/kiro.json",
      },
      { url: "https://kiro.dev/downloads/", extract: kiroVersion },
    ],
  },
  codebuddy: {
    key: "codebuddy",
    fallback: "2.184.0",
    sources: [
      { url: "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest" },
      { url: "https://registry.npmmirror.com/@tencent-ai/codebuddy-code/latest" },
    ],
  },
  codebuddyCn: {
    key: "codebuddy-cn",
    fallback: "4.12.4.43368774",
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
    fallback: "2.1.325",
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
    fallback: "0.43.2026040705",
    sources: [
      {
        url: "https://api.github.com/repos/microsoft/vscode-copilot-chat/releases/latest",
        extract: githubReleaseVersion,
      },
    ],
  },
  kilo: {
    key: "kilo-code",
    fallback: "7.8.28",
    sources: [{ url: "https://open-vsx.org/api/kilocode/kilo-code" }],
  },
  muse: {
    key: "muse-code",
    fallback: "1.4.20-R8619.1",
    sources: [{ url: "https://api.meta.ai/muse-code/channels/muse-stable" }],
  },
  trae: {
    key: "trae",
    // Fallback = the current desktop release per the official winget manifest
    // (ByteDance.Trae 3.6.13). Trae publishes no npm package and no release
    // API; the docs changelog renders as an SPA and no longer exposes its
    // entries to machine-readable parsing (the parser that once read it was
    // removed once it started returning null), so the pin carries the wire
    // identity until a machine-readable feed exists again. intl `llm_raw_chat`
    // answers `4015` for a stale version, so raise this pin when the desktop
    // build moves.
    fallback: "3.6.13",
    sources: [],
  },
  freepi: {
    key: "freepi",
    // The free-pi CLI version — the `x-client-version` the gateway reports.
    // Fallback = the current npm latest (0.6.21 as of 2026-11-14); a cold
    // process sends it until the monitor's first successful discovery.
    fallback: "0.6.21",
    sources: [{ url: "https://registry.npmjs.org/free-pi-cli/latest" }],
  },
  clixad: {
    key: "clixad",
    // The Clixad gateway publishes the CLI build it is paired with as
    // `cli_latest` on `/v1/models` (unauthenticated). Fallback = the version
    // the 0.0.1-beta.50 bundle shipped (verified live 2026-11-11); a cold
    // process sends it until the monitor's first successful discovery.
    fallback: "0.0.1-beta.50",
    sources: [
      {
        url: "https://clixad.onrender.com/v1/models",
        extract: clixadVersion,
      },
    ],
  },
  deepai: {
    key: "deepai",
    // The Electron-updater generic feed the DeepAI Code desktop app's own
    // auto-updater polls (`downloads.deepai.org/deepai-code/releases`,
    // surfaced by the 0.3.35 wire audit). Verified live 2026-11-14: 0.3.37,
    // up from the audited 0.3.35 pin — the old "no machine-readable feed"
    // note was wrong; the feed just was not looked for.
    fallback: "0.3.37",
    sources: [
      {
        url: "https://downloads.deepai.org/deepai-code/releases/latest.yml",
        extract: electronUpdaterVersion,
      },
    ],
  },
  cursor: {
    key: "cursor",
    // Fallback = the newest stable build from the official download API at the
    // time of wiring (cli-2026.11.05-86047df). Discovery replaces it within one
    // monitor tick; it is only what a cold process sends before the first
    // successful fetch. Kept equal to `CURSOR_CLIENT_VERSION` in the cursor
    // wire module so the badge and the request header always send one identity.
    fallback: "cli-2026.11.05-86047df",
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
    fallback: "0.23.1",
    sources: [
      {
        url: "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest",
        extract: githubReleaseVersion,
      },
    ],
  },
  zcode: {
    key: "zcode",
    fallback: "3.17.2",
    sources: [
      {
        url: "https://api.github.com/repos/zai-org/ZCode/releases/latest",
        extract: githubReleaseVersion,
      },
    ],
  },
  factoryDroid: {
    key: "factory-droid",
    // The official Factory Droid CLI publishes to npm as `droid` (bin `droid`,
    // repo `Factory-AI/factory`, maintainers @factory.ai). Fallback = the npm
    // latest at the time of wiring (1.12.1); a cold process sends it until the
    // monitor's first successful discovery.
    fallback: "1.12.1",
    sources: [{ url: "https://registry.npmjs.org/droid/latest" }],
  },
} as const;

const resolvers = {
  antigravity: createClientVersionResolver({ ...VERSION_SOURCES.antigravity, client: "antigravity" }),
  qoder: createClientVersionResolver({ ...VERSION_SOURCES.qoder, client: "qoder" }),
  hermes: createClientVersionResolver({ ...VERSION_SOURCES.hermes, client: "hermes" }),
  trae: createClientVersionResolver({ ...VERSION_SOURCES.trae, client: "trae" }),
  freepi: createClientVersionResolver({ ...VERSION_SOURCES.freepi, client: "freepi" }),
  clixad: createClientVersionResolver({ ...VERSION_SOURCES.clixad, client: "clixad" }),
  deepai: createClientVersionResolver({ ...VERSION_SOURCES.deepai, client: "deepai" }),
  cursor: createClientVersionResolver({ ...VERSION_SOURCES.cursor, client: "cursor" }),
  opencode: createClientVersionResolver({ ...VERSION_SOURCES.opencode, client: "opencode" }),
  commandcode: createClientVersionResolver({ ...VERSION_SOURCES.commandcode, client: "command-code" }),
  grok: createClientVersionResolver({ ...VERSION_SOURCES.grok, client: "grok" }),
  clineSdk: createClientVersionResolver({ ...VERSION_SOURCES.clineSdk, client: "cline-sdk" }),
  clineCli: createClientVersionResolver({ ...VERSION_SOURCES.clineCli, client: "cline-cli" }),
  codex: createClientVersionResolver({ ...VERSION_SOURCES.codex, client: "codex" }),
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
  factoryDroid: createClientVersionResolver({ ...VERSION_SOURCES.factoryDroid, client: "factory-droid" }),
} satisfies Record<keyof typeof VERSION_SOURCES, ClientVersionResolver>;
const PROVIDER_VERSION_RESOLVERS: Readonly<Record<string, ClientVersionResolver>> = {
  antigravity: resolvers.antigravity,
  freepi: resolvers.freepi,
  clixad: resolvers.clixad,
  deepai: resolvers.deepai,
  grok: resolvers.grok,
  xai: resolvers.grok,
  opencode: resolvers.opencode,
  "opencode-zen": resolvers.opencode,
  "opencode-go": resolvers.opencode,
  // The identity this provider is dispatched under is the CLI's, so the route
  // identity reports the CLI version, not the VS Code extension manifest.
  cline: resolvers.clineCli,
  codex: resolvers.codex,
  qoder: resolvers.qoder,
  cursor: resolvers.cursor,
  hermes: resolvers.hermes,
  trae: resolvers.trae,
  traecn: resolvers.trae,
  commandcode: resolvers.commandcode,
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
  // Both Qoder realms present the same IDE build identity (one COSY_VERSION
  // per product, not per deployment host).
  qodercn: resolvers.qoder,
  factory: resolvers.factoryDroid,
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
  scheduleFallbackRetry(resolversToRefresh);
}

let fallbackRetryTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * One bounded retry for resolvers still on their pinned fallback.
 *
 * `ensure()` swallows per-source failures (the loader returns null rather
 * than throwing, so there is no error to observe), and the monitor's tick is
 * 30 minutes — a transient blip would otherwise leave a cold identity stale
 * for the whole interval while every other client is current. One retry
 * 90 seconds after the pass closes most of that gap. Unref'd and single-shot:
 * it never holds the process open, never stacks up, and a resolver that
 * recovers on the retry reports `latest` on the next pinned-versions read.
 */
function scheduleFallbackRetry(resolvers: readonly ClientVersionResolver[]): void {
  if (fallbackRetryTimer !== undefined) return;
  const stuck = resolvers.filter((resolver) => resolver.snapshot().source === "fallback");
  if (stuck.length === 0) return;
  fallbackRetryTimer = setTimeout(() => {
    fallbackRetryTimer = undefined;
    void Promise.allSettled(stuck.map((resolver) => resolver.ensure()));
  }, 90_000);
  (fallbackRetryTimer as unknown as { unref?: () => void }).unref?.();
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
export const getFreepiVersion = accessor("freepi").get;
export const getDeepAIVersion = accessor("deepai").get;

export const getOpenCodeVersion = accessor("opencode").get;

export const getFactoryDroidVersion = accessor("factoryDroid").get;

export const getCommandCodeVersion = accessor("commandcode").get;

export const getGrokVersion = accessor("grok").get;

export function buildGrokUserAgent(version = getGrokVersion()): string {
  return buildGrokShellUserAgent(version);
}

export function buildGrokAuthUserAgent(version = getGrokVersion()): string {
  return buildGrokAuthUserAgentString(version);
}


export const getClineSdkVersion = accessor("clineSdk").get;
export const getClineCliVersion = accessor("clineCli").get;
export const _resetClineCliVersionCache = accessor("clineCli").reset;

export const getCodexVersion = accessor("codex").get;

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
