/**
 * Shared Qoder types.
 *
 * Kept as a separate module so the gRPC transport (`qoder-grpc.ts`) and the
 * legacy/modern HTTP transport (`qoder.ts`) share one shape without importing
 * each other.
 */
import type { QoderRealm } from "./qoder-realm";

export type { QoderRealm };

export interface QoderAuth {
  userId: string;
  userName: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
  machineId: string;
}

export interface QoderModelConfig {
  id: string;
  display_name: string;
  max_input_tokens: number;
  max_output_tokens?: number;
  is_vl: boolean;
  is_reasoning: boolean;
  /**
   * Whether upstream publishes this row as free. Only an explicit `true`
   * marks the model as free-tier; absent or `false` means billed/unknown, so
   * a 402/116 there is genuine quota exhaustion, not a free-tier entitlement
   * refusal, and must not trigger a legacy-surface fallback.
   */
  is_free?: boolean;
  source?: string;
  /**
   * Reasoning effort to send when the caller did not ask for one. Some models
   * on the IDE surface stream no reasoning unless an effort is present.
   */
  default_reasoning_effort?: string;
}
