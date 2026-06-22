# Metrics Time Range Picker (Grafana-style) — Design

> Status: draft · 2026-06-15
> Scope: `portal-web` Metrics dashboard + `src/portal/siclaw-api.ts` `/api/v1/siclaw/metrics/*`
> Ports the Grafana-style time picker already shipped in the downstream sicore web dashboard.

## Background & goal

The Metrics dashboard (`portal-web/src/pages/Metrics.tsx`) filters time with a 3-option
`<select>` — Today / Last 7 days / Last 30 days — driving `summary` and `timing`. The Audit
tab carries its **own, independent** range `<select>` (Last 1h/6h/24h/7d/30d), so the header
period and the audit window can silently disagree. Neither path can express an **absolute**
window ("2026-06-10 09:00 → 12:00").

Goal: replace the period enum with a **Grafana-style time picker** — quick relative ranges
plus an absolute From/To — and unify the backend `live`/`summary`/`timing`/`audit` endpoints
on a single `from`/`to` timestamp contract, matching what audit already half-did with
`startDate`/`endDate`. Clean break, no compatibility shim.

## What stays untouched (contract boundary)

`src/portal/adapter.ts` `/api/internal/siclaw/metrics/*` is a **separate, parallel**
implementation (independent SQL, `period` enum) consumed by the downstream sicore Portal over
the internal-auth channel. It is a cross-system wire contract and is **out of scope** — exactly
mirroring how the sicore port left its own `adapter/rpc.go` alone. Only `/api/v1/*` (siclaw's
own portal-web) migrates.

```
┌─────────────────┐   /api/v1/siclaw/metrics/*    ┌──────────────────────┐
│  portal-web SPA │ ────────────────────────────▶ │  siclaw-api.ts       │  ◀── MIGRATE
│  (this change)  │      from / to (ms|ISO)        │  /api/v1 handlers    │
└─────────────────┘                                └──────────────────────┘
┌─────────────────┐   /api/internal/.../metrics    ┌──────────────────────┐
│  sicore Portal  │ ────────────────────────────▶ │  adapter.ts          │  ◀── DO NOT TOUCH
│  (downstream)   │      period / startDate        │  /api/internal       │
└─────────────────┘                                └──────────────────────┘
```

## Overall approach

Same shape as the sicore port, adapted to siclaw's stack (Vite SPA, no i18n, no UI lib,
TypeScript backend):

1. **Time model in `useMetrics.ts`** — a `TimeRange { from, to }` where each side is either a
   relative expression (`now`, `now-30m`) or an absolute ISO string. `resolveRange()` converts
   to absolute `{ fromMs, toMs }` **at fetch time**, so the backend only ever sees absolute ms.
2. **`TimeRangePicker` component** — hand-rolled (no shadcn/radix/day-picker in this repo):
   a button showing the current label, opening a popover with quick ranges (right) and an
   absolute From/To editor (left).
3. **Backend `from`/`to`** — `resolveWindow()` reads `from`/`to` (unix-ms or ISO), defaults to a
   trailing 7d window, 400 on invalid / `from>=to`. `summary` and `timing` gain a `created_at <= to`
   upper bound; `audit` renames `startDate`/`endDate` → `from`/`to` (keeps its `BETWEEN`).

### Refresh semantics — relative slides / absolute fixed

Precise behavior (corrected per peer review — only `useLive` owns a timer):

- **`useLive`** owns the single 30s `setInterval`. Each tick re-runs `resolveRange`, so a
  **relative** live window re-bases on `now` (slides); an **absolute** one is constant (fixed).
  The KPI live fields (active sessions, WS connections, tool-calls total) and Top Tools/Skills
  ride this tick.
- **`useSummary` / `useTimingStats`** have **no timer**. They refetch only when their deps
  change — `[range.from, range.to, userId]` — or on the manual Refresh button. Because a
  relative range's strings (`"now-7d"`) are constant across renders, the cards do **not** silently
  slide every 30s; they re-resolve to the current `now` the next time the user changes the range
  or hits Refresh. This preserves the existing summary/timing refresh behavior — we are only
  swapping the window contract, not adding a ticking slide.
- The **Audit** list resolves the window **once per filter change and freezes it**, reusing the
  snapshot while paginating — a relative window must not slide mid-pagination or the cursor
  drifts (rows duplicate / skip). Audit therefore does **not** auto-refresh with the header tick.

## Detailed design

### Module 1 — backend `/api/v1` contract (`src/portal/siclaw-api.ts`)

- Add a local `resolveWindow(query)` helper:
  - reads `query.from` / `query.to`. **Parse rule (pinned to kill the ms-vs-ISO ambiguity):**
    a value matching `/^\d+$/` → `new Date(Number(v))` (unix **ms**, what the frontend always
    sends); otherwise → `new Date(v)` (ISO, for manual curl/debug only); a `NaN` `getTime()` is
    rejected. Note: this differs from audit's current `new Date(query.startDate)`, which would
    mis-handle a bare ms string — the helper fixes that. Bare years (`"2026"`) are intentionally
    read as ms, not a calendar year; the frontend never sends those.
  - both missing → default `{ from: now-7d, to: now }`.
  - present but unparseable, or `from >= to` → returns `null`; caller responds `400 Invalid time range`.
- `summary`: drop `PERIODS`/`period`/`cutoff`; use `from` as the `created_at >= ?` lower bound
  and add `AND ... created_at <= ?` upper bound to **all three** windowed queries (totalSessions,
  totalPrompts, byUser).
- `timing`: same swap; add the upper bound to both the assistant-rows and tool-rows SELECTs.
- `audit`: rename `startDate`/`endDate` → `from`/`to` (the `BETWEEN ? AND ?` already bounds both
  ends). Default window unchanged (trailing 24h when both absent — but the frontend will always
  send an explicit window).
- `live`: unchanged — it has no period (live snapshot, `userId` only).
- Dialect: `from`/`to` are passed as `Date` objects into parameterized queries exactly like the
  current `cutoff`/`startDate`, so MySQL + SQLite behavior is unchanged (invariants.md §5).

### Module 2 — time model (`portal-web/src/hooks/useMetrics.ts`)

```ts
export interface TimeRange { from: string; to: string }   // "now" | "now-30m" | ISO
export const QUICK_RANGES: Array<{ label: string; from: string }>   // to: "now"
export const DEFAULT_RANGE: TimeRange = { from: "now-7d", to: "now" }
export function isRelativeExpr(v: string): boolean
export function resolveRange(r: TimeRange): { fromMs: number; toMs: number }
export function rangeLabel(r: TimeRange): string
```

- `resolveRange` parses `now`, the **exact** regex `^now-(\d+)([smhdw])$` (`m`=minutes, **not**
  months; units s/m/h/d/w), else `Date.parse` of an absolute string interpreted in the browser's
  **local timezone** (`YYYY-MM-DD HH:mm` or ISO). The picker's Apply button is gated on
  `resolveRange` yielding a valid `from < to`, so unknown units (`now-3M`) are rejected at the UI
  rather than silently becoming `NaN` → backend 400.
- `useSummary` / `useTimingStats`: signature `period: string` → `range: TimeRange`; `fetchOnce`
  reads `rangeRef.current`, `resolveRange` → `from`/`to` ms query params; effect deps become
  `[range.from, range.to, userId]` (primitives, not the object).
- `useLive`: still `userId`-only + 30s interval — unchanged.
- `useAudit`: `AuditParams.startDate/endDate` → `from/to`.

### Module 3 — `TimeRangePicker` (`portal-web/src/components/metrics/TimeRangePicker.tsx`, new)

Hand-rolled to match siclaw's dependency-free style (raw Tailwind + lucide, popover via an
absolute-positioned panel + a `mousedown` outside-click listener):

```
┌─ Trigger: [🕐  Last 7 days  ▾] ─────────────────────────────────┐
│                                                                  │
│  ┌─ Absolute time range ─────┐  ┌─ Quick ranges ──────────────┐ │
│  │ From [ now-7d        ]    │  │ [search…]                   │ │
│  │ To   [ now           ]    │  │  Last 30 minutes            │ │
│  │ <calendar — see decision> │  │  Last 1 hour                │ │
│  │ [ Apply time range ]      │  │  Last 6 hours   … (10)      │ │
│  └───────────────────────────┘  └─────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

- Quick range click → `onChange({ from, to: "now" })`, closes.
- Absolute From/To text inputs accept a relative expr (`now-30m`) or an absolute time; Apply
  validates via `resolveRange` and emits the literal strings (relative stays relative → slides;
  absolute stays absolute → fixed).
- Popover open/close via an absolute panel + a `mousedown` outside-click listener attached
  **only while open**; the handler must ignore clicks inside **both** the panel and the trigger
  button (two-ref containment check) to avoid a close-then-reopen race.
- Mini-calendar is **date-only** (no date-fns): a `◀ month ▶` header + 7-col day grid built from
  `Date` math; clicking a day fills the date portion of whichever field (From/To) is "active",
  leaving time-of-day to the text input. The pure grid-generation function (first-of-month
  weekday offset, 28/29/30/31, Dec→Jan rollover) gets a unit test.

### Module 4 — wiring

- `Metrics.tsx`: `period` state → `timeRange: TimeRange`; header `<select>` → `<TimeRangePicker>`;
  pass `timeRange` to `useSummary`/`useTimingStats`/`AuditTable` and `rangeLabel(timeRange)` to the
  cards.
- `AuditTable.tsx`: accept `timeRange` from the page header and **drop its own `rangeMs`
  `<select>`** + `RANGE_OPTIONS` (decision #2 — unify). Resolve to `{fromMs,toMs}` in a `useMemo`
  keyed on `[timeRange.from, timeRange.to, tool, status, userFilterId]` (primitives only, **never
  `Date.now()`**), and feed the **resolved ms** into `useAudit`'s `from`/`to` params — this is the
  freeze that keeps pagination cursors stable.
- `KpiCards.tsx` / `TimingStatsCard.tsx`: `period` prop → `rangeLabel: string`; drop local period maps.
- `Metrics.tsx`: also update the **"By User" subtitle** at line ~149 (`(period: ${period})`) which
  references the deleted `period` state — becomes `rangeLabel(timeRange)`; this is a hard compile
  dependency, not cosmetic.

## Out of scope / deliberately skipped

- **i18n** — portal-web has none; strings stay inline English (consistent with the page).
- **OpenAPI** — no spec exists in this repo; nothing to update.
- **Product docs** — metrics is an admin-only internal surface with no existing `docs/features`
  page; no user-facing doc to sync.
- **`adapter.ts` `/api/internal`** — cross-system contract, untouched.

## Risks & edge cases

- **Audit pagination drift** — mitigated by freezing the resolved window per filter change.
- **Clock/timezone** — all relative resolution happens client-side; backend sees absolute ms only.
- **Invalid absolute input** — Apply is gated on `resolveRange` producing a valid `from < to`;
  backend independently 400s on bad params (fail-fast, no silent fallback).
- **byUser session-vs-message timestamp asymmetry** — `byUser` filters `s.created_at` while
  `totalPrompts`/timing filter `m.created_at`. With an upper bound, a session created before `to`
  whose messages land after `to` counts its session but not those messages (can read sessions=1,
  messages=0 in a tight absolute window). Pre-existing semantics the upper bound merely surfaces;
  not changed here.
- **Test migration** — `siclaw-api.misc.test.ts` `summary?period=bogus → 400` becomes
  `summary?from=2000&to=1000 → 400`. Verify `timing` had no separate invalid-period test to migrate,
  and that the summary happy-path assertion on `query.mock.calls[1][0]` still holds (the added
  `created_at <= ?` keeps the `delegation_event` LIKE clause and adds no extra query call).

## Estimate

- Files: ~7 (`useMetrics.ts`, `TimeRangePicker.tsx` [new], `Metrics.tsx`, `AuditTable.tsx`,
  `KpiCards.tsx`, `TimingStatsCard.tsx`, `siclaw-api.ts`) + 1 test.
- Lines: ~450–650 (main-agent execution; under the 1000-line threshold).

## Decision Record

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Absolute From/To entry widget | **Hand-rolled mini calendar + text inputs** | Zero new deps, fits siclaw's dependency-free Tailwind style, closest parity to sicore/Grafana. From/To text accept `now-30m`/ISO; an inline month grid sets the date; `Apply` commits. Native `<input type="datetime-local">` was rejected — it can't express relative expressions (`now-30m`), the core of the Grafana model, so it'd force running text + native pickers in parallel. Both peer reviewers flagged the calendar as the highest-effort/bug-density piece and suggested text-only; honored the user's explicit choice for the calendar, mitigated by keeping it date-only, self-contained, and unit-tested. |
| 2 | Audit tab time source | **Unify under the header picker** (drop Audit's own `rangeMs` select) | Matches sicore's end state; removes the duplicate, drift-prone path. Audit freezes the resolved window per filter change for pagination stability. |
| 3 | Quick-range set | **Match sicore's 10** (30m / 1h / 3h / 6h / 12h / 24h / 2d / 7d / 30d / 90d) | Cross-product consistency with the downstream sicore dashboard. |

### Mini-calendar scope (decision #1)

A compact, dependency-free month grid (`Date` math only, no date-fns): header with ◀ month ▶,
a 7-column day grid, click a day to fill whichever of From/To is "active". Time-of-day stays in
the text input (minute precision via `now-30m` or `YYYY-MM-DD HH:mm`); the calendar only sets the
date portion. ~100 lines, lives inside `TimeRangePicker.tsx`.
