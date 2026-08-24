# CONTRACTS.md — module contracts & style guide for build agents

Read `SPEC.md` first (§5–§10 especially). This file pins how the pieces fit.
**Signatures in the stub files are the contract — implement them, don't change
them.** If a contract is genuinely wrong, fix it AND note it at the top of your
final report; never drift silently.

## Ground rules

- Amounts: signed integer minor units everywhere (`amountMinor`). Never float
  arithmetic on money — use helpers in `src/money/money.ts`. Conversion only at
  display/report time via `rateLookup()` from `src/domain/fx.ts`; missing rate
  ⇒ exclude + count/mark, never guess (SPEC §6).
- Dates: `'YYYY-MM-DD'` strings; compare lexicographically; dayjs for period
  maths; display via `formatDate` (en-GB).
- IDs: `uid()` from `src/lib/util.ts`. Timestamps: `nowISO()`.
- DB access: import `db` from `src/db/db.ts`. Multi-step writes MUST be a
  single `db.transaction('rw', ...)`. Never `localStorage` for records.
- Transfers: `transferGroupId` linking two legs, `categoryId: null`, from-leg
  negative / to-leg positive, each leg in its own account's currency, both
  amounts explicit (SPEC §5). Excluded from income/spend/budget reports (D13).
- Refunds: positive amount in an expense category (D14) — spend figures are net
  of refunds and reported as positive numbers.
- Splits: non-empty `splits[]` must sum exactly to `amountMinor`; enforce on
  save and in the UI (SPEC §6). Reports/budgets attribute split transactions by
  each split's category.
- Pending transactions count in balances and reports (D15).
- `dedupeHash`: recompute on every transaction save via
  `makeDedupeHash(accountId, date, amountMinor, payeeName-or-description)`.
- Errors: throw `ValidationError` (from `src/domain/transactions.ts`) for user
  mistakes; UI catches and shows the message.
- **Dexie trap**: IndexedDB indexes never contain `null`/`undefined` — a
  `where('field').equals(x)` query can only find records where the field is a
  real value. To find records with a null field, use `.filter()` (or query a
  compound differently). This applies to `parentId`, `groupId`, `categoryId`,
  `payeeId`, `transferGroupId`, `importBatchId`.

## React / UI rules

- Subscribe to data with `useLive(() => …, [deps])` from `src/db/useLive.ts`;
  it re-runs when the touched Dexie tables change. Write via domain functions —
  the UI never hand-rolls multi-step Dexie writes.
- Routing: `useRoute()` / `navigate()` / `href()` from `src/ui/router.ts`.
  Paths: `/dashboard`, `/transactions`, `/budgets`, `/reports`, `/settings`
  (+ `/settings/<section>` subroutes are yours to define within your page).
  Query params via `route.params` (e.g. `/transactions?account=<id>`).
- Kit: use `src/ui/kit/kit.tsx` (Button, IconButton, Input, Select, Checkbox,
  Field, Segmented, Modal, ConfirmDialog, Amount, MoneyInput, ProgressBar,
  EmptyState, Chip, Card), `toast.tsx` (`useToast`), `icons.tsx`. Shared form
  widgets also exist — use them, don't rebuild them:
  `CategoryPicker.tsx` (CategoryPicker single-select + CategoryMultiSelect for
  budgets), `PayeeInput.tsx` (combobox, `onPick` hands you the payee with its
  learned defaultCategoryId), `TagsInput.tsx` (chip input by tag NAME),
  `DateRangePicker.tsx` (DateRangePicker + `defaultRange()`/`presetRange()`,
  exports `DateRangeValue`). Don't duplicate these; add page-local components
  inside your own folder.
- Styling: Tailwind with the SEMANTIC palette only — `bg-bg`, `bg-surface`,
  `bg-surface2`, `text-text`, `text-muted`, `text-faint`, `border-border`,
  `text-accent`/`bg-accent`/`text-on-accent`, `text-pos`, `text-neg`,
  `text-warn`, `text-danger`. Never hard-code hex colours in UI (account/
  category `colour` values from data are the exception, via inline style).
  Money columns get class `tnum`. Mobile-first; `lg:` is the desktop
  breakpoint; the main area scrolls, pages add their own padding (`p-4 lg:p-6`).
- Accessibility: every input inside `Field` (or with an explicit label/
  aria-label); dialogs via `Modal`; destructive actions via `ConfirmDialog`;
  icon-only buttons via `IconButton` (label required).
- Charts (Reports/Dashboard) — Recharts, binding rules:
  - **Every mark is direct-labelled** (name + formatted value visible without
    hover): category/payee/tag spend renders as a labelled horizontal-bar
    list, never an unlabelled pie. This is the accessibility relief for
    entity-coloured marks — non-negotiable.
  - **One axis per chart.** Never dual y-scales.
  - Colour by meaning: category/account marks use the entity's own `colour`;
    income = `var(--c-pos)`, expense = `var(--c-neg)`, net-worth/cash-flow
    lines = `var(--c-accent)`. Text (labels, values, axes, legends) always
    uses text tokens (`var(--c-text)`/`var(--c-muted)`), never series colour.
  - Marks: lines 2px with dot radius ≥3 on hover; bars thin with 4px rounded
    ends and gaps between them; grid/axes recessive
    (`stroke="var(--c-border)"`, tick fill `var(--c-muted)`, no vertical
    grid on time charts).
  - Tooltips on every plot: `contentStyle` with surface/border/text vars,
    values via `formatMinor`. Months displayed as "MMM YYYY".
  - Y-axis money ticks: compact ("£1.2k") via a shared formatter you write
    locally; never raw minor units.
- Currency formatting: `formatMinor` / `<Amount/>`. The base currency for
  totals comes from `getSettings()`.

## Who owns which files

Each agent owns ONLY its listed files (create freely inside your own folders).
Shared/foundation files (db, money, kit, layout, router, App.tsx) are
read-only for agents — if one blocks you, report it instead of editing it.

| Area | Files |
|---|---|
| Domain: transactions | `src/domain/transactions.ts`, `src/domain/payees.ts`, `src/domain/tags.ts`, `src/domain/categories.ts`, `src/domain/balances.ts`, tests |
| Domain: budgets | `src/domain/budgets.ts`, tests |
| Import engine | `src/import/{moneywiz,generic,dedupe,importer}.ts`, `src/domain/sample.ts`, `tests/fixtures/*`, tests |
| Backup | `src/backup/backup.ts`, tests |
| Reports engine | `src/reports/aggregate.ts`, tests |
| UI: Transactions | `src/ui/pages/Transactions.tsx`, `src/ui/quickadd/QuickAddSheet.tsx`, `src/ui/tx/**` (new) |
| UI: Dashboard | `src/ui/pages/Dashboard.tsx`, `src/ui/dashboard/**` (new) |
| UI: Budgets | `src/ui/pages/Budgets.tsx`, `src/ui/budgets/**` (new) |
| UI: Reports | `src/ui/pages/Reports.tsx`, `src/ui/reports/**` (new) |
| UI: Settings | `src/ui/pages/Settings.tsx`, `src/ui/settings/**` (new) |
| UI: Import wizard | `src/ui/import/**` |
| UI: Onboarding | `src/ui/pages/Onboarding.tsx`, `src/ui/onboarding/**` (new) |

## Cross-page contracts

- `QuickAddSheet` (`src/ui/quickadd/QuickAddSheet.tsx`): default export,
  props `{ open, onClose }`. Mounted once in App; other pages only navigate or
  rely on the FAB.
- `ImportWizard` (`src/ui/import/ImportWizard.tsx`): default export, props
  `{ onDone, onCancel }`, rendered inside a page/modal by Settings and
  Onboarding.
- Deep links other pages may use: `/transactions?account=<id>`,
  `/transactions?category=<id>`, `/transactions?payee=<id>`,
  `/transactions?tag=<id>`, `/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD`
  (combinable). The Transactions page must honour these on load.
- Reports deep link: `/reports?report=<net-worth|by-category|income-expense|cash-flow|by-payee|by-tag>`.

## Testing

- Vitest, environment node. Dexie tests: `import 'fake-indexeddb/auto'` FIRST
  in the test file, then `db`; reset between tests with
  `await Promise.all(db.tables.map(t => t.clear()))` (delete/reopen also fine).
- Test files live next to sources (`*.test.ts`) or under `tests/`.
- Run ONLY your own tests while iterating:
  `PATH="$HOME/.local/node/bin:$PATH" npx vitest run <paths>`.
  Others' failures are not yours to fix; the integrator runs the full suite.
- Don't run `npm run dev`, `npm run build`, or `tsc` on the whole repo —
  concurrent agents share the tree; the integrator handles whole-repo checks.
