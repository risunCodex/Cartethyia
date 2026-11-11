/**
 * Asks a provider whether it will serve traffic from a given egress.
 *
 * The question this answers is not "is the proxy up". A proxy can carry
 * traffic, pass a neutral canary, and still be refused by one provider: OpenCode
 * answers `GET /inference/v1/models` with 200 from a flagged address and only
 * refuses on the dispatch route. So this sends the provider's own dispatch —
 * the adapter's headers, the agent tool set, `stream: true` — through the same
 * `createValidatedFetch` + pool agent the gateway uses. A hand-built stand-in
 * can pass while dispatch fails, which is the failure the probe exists to
 * avoid.
 *
 * Run it instead of hand-rolling a `fetch` in a scratch file:
 *
 *   bun run scripts/tools/probe-egress.ts --provider opencode \
 *     --direct \
 *     --proxy http://nozomi.proxy.rlwy.net:48011 \
 *     --proxy iriguchi.proxy.rlwy.net:23244
 *
 *   # Read endpoints from a file, one per line (# comments allowed).
 *   bun run scripts/tools/probe-egress.ts -p opencode -f proxies.txt
 *
 *   # Pipe them in.
 *   cat proxies.txt | bun run scripts/tools/probe-egress.ts -p opencode
 *
 * Every endpoint is probed concurrently (default 4 at a time, `--concurrency`).
 * Exit code is 0 when at least one egress is usable, 1 otherwise, so it can gate
 * a shell pipeline.
 *
 * Verdicts:
 *
 *   allowed      the upstream served the dispatch (2xx) — or answered with its
 *                own validation error, which proves the IP gate let the address
 *                through. This is the distinction that matters: a 400
 *                `messages must not be empty` is an ALLOWED egress and a broken
 *                probe body, not a broken proxy.
 *   blocked      the upstream refused the address itself (`403 FreeTierError`).
 *                Replacing the proxy is the only fix; waiting does nothing.
 *   unreachable  the probe never got a usable answer: CONNECT failed, DNS
 *                failed, or the upstream answered 5xx. Says nothing about
 *                whether the address is refused.
 *   throttled    the upstream answered 429. The address is accepted; it is the
 *                rate that is spent.
 */
import { createHttpProxyAgent } from "../../src/network/pool/agent";
import { createValidatedFetch } from "../../src/network/egress/fetch";
import { buildProviderProbeRequest, isProbeableProvider } from "../../src/providers/provider-probe";
import {
  classifyProviderProbeAnswer,
  isRetryableProbeError,
  type ProbeVerdict,
} from "../../src/console/routing/pools/probe-verdict";
import { BUNDLED_PROVIDER_METADATA } from "../../src/providers/provider-metadata";

/** One egress under test, plus how to build its dial. */
interface EgressTarget {
  /** Human label for the result row. */
  readonly label: string;
  /** `undefined` dials direct. */
  readonly proxy?: string;
}

interface ProbeOutcome {
  readonly label: string;
  readonly verdict: ProbeVerdict;
  readonly httpStatus?: number;
  readonly latencyMs?: number;
  readonly detail?: string;
}

const DEFAULT_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 30_000;
/**
 * Attempts per egress for a transport-level failure.
 *
 * Three, not two: the first failure is usually the cold dial, and a second
 * failure that is also transport-shaped is real evidence the egress is down
 * rather than a second coincidence. A genuine refusal never reaches this loop,
 * because a 403 is an answer rather than a failure.
 */
const PROBE_TRANSPORT_ATTEMPTS = 3;
/** Linear backoff between attempts; long enough for a reset to settle. */
const PROBE_RETRY_DELAY_MS = 400;

interface Options {
  readonly providerId: string;
  readonly targets: readonly EgressTarget[];
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly json: boolean;
}

function usage(): never {
  console.error(
    [
      "Usage: bun run scripts/tools/probe-egress.ts --provider <id> [options]",
      "",
      "Options:",
      "  -p, --provider <id>     Provider to probe (must be IP-scoped; opencode is the only one)",
      "  --direct                Also probe this machine's own egress",
      "  --proxy <endpoint>      Add a proxy (repeatable). Bare host:port is read as http://",
      "  -f, --file <path>       Read endpoints from a file, one per line ('#' comments allowed)",
      "  --stdin                 Read endpoints from stdin",
      "  --concurrency <n>       Parallel probes (default 4)",
      "  --timeout <ms>          Per-probe timeout (default 30000)",
      "  --json                  Print one JSON object per line instead of a table",
      "  -h, --help              This message",
      "",
      "Endpoints may be http://, https://, socks5://, or bare host:port (http).",
      "Exit code: 0 if any egress is usable, 1 otherwise.",
    ].join("\n"),
  );
  process.exit(2);
}

/** Normalizes an operator-supplied endpoint. Bare `host:port` means HTTP. */
function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("://")) return trimmed;
  return `http://${trimmed}`;
}

function collectEndpointsFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
}

function parseArgs(argv: readonly string[]): Options {
  let providerId: string | undefined;
  const targets: EgressTarget[] = [];
  let concurrency = DEFAULT_CONCURRENCY;
  let timeoutMs = PROBE_TIMEOUT_MS;
  let json = false;
  const files: string[] = [];
  let readStdin = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) usage();
      index += 1;
      return value;
    };
    switch (arg) {
      case "-p":
      case "--provider":
        providerId = next();
        break;
      case "--direct":
        targets.push({ label: "direct" });
        break;
      case "--proxy":
        targets.push({ label: "", proxy: normalizeEndpoint(next()) });
        break;
      case "-f":
      case "--file":
        files.push(next());
        break;
      case "--stdin":
        readStdin = true;
        break;
      case "--concurrency":
        concurrency = Math.max(1, Number(next()) || DEFAULT_CONCURRENCY);
        break;
      case "--timeout":
        timeoutMs = Math.max(1_000, Number(next()) || PROBE_TIMEOUT_MS);
        break;
      case "--json":
        json = true;
        break;
      case "-h":
      case "--help":
        usage();
        break;
      default:
        // A bare argument is an endpoint, so `... --provider opencode host:port`
        // works without a flag. Anything starting with `-` is a mistake.
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          usage();
        }
        targets.push({ label: "", proxy: normalizeEndpoint(arg) });
        break;
    }
  }

  if (providerId === undefined) {
    console.error("--provider is required");
    usage();
  }

  const fromFiles: EgressTarget[] = [];
  for (const file of files) {
    const text = readFileText(file);
    for (const endpoint of collectEndpointsFromText(text)) {
      fromFiles.push({ label: "", proxy: normalizeEndpoint(endpoint) });
    }
  }
  if (readStdin) {
    const text = readFileText(0);
    for (const endpoint of collectEndpointsFromText(text)) {
      fromFiles.push({ label: "", proxy: normalizeEndpoint(endpoint) });
    }
  }

  const all = [...targets, ...fromFiles];
  if (all.length === 0) {
    console.error("No egress to probe: pass --direct, --proxy, --file, or --stdin");
    usage();
  }

  return {
    providerId,
    targets: all.map((target) => ({
      // The label is what the operator typed, minus the scheme they may have
      // omitted — printing `http://` on every row buries the distinguishing part.
      label: target.proxy === undefined ? target.label : target.proxy.replace(/^[a-z0-9+.-]+:\/\//i, ""),
      ...(target.proxy === undefined ? {} : { proxy: target.proxy }),
    })),
    concurrency,
    timeoutMs,
    json,
  };
}

/** Reads a file path, or fd 0 for stdin. Kept separate so `parseArgs` stays pure-ish. */
function readFileText(path: string | 0): string {
  try {
    return require("node:fs").readFileSync(path, "utf8") as string;
  } catch (error) {
    console.error(`Cannot read ${path === 0 ? "stdin" : path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

/**
 * Maps one response to a verdict through the same classifier the console uses,
 * so a CLI run and the dashboard's "Test OpenCode" button can never disagree
 * about what an answer means.
 */
async function probeOne(
  spec: NonNullable<Awaited<ReturnType<typeof buildProviderProbeRequest>>>,
  target: EgressTarget,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const started = performance.now();
  let lastError: unknown;
  // A cold dial is the failed-first-attempt case: the first attempt must build
  // DNS, the proxy tunnel, and the TLS handshake, and any of those can be
  // refused or reset once by a middlebox that accepts the next one. Retrying
  // only transport errors keeps the verdict honest — a real refusal (403
  // FreeTierError) is an answer, not a failure, and is never retried.
  for (let attempt = 1; attempt <= PROBE_TRANSPORT_ATTEMPTS; attempt += 1) {
    try {
      // A fresh agent per attempt is deliberate: reusing the one that just had
      // its connection refused would re-enter a socket pool whose state is
      // exactly what failed.
      const agent = target.proxy === undefined ? undefined : createHttpProxyAgent(target.proxy);
      const dial = createValidatedFetch(agent === undefined ? {} : { agent });
      const response = await dial(spec.url, {
        method: "POST",
        headers: spec.headers,
        body: JSON.stringify(spec.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text().catch(() => "");
      const answer = classifyProviderProbeAnswer(response.status, body);
      return {
        label: target.label,
        verdict: answer.status,
        httpStatus: response.status,
        latencyMs: Math.round(performance.now() - started),
        ...(answer.reason === undefined ? {} : { detail: answer.reason }),
      };
    } catch (error) {
      lastError = error;
      if (!isRetryableProbeError(error) || attempt === PROBE_TRANSPORT_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_DELAY_MS * attempt));
    }
  }
  const error = lastError;
  const message = error instanceof Error ? error.message : String(error);
  const timedOut =
    (error instanceof Error && error.name === "AbortError") ||
    /timed out|timeout|ETIMEDOUT/i.test(message);
  return {
    label: target.label,
    verdict: "unreachable",
    latencyMs: Math.round(performance.now() - started),
    detail: timedOut ? "probe timed out" : message.split("\n")[0]!.slice(0, 120),
  };
}

const VERDICT_GLYPH: Record<ProbeVerdict, string> = {
  allowed: "OK   ",
  blocked: "BLOCK",
  throttled: "RATE ",
  unreachable: "FAIL ",
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!isProbeableProvider(options.providerId)) {
    console.error(
      `${options.providerId} is not IP-scoped, so a probe cannot tell an egress refusal from a credential problem. ` +
        `Probeable: ${BUNDLED_PROVIDER_METADATA.filter((entry) => isProbeableProvider(entry.id)).map((entry) => entry.id).join(", ") || "(none)"}`,
    );
    process.exit(2);
  }

  const spec = await buildProviderProbeRequest(options.providerId);
  if (!spec) {
    console.error(`No probe spec for ${options.providerId}`);
    process.exit(2);
  }

  if (!options.json) {
    console.error(`Probing ${options.providerId} via ${spec.url}`);
    console.error(`${options.targets.length} egress(es), ${options.concurrency} at a time\n`);
  }

  const results: ProbeOutcome[] = new Array(options.targets.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const target = options.targets[index];
      if (target === undefined) return;
      results[index] = await probeOne(spec, target, options.timeoutMs);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.targets.length) }, () => worker()),
  );

  if (options.json) {
    for (const result of results) console.log(JSON.stringify(result));
  } else {
    const labelWidth = Math.max(...results.map((result) => result.label.length), 8);
    for (const result of results) {
      const status = result.httpStatus === undefined ? "  -" : String(result.httpStatus).padStart(3);
      const latency = result.latencyMs === undefined ? "" : `${String(result.latencyMs).padStart(6)}ms`;
      console.log(
        `${result.label.padEnd(labelWidth)}  ${VERDICT_GLYPH[result.verdict]}  ${status}  ${latency.padStart(9)}  ${result.detail ?? ""}`,
      );
    }
    const tally = (verdict: ProbeVerdict): number => results.filter((r) => r.verdict === verdict).length;
    console.log(
      `\nallowed ${tally("allowed")} · blocked ${tally("blocked")} · ` +
        `throttled ${tally("throttled")} · unreachable ${tally("unreachable")}`,
    );
  }

  const usable = results.some(
    (result) => result.verdict === "allowed" || result.verdict === "throttled",
  );
  process.exit(usable ? 0 : 1);
}

await main();
