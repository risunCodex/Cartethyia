/**
 * Shared upstream JSON executor for [OpenAI]-compatible adapters: POSTs a payload
 * with deadline/abort wiring and returns the response plus a release hook.
 *
 * `bodyEncoder` lets a provider send the same body with non-JSON encoding
 * (e.g. zstd, which the Grok Build CLI does). When omitted, the JSON string is
 * sent as-is.
 */
import type { ProviderDispatchContext, ValidatedOutboundFetch } from "../../providers/provider-contracts";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../providers/operations/upstream-deadline";

export async function postUpstreamJson(
  fetchUrl: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  context: ProviderDispatchContext,
  outboundFetch: ValidatedOutboundFetch,
  bodyEncoder?: (payload: Record<string, unknown>) => string | Uint8Array<ArrayBuffer>,
): Promise<{ res: Response; signal: AbortSignal; release: () => void }> {
  const lifecycle = createUpstreamDeadlineLifecycle(context);
  try {
    const res = await outboundFetch(fetchUrl, {
      method: "POST",
      headers,
      body: bodyEncoder ? bodyEncoder(payload) : JSON.stringify(payload),
      signal: lifecycle.signal,
    });
    return {
      res,
      signal: lifecycle.signal,
      release: lifecycle.release,
    };
  } catch (error: unknown) {
    lifecycle.release();
    const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
    if (abortError) throw abortError;
    throw error;
  }
}
