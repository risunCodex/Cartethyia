/**
 * Builds the request a provider probe sends, from the provider's own adapter.
 *
 * The point of probing rather than dispatching is to learn whether an egress
 * address is refused *before* a user request spends itself finding out. That
 * only works if the probe sends what a real dispatch sends — a hand-written
 * stand-in can pass while dispatch fails, which is the failure this module
 * exists to avoid.
 *
 * Only providers whose limits follow the egress address are probeable: for
 * every other provider a 403 belongs to the credential, so a probe would
 * report a pool as refused for a reason replacing the proxy cannot fix.
 */
import { encodeWireRequest } from "../protocol/registry";
import { resolveDialect } from "../protocol/translation/dialect/resolver";
import type { CanonicalRequest } from "../protocol/canonical-model";
import type { ProviderDispatchContext } from "./provider-contracts";
import { providerBaseUrl, providerRateLimitIsIpScoped } from "./provider-metadata";
import type { ProviderDispatchTarget, ProviderId } from "./provider-contracts";


/**
 * The model a probe asks for.
 *
 * `big-pickle` is the free id the OpenCode listing always carries, so a probe
 * against it answers "is this address refused" rather than "is this particular
 * model retired".
 */
const PROBE_MODEL = "big-pickle";

export interface ProviderProbeRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Whether this provider can be probed for an egress refusal at all. */
export function isProbeableProvider(providerId: string): boolean {
  return providerRateLimitIsIpScoped(providerId);
}

/**
 * The canonical request the probe sends.
 *
 * One short user turn, not an empty `messages` array. The empty-body theory was
 * wrong: the IP gate runs *after* body validation, so a healthy address answers
 * `400 messages must not be empty` instead of the 200 it would give a real
 * dispatch. That turned every good pool into `unreachable` — "the probe itself
 * could not complete" — which is the opposite of what it says, and it hid four
 * working proxies behind a verdict that blamed them.
 *
 * The turn is one word, so an allowed address runs the cheapest possible
 * inference. `stream: true` is what the gate requires of an accepted dispatch,
 * so the probe must carry it or a healthy address would be refused for the
 * wrong reason.
 */
function probeRequest(): CanonicalRequest {
  return {
    model: PROBE_MODEL,
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    stream: true,
    source_surface: "chat",
    generation_controls: {},
  } as unknown as CanonicalRequest;
}

/**
 * The dispatch context the adapter's header hook reads.
 *
 * The probe is not a dispatch: it carries no account and forwards no
 * credential, which is exactly right for a provider whose free tier is
 * anonymous. Only the fields the header builder reads are populated.
 */
function probeContext(providerId: string): ProviderDispatchContext {
  return {
    credential: { provider_id: providerId as ProviderId, credential_kind: "none" },
    deadline: Date.now() + 20_000,
    abort_signal: new AbortController().signal,
  };
}

/**
 * Builds the probe for one provider, or `undefined` when the provider is not
 * probeable.
 */
export async function buildProviderProbeRequest(
  providerId: string,
): Promise<ProviderProbeRequest | undefined> {
  if (!isProbeableProvider(providerId)) return undefined;

  // dynamic-import: cycle break -- opencode/provider transitively imports
  // this module through the discovery helper; a static import deadlocks at
  // load time.
  const { OPENCODE_FREE_SPEC } = await import("./integrations/opencode/provider");
  const spec = OPENCODE_FREE_SPEC;
  const source = probeRequest();
  const prepared = spec.prepareRequest?.(source) ?? source;
  const payload = await encodeWireRequest("chat", prepared, {
    ...(spec.chatTokenLimitField === undefined
      ? {}
      : { chatTokenLimitField: spec.chatTokenLimitField }),
    dialectPolicy: resolveDialect(PROBE_MODEL, providerId, "chat"),
  });
  // The adapter's own hooks build the wire body; without running them the
  // probe would omit the agent-tool fingerprint and be refused on a healthy
  // address, which reads as "this proxy is blocked" and would retire a good
  // pool.
  spec.prePayload?.(
    payload,
    prepared,
    {
      provider_id: providerId,
      model_id: PROBE_MODEL,
      wire_family: "chat",
      endpoint_path: "/inference/openai/v1/chat/completions",
      capabilities: {},
    } as ProviderDispatchTarget,
  );
  const headers = (await spec.buildExtraHeaders?.(probeContext(providerId), source)) ?? {};
  return {
    url: `${providerBaseUrl(providerId).replace(/\/+$/, "")}/inference/openai/v1/chat/completions`,
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  };
}
