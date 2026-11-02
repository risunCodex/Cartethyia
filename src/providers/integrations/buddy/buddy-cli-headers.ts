/**
 * The header family only the CLI identity sends.
 *
 * Everything here comes from the two reference gateways, which agree: the
 * desktop product sends conversation/tracing headers and a device token, while
 * the CLI sends the agent envelope. The CLI still drops the browser *transport*
 * headers (`origin`, `referer`, `accept-language`) and the device token, but
 * keeps the request-shape markers (`x-requested-with`, `x-codebuddy-request`)
 * the reference sends on every call regardless of transport — see the CLI
 * branches in each provider's `*-shared.ts`.
 *
 * The CLI's cloud chat transport is axios (`RestOperations`), not the OpenAI
 * Node SDK, so it sends **no** `x-stainless-*` fingerprint. The reference's
 * chat request helper sets only `Content-Type`, `Accept`, and `Authorization`
 * before the conversation/agent/identity headers are injected; the stainless
 * set belongs to the SDK-backed secondary clients, not to CodeBuddy chat.
 */

/**
 * The trace family the CLI carries as a child span.
 *
 * The desktop product omits the parent (`with_parent=False` in the reference);
 * the CLI conversation request is a child span, so it also sends `b3`'s fourth
 * field and `X-B3-ParentSpanId`. `buddyConversationHeaders` already produces
 * `traceparent`, `b3`, and the `X-B3-*` set, so only the parent is added here.
 */
export function buddyCliTraceHeaders(
  conversation: Readonly<Record<string, string>>,
): Record<string, string> {
  const traceId = conversation["x-trace-id"] ?? conversation["x-b3-traceid"];
  const spanId = conversation["x-b3-spanid"];
  if (traceId === undefined) return {};
  const b3 = `${traceId}-${spanId ?? traceId.slice(0, 16)}-1-${traceId.slice(0, 16)}`;
  return { ...(spanId === undefined ? {} : { "X-B3-ParentSpanId": spanId }), b3 };
}

/**
 * The full CLI identity envelope, minus what each caller already supplies.
 *
 * The caller keeps ownership of `User-Agent`, `X-IDE-*`, `X-Domain`, the
 * conversation family, and the OAuth identity headers; only the headers that
 * are the same for every CLI dispatch are built here.
 *
 * No `x-stainless-*` fingerprint: the CLI's chat transport is axios, not the
 * OpenAI Node SDK. `X-Private-Data` is added by the caller only when the
 * dispatch is actually private — the reference never sends it as `false`.
 */
export function buddyCliHeaders(args: {
  readonly userId: string;
  readonly enterpriseId?: string | undefined;
  readonly privateData?: boolean;
}): Record<string, string> {
  const enterpriseId =
    args.enterpriseId !== undefined && args.enterpriseId.trim().length > 0
      ? args.enterpriseId.trim()
      : undefined;
  return {
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    // The reference enum is local-agent / cloud-agent / agent-agent, and its
    // parser returns "other" for anything unknown or absent. A gateway is none
    // of the three, so "other" is the honest value rather than a guess.
    "X-Agent-Runtime": "other",
    "X-User-Id": args.userId,
    ...(args.privateData === true ? { "X-Private-Data": "true" } : {}),
    ...(enterpriseId === undefined
      ? {}
      : {
          "X-Enterprise-Id": enterpriseId,
          // The tenant falls back to the enterprise: the two are the same value
          // for an account that belongs to one enterprise, and the upstream
          // reads both.
          "X-Tenant-Id": enterpriseId,
        }),
  };
}
