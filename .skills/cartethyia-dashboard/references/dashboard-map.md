# Dashboard

`dashboard/src/` is the browser app. It is React, React Router, and TanStack
Query. The backend serves the built files at `/console`. The console router
basename is `/console`, so a route written as `/usage` is `/console/usage` in
the browser. Console pages use `/console/api`; the public landing and share apps
use their own public surfaces.

The dashboard does not import Elysia, database drivers, filesystem modules, or
secrets at runtime. Console requests go through `dashboard/src/data/api.ts`;
shared backend contracts may be imported as types only.

## Shell

```mermaid
flowchart TD
  main["main.tsx"] --> app["App"]
  app --> query["QueryClientProvider"]
  query --> router["BrowserRouter basename=/console"]
  router --> bridge["SessionTransitionBridge"]
  router --> boundary["ErrorBoundary + Suspense"]
  boundary --> public["/login /setup /banned"]
  boundary --> protected["ProtectedRoutes"]
  protected --> session{"GET session"}
  session -->|user| shell["DashboardShell"]
  session -->|401| login["/login?returnTo"]
  session -->|403| banned["/banned"]
  session -->|first boot| setup["/setup"]
  shell --> pages["feature pages"]
```

`ProtectedRoutes` fetches the session once, into `queryKeys.session.current`.
A later page reads that cache. It does not send a second session request on
every navigation. A 401 clears the cache and returns to login with the current
path. A 403 goes to `/banned`.

Route chunks are `lazyWithRetry`. After a deploy the old chunk URL 404s. The
loader reloads once to pick up the new `index.html`, then stops. It does not
loop.

## Pages

| Path | Page | What it operates |
| --- | --- | --- |
| `/` | `OverviewPage` | Tenant health and the first-look summary |
| `/usage` | `UsagePage` | Usage totals, breakdowns, chart, request list and detail drawer read raw telemetry events; no compacted day-index supplies the aggregates. The first tile on the Routing Latency bar is **Resolve** (average arrival → just-before-upstream: credential, admission, pool slot, preparation), separate from the P50/P95/P99 response-latency series beside it. Each tile's hover tooltip names the window and the sample count that fed it. |
| `/providers` | `ProvidersPage` | Provider catalog |
| `/providers/:providerId` | `ProviderDetailPage` | Accounts, auth, routing (including Usage floor), models |
| `/combos` | `CombosPage` | Aliases and combos |
| `/quota` | `QuotaPage` | Provider quota windows |
| `/proxy` | `ProxyPage` | Network pools and egress |
| `/console-log` | `ConsoleLogPage` | Process log ring. A request row reads left to right across the full width and wraps on its own; it leads with `[REQUEST]`, `[SUCCESS]`, or `[FAILED]`. Nothing is truncated. Newest lines stay at the top, so the view does not stick to the bottom. |
| `/model-lab` | `StudioPage` | Studio sessions against the gateway |
| `/cli-tools` | `CliToolsPage` | CLI tool list |
| `/cli-tools/:toolId` | `CliToolDetailPage` | Per-key slot mappings |
| `/customization` | `CustomizationPage` | Browser-only `localStorage` settings and the IndexedDB background blob; no backend |
| `/settings` | `SettingsPage` | Runtime preferences, backup |
| `/login`, `/setup`, `/banned` | session pages | No shell |

Unknown protected paths redirect to `/`. There is no fusion page.

Three of those pages are backed by a feature page that owns the data and the
console domain behind them: [`/combos`](../../../documentation/features/02-routing-aliases-combos.md),
[`/proxy`](../../../documentation/features/03-network-pools.md), and `/cli-tools`
([CLI model mapping](../../../documentation/features/01-cli-model-mapping.md)). The share page is public
and has its own: [share keys](../../../documentation/features/05-share-keys.md). Provider detail's
quota threshold is documented in [Usage floor](../../../documentation/features/04-usage-floor.md).

## Data flow

```mermaid
sequenceDiagram
  participant Page
  participant Hook
  participant Query as TanStack Query
  participant API as /console/api
  Page->>Hook: useX()
  Hook->>Query: queryKey
  Query->>API: consoleRequest
  API-->>Query: JSON
  Query-->>Page: data, isLoading, isError
  Page->>Hook: mutate
  Hook->>API: POST/PATCH/DELETE + CSRF
  API-->>Hook: result
  Hook->>Page: toast.success or toast.error
  Hook->>Query: invalidate queryKeys
```

`dashboard/src/data/query-keys.ts` is the key tree. A mutation invalidates the
keys it changed. It does not write the server response over an unrelated cache
entry.

`query-client.ts` holds the shared client. `query-policy.ts` holds stale times.
`route-prefetch.ts` warms the next page's queries. `contracts.ts` is the
TypeScript shape of the JSON. If the console payload changes, this file changes
with it. The dashboard does not keep a second, drifted type.

`consoleRequest` attaches the CSRF header on mutations. A 401 or 403 notifies
`SessionTransitionBridge` through `setSessionTransitionListener`.

Two surfaces are **streams, not polls** — do not wire a second polling loop
for them:

- `/console/api/notifications/stream` (SSE, subscribed on shell mount via
  `hooks/system.ts`) carries memory-growth and update-available badges.
- The update flow polls `GET /console/api/updates/status` every 3 s only while
  an update is running (`apps/console/shell.tsx`): it reloads on `success`
  **after verifying the `/system/health` version actually moved**, renders the
  `UpdateDialog` failure panel on `failed` (the dialog takes an `error` prop)
  and stops polling; `/updates/release` is the fallback poll target for
  gateways without the status endpoint. `UpdateDialog.tsx` owns the dialog
  state machine; the shell owns the poll loop.

## Feature layout

| Directory | Holds |
| --- | --- |
| `features/session` | Login, setup, banned |
| `features/overview` | Home summary |
| `features/usage` | Usage charts and breakdowns |
| `features/providers` | Provider list |
| `features/provider-detail` | One provider: accounts, routing, models |
| `features/routing` | Combos and aliases |
| `features/quota` | Quota windows |
| `features/proxy` | Pool list and pool detail |
| `features/logs` | Console log |
| `features/studio` | Model lab |
| `features/cli-tools` | CLI tool mappings |
| `features/settings` | Preferences and backup |
| `features/customization` | Appearance, blur, and background; browser state only |
| `apps/landing` | Public landing |
| `apps/share` | Public share page |
| `apps/console` | Console mount |
| `components/` | Shell, dialog, form controls |
| `hooks/` | Query hooks shared by more than one page |
| `lib/` | Toast, lazy retry, formatting |
| `styles/` | Tokens and layout |

A page-specific hook stays next to the page. A hook used by two features moves
to `dashboard/src/hooks/`.

Model Lab's Chat settings persist tool permission per session. **Ask before
running** is the default and shows an inline approval prompt before web search
or media-generation tools run; **YOLO** runs those tools automatically.
`ask_user_question` remains a separate user-answer flow in either mode.

## Share and landing

`apps/share` is the public page a share link opens: it reads the share API,
lets recipients copy granted model ids and test allowed models with the shared
key, and carries no key-management controls such as enable, disable, or delete.
What the page is for, and what enforces it, is on the
[share keys](../../../documentation/features/05-share-keys.md) page.

`apps/landing` is the unauthenticated product page. Crawlers do not run the
bundle, so title, description, and social tags for landing, console, and share
are injected by `src/console/dashboard-assets.ts` into the one
`dashboard/index.html`. Do not add a second Vite HTML entry.

## Layout rules

The document is the page scroll container. The sidebar rail/navigation and
contained surfaces such as dialogs can scroll independently. `.app-topbar` and
the desktop `.app-sidebar` stick against the document at the shell's 16px inset;
the narrow-shell drawer is fixed. The topbar is an opaque sibling above the
page content with its own shadow.
`.app-main-column`, `.dashboard-page`, and `.route-enter` do not scroll. The
sidebar collapses to a drawer at the shell's `@container app-shell` 860px
threshold, not a viewport breakpoint. `route-enter` moves vertically; do not
add opacity, transform, or filter animation there because it changes the
backdrop-filter grouping used by cards.

Card blur only reaches the uploaded background when that image is painted behind the card in the same group. `BackgroundLayer` mounts inside `.app-main-column`. `.route-enter` animates position only — an `opacity`, `transform`, or `filter` animation groups the page, and the card then blurs the black body instead of the image. `.custom-background` keeps `contain: none` for the same reason; anything else also pins a `fixed` layer to the scroller. Clarity and blur are separate sliders.

Dialog sizes come from `DialogSize` (`sm` 420, `md` 640, `lg` 880, `xl` 960) in
`components/ui/dialog.tsx`; `size` wins over `width`, and a raw `width={…}` px is
legacy. `expanded` is the explicit full-width escape hatch and caps at 1160. At
`max-small` (640px) a dialog stays centered with reduced viewport margins;
`Drawer` is the surface that becomes a full-viewport panel. New dialogs use
`DialogSize`, not a raw width.

New persisted UI preferences should use a `cartethyia:<area>:<name>` key and
defensive reads (SSR/storage availability, validation, and a fallback). Some
existing preferences retain older key formats; follow the owning helper rather
than renaming persisted keys incidentally. The share page stores an issued
enrollment key in IndexedDB, keyed by the share token.

Polling lists sort with a deterministic tiebreaker. Two rows with the same
timestamp must not swap places between polls.

## Mutation feedback

User-initiated mutations report both outcomes unless deliberately quiet or
automated.

| Result | Toast |
| --- | --- |
| success | `toast.success` with the outcome, for example "Proxy pool created" |
| failure | `toast.error` with `getErrorMessage(error, ...)` |

An interactive mutation that reports neither leaves the operator unable to
tell whether the click landed.

## Provider routing controls

`useRoutingStrategy` reads provider routing and writes it back through
`useUpdateProviderRouting`. Round robin is a boolean over the `round_robin`
strategy; fallback is the other value. `rotateCount`, `maxInflight`,
`skipProxy`, and `userAgent` save through `useDebouncedSave`, so a slider does
not send one request per pixel. User-agent editing is gated by `allowUserAgent`.

Three defaults apply when no routing row exists, all read from the backend:

- **Cline skips the proxy.** Its health follows the egress address, so a pool in
  front of it is the thing most likely to be wrong.
- **`maxInflight` is unlimited.** It was 5, which capped every unconfigured
  provider and surfaced as `capacity_exhausted` — a limit nobody set. A ceiling
  the operator did set is still enforced.
- **Client identity is the Claude Code CLI**, on the live version. It was a
  frozen Codex literal. "None" still means no header, which is why the hook
  initializes `userAgent` to `""` and lets the fetched row fill it.

## Build and serve

`bun run dashboard:build` writes the static bundle. The backend serves it. The
dev server proxies `/console/api` to the gateway. A page that works in dev and
404s in production is almost always a basename or asset-path mistake, not a
data bug.

Social tags are verified on the served HTML, not in the React tree. The served
document for `/`, a console route, and a share route must each carry the tags
`dashboard-assets.ts` injects.

## Authenticated console session

Follow [the dashboard reference](dashboard.md#authenticated-console-session)
for the real-form sign-in and shared browser session. Do not duplicate its
credential and session procedure here.

## Styling migration

Follow [the dashboard reference](dashboard.md) for the visual-baseline,
style-guard, and migration procedure. Keep this page as the route/layout map
rather than maintaining a second copy of that procedure.

## Where to change what

| Change | Start here |
| --- | --- |
| New page | `App.tsx` route, feature directory, query key, console domain |
| New API field | console contract, then `data/contracts.ts`, then the hook |
| New dialog | `components/` dialog, `DialogSize`, both toast arms |
| Update dialog / poll loop | `components/UpdateDialog.tsx` (`error` prop drives the failure panel), poll in `apps/console/shell.tsx`, `/updates/status` |
| Share page behavior | `apps/share`, and the share API it reads |
| Layout | `dashboard/src/styles/` and `dashboard/src/apps/console/shell.tsx` |
