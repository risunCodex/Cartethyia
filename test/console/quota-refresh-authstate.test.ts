/**
 * Auth-state forwarding on the account-quota refresh path (the tenant quota
 * routes built `QuotaRefreshTarget` from the account row but dropped
 * `authState`, so Kiro's profile-scoped usage surface refused the GET with
 * `400 Invalid profileArn.`) is covered by:
 * - `test/providers/kiro-oauth-flow.test.ts` (two-phase + label enrichment);
 * - `test/providers/account-authmethod.test.ts`.
 */
