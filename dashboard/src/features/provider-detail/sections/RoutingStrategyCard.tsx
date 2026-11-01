import { Cable, Fingerprint, Gauge, Info, Layers, Minus, Plus, Repeat, Shuffle, Waypoints } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Dialog } from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { Inline } from "../../../components/ui/inline";
import { ListRow } from "../../../components/ui/list-row";
import { Select } from "../../../components/ui/select";
import { ErrorState, LoadingState } from "../../../components/ui/state";
import { Switch } from "../../../components/ui/switch";
import { toast } from "../../../lib/toast";
import { DASHBOARD_VERSION } from "../../../lib/version";
import {
  PROXY_SKIP_HINT_PROVIDERS,
  ROUTING_ACTIVE_LABEL,
  useRoutingStrategy,
} from "../../../hooks/routing-strategy";
import { usePoolStrategy, useUpdatePoolStrategy } from "../../../hooks/network";
import type { PoolStrategySetting } from "../../../data/contracts";

/** Pool selection modes, mirroring POOL_ROUTING_STRATEGIES on the backend. */
const POOL_STRATEGY_OPTIONS: readonly { value: PoolStrategySetting["strategy"]; label: string }[] = [
  { value: "least_loaded", label: "Least loaded" },
  { value: "round_robin", label: "Round robin" },
  { value: "random", label: "Random" },
];

/** The slider's own scale: 1–50, with one step past the end meaning unlimited. */
const SLIDER_MAX = 50;
/** A typed number may go past the slider, but not past this. */
const MANUAL_MAX = 100;
function userAgentPresets(cartethyiaVersion: string, codexVersion: string, claudeVersion: string) {
  return [
    { value: "", label: "None" },
    { value: `Cartethyia/${cartethyiaVersion}`, label: `Cartethyia ${cartethyiaVersion}` },
    { value: `codex_cli_rs/${codexVersion}`, label: "Codex" },
    { value: `claude-cli/${claudeVersion} (external, cli)`, label: "Claude Code" },
  ] as const;
}

/** Shared shell for the grouped settings rows. */
function Row({ children, action }: { readonly children: ReactNode; readonly action: ReactNode }): ReactNode {
  return <ListRow actions={action}>{children}</ListRow>;
}

export function RoutingStrategyCard({
  providerId,
  clientVersion,
  routeIdentityVersions,
  userAgentEditable,
}: {
  readonly providerId: string;
  /** The provider's own discovered client, shown when its identity is fixed. */
  readonly clientVersion?: { readonly client: string; readonly version: string };
  readonly routeIdentityVersions: { readonly codex: string; readonly claude: string };
  /** False when the provider stamps its own identity, so the shown value cannot be changed. */
  readonly userAgentEditable: boolean;
}): ReactNode {
  const routing = useRoutingStrategy(providerId, userAgentEditable);
  const poolStrategyQuery = usePoolStrategy();
  const updatePoolStrategy = useUpdatePoolStrategy();
  const [limitsHelpOpen, setLimitsHelpOpen] = useState(false);
  const [poolHelpOpen, setPoolHelpOpen] = useState(false);
  const showUnsupportedHint = PROXY_SKIP_HINT_PROVIDERS.has(providerId);
  const presets = userAgentPresets(
    DASHBOARD_VERSION,
    routeIdentityVersions.codex,
    routeIdentityVersions.claude,
  );
  const userAgentOptions = presets.some((option) => option.value === routing.userAgent)
    ? presets
    : [...presets, { value: routing.userAgent, label: "Custom" }];

  if (routing.isLoading) return <LoadingState label="Loading routing..." />;
  if (routing.isError)
    return <ErrorState message="Failed to load routing" onRetry={routing.refetch} />;

  const activeLabel = routing.roundRobinEnabled
    ? `${ROUTING_ACTIVE_LABEL.roundRobin} · ${routing.rotateCount} account${routing.rotateCount === 1 ? "" : "s"} per rotation`
    : ROUTING_ACTIVE_LABEL.fallback;
  const poolStrategy = poolStrategyQuery.data;
  const poolStrategyOption = POOL_STRATEGY_OPTIONS.find(
    (option) => option.value === poolStrategy?.strategy,
  );
  const poolModeLabel =
    poolStrategy === undefined
      ? "…"
      : routing.skipProxy
        ? "Direct — proxy pools bypassed"
        : poolStrategyOption
          ? poolStrategy.strategy === "round_robin"
            ? `${poolStrategyOption.label} · ${poolStrategy.rotateCount} per rotation`
            : poolStrategyOption.label
          : "Unset";
  const subtitle = routing.isSaving
    ? "Saving..."
    : routing.saveFailed
      ? "Save failed — reverted to last saved value"
      : "Per-account and per-pool routing";
  // The slider stops at 50; one step further is unlimited. A typed value above
  // 50 still shows, parked at the end with its real number beside it.
  const unlimited = routing.maxInflight === null;
  const sliderValue = unlimited ? SLIDER_MAX + 1 : Math.min(SLIDER_MAX + 1, Math.max(1, routing.maxInflight));
  const shownValue = unlimited ? "∞" : String(routing.maxInflight);
  const proxyUnlimited = routing.maxInflightPerProxy === null;
  const proxySliderValue = proxyUnlimited
    ? SLIDER_MAX + 1
    : Math.min(SLIDER_MAX + 1, Math.max(1, routing.maxInflightPerProxy));
  const proxyShownValue = proxyUnlimited ? "∞" : String(routing.maxInflightPerProxy);
  // Always direct never dials a pool, so the ceiling has nothing to bound. The
  // stored value is kept, not cleared: turning Always direct back off restores
  // the operator's limit instead of silently resetting it to unlimited.
  const proxyLimitInactive = routing.skipProxy;
  const adjustRotateCount = (delta: number) => {
    routing.setRotateCount(Math.min(1000, Math.max(1, routing.rotateCount + delta)));
  };
  const handleUserAgentChange = (next: string) => {
    if (next === routing.userAgent) return;
    routing.setUserAgent(next);
    const label = userAgentOptions.find((option) => option.value === next)?.label ?? next;
    toast.success("Client identity updated", label);
  };

  const handlePoolStrategyChange = (next: string) => {
    if (next === poolStrategy?.strategy) return;
    updatePoolStrategy.mutate({ strategy: next as PoolStrategySetting["strategy"] });
  };
  const adjustPoolRotateCount = (delta: number) => {
    if (!poolStrategy) return;
    updatePoolStrategy.mutate({
      rotateCount: Math.min(1000, Math.max(1, poolStrategy.rotateCount + delta)),
    });
  };

  // The provider's own discovered client, shown verbatim when its identity is
  // fixed — the same string the editable path lists as a preset.
  const fixedIdentity = clientVersion
    ? `${clientVersion.client} ${clientVersion.version}`
    : "Provider default";

  return (
    <Card>
      <CardHeader title="Routing Strategy" subtitle={subtitle} icon={<Layers size={16} />} />
      <CardBody>
        <div className="grid gap-5 w-full min-w-0">
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-4 border-b border-inner-border pb-3">
              <span className="text-micro font-bold uppercase tracking-label text-text-tertiary">
                Provider accounts
              </span>
              <span className="inline-flex items-center gap-2 text-badge text-text-secondary">
                <span
                  className={`status-indicator-dot${routing.roundRobinEnabled ? " bg-accent" : " bg-text-tertiary"}`}
                  aria-hidden="true"
                />
                {activeLabel}
              </span>
            </div>

            <Row
              action={
                <>
                  {routing.roundRobinEnabled ? (
                    <div
                      role="group"
                      aria-label="Accounts per rotation"
                      className="inline-flex items-center gap-1 rounded-control border border-inner-border bg-surface-1 p-1"
                    >
                      <span className="px-2 text-badge text-text-secondary">Accounts/rotation</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 rounded-tiny"
                        aria-label="Decrease accounts per rotation"
                        disabled={routing.rotateCount <= 1}
                        icon={<Minus size={14} />}
                        onClick={() => adjustRotateCount(-1)}
                      />
                      <output
                        className="min-w-8 text-center text-body font-semibold tabular-nums"
                        aria-live="polite"
                      >
                        {routing.rotateCount}
                      </output>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 rounded-tiny"
                        aria-label="Increase accounts per rotation"
                        disabled={routing.rotateCount >= 1000}
                        icon={<Plus size={14} />}
                        onClick={() => adjustRotateCount(1)}
                      />
                    </div>
                  ) : null}
                  <Switch
                    checked={routing.roundRobinEnabled}
                    onChange={routing.setRoundRobinEnabled}
                    id="routing-round-robin"
                  />
                </>
              }
            >
              <div className="min-w-0">
                <label htmlFor="routing-round-robin">
                  <Inline gap="6px" className="text-body font-semibold">
                    <Repeat
                      size={15}
                      aria-hidden="true"
                      className={`shrink-0 ${routing.roundRobinEnabled ? "text-accent" : "text-text-tertiary"}`}
                    />
                    Rotate accounts
                  </Inline>
                </label>
                <div className="mt-1 text-badge text-text-tertiary">
                  Off uses priority order with failover. On rotates requests across this provider's
                  accounts.
                </div>
              </div>
            </Row>

            <Row
              action={
                <Switch
                  checked={routing.skipProxy}
                  onChange={routing.setSkipProxy}
                  id="routing-skip-proxy"
                />
              }
            >
              <div className="min-w-0">
                <label htmlFor="routing-skip-proxy">
                  <Inline gap="6px" className="text-body font-semibold">
                    <Cable
                      size={15}
                      aria-hidden="true"
                      className={`shrink-0 ${routing.skipProxy ? "text-accent" : "text-text-tertiary"}`}
                    />
                    Always direct
                  </Inline>
                </label>
                <div className="mt-1 text-badge text-text-tertiary">
                  Bypass automatic proxy-pool routing for this provider and always dial direct
                </div>
              </div>
            </Row>
          </div>

          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-4 border-b border-inner-border pb-3">
              <span className="text-micro font-bold uppercase tracking-label text-text-tertiary">
                Proxy pools
              </span>
              <span className="inline-flex items-center gap-2 text-badge text-text-secondary">
                <span
                  className={`status-indicator-dot${routing.skipProxy ? " bg-text-tertiary" : " bg-accent"}`}
                  aria-hidden="true"
                />
                {poolModeLabel}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 -my-1"
                aria-label="How pool routing works"
                onClick={() => setPoolHelpOpen(true)}
              >
                How it works
              </Button>
            </div>

            <Row
              action={
                <Inline gap="8px" align="center">
                  {poolStrategy?.strategy === "round_robin" && !routing.skipProxy ? (
                    <div
                      role="group"
                      aria-label="Pools per rotation"
                      className="inline-flex items-center gap-1 rounded-control border border-inner-border bg-surface-1 p-1"
                    >
                      <span className="px-2 text-badge text-text-secondary">Pools/rotation</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 rounded-tiny"
                        aria-label="Decrease pools per rotation"
                        disabled={updatePoolStrategy.isPending || poolStrategy.rotateCount <= 1}
                        icon={<Minus size={14} />}
                        onClick={() => adjustPoolRotateCount(-1)}
                      />
                      <output
                        className="min-w-8 text-center text-body font-semibold tabular-nums"
                        aria-live="polite"
                      >
                        {poolStrategy.rotateCount}
                      </output>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 rounded-tiny"
                        aria-label="Increase pools per rotation"
                        disabled={updatePoolStrategy.isPending || poolStrategy.rotateCount >= 1000}
                        icon={<Plus size={14} />}
                        onClick={() => adjustPoolRotateCount(1)}
                      />
                    </div>
                  ) : null}
                  <Select
                    id="routing-pool-strategy"
                    aria-label="Pool selection mode"
                    value={poolStrategy?.strategy ?? ""}
                    disabled={routing.skipProxy || updatePoolStrategy.isPending}
                    options={POOL_STRATEGY_OPTIONS}
                    onValueChange={handlePoolStrategyChange}
                  />
                </Inline>
              }
            >
              <div className="min-w-0">
                <label htmlFor="routing-pool-strategy">
                  <Inline gap="6px" className="text-body font-semibold">
                    <Shuffle
                      size={15}
                      aria-hidden="true"
                      className={`shrink-0 ${routing.skipProxy ? "text-text-tertiary" : "text-accent"}`}
                    />
                    Pool mode
                  </Inline>
                </label>
                <div className="mt-1 text-badge text-text-tertiary">
                  How proxy pools are chosen when this provider dials one.
                  {routing.skipProxy ? " Disabled while “Always direct” is on." : ""}
                </div>
              </div>
            </Row>
          </div>

          {/* Keep these paired controls balanced, filling the row on wide cards
              and stacking when the card cannot fit two readable tracks. */}
          <div className="routing-controls-grid grid gap-5 min-w-0 w-full">
            <div
              className="px-6 py-5 rounded-control border border-inner-border bg-surface-2 min-w-0"
            >
              <Inline gap="6px" className="text-body font-semibold mb-3">
                <Fingerprint
                  size={15}
                  aria-hidden="true"
                  className="text-text-tertiary shrink-0"
                />
                Client identity
              </Inline>
              {userAgentEditable ? (
                <Select
                  id="routing-user-agent-preset"
                  aria-label="Client identity"
                  value={routing.userAgent}
                  options={userAgentOptions}
                  onValueChange={handleUserAgentChange}
                />
              ) : (
                // A real disabled `Select`, not a hand-built trigger. The fake one
                // carried the `radix-select-trigger` marker with none of the
                // utilities the real trigger owns, so the value and its chevron
                // stacked as loose text instead of reading as a control.
                <Select
                  id="routing-user-agent-fixed"
                  aria-label="Client identity"
                  disabled
                  value={fixedIdentity}
                  options={[{ value: fixedIdentity, label: fixedIdentity }]}
                />
              )}
              <div className="text-badge text-text-tertiary mt-2">
                {userAgentEditable
                  ? "None sends the request as-is — whatever the runtime or egress sets, with no identity stamped by the gateway. A chosen value overrides it."
                  : "Set by the provider. It cannot be changed."}
              </div>
            </div>

            <div
              className="px-6 py-5 rounded-control border border-inner-border bg-surface-2 min-w-0"
            >
              <label htmlFor="routing-max-inflight" className="form-label">
                <Inline gap="6px" className="text-body font-semibold">
                  <Gauge
                    size={15}
                    aria-hidden="true"
                    className="text-text-tertiary shrink-0"
                  />
                  Max inflight / account
                </Inline>
              </label>
              <div className="text-badge text-text-tertiary mb-3">
                Per-account ceiling, not a provider-wide one: each account
                enforces its own limit, so a full account spills to the next.
                One step past {SLIDER_MAX} is unlimited.
              </div>
              <Inline gap="10px" className="mt-3">
                <input
                  id="routing-max-inflight"
                  type="range"
                  className="routing-slider flex-1 min-w-0"
                  data-unlimited={unlimited ? "true" : undefined}
                  min={1}
                  max={SLIDER_MAX + 1}
                  step={1}
                  value={sliderValue}
                  aria-valuetext={unlimited ? "Unlimited" : String(routing.maxInflight)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    routing.setMaxInflight(value > SLIDER_MAX ? null : Math.round(value));
                  }}
                  style={{ ["--slider-pct" as string]: `${(sliderValue / (SLIDER_MAX + 1)) * 100}%` }}
                />
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="Max inflight per account"
                  value={shownValue}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    if (raw === "" || raw === "∞") {
                      routing.setMaxInflight(null);
                      return;
                    }
                    const value = Number(raw);
                    if (Number.isFinite(value) && value >= 1)
                      routing.setMaxInflight(Math.min(MANUAL_MAX, Math.round(value)));
                  }}
                  className={`form-input w-26 shrink-0 px-2 py-3 text-center text-body ${unlimited ? "text-status-success" : ""}`}
                />
              </Inline>
            </div>
          </div>

          <div
            className={`px-6 py-5 rounded-control border border-inner-border bg-surface-2 min-w-0${proxyLimitInactive ? " opacity-60" : ""}`}
          >
            <div className="flex items-start justify-between gap-4">
              <label htmlFor="routing-max-inflight-per-proxy" className="min-w-0">
                <Inline gap="6px" className="text-body font-semibold">
                  <Waypoints
                    size={15}
                    aria-hidden="true"
                    className="text-text-tertiary shrink-0"
                  />
                  Max inflight / proxy
                </Inline>
                <div className="mt-1 text-badge text-text-tertiary">
                  Each proxy pool carries at most this many concurrent requests for this
                  provider. Other providers on the same pool are unaffected.
                </div>
              </label>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                aria-label="How per-proxy limits work"
                onClick={() => setLimitsHelpOpen(true)}
              >
                How it works
              </Button>
            </div>
            <Inline gap="10px" className="mt-3">
              <input
                id="routing-max-inflight-per-proxy"
                type="range"
                className="routing-slider flex-1 min-w-0"
                data-unlimited={proxyUnlimited ? "true" : undefined}
                min={1}
                max={SLIDER_MAX + 1}
                step={1}
                disabled={proxyLimitInactive}
                value={proxySliderValue}
                aria-valuetext={proxyUnlimited ? "Unlimited" : String(routing.maxInflightPerProxy)}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  routing.setMaxInflightPerProxy(value > SLIDER_MAX ? null : Math.round(value));
                }}
                style={{
                  ["--slider-pct" as string]: `${(proxySliderValue / (SLIDER_MAX + 1)) * 100}%`,
                }}
              />
              <input
                type="text"
                inputMode="numeric"
                aria-label="Max inflight per proxy"
                disabled={proxyLimitInactive}
                value={proxyShownValue}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (raw === "" || raw === "∞") {
                    routing.setMaxInflightPerProxy(null);
                    return;
                  }
                  const value = Number(raw);
                  if (Number.isFinite(value) && value >= 1)
                    routing.setMaxInflightPerProxy(Math.min(MANUAL_MAX, Math.round(value)));
                }}
                className={`form-input w-26 shrink-0 px-2 py-3 text-center text-body ${proxyUnlimited ? "text-status-success" : ""}`}
              />
            </Inline>
            <div className="mt-2 text-badge text-text-tertiary">
              {proxyLimitInactive
                ? "Always direct is on, so this provider never dials a pool. The limit is kept for when a pool is used again."
                : `One step past ${SLIDER_MAX} is unlimited.`}
            </div>
          </div>

          <Dialog
            open={limitsHelpOpen}
            onClose={() => setLimitsHelpOpen(false)}
            title="How concurrency limits stack"
            size="md"
          >
            <div className="grid gap-4 text-body">
              <p className="text-text-secondary">
                Three limits apply at once. Each one bounds a different thing; none
                replaces another.
              </p>
              <dl className="grid gap-3">
                <div>
                  <dt className="font-semibold">Max inflight / account</dt>
                  <dd className="text-badge text-text-tertiary">
                    One account of this provider, across every proxy. Set here, above.
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold">Max inflight / proxy</dt>
                  <dd className="text-badge text-text-tertiary">
                    One proxy pool's concurrent requests <em>for this provider</em>. The
                    same number applies to every pool; each pool counts separately. This
                    is the field above.
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold">Pool capacity</dt>
                  <dd className="text-badge text-text-tertiary">
                    Everything through one pool, all providers combined. Set on the proxy
                    itself, on the Proxies page.
                  </dd>
                </div>
              </dl>
              <p className="text-badge text-text-tertiary">
                A request must clear all three. When a pool is full for this provider, the
                request moves to another pool that still has room; it only fails with{" "}
                <code>429</code> when every pool is full.
              </p>
              <p className="text-badge text-text-tertiary">
                Unlimited means no counter is kept for this provider, so the limit costs
                nothing until you set one.
              </p>
            </div>
          </Dialog>
          <Dialog
            open={poolHelpOpen}
            onClose={() => setPoolHelpOpen(false)}
            title="How pool routing works"
            size="md"
          >
            <div className="grid gap-4 text-body">
              <p className="text-text-secondary">
                When a provider dials a proxy pool, the gateway picks the pool
                with one of three modes. All modes skip pools that are cooling
                down, full, or disabled — the pool's own gates always apply.
              </p>
              <dl className="grid gap-3">
                <div>
                  <dt className="font-semibold">Least loaded</dt>
                  <dd className="text-badge text-text-tertiary">
                    Each request goes to the pool with the most headroom
                    (weighted). The default — spreads load and prefers the
                    fastest-available egress.
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold">Round robin</dt>
                  <dd className="text-badge text-text-tertiary">
                    Requests rotate across pools in a fixed order, with a set
                    number of successful requests per pool before moving on.
                    Useful for even request counts across pools.
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold">Random</dt>
                  <dd className="text-badge text-text-tertiary">
                    Each request picks from the eligible pools at random, so a
                    burst does not gang up on the first pools in the order.
                  </dd>
                </div>
              </dl>
              <p className="text-badge text-text-tertiary">
                Turning on “Always direct” bypasses pools entirely — this mode
                has no effect then.
              </p>
            </div>
          </Dialog>
          {showUnsupportedHint && (
            <Inline
              gap="6px"
              align="flex-start"
              className="mt-1 text-badge text-text-tertiary"
            >
              <Info size={12} className="shrink-0 mt-0.5" />
              <span>
                This provider doesn't reliably work through a plain HTTP/S proxy — use a SOCKS5 or
                proxy pool instead if you need to route it.
              </span>
            </Inline>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
