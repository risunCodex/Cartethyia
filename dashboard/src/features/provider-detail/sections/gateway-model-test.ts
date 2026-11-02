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
const TEST_MAX_TOKENS = 256;
// Same probe prompt the model test always used (see buildProbeCanonicalRequest):
// it passes content-policy review and produces a useful sample — the model
// identifies itself and states its knowledge cutoff, instead of echoing a
// canned reply.
const TEST_PROMPT = "What model are you, and what is your knowledge cutoff date? Answer in one sentence.";

export function useGatewaySignedModelTest() {
  const keys = useApiKeys();
  const reveal = useRevealApiKey();
  const [testing, setTesting] = useState(false);

  const test = useCallback(
    async (model: string): Promise<GatewayModelTestResult> => {
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
      const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
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
            messages: [{ role: "user", content: TEST_PROMPT }],
            max_tokens: TEST_MAX_TOKENS,
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
        const sample =
          typeof message?.content === "string"
            ? (message.content as string).trim()
            : "";
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
