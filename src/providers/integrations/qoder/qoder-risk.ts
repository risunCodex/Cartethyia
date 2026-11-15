/**
 * Qoder risk telemetry and per-account dispatch spacing.
 *
 * Two signals the donor hub's wire audits pinned down (its issues #10/#56/
 * #158) and its docs encode as the playbook:
 *
 *  - **The queue envelope has two meanings.** A `p3` capacity queue admits
 *    within the stated interval; a sustained `p4` + `RESOURCE_LIMIT` pin
 *    across accounts/realm/models with healthy quota is an egress/machine
 *    risk signal. `10605` alone conflates them, so this module tracks a
 *    streak per provider and warns ONCE when it crosses the threshold —
 *    an operator should hear "your egress may be flagged" once, not every
 *    minute.
 *  - **Request cadence is itself a scored dimension.** The hub added a
 *    per-account concurrency-1 + ≥400ms spacing gate (its PR #78) after
 *    upstream confirmed "calling protection". We keep the gateway's
 *    fail-fast queue handling but space same-account dispatches by a
 *    configurable minimum gap.
 */

import { resolveQoderMinGapMs, resolveQoderP4WarnStreak } from "../../../config/runtime";
import { log } from "../../../observability/logger";

export interface QoderRiskSnapshot {
  readonly queueTotal: number;
  /** Consecutive queued envelopes whose `queueType` is `p4`. */
  readonly p4Streak: number;
  /** Last queued `queueType`, when the envelope stated one. */
  readonly lastQueueType?: string;
  readonly lastQueueAt: number;
}

const counters = new Map<string, { queueTotal: number; p4Streak: number; lastQueueType?: string; lastQueueAt: number; }>();

function bucket(providerId: string): { queueTotal: number; p4Streak: number; lastQueueType?: string; lastQueueAt: number; } {
  let entry = counters.get(providerId);
  if (entry === undefined) {
    entry = { queueTotal: 0, p4Streak: 0, lastQueueAt: 0 };
    counters.set(providerId, entry);
  }
  return entry;
}

function p4WarnStreak(): number {
  return resolveQoderP4WarnStreak();
}

/** Records one queued envelope; warns once per streak when it looks like a risk pin. */
export function noteQoderQueue(providerId: string, queueType: string | undefined): QoderRiskSnapshot {
  const entry = bucket(providerId);
  entry.queueTotal += 1;
  entry.lastQueueAt = Date.now();
  if (queueType !== undefined && queueType.length > 0) entry.lastQueueType = queueType;
  if (queueType === "p4") entry.p4Streak += 1;
  else entry.p4Streak = 0;
  const threshold = p4WarnStreak();
  // Re-alarm on every threshold multiple: a sustained pin must keep
  // surfacing (5, 10, …) without becoming one line per request.
  if (entry.p4Streak > 0 && entry.p4Streak % threshold === 0) {
    warnCount += 1;
    // One line per streak escalation, not one per request: the pin is
    // machine+egress scoped, so per-account noise buries the signal.
    log.warn(
      `[qoder] ${providerId}: ${entry.p4Streak} consecutive queueType=p4 envelopes — this is an egress/machine risk pin (quota reads healthy upstream), not a capacity queue`,
    );
  }
  return snapshotOf(entry);
}

/** Records a clean (non-queued) dispatch, resetting the p4 streak. */
export function noteQoderDispatchOk(providerId: string): QoderRiskSnapshot {
  const entry = bucket(providerId);
  entry.p4Streak = 0;
  return snapshotOf(entry);
}

function snapshotOf(entry: { queueTotal: number; p4Streak: number; lastQueueType?: string; lastQueueAt: number }): QoderRiskSnapshot {
  return {
    queueTotal: entry.queueTotal,
    p4Streak: entry.p4Streak,
    ...(entry.lastQueueType !== undefined ? { lastQueueType: entry.lastQueueType } : {}),
    lastQueueAt: entry.lastQueueAt,
  };
}

/** Read-only snapshot for console/telemetry surfaces. */
export function qoderRiskSnapshot(providerId: string): QoderRiskSnapshot {
  const entry = counters.get(providerId);
  if (entry === undefined) return { queueTotal: 0, p4Streak: 0, lastQueueAt: 0 };
  return snapshotOf(entry);
}

// ── Per-account dispatch spacing ───────────────────────────────────────────

const lastDispatchAt = new Map<string, number>();
let spacingTail: Promise<unknown> = Promise.resolve();

/** Minimum gap between dispatches of one account (ms), env-configurable. */
export function qoderMinGapMs(): number {
  return resolveQoderMinGapMs();
}

/**
 * Serializes and spaces same-account dispatches: the next dispatch for an
 * account starts at least `qoderMinGapMs()` after the previous one *started*
 * (the hub's PR #78 gates on gaps between request starts — a long stream must
 * not delay its own account's next turn beyond the gap).
 *
 * Keyed per provider+account so qoder and qodercn spaces are independent.
 */
export async function qoderAccountGate(providerId: string, accountId: string): Promise<void> {
  const key = `${providerId}:${accountId || "anonymous"}`;
  const gap = qoderMinGapMs();
  const previous = spacingTail;
  let release!: () => void;
  spacingTail = new Promise<void>((resolve) => {
    release = (): void => resolve();
  });
  try {
    await previous;
    const now = Date.now();
    const last = lastDispatchAt.get(key) ?? 0;
    const wait = last + gap - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastDispatchAt.set(key, Date.now());
  } finally {
    release();
  }
}

/** Test hook: clears counters and spacing state. */
export function _resetQoderRisk(): void {
  counters.clear();
  lastDispatchAt.clear();
  spacingTail = Promise.resolve();
  warnCount = 0;
}

/** Test hook: how many p4-streak warnings have been emitted. */
export let warnCount = 0;
