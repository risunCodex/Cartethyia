import type { ApiKeyAdmissionService } from "../../src/security/admission/service";
import type { AdmissionLease } from "../../src/security/admission/contracts";
import type { AttemptLeaseSource } from "../../src/transport/dispatch/leases";
import type { ProxyRequestState } from "../../src/transport/request/state";
import type { RouteCandidate, Reservation, RoutePlan } from "../../src/transport/routing/route-model";
import type { RoutingEngine } from "../../src/transport/routing/router";
import type { ProviderId, ResolvedCredential } from "../../src/providers/provider-contracts";

export async function prepareAttempt(candidate: RouteCandidate) {
  const credential: ResolvedCredential = {
    // Custom route candidates carry plain strings; preparation is where a
    // provider id becomes the branded credential identity.
    provider_id: candidate.provider_id as ProviderId,
    credential_kind: "none",
  };
  return {
    credential,
    adapter: {},
  };
}

export function attemptCandidate(providerId: string, accountId: string): RouteCandidate {
  return {
    provider_id: providerId,
    model_id: "deepseek-v4.1-flash",
    endpoint: `/v1/${providerId}`,
    capability_profile: {},
    wire_family: "chat",
    provider_account_id: accountId,
    provider_account_label: accountId,
  };
}

export function attemptState(requestId: string, deadlineMs = Date.now() + 600_000): ProxyRequestState {
  return {
    requestId,
    startedAtMs: Date.now(),
    deadlineMs,
    ingressBody: { model: "deepseek", messages: [] },
    abortController: new AbortController(),
    startProviderFlight: () => undefined,
    releaseIngressBody: () => undefined,
    extendDeadline: () => undefined,
    cleanup: () => undefined,
  };
}

/** A fully valid lease path: tests must fail if dispatch cannot acquire it. */
export function attemptLeaseSource(
  candidates: readonly RouteCandidate[],
  requestedModel = "deepseek",
): AttemptLeaseSource {
  const admissionService = {
    admit: async (): Promise<AdmissionLease> => ({
      reservationId: crypto.randomUUID(),
      apiKeyId: "test-api-key",
      released: false,
      commitUsage: async () => undefined,
      release: async () => undefined,
    }),
  } as unknown as ApiKeyAdmissionService;
  const routingEngine = {
    reserve: async (plan: RoutePlan): Promise<Reservation> => ({
      candidate: plan.candidates[0]!,
      lease_id: crypto.randomUUID(),
      acquired_at: Date.now(),
      expires_at: Date.now() + 60_000,
    }),
    release: async (_reservation: Reservation) => undefined,
  } as unknown as RoutingEngine;
  return {
    estimatedInputTokens: 10,
    estimatedOutputTokens: 0,
    admissionService,
    routingEngine,
    authorizationSnapshot: { api_key_id: "test-api-key", tenant_id: "tenant-1" },
    plan: {
      revision: 0,
      candidates,
      requested_model: requestedModel,
      resolved_model: requestedModel,
      provider_id: candidates[0]?.provider_id ?? "unknown",
      decisions: new Map(),
    },
  };
}
