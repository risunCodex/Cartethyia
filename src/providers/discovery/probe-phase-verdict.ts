/**
 * Probe phases 7–8 — mirror the probe's outcome onto the account health
 * machine and compute the connectivity verdict from the event stream.
 */
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { CanonicalEvent, UsageRecord, WireFamily } from "../../protocol/canonical-model";
import {
  classifyUpstreamFailure,
} from "../../protocol/failure-classify";
import { terminalFailure } from "../../transport/dispatch/attempt-finalize";
import { recordAccountFailure, recordAccountSuccess } from "../operations/account-health-service";
import { GatewayError } from "../../protocol/gateway-error";

/**
 * Phase 7 — mirror the probe's outcome onto the account's health machine. A
 * probe that fails against a real account carries the same health signal as
 * live traffic (quota exhaustion, dead credentials): record it so the account
 * cools down / disables instead of staying green while every probe fails.
 * Non-mutating categories (unknown, policy) are no-ops inside
 * `recordAccountFailure`; this never throws. A successful probe proves the
 * account works, so recover it symmetrically (a cooling account flips back to
 * active instead of staying stale).
 */
export async function recordProbeHealth(args: {
  readonly db: CartethyiaDatabase;
  readonly invalidator: { invalidate(): unknown } | undefined;
  readonly accountId: string | undefined;
  readonly dispatchError: unknown;
  /**
   * The probe's canonical events, when there are any.
   *
   * Needed because some adapters deliver a refusal as a terminal event rather
   * than as a thrown error — a terminal `resource_exhausted` is the case — so
   * `dispatchError` stays `undefined` for a Run the upstream refused. Without
   * the events, that account looked like a success and was recovered.
   */
  readonly events?: readonly CanonicalEvent[] | undefined;
  readonly modelId: string;
  readonly upstreamStatusCode: number | undefined;
}): Promise<void> {
  const { db, invalidator, accountId, dispatchError, modelId, upstreamStatusCode } = args;
  // A terminal `failed` state is written only by the upstream decoders, so it
  // is the upstream refusing — the same thing a thrown error would have meant.
  const terminal = args.events?.find((event) => event.type === "terminal");
  // Reconstructed through the very function the live dispatch path uses, so a
  // refusal carries the same code, status, and health classification in both.
  // Hand-rolling a category here is how the two paths drifted apart.
  const refusedUpstream =
    terminal?.type === "terminal" && terminal.state === "failed"
      ? terminalFailure(terminal)
      : undefined;
  const failure = dispatchError ?? refusedUpstream;
  if (failure !== undefined && accountId) {
    const failureEvidence = {
      ...classifyUpstreamFailure(failure),
      modelId,
      ...(upstreamStatusCode === undefined ? {} : { statusCode: upstreamStatusCode }),
    };
    // The health machine owns the outcome. A 202 that carries a rate limit is
    // already classified as `rate_limit_transient` with a real cooldown by
    // `classifyAccountError`, so writing a status here only clobbered that
    // cooldown with a state nothing recovers from.
    await recordAccountFailure(db, accountId, failure, failureEvidence)
      .then((classification) => {
        if (classification?.mutatesAccount) void invalidator?.invalidate();
      })
      .catch(() => {});
  }
  // Symmetric: a successful probe proves the account works, so recover it
  // (a cooling account flips back to active instead of staying stale).
  // recordAccountSuccess is a no-op write for already-healthy accounts and
  // never throws.
  if (failure === undefined && accountId) {
    await recordAccountSuccess(db, accountId)
      .then((recovered) => {
        if (recovered) void invalidator?.invalidate();
      })
      .catch(() => {});
  }
}

/** The connectivity verdict a probe's event stream and dispatch error yield. */
export interface ProbeVerdict {
  readonly ok: boolean;
  readonly errorMessage: string | undefined;
  readonly usage: UsageRecord | undefined;
}

/**
 * Phase 8 — turn the probe's event stream and any dispatch error into the
 * verdict. Reasoning-only models can exhaust the tiny probe budget before
 * emitting visible text: a `length`-capped run that still produced reasoning
 * content proves connectivity, so count it as a pass.
 */
export function computeProbeVerdict(args: {
  readonly events: readonly CanonicalEvent[];
  readonly dispatchError: unknown;
  readonly wireFamily: WireFamily;
}): ProbeVerdict {
  const { events, dispatchError, wireFamily } = args;
  const terminal = events.find((event) => event.type === "terminal");
  const producedReasoning = events.some(
    (event) => event.type === "content_delta" && event.content.kind === "reasoning",
  );
  const cappedButReasoning =
    terminal?.type === "terminal" &&
    terminal.state === "complete" &&
    terminal.stop_reason === "length" &&
    producedReasoning;
  const ok =
    dispatchError === undefined &&
    terminal?.type === "terminal" &&
    (terminal.state === "complete" || cappedButReasoning);
  let errorMessage: string | undefined;
  if (dispatchError !== undefined) {
    const base =
      dispatchError instanceof GatewayError
        ? dispatchError.message
        : dispatchError instanceof Error
          ? dispatchError.message
          : "Model probe failed";
    // Present upstream errors with provider/wire/status context instead of a
    // raw JSON blob like "{\"error\":\"Not Found\",\"success\":false}".
    // Try to unwrap a JSON-stringified error body first.
    let pretty = base;
    const trimmed = base.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const inner =
          typeof parsed.error === "string"
            ? parsed.error
            : typeof parsed.message === "string"
              ? parsed.message
              : undefined;
        if (inner) pretty = inner;
      } catch {
        // Malformed or non-standard JSON error payloads safely retain original error message.
      }
    }
    const details =
      dispatchError instanceof GatewayError
        ? (dispatchError.details as Record<string, unknown>)
        : undefined;
    const status =
      dispatchError instanceof GatewayError && typeof dispatchError.status === "number"
        ? dispatchError.status
        : undefined;
    const providerCode =
      typeof details?.providerCode === "string" ? String(details.providerCode) : undefined;
    const providerStatus =
      typeof details?.providerStatus === "number" ? Number(details.providerStatus) : undefined;
    const upstreamReq =
      typeof details?.upstreamRequestId === "string"
        ? String(details.upstreamRequestId)
        : undefined;
    const statusTag =
      providerCode !== undefined && providerStatus !== undefined
        ? `${providerCode} (upstream ${status ?? providerStatus})`
        : providerCode !== undefined
          ? providerCode
          : status !== undefined
            ? `upstream ${status}`
            : undefined;
    // A 429 that names a free-tier usage limit is upstream quota state, not a
    // payload or egress defect — label it as the throttle it is instead of a
    // generic probe failure.
    const throttled =
      status === 429 ||
      providerStatus === 429 ||
      /free usage limit|rate limit|throttl/i.test(base);
    // The toast title already names the model. Repeating `provider/model via
    // wire path` in the body made the operator read the same identity twice
    // and buried the upstream sentence. The wire family stays, because that is
    // the one fact the title does not carry; the path is noise next to it.
    const tagged = statusTag !== undefined ? `${pretty} (${statusTag})` : pretty;
    errorMessage = `${wireFamily} — ${throttled ? "Upstream rate limit (HTTP 429): " : ""}${tagged}${upstreamReq ? ` [req ${upstreamReq}]` : ""}`;

  } else if (terminal?.type === "terminal" && terminal.state !== "complete") {
    // Read the terminal's own detail before falling back to the stop reason.
    //
    // `stop_reason` is a canonical one-word label — "error" — so reporting it
    // alone turned a quota refusal into a toast whose entire body was
    // the word "error". The upstream sentence an operator needs is in
    // `stop_details`, which is where the adapter parks it and where the live
    // dispatch path already reads it (see `terminalFailure` in
    // `attempt-finalize.ts`). The probe path disagreed with the dispatch path
    // about the same provider response.
    const detail = terminal.stop_details;
    const message =
      typeof detail?.["message"] === "string" && detail["message"].trim().length > 0
        ? detail["message"].trim()
        : undefined;
    const code = typeof detail?.["code"] === "string" ? detail["code"] : undefined;
    const tag = code === undefined ? "" : ` (${code})`;
    errorMessage = `${message ?? terminal.stop_reason ?? "Model probe failed"}${tag}`;
  } else {
    errorMessage = undefined;
  }
  const usage = terminal?.type === "terminal" ? terminal.usage : undefined;
  return { ok, errorMessage, usage };
}
