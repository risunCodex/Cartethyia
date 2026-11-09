/**
 * Qoder integration — public barrel.
 *
 * Re-exports every public API of the integration. The folder was restructured
 * (2026-11-05) into focused modules; this barrel keeps every existing import
 * path (`src/providers/integrations/qoder/qoder.ts`) working unchanged.
 *
 * Surface contract (see `qoder-adapter.ts`):
 * - `grpc` — default billed carrier (1M-token context).
 * - `cosy` — free/lite + forced legacy (COSY Bearer signing).
 * - `ide` — probe/testing only, never production.
 */

// Auth: PAT detection, machine id, OAuth auth, PAT→jt exchange v1, session id
export {
  isQoderPat,
  qoderMachineIdForAccount,
  qoderOAuthAuth,
  qoderSessionId,
  resolveQoderAuth,
} from "./qoder-auth";
export type { QoderAuth, QoderModelConfig } from "./qoder-types";

// COSY signing: alphabet transform, Bearer headers, signer, body encode
export {
  qoderBuildCosyHeaders,
  transformQoderBody,
  qoderEncodeBody,
  qoderSignerFor,
} from "./qoder-cosy";

// Shared message helpers
export { flattenCanonicalContent, qoderTools, qoderToolChoice } from "./qoder-body";

// Chat builder + legacy COSY transport
export { buildQoderRequest, callQoder } from "./qoder-chat";
export type { QoderModeProfile } from "./qoder-chat";
export { MODERN_PROFILE } from "./qoder-chat";

// IDE surface (probe/testing only)
export {
  buildQoderIdeRequest,
  qoderBodyToCanonicalEvents,
  qoderEnvelopeToFrames,
} from "./qoder-ide";

// gRPC transport
export {
  buildQoderGrpcRequest,
  qoderGrpcMetadata,
  qoderGrpcToCanonicalEvents,
  qoderGrpcClient,
  qoderGrpcChannelOptions,
  fromProtoStruct,
  QoderToolCallBuffer,
  resolveQoderToolFragmentId,
} from "./qoder-grpc";
export type { QoderProtoToolFragment, QoderDrainedToolCall, QoderToolFragmentState } from "./qoder-grpc";

// Adapter + transport selection
export { createQoderAdapter, createQoderCnAdapter, resolveQoderTransport } from "./qoder-adapter";

// Realm constants & helpers
export {
  QODER_CHAT_PATH,
  QODER_MODELS_PATH,
  QODER_IDE_CHAT_PATH,
  QODER_REALMS,
  QODER_PROVIDER_ID,
  qoderIdeChatUrl,
  qoderGrpcHost,
  qoderRealmForProvider,
  qoderGatewayCandidates,
  qoderInferenceCandidates,
} from "./qoder-realm";
export type { QoderRealm, QoderRealmConfig } from "./qoder-realm";

// Catalog & virtual models
export {
  QODER_INTL_MODELS,
  QODER_INTL_MODELS as QODER_MODELS,
  QODER_CN_MODELS,
  QODER_INTL_MODEL_CONFIGS,
  QODER_CN_MODEL_CONFIGS,
  discoverQoderModels,
  mapQoderCatalogResponse,
  qoderCatalogModel,
  qoderMaxContextWindow,
  qoderVirtualModels,
  qoderDiscoveredMaxContexts,
  resetQoderDiscoveryCache,
} from "./qoder-catalog";
export type { QoderCatalogEntry, QoderSigner } from "./qoder-catalog";
export {
  QODER_VIRTUAL_MODELS,
  qoderDispatchModelId,
  isQoderVirtualModel,
  qoderVirtualIdFor,
} from "./qoder-virtual";
export type { QoderVirtualModel } from "./qoder-virtual";

// OAuth device flow
export {
  QoderOAuthClient,
  qoderOAuthClient,
  qoderCnOAuthClient,
  parseQoderOAuthState,
  readQoderUserInfo,
  qoderHardwareMachineId,
  qoderOAuthUrls,
} from "./qoder-oauth";
export type { QoderUserInfo, QoderOAuthState } from "./qoder-oauth";

// Quota
export { fetchQoderQuota, fetchQoderCnQuota } from "./qoder-quota";

// UMID / OS-derived machine identity
export {
  mintQoderOsIdentity,
  collectOsFingerprint,
  mintQoderNativeIdentity,
  replayQoderNativeIdentity,
  mintQoderGeneratedIdentity,
  qoderMachineHeaders,
} from "./qoder-umid";
export type { QoderNativeIdentity } from "./qoder-umid";
export {
  DrizzleQoderNativeIdentityStore,
  allocateQoderNativeIdentity,
  ensureQoderNativeIdentity,
} from "./qoder-native-identity-store";
export type { QoderNativeIdentityStore, NativeIdentityMinter, NativeIdentityReplayer } from "./qoder-native-identity-store";

// Check-in / claims
export {
  fetchQoderDailyCheckin,
  buildCampaignHeaders,
  isQoderCheckinProvider,
  QODER_CHECKIN_PROVIDER_IDS,
} from "./qoder-checkin";
export { claimQoderCredits } from "./claim-qoder-credits";
export type { QoderCreditClaimResult } from "./claim-qoder-credits";

// SSE decode
export { decodeQoderSseEvents } from "./qoder-sse";
export type { QoderSseEvent } from "./qoder-sse";
