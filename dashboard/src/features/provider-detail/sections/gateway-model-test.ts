import { useCallback, useState } from "react";
import { useApiKeys, useRevealApiKey } from "../../../hooks/api-keys";

/**
 * One gateway-signed model test.
 *
 * `ModelCard`'s Test button must exercise the same path a real request takes —
 * signed with the tenant's default API key and sent to `/v1/chat/completions` —
 * not the internal probe route. The probe picks one account and dispatches
 * directly, skipping the routing ladder (usage floor, credit ordering, cooldown
 * eligibility). A model that would route fine on a credited account therefore
 * showed "Fail" whenever the probe happened to select a below-floor or
 * zero-credit account. Going through the gateway makes the button report what a
 * real request would do, including the floor skipping to the next account.
 */
export interface GatewayModelTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Assistant text from the first completion choice; absent on failure. */
  readonly sample?: string;
  /** The `model` the upstream named in its own response, verbatim. */
  readonly reportedModel?: string;
  readonly error?: string;
}

const TEST_TIMEOUT_MS = 20_000;
/** Fast mode: a short abort deadline and a tiny token budget, no retry (area 07). */
export const FAST_TEST_TIMEOUT_MS = 10_000;
export const FAST_TEST_MAX_TOKENS = 64;
export const FAST_TEST_SAMPLE_CHARS = 80;
// Neutral greeting for the fast model test — no identity question, which some
// providers treat as a guardrail trigger (see probe-phases PROBE_FAST_DEFAULT_PROMPT).
const FAST_TEST_PROMPT = "How are you?";
// Prompt the model test always used; detail mode keeps it (see buildProbeCanonicalRequest).
const TEST_PROMPT = "What model are you, and what is your knowledge cutoff date? Answer in one sentence.";

/** Options for one gateway test; `fast` keeps the same signed gateway path. */
export interface GatewayModelTestOptions {
  readonly fast?: boolean;
}

export function useGatewaySignedModelTest() {
  const keys = useApiKeys();
  const reveal = useRevealApiKey();
  const [testing, setTesting] = useState(false);

  const test = useCallback(
    async (
      model: string,
      maxTokens?: number,
      options: GatewayModelTestOptions = {},
    ): Promise<GatewayModelTestResult> => {
      const fast = options.fast === true;
      const defaultKey = (keys.data ?? []).find(
        (key) => key.enabled && key.revokedAt === undefined && key.isDefault,
      );
      if (defaultKey === undefined) {
        return {
          ok: false,
          latencyMs: 0,
          error: "The default gateway API key is unavailable.",
        };
      }

      let secret: string;
      try {
        ({ secret } = await reveal.mutateAsync({ keyId: defaultKey.id }));
      } catch (err) {
        return {
          ok: false,
          latencyMs: 0,
          error:
            (err as { message?: string }).message ??
            "Failed to reveal the default API key.",
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fast ? FAST_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS);
      const startedAt = performance.now();
      setTesting(true);
      try {
        const response = await fetch("/v1/chat/completions", {
          method: "POST",
          credentials: "same-origin",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: fast ? FAST_TEST_PROMPT : TEST_PROMPT }],
            // Use the model's catalog output limit when known, otherwise omit the
            // field so the gateway applies its own default. A hard-coded small
            // ceiling made reasoning-heavy models exhaust the budget on the
            // thinking phase and return an empty answer ("No sample text").
            // Fast mode deliberately takes the other side of that trade: the
            // answer is only a smoke signal, so 64 tokens is enough.
            ...(fast
              ? { max_tokens: FAST_TEST_MAX_TOKENS }
              : maxTokens === undefined
                ? {}
                : { max_tokens: maxTokens }),
            stream: false,
          }),
        });

        const text = await response.text();
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(text) as Record<string, unknown>;
        } catch {
          payload = null;
        }
        const latencyMs = Math.round(performance.now() - startedAt);

        if (!response.ok) {
          const error = payload?.error as Record<string, unknown> | undefined;
          const message =
            typeof error?.message === "string"
              ? error.message
              : `Gateway responded with HTTP ${response.status}`;
          return { ok: false, latencyMs, error: message };
        }

        const choices = Array.isArray(payload?.choices) ? payload?.choices : [];
        const first = choices[0] as Record<string, unknown> | undefined;
        const message = first?.message as Record<string, unknown> | undefined;
        const rawSample =
          typeof message?.content === "string"
            ? (message.content as string).trim()
            : "";
        // D40: fast reports just enough text to prove the model answered.
        const sample = fast ? rawSample.slice(0, FAST_TEST_SAMPLE_CHARS) : rawSample;
        const reportedModel =
          typeof payload?.model === "string" ? (payload.model as string) : undefined;
        return {
          ok: true,
          latencyMs,
          ...(sample.length > 0 ? { sample } : {}),
          ...(reportedModel !== undefined ? { reportedModel } : {}),
        };
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - startedAt),
          error: aborted
            ? "The model test timed out."
            : (err as { message?: string }).message ?? "Network error during model test.",
        };
      } finally {
        clearTimeout(timer);
        setTesting(false);
      }
    },
    [keys.data, reveal],
  );

  return { test, testing };
}
