/**
 * Devin (Codeium Cascade) protobuf schema — trimmed subset, protobufjs.
 *
 * Vendored from oh-my-pi (`packages/catalog/src/discovery/devin-proto.ts`,
 * MIT) and cross-checked against the original `.proto` files in
 * `vendor/proto/devin/`. Only messages consumed by the Cartethyia adapter
 * are declared; field numbers are wire-identical to the originals.
 *
 * License: MIT (c) Stencil Labs, Inc. (oh-my-pi) — retained per source.
 */

import protobuf from "protobufjs";
import { addEnum, addType } from "../../cursor/protocol/protobuf-schema";

// ── Enums ──

function addDevinEnums(root: protobuf.Root): void {
  addEnum(root, "ChatMessageSource", {
    UNSPECIFIED: 0,
    USER: 1,
    SYSTEM: 2,
    UNKNOWN: 3,
    TOOL: 4,
    SYSTEM_PROMPT: 5,
  });
  addEnum(root, "ChatMessageRequestType", {
    UNSPECIFIED: 0,
    GENERAL: 1,
    CONTEXT_CHECK: 2,
    PLAN: 3,
    COMMAND: 4,
    CASCADE: 5,
    EVAL: 6,
    WINDSURF_REVIEW: 7,
    VIBE_AND_REPLACE: 8,
    DEEPWIKI: 9,
    DEVSTRAL: 10,
    CODEMAP_GENERATION: 11,
    CODEMAP_SUGGESTIONS: 12,
    SMART_FRIEND: 13,
    LIFEGUARD: 14,
    CHECKPOINT: 15,
  });
  addEnum(root, "ConversationalPlannerMode", {
    UNSPECIFIED: 0,
    DEFAULT: 1,
    READ_ONLY: 2,
    NO_TOOL: 3,
    EXPLORE: 4,
    PLANNING: 5,
    AUTO: 6,
  });
  addEnum(root, "StopReason", {
    UNSPECIFIED: 0,
    INCOMPLETE: 1,
    STOP_PATTERN: 2,
    MAX_TOKENS: 3,
    MIN_LOG_PROB: 4,
    MAX_NEWLINES: 5,
    EXIT_SCOPE: 6,
    NONFINITE_LOGIT_OR_PROB: 7,
    FIRST_NON_WHITESPACE_LINE: 8,
    PARTIAL: 9,
    FUNCTION_CALL: 10,
    CONTENT_FILTER: 11,
    NON_INSERTION: 12,
    ERROR: 13,
  });
  addEnum(root, "CacheControlType", { UNSPECIFIED: 0, EPHEMERAL: 1 });
  addEnum(root, "DisplayOption", {
    UNSPECIFIED: 0,
    ARENA: 1,
    BATTLE_GROUP_ONLY: 2,
    MODEL_ROUTER: 3,
    QUICK_REVIEW: 4,
  });
  addEnum(root, "ModelDimensionKind", { UNSPECIFIED: 0, COST: 1, COST_FUZZY: 2 });
  addEnum(root, "BillingStrategy", { UNSPECIFIED: 0, CREDITS: 1, QUOTA: 2, ACU: 3 });
  addEnum(root, "TeamsTier", {
    UNSPECIFIED: 0,
    TEAMS: 1,
    PRO: 2,
    ENTERPRISE_SAAS: 3,
    HYBRID: 4,
    ENTERPRISE_SELF_HOSTED: 5,
    WAITLIST_PRO: 6,
    TEAMS_ULTIMATE: 7,
    PRO_ULTIMATE: 8,
    TRIAL: 9,
    ENTERPRISE_SELF_SERVE: 10,
    ENTERPRISE_SAAS_POOLED: 11,
    DEVIN_ENTERPRISE: 12,
    DEVIN_TEAMS: 14,
    DEVIN_TEAMS_V2: 15,
    DEVIN_PRO: 16,
    DEVIN_MAX: 17,
    MAX: 18,
    DEVIN_FREE: 19,
    DEVIN_TRIAL: 20,
  });
}

// ── Types ──

function addDevinTypes(root: protobuf.Root): void {
  // exa.codeium_common_pb.Metadata
  addType(root, "Metadata", [
    { id: 1, name: "ideName", type: "string" },
    { id: 2, name: "extensionVersion", type: "string" },
    { id: 3, name: "apiKey", type: "string" },
    { id: 4, name: "locale", type: "string" },
    { id: 5, name: "os", type: "string" },
    { id: 6, name: "disableTelemetry", type: "bool" },
    { id: 7, name: "ideVersion", type: "string" },
    { id: 8, name: "hardware", type: "string" },
    { id: 9, name: "requestId", type: "uint64" },
    { id: 10, name: "sessionId", type: "string" },
    { id: 11, name: "sourceAddress", type: "string" },
    { id: 12, name: "extensionName", type: "string" },
    { id: 13, name: "userAgent", type: "string" },
    { id: 14, name: "url", type: "string" },
    { id: 15, name: "authSource", type: "int32" },
    { id: 16, name: "lsTimestamp", type: "Timestamp" },
    { id: 17, name: "extensionPath", type: "string" },
    { id: 20, name: "userId", type: "string" },
    { id: 21, name: "userJwt", type: "string" },
    { id: 22, name: "forceTeamId", type: "string" },
    { id: 24, name: "deviceFingerprint", type: "string" },
    { id: 25, name: "triggerId", type: "string" },
    { id: 26, name: "planName", type: "string" },
    { id: 27, name: "id", type: "string" },
    { id: 28, name: "ideType", type: "string" },
    { id: 29, name: "impersonateTier", type: "string" },
    { id: 30, name: "supportedModelDisplays", type: "DisplayOption", repeated: true },
    { id: 31, name: "f", type: "string" },
    { id: 32, name: "teamId", type: "string" },
  ]);

  // google.protobuf.Timestamp
  addType(root, "Timestamp", [
    { id: 1, name: "seconds", type: "int64" },
    { id: 2, name: "nanos", type: "int32" },
  ]);

  // exa.codeium_common_pb.ImageData
  addType(root, "ImageData", [
    { id: 1, name: "base64Data", type: "string" },
    { id: 2, name: "mimeType", type: "string" },
    { id: 3, name: "caption", type: "string" },
  ]);

  // exa.chat_pb.PromptCacheOptions
  addType(root, "PromptCacheOptions", [
    { id: 1, name: "type", type: "CacheControlType" },
  ]);

  // exa.chat_pb.ChatToolDefinition
  addType(root, "ChatToolDefinition", [
    { id: 1, name: "name", type: "string" },
    { id: 2, name: "description", type: "string" },
    { id: 3, name: "jsonSchemaString", type: "string" },
    { id: 5, name: "attributionFieldNames", type: "string", repeated: true },
    { id: 6, name: "serverName", type: "string" },
    { id: 7, name: "readOnlyHint", type: "bool" },
    { id: 9, name: "isCustomTool", type: "bool" },
    { id: 10, name: "customToolGrammar", type: "string" },
    { id: 11, name: "customToolGrammarSyntax", type: "string" },
    { id: 12, name: "strict", type: "bool" },
  ]);

  // exa.chat_pb.ChatToolChoice (oneof choice)
  addType(
    root,
    "ChatToolChoice",
    [
      { id: 1, name: "optionName", type: "string" },
      { id: 2, name: "toolName", type: "string" },
    ],
    [{ name: "choice", fields: ["optionName", "toolName"] }],
  );

  // exa.chat_pb.ChatMessagePrompt
  addType(root, "ChatMessagePrompt", [
    { id: 1, name: "messageId", type: "string" },
    { id: 2, name: "source", type: "ChatMessageSource" },
    { id: 3, name: "prompt", type: "string" },
    { id: 4, name: "numTokens", type: "uint32" },
    { id: 5, name: "safeForCodeTelemetry", type: "bool" },
    { id: 6, name: "toolCalls", type: "ChatToolCall", repeated: true },
    { id: 7, name: "toolCallId", type: "string" },
    { id: 8, name: "promptCacheOptions", type: "PromptCacheOptions" },
    { id: 9, name: "toolResultIsError", type: "bool" },
    { id: 10, name: "images", type: "ImageData", repeated: true },
    { id: 11, name: "thinking", type: "string" },
    { id: 12, name: "signature", type: "string" },
    { id: 13, name: "thinkingRedacted", type: "bool" },
    { id: 14, name: "promptAnnotationRanges", type: "int32", repeated: true },
    { id: 15, name: "outputId", type: "string" },
    { id: 16, name: "thinkingId", type: "string" },
    { id: 18, name: "signatureType", type: "string" },
    { id: 19, name: "phase", type: "string" },
  ]);

  // exa.codeium_common_pb.ChatToolCall
  addType(root, "ChatToolCall", [
    { id: 1, name: "id", type: "string" },
    { id: 2, name: "name", type: "string" },
    { id: 3, name: "argumentsJson", type: "string" },
    { id: 4, name: "invalidJsonStr", type: "string" },
    { id: 5, name: "invalidJsonErr", type: "string" },
    { id: 6, name: "isCustomToolCall", type: "bool" },
  ]);

  // exa.codeium_common_pb.CompletionConfiguration
  addType(root, "CompletionConfiguration", [
    { id: 1, name: "numCompletions", type: "int64" },
    { id: 2, name: "maxTokens", type: "int64" },
    { id: 3, name: "maxNewlines", type: "int64" },
    { id: 4, name: "minLogProbability", type: "double" },
    { id: 5, name: "temperature", type: "double" },
    { id: 6, name: "firstTemperature", type: "double" },
    { id: 7, name: "topK", type: "int64" },
    { id: 8, name: "topP", type: "double" },
    { id: 9, name: "stopPatterns", type: "string", repeated: true },
    { id: 10, name: "seed", type: "int64" },
  ]);

  // exa.codeium_common_pb.ModelUsageStats
  addType(root, "ModelUsageStats", [
    { id: 1, name: "modelDeprecated", type: "int32" },
    { id: 9, name: "modelUid", type: "string" },
    { id: 10, name: "billingModelUid", type: "string" },
    { id: 11, name: "requestedModelUid", type: "string" },
    { id: 2, name: "inputTokens", type: "uint64" },
    { id: 3, name: "outputTokens", type: "uint64" },
    { id: 4, name: "cacheWriteTokens", type: "uint64" },
    { id: 5, name: "cacheReadTokens", type: "uint64" },
    { id: 6, name: "apiProvider", type: "int32" },
    { id: 7, name: "messageId", type: "string" },
  ]);

  // exa.chat_pb.GetChatMessageRequest
  addType(root, "GetChatMessageRequest", [
    { id: 1, name: "metadata", type: "Metadata" },
    { id: 2, name: "prompt", type: "string" },
    { id: 3, name: "chatMessagePrompts", type: "ChatMessagePrompt", repeated: true },
    { id: 5, name: "useInternalChatModel", type: "bool" },
    { id: 7, name: "requestType", type: "ChatMessageRequestType" },
    { id: 8, name: "configuration", type: "CompletionConfiguration" },
    { id: 10, name: "tools", type: "ChatToolDefinition", repeated: true },
    { id: 11, name: "disableParallelToolCalls", type: "bool" },
    { id: 12, name: "toolChoice", type: "ChatToolChoice" },
    { id: 13, name: "systemPromptCacheOptions", type: "PromptCacheOptions" },
    { id: 14, name: "chatModelName", type: "string" },
    { id: 15, name: "trajectoryReference", type: "TrajectoryReference" },
    { id: 16, name: "cascadeId", type: "string" },
    { id: 17, name: "promptId", type: "string" },
    { id: 18, name: "providerSource", type: "int32" },
    { id: 19, name: "language", type: "string" },
    { id: 20, name: "plannerMode", type: "ConversationalPlannerMode" },
    { id: 21, name: "chatModelUid", type: "string" },
    { id: 22, name: "executionId", type: "string" },
    { id: 25, name: "arenaAssignmentJwt", type: "string" },
    { id: 26, name: "modelAssignmentJwt", type: "string" },
  ]);

  // exa.api_server_pb.TrajectoryReference (minimal)
  addType(root, "TrajectoryReference", [
    { id: 1, name: "trajectoryId", type: "string" },
    { id: 2, name: "stepIndex", type: "int32" },
    { id: 3, name: "stepType", type: "int32" },
  ]);

  // exa.api_server_pb.GetChatMessageResponse
  addType(root, "GetChatMessageResponse", [
    { id: 1, name: "messageId", type: "string" },
    { id: 2, name: "timestamp", type: "Timestamp" },
    { id: 3, name: "deltaText", type: "string" },
    { id: 4, name: "deltaTokens", type: "uint32" },
    { id: 5, name: "stopReason", type: "StopReason" },
    { id: 6, name: "deltaToolCalls", type: "ChatToolCall", repeated: true },
    { id: 7, name: "usage", type: "ModelUsageStats" },
    { id: 8, name: "redact", type: "bool" },
    { id: 9, name: "deltaThinking", type: "string" },
    { id: 10, name: "deltaSignature", type: "string" },
    { id: 11, name: "thinkingRedacted", type: "bool" },
    { id: 12, name: "latency", type: "double" },
    { id: 14, name: "creditCost", type: "int32" },
    { id: 15, name: "outputId", type: "string" },
    { id: 17, name: "requestId", type: "string" },
    { id: 18, name: "committedCreditCost", type: "int32" },
    { id: 21, name: "deltaSignatureType", type: "string" },
    { id: 22, name: "committedAcuCost", type: "double" },
    { id: 23, name: "actualModelUid", type: "string" },
    { id: 24, name: "arenaInvocationCapReached", type: "bool" },
    { id: 25, name: "phase", type: "string" },
    { id: 26, name: "committedQuotaCostBasisPoints", type: "int64" },
    { id: 27, name: "committedOverageCostCents", type: "int64" },
  ]);

  // exa.auth_pb.GetUserJwtRequest / Response
  addType(root, "GetUserJwtRequest", [{ id: 1, name: "metadata", type: "Metadata" }]);
  addType(root, "GetUserJwtResponse", [
    { id: 1, name: "userJwt", type: "string" },
    { id: 2, name: "customApiServerUrl", type: "string" },
  ]);

  // exa.api_server_pb.AssignModelRequest / Response
  addType(root, "AssignModelRequest", [
    { id: 1, name: "metadata", type: "Metadata" },
    { id: 2, name: "modelRouterUid", type: "string" },
    { id: 3, name: "cascadeId", type: "string" },
    { id: 5, name: "chatMessagePrompt", type: "ChatMessagePrompt" },
  ]);
  addType(root, "ModelAssignment", [
    { id: 1, name: "assignmentJwt", type: "string" },
    { id: 2, name: "modelUid", type: "string" },
    { id: 3, name: "harnessUids", type: "string", repeated: true },
  ]);
  addType(root, "AssignModelResponse", [{ id: 1, name: "assignment", type: "ModelAssignment" }]);

  // exa.api_server_pb.GetCliModelConfigsRequest / Response
  addType(root, "GetCliModelConfigsRequest", [{ id: 1, name: "metadata", type: "Metadata" }]);
  addType(root, "DefaultOverrideModelConfig", [
    { id: 1, name: "modelOrAliasDeprecated", type: "string" },
    { id: 2, name: "versionId", type: "string" },
    { id: 3, name: "modelUid", type: "string" },
  ]);
  addType(root, "GetCliModelConfigsResponse", [
    { id: 1, name: "clientModelConfigs", type: "ClientModelConfig", repeated: true },
    { id: 3, name: "defaultOverrideModelConfig", type: "DefaultOverrideModelConfig" },
  ]);

  // exa.codeium_common_pb.ModelFeatures
  addType(root, "ModelFeatures", [
    { id: 11, name: "supportsImages", type: "bool" },
    { id: 12, name: "supportsToolCalls", type: "bool" },
    { id: 15, name: "supportsThinking", type: "bool" },
    { id: 21, name: "supportsParallelToolCalls", type: "bool" },
  ]);

  // exa.codeium_common_pb.ModelInfo
  addType(root, "ModelInfo", [
    { id: 1, name: "modelId", type: "int32" },
    { id: 2, name: "isInternal", type: "bool" },
    { id: 4, name: "maxTokens", type: "int32" },
    { id: 6, name: "modelFeatures", type: "ModelFeatures" },
    { id: 8, name: "modelName", type: "string" },
    { id: 13, name: "maxOutputTokens", type: "int32" },
    { id: 17, name: "modelUid", type: "string" },
    { id: 20, name: "harnessUids", type: "string", repeated: true },
    { id: 22, name: "displayOption", type: "int32" },
    { id: 23, name: "modelFamilyUid", type: "string" },
    { id: 25, name: "isModelRouter", type: "bool" },
  ]);

  // exa.codeium_common_pb.ModelDimension
  addType(root, "ModelDimension", [
    { id: 1, name: "label", type: "string" },
    // proto: `float value = 2` — fixed32, not double. A double here shifts
    // every following field and makes the whole catalog undecodable.
    { id: 2, name: "value", type: "float" },
    { id: 3, name: "denominator", type: "string" },
    { id: 4, name: "minRange", type: "float" },
    { id: 5, name: "maxRange", type: "float" },
    { id: 6, name: "kind", type: "ModelDimensionKind" },
    { id: 7, name: "info", type: "string" },
  ]);

  // exa.codeium_common_pb.ModelFamilyMetadata
  addType(root, "ModelFamilyEntryValue", [
    { id: 1, name: "order", type: "int32" },
    { id: 2, name: "name", type: "string" },
  ]);
  addType(root, "ModelFamilyEntry", [
    { id: 1, name: "key", type: "string" },
    { id: 2, name: "value", type: "ModelFamilyEntryValue" },
  ]);
  addType(root, "ModelFamilyMetadata", [
    { id: 1, name: "modelFamilyLabel", type: "string" },
    { id: 2, name: "entries", type: "ModelFamilyEntry", repeated: true },
    { id: 3, name: "isDefaultModelInFamily", type: "bool" },
  ]);

  // exa.codeium_common_pb.ClientModelConfig
  addType(root, "ClientModelConfig", [
    { id: 1, name: "label", type: "string" },
    { id: 3, name: "creditMultiplier", type: "float" },
    { id: 4, name: "disabled", type: "bool" },
    { id: 5, name: "supportsImages", type: "bool" },
    { id: 7, name: "isPremium", type: "bool" },
    { id: 9, name: "isBeta", type: "bool" },
    { id: 11, name: "isRecommended", type: "bool" },
    { id: 12, name: "allowedTiers", type: "int32", repeated: true },
    { id: 13, name: "pricingType", type: "int32" },
    { id: 15, name: "isNew", type: "bool" },
    { id: 18, name: "maxTokens", type: "int32" },
    { id: 20, name: "isCapacityLimited", type: "bool" },
    { id: 21, name: "fastStatus", type: "int32" },
    { id: 22, name: "modelUid", type: "string" },
    { id: 23, name: "modelInfo", type: "ModelInfo" },
    { id: 24, name: "modelCostTier", type: "int32" },
    { id: 27, name: "description", type: "string" },
    { id: 29, name: "smartFriendModelUid", type: "string" },
    { id: 30, name: "modelFamilyMetadata", type: "ModelFamilyMetadata" },
    { id: 31, name: "isDefaultModelInFamily", type: "bool" },
    { id: 32, name: "modelDimensions", type: "ModelDimension", repeated: true },
    { id: 33, name: "disabledReason", type: "string" },
  ]);

  // exa.seat_management_pb.ExchangePKCEAuthorizationCodeRequest / Response
  addType(root, "ExchangePKCEAuthorizationCodeRequest", [
    { id: 1, name: "authorizationCode", type: "string" },
    { id: 2, name: "codeVerifier", type: "string" },
  ]);
  addType(root, "ExchangePKCEAuthorizationCodeResponse", [
    { id: 1, name: "apiKey", type: "string" },
    { id: 2, name: "name", type: "string" },
    { id: 3, name: "apiServerUrl", type: "string" },
    { id: 4, name: "devinWebappHost", type: "string" },
    { id: 5, name: "devinApiUrl", type: "string" },
  ]);

  // exa.seat_management_pb.GetUserStatusRequest / Response
  addType(root, "GetUserStatusRequest", [{ id: 1, name: "metadata", type: "Metadata" }]);

  addType(root, "DevinPlanInfo", [
    { id: 1, name: "canUseCascade", type: "bool" },
    { id: 2, name: "canUseCli", type: "bool" },
    { id: 3, name: "isAdmin", type: "bool" },
    { id: 4, name: "orgId", type: "string" },
    { id: 5, name: "webappHost", type: "string" },
    { id: 7, name: "apiUrl", type: "string" },
    { id: 8, name: "accountDisplayName", type: "string" },
  ]);

  addType(root, "PlanInfo", [
    { id: 1, name: "teamsTier", type: "TeamsTier" },
    { id: 2, name: "planName", type: "string" },
    { id: 12, name: "monthlyPromptCredits", type: "int64" },
    { id: 13, name: "monthlyFlowCredits", type: "int64" },
    { id: 14, name: "monthlyFlexCreditPurchaseAmount", type: "int64" },
    { id: 33, name: "devinInfo", type: "DevinPlanInfo" },
    { id: 34, name: "isDevin", type: "bool" },
    { id: 35, name: "billingStrategy", type: "BillingStrategy" },
    { id: 36, name: "hideDailyQuota", type: "bool" },
    { id: 37, name: "hideWeeklyQuota", type: "bool" },
  ]);

  addType(root, "PlanStatus", [
    { id: 1, name: "planInfo", type: "PlanInfo" },
    { id: 2, name: "planStart", type: "int64" },
    { id: 3, name: "planEnd", type: "int64" },
    { id: 4, name: "availableFlexCredits", type: "int64" },
    { id: 5, name: "usedFlowCredits", type: "int64" },
    { id: 6, name: "usedPromptCredits", type: "int64" },
    { id: 7, name: "usedFlexCredits", type: "int64" },
    { id: 8, name: "availablePromptCredits", type: "int64" },
    { id: 9, name: "availableFlowCredits", type: "int64" },
    { id: 10, name: "topUpStatus", type: "int32" },
    { id: 14, name: "dailyQuotaRemainingPercent", type: "int32" },
    { id: 15, name: "weeklyQuotaRemainingPercent", type: "int32" },
    { id: 16, name: "overageBalanceMicros", type: "int64" },
    { id: 17, name: "dailyQuotaResetAtUnix", type: "int64" },
    { id: 18, name: "weeklyQuotaResetAtUnix", type: "int64" },
  ]);

  addType(root, "UserStatus", [
    { id: 5, name: "teamId", type: "string" },
    { id: 7, name: "email", type: "string" },
    { id: 10, name: "teamsTier", type: "TeamsTier" },
    { id: 13, name: "planStatus", type: "PlanStatus" },
    { id: 36, name: "userId", type: "string" },
  ]);

  addType(root, "GetUserStatusResponse", [
    { id: 1, name: "userStatus", type: "UserStatus" },
    { id: 2, name: "planInfo", type: "PlanInfo" },
  ]);
}

// ── Root ──

export function createDevinRoot(): protobuf.Root {
  const root = new protobuf.Root();
  addDevinEnums(root);
  addDevinTypes(root);
  // resolve forward references (e.g. ChatToolCall used by ChatMessagePrompt before being defined)
  root.resolveAll();
  return root;
}

export const devinRoot = createDevinRoot();

/** Message types used by the adapter, resolved once. */
export const DevinMessageTypes = {
  Metadata: devinRoot.lookupType("Metadata"),
  Timestamp: devinRoot.lookupType("Timestamp"),
  ImageData: devinRoot.lookupType("ImageData"),
  PromptCacheOptions: devinRoot.lookupType("PromptCacheOptions"),
  ChatToolDefinition: devinRoot.lookupType("ChatToolDefinition"),
  ChatToolChoice: devinRoot.lookupType("ChatToolChoice"),
  ChatMessagePrompt: devinRoot.lookupType("ChatMessagePrompt"),
  ChatToolCall: devinRoot.lookupType("ChatToolCall"),
  CompletionConfiguration: devinRoot.lookupType("CompletionConfiguration"),
  ModelUsageStats: devinRoot.lookupType("ModelUsageStats"),
  GetChatMessageRequest: devinRoot.lookupType("GetChatMessageRequest"),
  TrajectoryReference: devinRoot.lookupType("TrajectoryReference"),
  GetChatMessageResponse: devinRoot.lookupType("GetChatMessageResponse"),
  GetUserJwtRequest: devinRoot.lookupType("GetUserJwtRequest"),
  GetUserJwtResponse: devinRoot.lookupType("GetUserJwtResponse"),
  AssignModelRequest: devinRoot.lookupType("AssignModelRequest"),
  ModelAssignment: devinRoot.lookupType("ModelAssignment"),
  AssignModelResponse: devinRoot.lookupType("AssignModelResponse"),
  GetCliModelConfigsRequest: devinRoot.lookupType("GetCliModelConfigsRequest"),
  DefaultOverrideModelConfig: devinRoot.lookupType("DefaultOverrideModelConfig"),
  GetCliModelConfigsResponse: devinRoot.lookupType("GetCliModelConfigsResponse"),
  ModelFeatures: devinRoot.lookupType("ModelFeatures"),
  ModelInfo: devinRoot.lookupType("ModelInfo"),
  ModelDimension: devinRoot.lookupType("ModelDimension"),
  ModelFamilyEntryValue: devinRoot.lookupType("ModelFamilyEntryValue"),
  ModelFamilyEntry: devinRoot.lookupType("ModelFamilyEntry"),
  ModelFamilyMetadata: devinRoot.lookupType("ModelFamilyMetadata"),
  ClientModelConfig: devinRoot.lookupType("ClientModelConfig"),
  ExchangePKCEAuthorizationCodeRequest: devinRoot.lookupType("ExchangePKCEAuthorizationCodeRequest"),
  ExchangePKCEAuthorizationCodeResponse: devinRoot.lookupType("ExchangePKCEAuthorizationCodeResponse"),
  GetUserStatusRequest: devinRoot.lookupType("GetUserStatusRequest"),
  DevinPlanInfo: devinRoot.lookupType("DevinPlanInfo"),
  PlanInfo: devinRoot.lookupType("PlanInfo"),
  PlanStatus: devinRoot.lookupType("PlanStatus"),
  UserStatus: devinRoot.lookupType("UserStatus"),
  GetUserStatusResponse: devinRoot.lookupType("GetUserStatusResponse"),
} as const;

/** Enum values mirrored for runtime use. */
export const DevinEnums = {
  ChatMessageSource: devinRoot.lookupEnum("ChatMessageSource").values as Record<string, number>,
  ChatMessageRequestType: devinRoot.lookupEnum("ChatMessageRequestType").values as Record<string, number>,
  ConversationalPlannerMode: devinRoot.lookupEnum("ConversationalPlannerMode").values as Record<string, number>,
  StopReason: devinRoot.lookupEnum("StopReason").values as Record<string, number>,
  CacheControlType: devinRoot.lookupEnum("CacheControlType").values as Record<string, number>,
  DisplayOption: devinRoot.lookupEnum("DisplayOption").values as Record<string, number>,
  ModelDimensionKind: devinRoot.lookupEnum("ModelDimensionKind").values as Record<string, number>,
  BillingStrategy: devinRoot.lookupEnum("BillingStrategy").values as Record<string, number>,
  TeamsTier: devinRoot.lookupEnum("TeamsTier").values as Record<string, number>,
} as const;

/** Wire-string helpers. */
export function fromEnum(
  values: Record<string, number>,
  value: number | undefined | null,
): string {
  if (value === undefined || value === null) return "UNSPECIFIED";
  for (const [name, v] of Object.entries(values)) {
    if (v === value) return name;
  }
  return String(value);
}
