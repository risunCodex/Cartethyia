/**
 * Captures live Buddy-family model catalogs into `data/provider-catalogs/`.
 *
 * This replaces the ad-hoc script that produced
 * `buddy-live-model-catalogs-2026-10-12.json`; that run was not committed, so
 * the file could not be regenerated. It now can be.
 *
 * The capture is deliberately read-only and ephemeral: it calls the same
 * `GET /v3/config` the provider discovery path calls, records the roster, and
 * writes NOTHING that identifies the account. Credentials are read from a
 * file passed on the command line and never echoed.
 *
 * Usage:
 *   bun run scripts/tools/capture-buddy-catalogs.ts \
 *     --creds C:\path\to\cb-accounts-<timestamp>.json \
 *     [--out data/provider-catalogs/buddy-live-model-catalogs-<date>.json]
 *
 * `--check` exits nonzero when a live roster differs from the stored one, which
 * is the useful form for CI or a scheduled refresh check.
 *
 * Endpoint survey (probed live 2026-10-25 against both hosts, one credential):
 *
 *   200 /v3/config                        29 models, 27 in the CLI roster  <-- used
 *   200 /v2/enterprises/personal/models   18 models, 17 in the CLI roster  (stale)
 *   500 /console/enterprises/personal/models  (CN-only path; 500 on intl hosts)
 *   404 /v1/models, /v3/models, /v2/models, /v4/config, /api/v3/config,
 *       /v3/config/models, /v3/agent/config, /v1/enterprises/personal/models
 *
 * The personal-models path answers and is the runtime's fallback, but it is
 * BEHIND: it lacks every model added since (gpt-6*, grok-4.7, kimi-k3.1*,
 * gemini-3.8-flash, minimax-m3.1-flash, step-5-preview) and still lists retired
 * ones (deep-model, kimi-k2.6, gemini-3.5-flash) plus gpt-5.3-codex. Capturing
 * from it would silently regress the roster by ~11 models, so /v3/config is the
 * source of record and the fallback is only for hosts that do not answer it.
 *
 * `x-product` does not change the roster: SaaS, IDE, Cli and an empty value all
 * return the same 29/27. The per-model shape is identical across both paths
 * (credits, descriptionEn/Zh, id, isDefault, maxAllowedSize, maxInputTokens,
 * maxOutputTokens, name, supportsImages, supportsToolCall, temperature, vendor).
 *
 * The 29 -> 27 drop is the text-to-image/video filter: hy-image-3.5 carries
 * `text-to-image` and kling-video-v3 carries `text-to-video`, which the runtime
 * discovery path also excludes. Not a capture defect.
 */

import { parseArgs } from "node:util";

interface RawModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly disabled?: unknown;
  readonly maxInputTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly supportsImages?: unknown;
  readonly supportsToolCall?: unknown;
  readonly supportsReasoning?: unknown;
  readonly credits?: unknown;
  readonly tags?: unknown;
  readonly videoGeneration?: unknown;
}

interface CatalogModel {
  id: string;
  name: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  supportsImages: boolean;
  supportsToolCall: boolean;
  supportsReasoning: boolean | null;
  credits: string;
}

interface ExcludedModel {
  id: string;
  name: string;
  reason: string;
  tags: readonly string[];
  /** Present only for media models, where upstream publishes capabilities here. */
  videoGeneration?: unknown;
}

interface Catalog {
  providerId: string;
  host: string;
  endpoint: string;
  identityUserAgent: string;
  httpStatus: number;
  envelopeCode: number | null;
  cliModelIds: readonly string[];
  models: readonly CatalogModel[];
  /**
   * Rows upstream publishes that this capture does NOT route, with why.
   *
   * Recorded rather than dropped: the gateway cannot serve them today, but
   * "cannot serve" and "does not exist" are different facts, and a catalog that
   * silently omits them makes a media model look like it was never offered.
   */
  excludedModels: readonly ExcludedModel[];
}

const IDENTITY_USER_AGENT =
  "CLI/4.12.1.39217423 CodeBuddy/4.12.1.39217423";

/** Hosts to probe, with the provider id their roster is stored under. */
const SITES: readonly { providerId: string; host: string }[] = [
  { providerId: "cb", host: "www.codebuddy.ai" },
  // CN realm. A separate credential export: the CN sites are a different
  // account realm and reject an intl token. Passed via --creds-cn.
  { providerId: "cbcn", host: "copilot.tencent.com" },
];

/** Which credential each site needs: CN sites take the CN token. */
const CN_PROVIDER_IDS: ReadonlySet<string> = new Set(["cbcn"]);

/**
 * Every path that answers, captured — not just the one we trust.
 *
 * `/v2/enterprises/personal/models` is the runtime's fallback and is stale by
 * ~11 models. Recording it anyway is the point: the drift between the two is
 * the evidence that /v3/config must stay the source of record, and a reader who
 * only sees the good roster cannot tell that the fallback would regress it.
 *
 * Order matters: index 0 is the source of record.
 */
const ENDPOINTS: readonly { path: string; label: string }[] = [
  { path: "/v3/config", label: "GET /v3/config" },
  { path: "/v2/enterprises/personal/models", label: "GET /v2/enterprises/personal/models" },
  // CN-only directory path. On the intl hosts it answers 500, which is why it
  // is not in the intl set above; on the CN hosts it answers 200 alongside
  // /v2/enterprises/personal/models.
  { path: "/console/enterprises/personal/models", label: "GET /console/enterprises/personal/models" },
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `sub` of an access token, so the directory scores by account. Undefined for opaque keys. */
function accountUid(credential: string): string | undefined {
  const parts = credential.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

async function captureSite(
  providerId: string,
  host: string,
  credential: string,
  endpointPath: string,
  endpointLabel: string,
): Promise<Catalog> {
  const uid = accountUid(credential);
  const response = await fetch(`https://${host}${endpointPath}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential}`,
      "user-agent": IDENTITY_USER_AGENT,
      "x-product": "SaaS",
      ...(uid === undefined ? { "x-no-user-id": "1" } : { "x-user-id": uid }),
      "x-no-enterprise-id": "1",
      "x-no-department-info": "1",
    },
    signal: AbortSignal.timeout(20_000),
  });

  const empty: Catalog = {
    providerId,
    host,
    endpoint: endpointLabel,
    identityUserAgent: IDENTITY_USER_AGENT,
    httpStatus: response.status,
    envelopeCode: null,
    cliModelIds: [],
    models: [],
    excludedModels: [],
  };
  if (!response.ok) return empty;

  const envelope = asRecord(await response.json().catch(() => undefined));
  if (envelope === undefined) return empty;
  const code = envelope["code"];
  if (code !== 0) return { ...empty, envelopeCode: typeof code === "number" ? code : null };

  const data = asRecord(envelope["data"]);
  const rawModels = data?.["models"];
  if (!Array.isArray(rawModels)) return { ...empty, envelopeCode: 0 };

  // The CLI agent's roster, when published, is the callable subset — the same
  // rule the runtime discovery path applies, so the capture matches what a
  // sync would actually persist.
  const agents = data?.["agents"];
  let cliRoster: Set<string> | undefined;
  if (Array.isArray(agents)) {
    for (const entry of agents) {
      const agent = asRecord(entry);
      if (agent?.["name"] !== "cli") continue;
      const listed = agent["models"];
      if (Array.isArray(listed) && listed.length > 0) {
        cliRoster = new Set(listed.filter((id): id is string => typeof id === "string"));
      }
      break;
    }
  }

  const models: CatalogModel[] = [];
  const excluded: ExcludedModel[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    const model = asRecord(entry) as RawModel | undefined;
    const id = model?.id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    const name = typeof model?.name === "string" && model.name.length > 0 ? model.name : id;
    const tagList: readonly string[] = Array.isArray(model?.tags)
      ? model.tags.filter((t): t is string => typeof t === "string")
      : [];
    const exclude = (reason: string): void => {
      excluded.push({ id, name, reason, tags: tagList, ...(model?.videoGeneration === undefined ? {} : { videoGeneration: model.videoGeneration }) });
    };
    if (model?.disabled === true) {
      exclude("disabled upstream");
      continue;
    }
    const lowerId = id.toLowerCase();
    if (
      lowerId.startsWith("nes-") ||
      lowerId.startsWith("completion-") ||
      lowerId.startsWith("codewise-")
    ) {
      exclude("non-chat family prefix (nes-/completion-/codewise-)");
      continue;
    }
    const output = asNumber(model?.maxOutputTokens);
    if (output !== null && output <= 256) {
      exclude(`maxOutputTokens ${output} <= 256 (completion model)`);
      continue;
    }
    if (tagList.some((tag) => tag.toLowerCase() === "text-to-image")) {
      exclude("text-to-image tag — media model, no chat surface");
      continue;
    }
    if (tagList.some((tag) => /-to-video$/.test(tag.toLowerCase()))) {
      exclude("video-generation tags — media model, no chat surface");
      continue;
    }
    if (cliRoster !== undefined && !cliRoster.has(id)) {
      exclude("not in the CLI roster");
      continue;
    }
    seen.add(id);
    models.push({
      id,
      name,
      maxInputTokens: asNumber(model?.maxInputTokens),
      maxOutputTokens: output,
      supportsImages: model?.supportsImages === true,
      supportsToolCall: model?.supportsToolCall === true,
      supportsReasoning: model?.supportsReasoning === true ? true : null,
      credits: asString(model?.credits),
    });
  }

  return {
    ...empty,
    envelopeCode: 0,
    cliModelIds: cliRoster === undefined ? [] : [...cliRoster],
    models,
    excludedModels: excluded,
  };
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    "creds-cn": { type: "string" },
    out: { type: "string" },
    check: { type: "string" },
  },
});

/** Reads the first account's access token out of an exported accounts file. */
async function tokenFrom(path: string): Promise<string | undefined> {
  const file = (await Bun.file(path).json().catch(() => null)) as
    | { accounts?: readonly { accessToken?: unknown }[] }
    | null;
  const token = file?.accounts?.[0]?.accessToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

const credsPath = values.creds;
if (typeof credsPath !== "string") {
  console.error("--creds <path to exported accounts json> is required");
  process.exit(2);
}
const token = await tokenFrom(credsPath);
if (token === undefined) {
  console.error(`no accessToken found in ${credsPath}`);
  process.exit(2);
}

// The CN sites are a different account realm and reject an intl token, so they
// need their own export. Without it they are skipped rather than captured as a
// wall of 401s.
const cnCredsPath = values["creds-cn"];
const cnToken =
  typeof cnCredsPath === "string" ? await tokenFrom(cnCredsPath) : undefined;
if (typeof cnCredsPath === "string" && cnToken === undefined) {
  console.error(`no accessToken found in ${cnCredsPath}`);
  process.exit(2);
}

const catalogs: Catalog[] = [];
for (const site of SITES) {
  const siteToken = CN_PROVIDER_IDS.has(site.providerId) ? cnToken : token;
  if (siteToken === undefined) {
    console.log(`[capture] ${site.host}: skipped — no CN credential (pass --creds-cn)`);
    continue;
  }
  for (const endpoint of ENDPOINTS) {
    const captured = await captureSite(
      site.providerId,
      site.host,
      siteToken,
      endpoint.path,
      endpoint.label,
    );
    catalogs.push(captured);
    console.log(
      `[capture] ${site.host} ${endpoint.path}: http=${captured.httpStatus} ` +
        `code=${captured.envelopeCode} models=${captured.models.length} cli=${captured.cliModelIds.length}`,
    );
  }
}

// Only the source-of-record endpoint (/v3/config) is required to answer, and
// only for sites we actually had a credential for. A secondary endpoint coming
// back empty is a finding, not a reason to abort — capturing that it is empty
// or stale is the point.
const failed = catalogs.filter(
  (c) => c.endpoint === ENDPOINTS[0]!.label && c.httpStatus === 200 && c.models.length === 0,
);
if (failed.length > 0) {
  console.error(
    `[capture] ${failed.map((c) => c.host).join(", ")} returned no models on ` +
      `${ENDPOINTS[0]!.label} — ` +
      `refusing to overwrite a working catalog with an empty roster.`,
  );
  process.exit(1);
}

const capturedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const day = capturedAt.slice(0, 10);

/**
 * One file per endpoint, each holding every host.
 *
 * Split by endpoint rather than by provider because the endpoint is the axis
 * that matters: `/v3/config` is the source of record and `/v2/...` is the stale
 * runtime fallback. Keeping them in separate files means a consumer cannot
 * accidentally load the fallback roster as if it were current, and the drift
 * between them stays a file-level comparison instead of an array index.
 */
const FILE_PER_ENDPOINT: Record<string, string> = {
  "GET /v3/config": `buddy-v3-config-model-catalogs-${day}.json`,
  "GET /v2/enterprises/personal/models": `buddy-v2-personal-model-catalogs-${day}.json`,
  "GET /console/enterprises/personal/models": `buddy-console-personal-model-catalogs-${day}.json`,
};

function sourceNote(endpointLabel: string): string {
  return (
    `Live ${endpointLabel} using temporary credentials; credentials and account ` +
    `identity are not included.` +
    (endpointLabel === ENDPOINTS[0]!.label
      ? " Source of record: this roster is the one a catalog sync persists."
      : " Runtime fallback roster: stale and narrower — see the v3-config file for the current roster.")
  );
}

if (typeof values.check === "string") {
  const stored = (await Bun.file(values.check).json().catch(() => null)) as
    | { catalogs?: readonly Catalog[] }
    | null;
  const previous = new Map(
    (stored?.catalogs ?? []).map((c) => [`${c.providerId}|${c.endpoint}`, c]),
  );
  let drift = 0;
  for (const current of catalogs) {
    const before = previous.get(`${current.providerId}|${current.endpoint}`);
    const beforeIds = new Set((before?.models ?? []).map((m) => m.id));
    const nowIds = new Set(current.models.map((m) => m.id));
    const added = [...nowIds].filter((id) => !beforeIds.has(id));
    const removed = [...beforeIds].filter((id) => !nowIds.has(id));
    if (added.length > 0 || removed.length > 0) {
      drift++;
      console.log(
        `[check] ${current.providerId} ${current.endpoint}: +${added.length} added (${added.join(", ") || "-"}) ` +
          `-${removed.length} removed (${removed.join(", ") || "-"})`,
      );
    } else {
      console.log(`[check] ${current.providerId}: unchanged (${nowIds.size} models)`);
    }
  }
  console.log(drift === 0 ? "[check] no drift" : `[check] drift in ${drift} catalog(s)`);
  process.exit(drift === 0 ? 0 : 1);
}

// `--out` writes one combined file (all endpoints, all hosts). Without it the
// default is one file per endpoint, which is the layout actually checked in.
if (typeof values.out === "string") {
  await Bun.write(
    values.out,
    `${JSON.stringify(
      { capturedAt, source: sourceNote(ENDPOINTS[0]!.label), catalogs },
      null,
      2,
    )}\n`,
  );
  console.log(`[capture] wrote ${values.out} (${catalogs.length} catalogs)`);
} else {
  for (const endpoint of ENDPOINTS) {
    const group = catalogs.filter((c) => c.endpoint === endpoint.label);
    const name = FILE_PER_ENDPOINT[endpoint.label];
    if (name === undefined) continue;
    const outPath = `data/provider-catalogs/${name}`;
    await Bun.write(
      outPath,
      `${JSON.stringify(
        { capturedAt, source: sourceNote(endpoint.label), catalogs: group },
        null,
        2,
      )}\n`,
    );
    console.log(
      `[capture] wrote ${outPath} ` +
        `(${group.map((c) => `${c.providerId}:${c.models.length}`).join(" ")})`,
    );
  }
}
