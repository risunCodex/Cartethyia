// Facade over the buddy account module. The implementation lives in four
// domain siblings — OAuth device flow (`buddy-account-oauth.ts`), Tencent
// billing quota (`buddy-account-quota.ts`), paged request-usage fetch
// (`buddy-account-usage.ts`), and the usage snapshot store
// (`buddy-account-usage-store.ts`). This barrel keeps the public surface of
// the original single file: every export, class surface, and behavior is
// unchanged. Importers keep importing from "…/buddy/account".

export {
  BuddyOAuthClient,
  buddyAccountUid,
  buddyAccountUidFromClaims,
  buddyResponseData,
  parseBuddyTokenData,
  strictResponseCode,
} from "./buddy-account-oauth";
export type {
  BuddyOAuthVariant,
  BuddyTokenData,
} from "./buddy-account-oauth";

export {
  billingNum,
  fetchTencentBillingQuota,
  parseBillingResetTime,
  resolveBearerToken,
} from "./buddy-account-quota";
export type {
  TencentBillingAccount,
  TencentBillingFetchOptions,
} from "./buddy-account-quota";

export {
  fetchBuddyRequestUsage,
} from "./buddy-account-usage";
export type {
  BuddyUsageFetchOptions,
  BuddyUsageResult,
  BuddyUsageRow,
} from "./buddy-account-usage";

export {
  pruneBuddyUsageSnapshots,
  readBuddyUsageSnapshots,
  saveBuddyUsageSnapshots,
} from "./buddy-account-usage-store";
export type {
  BuddyUsageSnapshotRow,
} from "./buddy-account-usage-store";
