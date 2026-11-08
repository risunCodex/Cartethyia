# Audit part — Console API & dashboard

Status: audited (first pass)
Scope: `src/console/**`, `dashboard/**`, contract mirrors

---

## Findings

### 1. The dashboard still bypasses its own contract boundary

- **Verdict:** cutover / boundary cleanup
- **Behavior change?:** no
- **Severity:** HIGH
- **Effort:** M
- **Evidence:**
  - `dashboard/src/data/contracts.ts:1-35`
  - `dashboard/src/data/contracts.ts:46-57`
  - `dashboard/src/data/contracts.ts:65-107`
  - `dashboard/src/data/contracts.ts:152-171`
  - `dashboard/src/data/contracts.ts:195-221`
  - `dashboard/src/data/contracts.ts:246-293`
  - `dashboard/src/components/BackupPanel.tsx:30-32`
  - `dashboard/src/hooks/backup.ts:8-9`
  - `dashboard/src/components/InjectSystemPromptPanel.tsx:23-24`
  - `dashboard/src/hooks/system-prompt.ts:7`
  - `dashboard/src/data/usage-periods.ts:6-7`
- **Current behavior:** `dashboard/src/data/contracts.ts` is clearly intended as
  the browser-safe facade, but several dashboard files still import backend or
  backend-adjacent modules directly.
- **Why it matters:** it reintroduces drift/bundling risk and leaves ownership of
  the browser-safe boundary ambiguous.
- **Recommended cut:** migrate every dashboard consumer to the facade/shared-pure
  contract modules only; enforce it with a lint/import-boundary rule or test.
- **Likely follow-up:** tests + docs.

### 2. InferHub types are duplicated in the dashboard with weak runtime validation

- **Verdict:** merge to one shared DTO owner
- **Behavior change?:** no
- **Severity:** HIGH
- **Effort:** M
- **Evidence:**
  - Dashboard mirror:
    - `dashboard/src/hooks/inferhub.ts:18-77`
    - `dashboard/src/hooks/inferhub.ts:79-89`
    - `dashboard/src/hooks/inferhub.ts:120-125`
  - Server-side types already exist:
    - `src/console/inferhub/types.ts:16-105`
  - Route response shape:
    - `src/console/inferhub/routes.ts:220-235`
    - `src/console/inferhub/routes.ts:237-261`
- **Current behavior:** the dashboard redefines `InferhubMeta`,
  `InferhubTier`, `InferhubModel`, `InferhubSummary`, then accepts payloads via
  casts instead of strong parsing.
- **Why it matters:** classic client/server drift territory.
- **Recommended cut:** extract/export a browser-safe InferHub response DTO
  module and consume it from both sides.
- **Likely follow-up:** contract snapshot/parser tests.

### 3. `SharedKeyPage` is still a hand-written mirror of an inline route response

- **Verdict:** contract cleanup
- **Behavior change?:** no
- **Severity:** MED/HIGH
- **Effort:** S/M
- **Evidence:**
  - Dashboard mirror: `dashboard/src/data/contracts.ts:183-191`
  - Dashboard consumer: `dashboard/src/hooks/api-keys.ts:243-263`
  - Server route emits inline shape: `src/console/api-keys/routes.ts:701-723`
- **Current behavior:** a small response shape is duplicated instead of being
  exported from a canonical contract.
- **Why it matters:** easy-to-miss stale mirror.
- **Recommended cut:** promote the response shape into
  `src/console/api-keys/contracts.ts` and import it through the dashboard
  facade.
- **Likely follow-up:** one contract assertion test.

### 4. Route definitions are duplicated across router, shell nav, and title maps

- **Verdict:** merge to one manifest
- **Behavior change?:** maybe (dead nav branch removed)
- **Severity:** MED
- **Effort:** M
- **Evidence:**
  - Router tree: `dashboard/src/App.tsx:175-188`
  - Shell nav manifest: `dashboard/src/apps/console/shell.tsx:63-100`
  - Separate title map: `dashboard/src/apps/console/shell.tsx:103-163`
  - Dead/empty nav group: `dashboard/src/apps/console/shell.tsx:83-90`
  - Renderer still treats empty children as expandable: `dashboard/src/apps/console/shell.tsx:598-640`
- **Current behavior:** effectively three route manifests plus one dead `Tools`
  branch.
- **Why it matters:** maintainability trap; route/nav/title drift is easy.
- **Recommended cut:** consolidate path/title/nav metadata into one route
  manifest and remove the dead branch.
- **Likely follow-up:** route/nav parity test.

### 5. Provider catalog fetch is mounted globally just to label provider detail pages

- **Verdict:** performance cleanup
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** S/M
- **Evidence:**
  - Shell always mounts `useProviders()`: `dashboard/src/apps/console/shell.tsx:789`
  - Used for route-title resolution: `dashboard/src/apps/console/shell.tsx:850`
  - Hook polls catalog: `dashboard/src/hooks/providers.ts:31-46`
- **Current behavior:** provider catalog polling becomes effectively always-on
  for every protected page, only to pretty-print `/providers/:providerId`
  titles.
- **Why it matters:** unnecessary background fetch/poll work and shell
  responsibility creep.
- **Recommended cut:** move provider-title resolution behind the provider detail
  route, or use route state/fallback id.
- **Likely follow-up:** title fallback test.

### 6. `/system/performance` looks unused from the dashboard surface

- **Verdict:** validate deadness, then cut or document
- **Behavior change?:** maybe
- **Severity:** LOW/MED
- **Effort:** S
- **Evidence:**
  - Route exists: `src/console/observability/performance.ts:13-22`
  - Mounted: `src/console/domain-registration.ts:281`
  - No dashboard consumer found in the audit
- **Current behavior:** live console API surface with no known dashboard reader.
- **Why it matters:** possible dead API surface.
- **Recommended cut:** confirm whether anything external uses it; remove if not,
  or explicitly document it as headless/internal.
- **Likely follow-up:** tests/docs if removed or kept intentionally.

---

## Recommended execution order

1. Enforce one browser-safe contract boundary for dashboard imports
2. Merge InferHub DTO ownership
3. Canonicalize `SharedKeyPage` contract
4. Collapse router/sidebar/title metadata into one manifest
5. Stop shell-wide provider polling for route labels
6. Confirm and prune `/system/performance` if unused

---

## Execution status

- ⛔ Audit only; no implementation yet.
