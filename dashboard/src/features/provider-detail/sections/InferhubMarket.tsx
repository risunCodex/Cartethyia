/**
 * The InferHub market section on the provider detail page.
 *
 * On demand: data is read when the page opens and re-read only when the
 * operator presses Refresh. There is no interval and no background polling —
 * the age of what is on screen is shown so it can never be mistaken for live.
 *
 * Two things here are untrusted remote data and are rendered as text only:
 * `systemPromptNote` (how an upstream rewrites the system prompt) and every
 * label. Neither is ever interpolated into a prompt, a URL, or HTML.
 */
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { ChevronDown, ExternalLink, RefreshCw } from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Banner } from "../../../components/patterns/banner";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { Stack } from "../../../components/ui/stack";
import { cn } from "../../../lib/classnames";
import { consoleRequest } from "../../../data/api";
import { useInferhubSummary } from "../../../hooks/inferhub";
import type { InferhubModel, InferhubSummary } from "../../../data/contracts";

function formatPrice(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  return `${Math.floor(ageSeconds / 3600)}h ago`;
}

/**
 * How the model table is ordered.
 *
 * `availability` first because a cheap model nobody can serve is worse than a
 * slightly dearer one that answers. `sustainable` uses the capacity-weighted
 * price — the cheapest tier with enough providers behind it — since the
 * absolute cheapest ask is usually a single provider.
 */
type SortKey = "provider" | "availability" | "sustainable" | "price" | "discount";

const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  /** A–Z by provider, which is how an operator scans a marketplace roster. */
  provider: "Provider (A–Z)",
  availability: "Highest availability",
  sustainable: "Sustainable price",
  price: "Lowest price",
  discount: "Biggest discount",
};

/** Nulls sort last regardless of direction: unknown is not "best at zero". */
function byNumber(
  value: (model: InferhubModel) => number | null,
  direction: "asc" | "desc",
): (a: InferhubModel, b: InferhubModel) => number {
  return (a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return direction === "asc" ? left - right : right - left;
  };
}

function comparator(key: SortKey): (a: InferhubModel, b: InferhubModel) => number {
  switch (key) {
    case "provider":
      // Family name first, then prefix, so "Antigravity" precedes "Cline" and a
      // tie on name still has a stable order.
      return (a, b) =>
        a.family.localeCompare(b.family, undefined, { sensitivity: "base" }) ||
        a.prefix.localeCompare(b.prefix);
    case "availability":
      return (a, b) =>
        b.providersLive - a.providersLive ||
        byNumber((m) => m.health.successRatePct, "desc")(a, b);
    case "sustainable":
      return byNumber((m) => m.capacityPriceIn, "asc");
    case "price":
      return byNumber((m) => m.minAskIn, "asc");
    case "discount":
      return byNumber((m) => m.tiersIn[0]?.discountPct ?? null, "desc");
  }
}

/** The tone a family state renders as. */
function stateTone(state: string | null): "ok" | "warn" | "err" | "default" {
  if (state === "operational") return "ok";
  if (state === "degraded") return "warn";
  if (state === "major_outage") return "err";
  return "default";
}

/**
 * The upstream family row for a prefix.
 *
 * Family state lives on the family, not on the model: `/status` reports it per
 * prefix, and the per-model `health.familyState` is only populated once health
 * has been merged. Reading the model's own field showed `unknown` for every row
 * even when the family was `operational`.
 */
function familyOf(summary: InferhubSummary, prefix: string) {
  return summary.providers.find((provider) => provider.prefix === prefix);
}

/**
 * Whether a model is worth listing by default.
 *
 * "Unknown" means InferHub's health signals came back null below its volume
 * floors — not that the model is bad. Both are hidden by default because
 * neither can be routed to with confidence, and both stay reachable through
 * "Show all".
 */
function isUsable(model: {
  readonly providersLive: number;
  readonly routable: boolean;
  readonly minAskIn: number | null;
}): boolean {
  return model.providersLive > 0 && model.routable && model.minAskIn !== null;
}

export function InferhubMarket(): ReactNode {
  const query = useInferhubSummary();
  const summary = query.data;
  // Collapsed by default: an operator opening an InferHub page to manage
  // accounts should not be handed a 270-row market table they did not ask for.
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Availability columns are on by default: a price without whether the
  // upstream answers is not a usable signal.
  const [showUpstreams, setShowUpstreams] = useState(true);
  const [sort, setSort] = useState<SortKey>("provider");
  // Collapse-all toggle: flips every provider group shut (or back open). The
  // groups keep their own local open state; this is an operator-wide override.
  const [collapsedAll, setCollapsedAll] = useState(false);

  // Every hook runs before any early return. The memo used to sit below the
  // "no data yet" returns, so a render that had summary ran one more hook than
  // a render that did not — React reads that as a changed hook order and throws
  // "Rendered more hooks than during the previous render".
  const models = summary?.models ?? [];
  const usable = models.filter(isUsable);
  const grouped = useMemo(() => {
    const source = showAll ? models : usable;
    const sorted = [...source].sort(comparator(sort));
    const byPrefix = new Map<string, InferhubModel[]>();
    for (const model of sorted) {
      const bucket = byPrefix.get(model.prefix);
      if (bucket === undefined) byPrefix.set(model.prefix, [model]);
      else bucket.push(model);
    }
    // `provider` sorts by family name so the groups read A–Z; any other sort
    // keeps groups ordered by their best-ranked model.
    return [...byPrefix.entries()].map(([prefix, items]) => ({
      prefix,
      family: items[0]?.family ?? prefix,
      models: items,
    }));
  }, [models, usable, showAll, sort]);

  const refreshButton = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void query.refetch()}
      disabled={query.isFetching}
      title="Re-read InferHub market data now"
    >
      <RefreshCw size={14} />
      {query.isFetching ? "Refreshing…" : "Refresh"}
    </Button>
  );

  // No data and no error yet: nothing has been read.
  if (summary === undefined && !query.isError) {
    return (
      <Card>
        <CardHeader
          title="InferHub market"
          subtitle={query.isPending ? "Reading market data…" : undefined}
          icon={<RefreshCw size={16} />}
        />
        <CardBody>
          {query.isError ? (
            <Banner tone="danger" surface="raised" live="none">InferHub market data could not be read.</Banner>
          ) : null}
        </CardBody>
      </Card>
    );
  }

  if (summary === undefined) {
    return (
      <Card>
        <CardHeader title="InferHub market" icon={<RefreshCw size={16} />} action={refreshButton} />
        <CardBody>
          <Banner tone="danger" surface="raised" live="none">InferHub market data could not be read.</Banner>
        </CardBody>
      </Card>
    );
  }

  const groups = grouped;
  const shownCount = groups.reduce((total, group) => total + group.models.length, 0);
  const hiddenCount = models.length - shownCount;

  return (
    <Card>
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Only the header row toggles. The body is content, not a hit target —
            a card-wide toggle meant clicking a table row or the key field
            collapsed the section. */}
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse InferHub market" : "Expand InferHub market"}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-3 border-0 bg-transparent p-0 text-left text-inherit"
        >
          <ChevronDown
            size={15}
            aria-hidden="true"
            className={cn("shrink-0 transition-transform", !expanded && "-rotate-90")}
          />
          <Stack gap="1px">
            {/* No arbitrary utility: this file has no styling-debt allowance,
                and the ratchet fails a new one. */}
            <h2 className="text-body font-bold">InferHub market</h2>
            {summary.meta.fetchedAt > 0 ? (
              <p className="mt-1 text-badge text-text-tertiary">
                Updated {formatAge(summary.meta.ageSeconds)}
              </p>
            ) : null}
          </Stack>
        </button>
        <div className="flex items-center gap-2">{expanded ? refreshButton : null}</div>
      </div>
      {expanded ? (
        <CardBody>
          <div className="flex flex-col gap-3">
            <InferhubKeyField onSaved={() => void query.refetch()} />

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-caption text-text-secondary">
                Sort
                <Select
                  value={sort}
                  onValueChange={(next) => setSort(next as SortKey)}
                  options={(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
                    value: key,
                    label: SORT_LABELS[key],
                  }))}
                  aria-label="Sort InferHub models"
                />
              </label>
              <label className="flex items-center gap-2 text-caption text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={showUpstreams}
                  onChange={(event) => setShowUpstreams(event.target.checked)}
                  className="cursor-pointer"
                />
                Show availability
              </label>
            </div>
          </div>

          {summary.error === "no_config_key" ? (
          <Banner tone="warning" surface="raised" live="none">
            No InferHub <code>config_read</code> key is configured, so the marketplace catalog
            cannot be read. Add one above.
          </Banner>
        ) : null}
        {summary.error === "upstream_unavailable" ? (
          <Banner tone="warning" surface="raised" live="none">
            InferHub did not answer. Showing the last snapshot that was read
            {summary.meta.fetchedAt > 0 ? ` (${formatAge(summary.meta.ageSeconds)})` : ""}.
          </Banner>
        ) : null}
        {summary.meta.stale && summary.error === null ? (
          <Banner tone="warning" surface="raised" live="none">
            This snapshot is {formatAge(summary.meta.ageSeconds)} — press Refresh for current
            prices.
          </Banner>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <p className="text-micro text-text-tertiary">
            {shownCount} of {models.length} models
          </p>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setCollapsedAll((current) => !current)}
              title={collapsedAll ? "Expand all provider groups" : "Collapse all provider groups"}
            >
              {collapsedAll ? "Expand all" : "Collapse all"}
            </Button>
            <label className="flex items-center gap-2 text-caption text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(event) => setShowAll(event.target.checked)}
                className="cursor-pointer"
              />
              Show all
              {hiddenCount > 0 ? (
                <span className="text-micro text-text-tertiary">
                  (includes {hiddenCount} hidden)
                </span>
              ) : null}
            </label>
          </div>
        </div>

        {/* One card per provider, each with its own models. Grouped rather than
            one flat table because the roster is 270 rows across 21 upstreams,
            and a provider's state and note apply to all of its models. */}
        {groups.length === 0 ? (
          <p className="mt-3 text-caption text-text-secondary">No models to show.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {groups.map((group) => (
              <ProviderGroup
                key={group.prefix}
                group={group}
                showUpstreams={showUpstreams}
                summary={summary}
                collapsedAll={collapsedAll}
              />
            ))}
          </div>
        )}

      </CardBody>
      ) : null}
    </Card>
  );
}

/**
 * One provider's models, inside its own card.
 *
 * A card in a card: the section is already a card, and each upstream group gets
 * its own bordered block so the provider it belongs to is never ambiguous in a
 * 270-row roster. Expanded by default — an operator opened the section to see
 * models, not to hunt for them.
 */
function ProviderGroup({
  group,
  showUpstreams,
  summary,
  collapsedAll,
}: {
  group: { readonly prefix: string; readonly family: string; readonly models: readonly InferhubModel[] };
  showUpstreams: boolean;
  summary: InferhubSummary;
  collapsedAll: boolean;
}): ReactNode {
  // Expanded by default; only a provider the operator collapsed stays shut.
  const [open, setOpen] = useState(true);
  const effectiveOpen = collapsedAll ? false : open;
  const family = familyOf(summary, group.prefix);
  const state = family?.familyState ?? null;
  const note = group.models.find((model) => model.systemPromptNote !== null)?.systemPromptNote ?? null;

  return (
    <div className="rounded-card border border-inner-border bg-surface-2">
      <button
        type="button"
        aria-expanded={effectiveOpen}
        aria-label={`${effectiveOpen ? "Collapse" : "Expand"} ${group.family} models`}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 border-0 bg-transparent px-3 py-2 text-left text-inherit"
      >
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={cn("shrink-0 transition-transform", !effectiveOpen && "-rotate-90")}
        />
        <span className="text-caption font-bold">{group.family}</span>
        <span className="font-mono text-micro text-text-tertiary">{group.prefix}/</span>
        {state !== null ? (
          <Badge tone={stateTone(state)} dot>
            {state.replace(/_/g, " ")}
          </Badge>
        ) : null}
        {showUpstreams && family !== undefined ? (
          <span className="text-micro text-text-tertiary tabular-nums">
            24h {formatPercent(family.availability24hPct)} · 7d{" "}
            {formatPercent(family.availability7dPct)}
          </span>
        ) : null}
        <span className="ml-auto text-micro text-text-tertiary">
          {group.models.length} model{group.models.length === 1 ? "" : "s"}
        </span>
      </button>
      {effectiveOpen ? (
        <div className="px-3 pb-3">
          {/* The note is an upstream-level behaviour, so it sits on the group,
              not on every row of it. */}
          {note !== null ? (
            <p className="mb-2 text-micro text-text-secondary">{note}</p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-caption">
              <thead>
                <tr className="text-left text-text-secondary">
                  <th className="py-1 pr-3">Model</th>
                  <th className="py-1 pr-3">Input</th>
                  <th className="py-1 pr-3">Output</th>
                  <th className="py-1 pr-3">Discount</th>
                  <th className="py-1 pr-3">Live</th>
                  <th className="py-1 pr-3">{showUpstreams ? "24h" : "Success"}</th>
                </tr>
              </thead>
              <tbody>
                {group.models.map((model) => (
                  <tr key={model.id} className="border-t border-inner-border">
                    <td className="py-1 pr-3 font-mono">{model.id}</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {formatPrice(model.minAskIn)}
                      {model.capacityPriceIn !== null &&
                      model.capacityPriceIn !== model.minAskIn ? (
                        <div className="text-micro text-text-secondary">
                          {formatPrice(model.capacityPriceIn)} sustainable
                        </div>
                      ) : null}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{formatPrice(model.minAskOut)}</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {model.tiersIn[0]?.discountPct === undefined ||
                      model.tiersIn[0]?.discountPct === null
                        ? "—"
                        : `−${model.tiersIn[0].discountPct}%`}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">
                      {model.providersLive === 0 ? <Badge>none</Badge> : model.providersLive}
                    </td>
                    {/* Null is unknown, not zero: a quiet model is unverified,
                        not failing. */}
                    <td className="py-1 pr-3 tabular-nums">
                      {showUpstreams
                        ? formatPercent(family?.availability24hPct ?? null)
                        : formatPercent(model.health.successRatePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The `config_read` key, on its own row — not part of the accounts list.
 *
 * Stored through the InferHub key route, which encrypts it at rest in its own
 * table. It is never written into `provider_accounts.auth_state`, which is
 * documented as the per-account *non-secret* config field and travels with the
 * account through backup/restore.
 *
 * The value itself is write-only here: the API returns only whether a key is
 * set and its last four characters, so a saved key can never be read back out
 * of the console.
 */
function InferhubKeyField({ onSaved }: { onSaved: () => void }): ReactNode {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<{
    readonly configured: boolean;
    readonly last4: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    if (value.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await consoleRequest("/inferhub/key", {
        method: "PUT",
        body: JSON.stringify({ key: value.trim() }),
      });
      setValue("");
      setStatus({ configured: true, last4: null });
      onSaved();
    } catch {
      setError("Could not save the key.");
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await consoleRequest("/inferhub/key", { method: "DELETE" });
      setStatus({ configured: false, last4: null });
      onSaved();
    } catch {
      setError("Could not remove the key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <Input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="sk-airo-… (config_read key)"
            aria-label="InferHub config_read key"
            autoComplete="off"
          />
        </div>
        <Button size="sm" onClick={() => void save()} disabled={busy || value.trim().length === 0}>
          {busy ? "Saving…" : "Save key"}
        </Button>
        {status?.configured ? (
          <Button size="sm" variant="secondary" onClick={() => void clear()} disabled={busy}>
            Remove
          </Button>
        ) : null}
      </div>
      <p className="text-micro text-text-tertiary">
        Stored encrypted beside the market settings, never in this provider&apos;s accounts. Must be a{" "}
        <code>config_read</code> key — never an inference key.
      </p>
      <p className="text-micro text-text-tertiary">
        <a
          href="https://inferhub.dev/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-accent hover:underline"
        >
          <ExternalLink size={12} aria-hidden="true" />
          inferhub.dev — create a <code>config_read</code> key
        </a>
      </p>
      {error !== null ? (
        <Banner tone="danger" surface="raised" live="alert">
          {error}
        </Banner>
      ) : null}
    </div>
  );
}
