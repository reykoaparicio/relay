# Plan 09: Design System — Tokens, Theme, Accessible Component Library (Agent I)

Spec: §3.3 (keyboard + text status), §5.1, §5.7 · Skill: **ui-ux-pro-max** (design-system query: "developer tool desktop dashboard AI workflow dark mode professional") · Waves (00 §3): **Wave 0 / M1** I1–I4 · I5–I6 are not separately scheduled in 00 §3 and land alongside J's waves

Files (exclusive): `apps/desktop/src/renderer/styles/**`, `apps/desktop/src/renderer/components/ui/**`, `apps/desktop/src/renderer/lib/format/**`

Visual reference: the HTML mocks in [`plans/mocks/`](mocks/index.html). Each class in `mocks/assets/app.css` maps to exactly one component below, and that CSS file lists the mapping in its header.

---

## Design direction (ui-ux-pro-max output, adapted)

The skill's `--design-system` run recommended the following:
- **Colors:** "Code dark + run green" (primary `#1E293B`, background `#0F172A`, CTA `#22C55E`, text `#F8FAFC`).
- **Typography:** Fira Code for headings and Fira Sans for body, with the mood "dashboard, data, analytics, code, technical, precise".
- **Anti-patterns to avoid:** flat design without depth, and text-heavy pages.

This plan adapts that output for the Relay mocks as follows:

| Skill output | Relay decision | Why |
|---|---|---|
| Pattern "Horizontal Scroll Journey" / style "Vibrant & Block-based" | **Rejected** | Those are landing-page patterns. Relay is a dense desktop tool, and spec §5.1 asks for "restrained visual styling" |
| Code-dark + run-green palette | **Adopted**, tuned to match the concept mocks (teal-green accent `#6EE7C7` on `#0B1119`) with all text pairs ≥ 4.5:1 | Matches the spec mockups and meets the accessibility tier |
| Fira Code headings / Fira Sans body | **Fira Sans for all UI text, Fira Code for numbers, IDs, hashes, money, and token counts** | Monospace headings hurt scanability in dense panels. Tabular mono digits make ledgers align |
| Pre-delivery checklist | **Adopted verbatim** as the I-gate (below) | – |

UX rules pulled from the skill (`--domain ux`, `--domain web`, `--stack react`), all **CRITICAL/HIGH**:
- `focus-states` (visible ring), `keyboard-nav`, `skip-link`, `aria-labels` on icon-only buttons, `form-labels` (`htmlFor`), and `color-contrast` 4.5:1.
- `loading-buttons` (disable plus spinner during async), `error-feedback` near the field, `loading-states` (skeletons), `content-jumping` (reserve space), and `reduced-motion`.
- Stack items: use semantic `button`/`a`/`label` rather than a `div` with a role, `onKeyDown` alongside `onClick` for custom widgets, virtualize long lists, lazy-load routes, and use primitive deps in hooks.

## I1: Tokens & theme (`styles/tokens.css`, `styles/theme.css`, `styles/base.css`, `styles/fonts.css`)
- `tokens.css` is a **verbatim copy** of `plans/mocks/assets/tokens.css`, which is the single source of truth. A unit test compares the two files and fails on drift.
- `theme.css` uses the Tailwind v4 `@theme` block to map tokens to utilities:
  ```css
  @import "tailwindcss";
  @import "./tokens.css";
  @theme inline {
    --color-canvas: var(--color-canvas); --color-surface: var(--color-surface); --color-surface-raised: var(--color-surface-raised);
    --color-border: var(--color-border); --color-text: var(--color-text); --color-muted: var(--color-text-muted);
    --color-accent: var(--color-accent); --color-warning: var(--color-warning); --color-danger: var(--color-danger);
    --color-info: var(--color-info); --color-unknown: var(--color-unknown);
    --font-sans: var(--font-sans); --font-mono: var(--font-mono);
    --radius-md: var(--radius-md); --radius-lg: var(--radius-lg);
  }
  @custom-variant light (&:where([data-theme="light"], [data-theme="light"] *));
  ```
- `fonts.css`: local `@font-face` rules, **woff2 only**, for the **latin and latin-ext** subsets of Fira Sans 400/500/600/700 and Fira Code 400/500 (PERF-04). The files come from the `@fontsource` packages (bundled as assets, so their OFL notices are collected); `unicode-range` is copied from @fontsource so a subset loads only when needed. Bundled locally because the CSP blocks remote fonts, with `font-display: swap`.
- Theme switching: `data-theme` on `<html>`, driven by `app.getSettings().theme` (`'dark' | 'light' | 'system'`). `system` follows `prefers-color-scheme`. Dark is the default (§5.1).

## I2: Formatting library (`lib/format/*.ts`) — pure, unit-tested
| Function | Output | Notes |
|---|---|---|
| `formatMoney(m: Microusd, certainty?)` | `"$0.48"`, `"$0.0042"` (4 dp below $0.01), `"≈ $0.48 est."` when estimated | Never uses floats for arithmetic. Uses `formatUsd` from contracts |
| `formatTokens(n)` | `"12.4k"` | |
| `formatHash(sha)` | `"6f4a…b18c"` | Full value in `title` **and** in a copy button (no tooltip-only info, §5.7) |
| `formatDuration(ms)` | `"1m 12s"` | |
| `formatRelativeTime(epochMs, now)` | `"3 min ago"` + absolute in `<time dateTime>` | |
| `statusPresentation(kind, value)` | `{ label, tone, icon, detail? }` for run status, step state, attempt state, memory status, cost certainty, pause reason | **Exhaustive** over the contracts enums (compile error when an enum grows) |

`statusPresentation` returns `{ label, tone, icon, detail? }`. `detail` is a short **visible** sentence (rendered by `StatusBadge` with `showDetail` and by J8 banners), never tooltip-only text. The run-status and pause-reason rows below are the complete set, one row per contracts `RUN_STATUSES` and `PAUSE_REASONS` value (02 B2). Step, attempt, memory, and certainty rows are an excerpt; the full table is in code.

| Value | Label | Tone | Icon (lucide) | Detail |
|---|---|---|---|---|
| run `queued` | Queued | neutral | `Clock` | – |
| run `running` | Running | info | `Loader` (static when reduced-motion) | – |
| run `awaiting_approval` | Awaiting your approval | warning | `Hand` | – |
| run `cancelling` | Cancelling | neutral | `Loader` | Finishing the in-flight request before stopping |
| run `interrupted` | Interrupted | warning | `ZapOff` | Relay stopped unexpectedly. Review what happened before continuing |
| run `completed` | Completed | success | `CheckCircle2` | – |
| run `incomplete` | Incomplete | warning | `CircleDashed` | The run ended before the goal was met. Results are partial |
| run `failed` | Failed | danger | `XCircle` | Stopped by an internal error. Completed artifacts are intact |
| run `cancelled` | Cancelled | neutral | `Ban` | Stopped by you. Finished steps are kept |
| run `paused` + `budget_run` | Paused: run budget | warning | `PauseCircle` | The next step would exceed this run's allowance |
| run `paused` + `budget_project` | Paused: project budget | warning | `Wallet` | The next step would exceed the project's monthly allowance |
| run `paused` + `budget_overrun` | Paused: cost exceeded reservation | warning | `TrendingUp` | The last request cost more than reserved. Acknowledge to continue |
| run `paused` + `user` | Paused by you | neutral | `PauseCircle` | – |
| run `paused` + `auth_required` | Paused: provider sign-in needed | warning | `KeyRound` | Reconnect the provider to continue |
| run `paused` + `rate_limited` | Paused: provider rate limit | warning | `Timer` | Automatic waits are used up. Resume when ready |
| run `paused` + `setup_blocked` | Paused: setup blocked | warning | `AlertTriangle` | A required check failed before the step could start |
| run `paused` + `approval_stale` | Paused: approval out of date | warning | `FileWarning` | Project files changed after approval |
| run `paused` + `limit_attempts` | Paused: attempt limit reached | warning | `Repeat` | Raise the limit or stop |
| run `paused` + `deadline` | Paused: time limit reached | warning | `AlarmClock` | Raise the limit or stop |
| run `paused` + `output_invalid` | Paused: output didn't match schema | warning | `FileX` | Repair attempts are used up. Retry the step or choose another profile |
| run `paused` + `provider_unavailable` | Paused: provider unavailable | warning | `CloudOff` | Retries are used up. Retry the step or choose another profile |
| run `paused` + `model_refused` | Paused: model declined | warning | `ShieldX` | Choose another profile or edit the goal |
| run `paused` + `unknown_outcome` | Paused: request may not have completed | unknown | `HelpCircle` | Retry the step (this may charge again) or stop |
| certainty `estimated` | est. | neutral | `Sigma` | – |
| certainty `unknown` (legacy) | Estimated | neutral | `Sigma` | – (decision 1: never shown as unknown) |

## I3: Primitive components (`components/ui/*.tsx`)

Each component is a function component with a typed props interface, forwards refs where it is focusable, and has **no data fetching** (pure UI). Radix primitives supply the complex widgets, which gives correct a11y semantics.

| Component | Props (key) | A11y requirements | Mock class |
|---|---|---|---|
| `Button` | `variant: 'primary'\|'secondary'\|'danger'\|'ghost'`, `pending?: boolean`, `size?: 'md'\|'lg'` | Real `<button>`. `pending` → `aria-busy`, disabled, spinner plus unchanged label width. Min height 40 (44 for primary) | `.btn` |
| `IconButton` | `label: string` (required) | `aria-label={label}`, lucide icon `aria-hidden` | – |
| `StatusBadge` | `kind`, `value`, `pauseReason?`, `showDetail?` | Icon + text **always**. Never color-only (gate). `showDetail` renders `detail` as visible secondary text | `.badge` |
| `Card`, `CardHeader` | `as?: 'section'\|'article'`, `labelledBy` | Section landmark with a heading | `.card` |
| `StatTile` | `label`, `value: ReactNode`, `hint`, `href?` | If `href`, the whole tile is a link with descriptive text | `.stat` |
| `PageHeader` | `title`, `breadcrumbs`, `status?`, `actions` | `<h1>`. Status is plain text (not a live region: run status is announced once by `useRunEvents`, A11Y-01) | `.topbar` |
| `AppShell` | `nav`, `workspace`, `children` | Skip link to `#main`, `<nav aria-label="Primary">`, `<main id="main" tabIndex={-1}>` | `.shell` |
| `SideNav` / `NavItem` | `items`, `activeKey`, `badgeCount?` | `aria-current="page"`. The count badge has sr text: "3 waiting for approval" | `.nav-item` |
| `ProjectSwitcher` | `projects`, `activeId`, `onSelect` | Radix `DropdownMenu`. The active project is announced | `.project-switcher` |
| `Field` | `label`, `hint?`, `error?`, `children(control props)` | Generates ids and wires `htmlFor`, `aria-describedby` (hint + error), `aria-invalid` | `.field` |
| `TextInput`, `Textarea`, `Select`, `Checkbox`, `RadioGroup`, `NumberInput`, `MoneyInput` | controlled | `MoneyInput` accepts a dollar string, converts via `usd()`, and shows parse errors inline, with no float arithmetic | `.input` etc. |
| `Tabs` | Radix Tabs | Arrow-key navigation, `aria-selected` | `.tabs` |
| `ResponsivePanels` | `tabs: Panel[]`, `secondary: Panel[]`, `value`, `onValueChange`, `label`, `breakpointPx?` (default 1280) where `Panel = { id, label, content }` | At ≥ `breakpointPx` renders `tabs` in a `Tabs` widget and the `secondary` panels as a bottom row of labelled `<section>`s. Below it, the `secondary` panels **collapse into the same tabs** (appended after `tabs`, same ids), so nothing is hidden. Uses `matchMedia` (via a `useMediaQuery` hook in this folder); if the selected id is a secondary panel and the layout widens, the selection falls back to the first tab. No layout shift beyond the swap. Used by J's `RunInspector` (the ledger + context bottom row, §5.7) | run-inspector bottom row |
| `Dialog`, `ConfirmDialog` | Radix Dialog; `ConfirmDialog` has `destructive?: boolean`, `consequences: ReactNode` (the accessible description), `secondaryAction?: { label, onClick, pending? }` (a footer button, e.g. "Archive instead"; every footer button is disabled while any is pending), `children?` (body content kept out of the description: warnings, the mutation error) | Focus trap, Esc closes, returns focus. **Destructive only**; no confirmations for read-only actions (§5.7) | `.dialog` |
| `InlineAlert` | `tone`, `title`, `children`, `actions?`, `live?: 'off' \| 'polite' \| 'assertive'` (default `'off'`) | Silent by default (a banner that is part of the page is read in place). `'assertive'` (`role="alert"`) only for an alert answering the user's own submit (MutationError, form errors); `'polite'` (`role="status"`) for an update the user waits on (runner state, save confirmations, `ServerChangesNotice`) (A11Y-01) | `.banner` |
| `ServerChangesNotice` | `title`, `intro?`, `keepLabel`, `onKeep`, `keepPending?`, `keepDisabled?`, `children` (the comparison) | Polite warning: a newer server version arrived while the user had edits; nothing was overwritten and keeping the user's changes is explicit. Used with `hooks/useRebasableForm` (DUP-01) | `.banner.warning` |
| `ListItemButton` | `title`, `aside?`, `meta?`, `badges?`, `leading?` | One `<button>` per row: `aria-labelledby` the title, `aria-describedby` the aside/meta/badges; never a hand-written `aria-label` (DS-04). Non-interactive rows use `.list-item.static` | `.list-item` |
| `DateInput` | `value` (`YYYY-MM-DD`, `''`, or `INCOMPLETE_DATE`), `onValueChange` | Native date input inside `Field`; parse/format helpers in `lib/format/date.ts` (DS-03). A partly typed date (`validity.badInput`) is reported as `INCOMPLETE_DATE` (rejected by `parseDateInput`), never as `''` ("no date") | `.input` |
| `usePageFocusRescue(fallback)` / `useFocusRescue(container, fallback)` | – | When a mutation removes or disables the focused control, focus moves to the fallback (the shell uses `<main tabIndex=-1>`), never `<body>` (A11Y-02). Never while a dialog is open (dialogs own their focus), and deferred past a closing dialog's own focus restore, so a close goes straight to the opener | – |
| `Toast` / `useToast` | Radix Toast; **dedupe by key** within 10 s | For actionable failures only ("no repeated generic toast spam", §5.1) | `.toast` |
| `DataTable` | `columns`, `rows`, `onRowActivate`, `emptyState` | `<table>`, `<th scope>`. Rows are keyboard-activatable via a link in the first cell (not a clickable `<tr>` only) | `.table` |
| `KeyValueList` | `items: {term, value, mono?}[]` | `<dl>` | `.kv` |
| `EmptyState` | `title`, `body`, `actions` | – | – |
| `Skeleton` | `lines`, `height` | `aria-hidden`. The parent has `aria-busy` | – |
| `CopyButton` | `value`, `label` | Announces "Copied" via the live region | – |
| `Hash` | `value` | Composes `formatHash` + `CopyButton` | `.mono` |
| `Money` | `value`, `certainty?` | Composes `formatMoney`, with the certainty label as visible text | `.num` |
| `LiveRegion` | provider + `announce(msg)` | Single polite region. Only announces completion, pauses, and approval requests, never tokens (§5.7) | – |
| `ErrorView` | `error: AppError`, `onAction(nextAction)` | Maps `nextAction` → a button label and handler hook | `.banner.danger` |

## I4: Domain display components (`components/ui/domain/*.tsx`) — pure presentational, data via props

Components that render step outputs or manifests take their prop types from **`@relay/contracts`** (type-only imports): `PlanV1`, `PatchV1`, `FindingsV1`, `ReviewV1`, `ReportV1` from `outputs/*`, and `ContextManifest` from `domain/manifest`. They never import `@relay/templates` and never redeclare output shapes locally. View types (`StepView`, `AttemptView`, `ApprovalView`, `CatalogModel`) also come from contracts (`domain/views.ts`).

| Component | Props | Behavior | Mock |
|---|---|---|---|
| `StepTimeline` | `steps: StepView[]`, `selectedId`, `onSelect` | `<ol>`. Each step is a `ListItemButton` (`aria-current="step"`, named by the step title, described by its text state) with a state dot. Arrow keys move the selection. Memoized | run-inspector timeline |
| `BudgetMeter` | `cost: CostSummary` | Stacked bar with segments for settled (solid), estimated (hatched; legacy not-confirmed amounts fold in), and reserved, plus a **text legend with amounts** (estimates and a remaining amount that depends on them read "~$…") and `role="img"` + `aria-label` summarizing the amounts | `.meter` |
| `BudgetLedger` | `cost`, `byStep?` | `<table>` with rows reported / calculated / estimated ("~$X (estimated)") / reserved / tracked total / allowance / remaining (totals with an estimate read "~"). "Tracked by Relay" caption (§9.1) | `.ledger` |
| `BudgetBreakdownTable` | `breakdown: BudgetBreakdown` | Shows L, C, R, U, N and the total vs L with the inequality spelled out: "$3.10 > $3.00 → blocked" | new-run `budget-blocked` |
| `PlanBody` | `plan: PlanV1`, `fileScope?` | The whole plan body shared by the step panel and ApprovalCard (DUP-02): goal, steps with the findings they address, file scope, sources, suggested tests, risks, open questions | – |
| `ApprovalCard` | `approval: ApprovalView`, `plan: PlanV1`, `onDecide` | `PlanBody` (so approvers see unresolved questions, test suggestions and finding ids), and the "covers plan hash X and context snapshot Y only" line. Approve / Request revision (reveals a required textarea) / Reject. Pending states | run-inspector awaiting-approval |
| `AttemptsTable` | `attempts: AttemptView[]` | Model, dispatch state badge, tokens in/out with reported/est labels, cost + certainty, provider latency **separately from** app time (§3.3) | Attempts tab |
| `ContextManifestView` | `manifest: ContextManifest` | Files (hash, tokens, included/omitted + reason), memory (revision, stale flag), upstream artifacts, "providers receiving this context" | Context tab |
| `DiffViewer` | `files: PatchV1['files']` | Unified diff with add/del/hunk coloring **plus `+`/`-` gutter glyphs** (not color only). Virtualized beyond 500 lines. Lazy-loaded | report `patch` |
| `FileTree` | `included`, `excluded` | Excluded rows show the reason text (`secret`, `too_large`, …) | onboarding select-project |
| `MemoryRecordCard` | `record`, `selected` | Title, excerpt, type/source line, stale indicator (a `ListItemButton`) | memory list |
| `ConflictCompare` | `a`, `b`, `value`, `onValueChange`, `onSubmit`, `slots?` (per-option fields), `pending?`, `submitDisabled?` | Controlled. Side-by-side columns with the 4 resolution choices; the chosen option's slot (e.g. the combine rewrite, the two scopes) renders under them and one "Resolve conflict" submits the single form. Never merges silently | memory conflict |
| `RecoveryPanel` | `run: RunDetail`, `onDecide`, `showRequests?` | Last completed step, the requests that may not have completed with the estimate counted ("may not have been charged" note), the action buttons from `availableActions` (never a per-attempt decision) | overview interrupted / run-inspector unknown-outcome |
| `CatalogTable` | `entries: CatalogModel[]`, `catalogVersion`, `profileChecks?: Record<ModelId, CapabilityWarning[]>` | Built on `DataTable`. Columns: model (name + mono id), provider, capabilities (each shown as ✓/✗ **with text** "Yes"/"No"; glyphs `aria-hidden`), prices per MTok for input / output / cache read / cache write (via `Money`), catalog version, source (the `https://` URL shown **as text** with a `CopyButton`, not a clickable external link), and effective date (`<time>`). `profileChecks` adds a visible warnings column for per-profile capability check results | settings providers models |
| `FakeProviderBadge` | – | Persistent badge in the shell when `providerMode === 'fake'` (§22.2 honesty) | – |

## I5: Motion & performance
- Transitions use `var(--duration-fast)` for color and border changes only. There are no layout-shifting hover transforms (ui-ux-pro-max "stable hover states").
- Spinners stop under `prefers-reduced-motion` (tokens set durations to 0, and `Loader` renders statically).
- `DiffViewer` and the run-events list use `@tanstack/react-virtual`.

## I6: Component test setup (`components/ui/test-utils.tsx`)
Owned by I: `renderWithProviders()` (QueryClient + LiveRegion + Theme) and `axe` helper via `vitest-axe`. J's page tests import it.

## Unit / component tests (owned by I; `*.test.tsx` beside components; jsdom)

| File | Must cover |
|---|---|
| `tokens.test.ts` | `styles/tokens.css` byte-equal to `plans/mocks/assets/tokens.css` |
| `contrast.test.ts` | Parses tokens, computes WCAG contrast for the declared text/background pairs (text on canvas/surface/raised, muted on surface, each status fg on its bg, accent on accent-bg) in **both themes** ≥ 4.5 |
| `format/*.test.ts` | Money formatting (0, 1 µUSD, 480000, negative overrun), hash truncation, exhaustive `statusPresentation` (iterate the contracts enums, including every `PAUSE_REASONS` value; every value has a label + icon; `failed`, `cancelled`, `interrupted`, `incomplete`, and every pause reason except `user` have a non-empty `detail`) |
| `Button.test.tsx` | Pending state disables, sets aria-busy, and keeps the label |
| `StatusBadge.test.tsx` | Renders text for every run status and every paused + pause reason combination (no empty label). `showDetail` renders the detail as visible text |
| `Field.test.tsx` | Label association, `aria-describedby` includes the error id when there is an error |
| `ConfirmDialog.test.tsx` | Focus trap and return focus. Esc closes |
| `BudgetMeter.test.tsx` | Legend amounts present as text. `aria-label` summary |
| `ApprovalCard.test.tsx` | Revision requires a note (button disabled until non-empty). Hashes shown. Renders a `PlanV1` fixture that parses with the contracts schema |
| `ResponsivePanels.test.tsx` | With `matchMedia` mocked at 1100 px, the secondary panels appear as tabs after the primary tabs and are keyboard-reachable. At 1440 px they render as labelled sections, not tabs. Widening while a secondary tab is selected falls back to the first tab |
| `CatalogTable.test.tsx` | Every capability cell has visible Yes/No text. Prices use `Money` formatting. Source URL is rendered as text with a copy button and no `<a href>` to an external host. Catalog version and effective date are shown. Capability warnings render as text |
| `a11y.test.tsx` | `axe` has no violations for each component rendered in its main states (dark + light), including `ResponsivePanels` in both layouts and `CatalogTable` |

## Success Criteria (gate)
- [ ] `pnpm test:unit apps/desktop/src/renderer/components apps/desktop/src/renderer/lib apps/desktop/src/renderer/styles` → green
- [ ] `pnpm lint` → exit 0 (jsx-a11y strict, no `dangerouslySetInnerHTML`)
- [ ] ui-ux-pro-max pre-delivery checklist, all true:
  - [ ] No emojis used as icons (lucide only)
  - [ ] `cursor-pointer` on all clickable elements (base.css sets it for `button, [role=button], a, summary, label[for]`)
  - [ ] Hover states give clear feedback with 150–300 ms transitions
  - [ ] Light and dark mode text contrast ≥ 4.5:1 (`contrast.test.ts`)
  - [ ] Focus states visible (`:focus-visible` ring in base.css)
  - [ ] `prefers-reduced-motion` respected
  - [ ] Works at 1024–1440 px widths (the desktop app min width is 1024; a phone layout is not promised, §5.7). Below 1280 px, `ResponsivePanels` collapses secondary panels into tabs
  - [ ] Color is never the only indicator (StatusBadge, DiffViewer glyphs, BudgetMeter legend, CatalogTable Yes/No text)

## Review Checklist
- [ ] Every mock class in `app.css` has a component
- [ ] No component fetches data or calls `window.relay`
- [ ] No info exists only in a tooltip (hash values are also copyable, and status text is visible)
- [ ] `statusPresentation` covers every run status and every pause reason with visible text, and `failed` is visually distinct from the recoverable pauses
- [ ] Output and manifest prop types are imported from `@relay/contracts`; no component redeclares an output shape or imports `@relay/templates`
- [ ] `ResponsivePanels` hides no content at any width ≥ 1024 px
