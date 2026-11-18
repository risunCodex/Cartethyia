// Perch plan selection.
//
// New Perch accounts have no plan until one is chosen; the hosted API answers
// model calls with "Pick a plan to start using Perch" until then. The official
// CLI resolves this through `GET/POST /api/perch-terminal/cli-plan` — the GET
// reports `planRequired` plus the current `starter.noticeVersion`, and the
// POST `{plan:"starter", noticeVersion}` selects the free Starter plan
// (programmatic path, no checkout page; verified live 2026-11-08, see
// `documentation/research/perch/README.md`).
//
// `ensurePerchStarterPlan` is idempotent and best-effort: it is called after
// OAuth exchange (so a fresh login lands on Starter immediately) and lazily
// from dispatch when the account session reports no plan. It never throws —
// a failed selection leaves the account exactly as unplanned as before, and
// the model-call error remains the surface that reports it.

import { PERCH_APP_URL } from "./perch-realm";
import type { OutboundFetch } from "../../provider-contracts";

/** Fallback notice version when the GET response omits it (captured 2026-11-08). */
const PERCH_STARTER_NOTICE_VERSION_FALLBACK = "2026-09-13";

const PERCH_CLI_PLAN_PATH = "/api/perch-terminal/cli-plan";

function perchPlanHeaders(access: string): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    accept: "application/json",
  };
}

/**
 * Ensures the account sits on the free Starter plan. Returns `true` when a
 * selection was posted, `false` when the account already had a plan or the
 * endpoints were unreachable/malformed. Never throws.
 */
export async function ensurePerchStarterPlan(
  access: string,
  fetchFn: OutboundFetch,
): Promise<boolean> {
  try {
    const statusRes = await fetchFn(`${PERCH_APP_URL}${PERCH_CLI_PLAN_PATH}`, {
      headers: perchPlanHeaders(access),
      signal: AbortSignal.timeout(15_000),
    });
    if (!statusRes.ok) return false;
    const status = (await statusRes.json().catch(() => null)) as {
      planRequired?: unknown;
      starter?: { noticeVersion?: unknown };
    } | null;
    if (!status || status.planRequired !== true) return false;
    const noticeVersion =
      typeof status.starter?.noticeVersion === "string" && status.starter.noticeVersion.length > 0
        ? status.starter.noticeVersion
        : PERCH_STARTER_NOTICE_VERSION_FALLBACK;
    const selectRes = await fetchFn(`${PERCH_APP_URL}${PERCH_CLI_PLAN_PATH}`, {
      method: "POST",
      headers: { ...perchPlanHeaders(access), "content-type": "application/json" },
      body: JSON.stringify({ plan: "starter", noticeVersion }),
      signal: AbortSignal.timeout(15_000),
    });
    return selectRes.ok;
  } catch {
    return false;
  }
}
