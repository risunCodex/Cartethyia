/**
 * Shared Qoder types.
 *
 * Kept as a separate module so the transports (gRPC, IDE/HTTP, legacy COSY)
 * and the auth layer share one shape without importing each other.
 */
import type { QoderRealm } from "./qoder-realm";

export type { QoderRealm };

export interface QoderAuth {
  userId: string;
  userName: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
  /** One UUID-like machine id used in COSY signing and session identity. */
  machineId: string;
  /**
   * Native UMID machine token (`P1gA…`), when a native identity is bound.
   * Absent for OAuth device tokens; the COSY header set then falls back to
   * `machineId` for the token/type/code fields.
   */
  machineToken?: string;
  /** Native UMID machine type (18-hex), when known. */
  machineType?: string;
  /** Native UMID machine code (18-hex), when known. */
  machineCode?: string;
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
