import { type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import { Inline } from "../../../components/ui/inline";
import { activeModelCooldowns } from "../../../components/AccountCooldown";
import { formatResetDistance } from "../../../lib/format/quota";
import {
  accountErrorLabel,
  authInvalidatedLabel,
  showsErrorPill,
  validationTargetUrl,
} from "../../../lib/format/labels";
import type { ProviderAccountResponse } from "../../../data/contracts";

/**
 * The per-model backoff chip, shared by every status arm of the badge.
 *
 * A model-scoped throttle excludes only the (account, model) pair in the
 * routing catalog, so it is independent of the account-wide status: it can be
 * in force while the account reads `active`, `cooldown`, or `disabled`, so it
 * is shared by every arm — including `disabled`, where it is the operator's
 * last known health of the account.
 */
function ModelCooldownChip({
  cooldowns,
  reason,
}: {
  readonly cooldowns: { count: number; modelId: string; until: string } | undefined;
  readonly reason?: string;
}): ReactNode {
  if (!cooldowns) return null;
  const distance = formatResetDistance(cooldowns.until);
  const soonest = `Soonest: ${cooldowns.modelId} — ${distance}`;
  return (
    <Badge tone="warn" dot title={reason ? `${reason} — ${soonest}` : soonest}>
      {cooldowns.count} model{cooldowns.count === 1 ? "" : "s"} cooling · {distance}
    </Badge>
  );
}

function credentialFamily(account: ProviderAccountResponse): string | undefined {
  if (account.credentialKind === "oauth") return "OAuth";
  if (account.credentialMode === "jwt") return "JWT";
  return undefined;
}

/**
 * The error pill for an account. For `validation_required` the pill becomes a
 * real link to the upstream verification URL (external icon included), because
 * the only remediation is the operator clicking through and verifying the
 * account.
 */
function renderErrorPill(account: ProviderAccountResponse): ReactNode {
  if (!showsErrorPill(account.lastErrorCategory)) return null;
  if (account.lastErrorCategory === "quota_exhausted" && activeModelCooldowns(account)) return null;
  const label = accountErrorLabel(account.lastErrorCategory, account.credentialKind, account.providerId);
  const title = account.lastError ?? account.lastErrorCategory;
  // A Copilot license refusal gets its own tone + a tooltip that says the
  // remedy: the account is parked because the upstream reports no Copilot
  // access, and the fix is a plan/seat change, not a re-login.
  if (account.lastErrorCategory === "policy_blocked_banned" && account.providerId === "github") {
    return (
      <Badge tone="err" dot title={title}>
        {label}
      </Badge>
    );
  }
  if (account.lastErrorCategory === "validation_required") {
    const url = validationTargetUrl(account.lastError);
    if (url !== undefined) {
      return (
        <a href={url} target="_blank" rel="noreferrer noopener" title={title}>
          <Badge tone="warn">
            {label}
            <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
          </Badge>
        </a>
      );
    }
  }
  return <Badge tone="warn" title={title}>{label}</Badge>;
}

function activeCredentialTone(account: ProviderAccountResponse): "blue" | "ok" {
  return account.credentialKind === "oauth" ? "blue" : "ok";
}

/**
 * Provider-scoped rate-limit badge for pool-as-account rows. A pool can read
 * `active` (the egress is reachable) while the upstream is still refusing it
 * for one provider — the marker lives on the pool row, not in the account's
 * own status. Without this a spent OpenCode free-tier egress looked identical
 * to a healthy one.
 */
function PoolProviderCooldownBadge({
  account,
}: {
  readonly account: ProviderAccountResponse;
}): ReactNode {
  const markers = account.providerCooldowns;
  if (!markers || markers.length === 0) return null;
  const now = Date.now();
  const active = markers.filter((marker) => new Date(marker.until).getTime() > now);
  if (active.length === 0) return null;
  const blocked = active.some((marker) => marker.blocked);
  const soonest = active.reduce((min, marker) => {
    const at = new Date(marker.until).getTime();
    return at < min ? at : min;
  }, Infinity);
  const title = active
    .map((marker) => `${marker.providerId}: ${marker.reason}${marker.blocked ? " (blocked)" : ""}`)
    .join(" · ");
  return (
    <Badge tone="warn" title={`${title} — resets ${formatResetDistance(new Date(soonest).toISOString())}`}>
      {blocked ? "Egress blocked" : "Rate-limited"}
    </Badge>
  );
}

export function AccountStatusBadge({
  account,
}: {
  readonly account: ProviderAccountResponse;
}): ReactNode {
  const cooldownUntilMs = account.cooldownUntil ? new Date(account.cooldownUntil).getTime() : NaN;
  const hasActiveCooldown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > Date.now();
  const modelCooldowns = activeModelCooldowns(account);
  // `disabled` is the terminal state, so it is checked first: a disabled row
  // can still carry a stale `cooldownUntil`, and showing "Cooldown" there hid
  // the fact that the account is actually parked. The category/reason are
  // surfaced too, so a disabled account is as diagnosable as a cooldown.
  if (account.status === "disabled") {
    // A rejected credential is not a cooldown: it cannot clear on its own, so
    // the row says what the operator must actually do. The raw category is kept
    // in the tooltip so the reason is still inspectable.
    const family = credentialFamily(account);
    const revoked = account.lastErrorCategory === "auth_invalidated";
    return (
      <Inline gap="4px">
        <Badge tone="disabled" dot title={account.lastError}>
          Disabled{family ? ` - ${family}` : ""}
        </Badge>
        {revoked ? (
          <Badge tone="warn" title={account.lastError}>
            {authInvalidatedLabel(account.credentialKind)}
          </Badge>
        ) : renderErrorPill(account)}
        <ModelCooldownChip cooldowns={modelCooldowns} reason={account.lastErrorCategory === "quota_exhausted" ? account.lastError : undefined} />
      </Inline>
    );
  }
  if (account.status === "active") {
    // An account can be `active` and still have per-model backoffs: the router
    // skips those (account, model) pairs while the account stays usable for
    // every other model. Showing a bare "Active" hid that entirely.
    //
    // The badge stays "Active" even for a static token. Static is a property
    // of the credential, shown in the chip beside this badge, not a status.
    return (
      <Inline gap="4px">
        <Badge tone={activeCredentialTone(account)} dot>
          Active{credentialFamily(account) ? ` - ${credentialFamily(account)}` : ""}
        </Badge>
        <PoolProviderCooldownBadge account={account} />
        {renderErrorPill(account)}
        <ModelCooldownChip cooldowns={modelCooldowns} reason={account.lastErrorCategory === "quota_exhausted" ? account.lastError : undefined} />
      </Inline>
    );
  }
  if (account.status === "cooldown" || hasActiveCooldown)
    return (
      <Inline gap="4px">
        <Badge tone="warn" dot>
          Cooldown{credentialFamily(account) ? ` - ${credentialFamily(account)}` : ""}{" "}
          {account.cooldownUntil ? `(${formatResetDistance(account.cooldownUntil)})` : ""}
        </Badge>
        <PoolProviderCooldownBadge account={account} />
        {renderErrorPill(account)}
        <ModelCooldownChip cooldowns={modelCooldowns} reason={account.lastErrorCategory === "quota_exhausted" ? account.lastError : undefined} />
      </Inline>
    );
  return <Badge tone="disabled">Disabled</Badge>;
}
