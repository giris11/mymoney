# PROGRESS.md

Status of every Phase 1 spec feature. Updated as work lands. (Phase 2/3 items are all **not started** by design — Phase 1 gate first.)

**Legend:** ✅ done · 🟡 partial · ⬜ not started

## Build plan (Phase 1)

1. ✅ SPEC.md saved verbatim, git init, spec committed
2. ✅ Project scaffold: Vite + React + TS + Tailwind 4 + PWA + Vitest, icons, config
3. ✅ Foundation: data model + Dexie schema v1, money math, seed categories, contracts
4. ✅ Domain modules (parallel): transactions/balances, import engine, budgets, backup, reports aggregation — tests green
5. ✅ App shell: layout (sidebar / bottom tabs), hash router, theme, UI kit + shared pickers
6. ✅ Pages (parallel): Transactions register + editor + quick add, Dashboard, Budgets, Reports, Settings, Import wizard, Onboarding + sample data
7. ✅ Integration: wiring, typecheck, full test suite (258), hand-calculated golden tests
8. ✅ Adversarial review pass (7 lenses, every finding independently verified) + fixes
9. ✅ Browser verification: onboarding → sample data → quick add → budgets/periods → all reports+drill-down → MoneyWiz import → re-import dedupe (27/27 caught) → backup export → dark/light → mobile → production build with active service worker
10. ✅ Handover: dev server running, docs updated

## Phase 1 features (spec §8.1)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Accounts CRUD, groups, colours, archive, net worth header | ✅ | currency locked once used; delete blocked while referenced (archive instead) |
| 2 | Transactions CRUD, splits, transfers, refunds, pending/cleared, tags, notes | ✅ | transfer legs sync; refund = positive amount in expense category (D14) |
| 2b | Virtualised register, instant search + filters | ✅ | @tanstack/react-virtual; all seven filter axes; deep links from sidebar/reports/budgets |
| 3 | Categories (multi-level, seeded, editable), payees w/ autocomplete, tags | ✅ | payee→category learning; Settings rules list (D17) |
| 4 | Multi-currency + manual rates table | ✅ | display-time conversion only; missing rate surfaced, never guessed |
| 5 | MoneyWiz CSV import (detect, map, preview, dedupe, undo) | ✅ | verified in-browser: 27-row import, re-import → 27/27 exact duplicates auto-skipped |
| 5b | Generic CSV import with column-mapping UI + saved mappings | ✅ | mapping saved per header signature; debit/credit pairs, decimal commas, date formats |
| 6 | Budgets: per period, progress bars, over/under | ✅ | descendants included; period navigation; missing-rate chip |
| 7 | Dashboard (net worth, month income/spend, budgets, recent, top categories) | ✅ | |
| 8 | Reports ×6 with date-range picker | ✅ | category drill-down with breadcrumbs; labelled bar lists; base-currency |
| 9 | Backup export / restore / 7-day nudge | ✅ | all-or-nothing restore with typed confirmation; round-trip tested |
| 10 | PWA: installable, offline, icons, subpath-safe | 🟡 | SW + manifest + icons verified on production build; iOS per-device splash images deferred (D26) — icons/standalone/offline all in place |
| 11 | Dark/light mode, responsive, onboarding, sample data | ✅ | sample data is one undoable batch, groups labelled "Sample ·" |
| — | Test suite (spec §10) | ✅ | 258 tests: money maths, balances, import parsing incl. edge cases, dedupe + near-dups, budget periods, backup round-trip, golden hand-calculated month |

## Definition of done (spec §12) — status

Everything except the physical-iPhone steps has been machine-verified (onboarding, add/edit/delete incl. split + transfer, MoneyWiz import + duplicate detection on second import, dashboard + six reports + budgets with hand-calculated numbers, backup export→wipe→restore equality in tests, dark/light, `npm test` clean). **Left for Girish:** install on the iPhone home screen, airplane-mode check, and a real MoneyWiz export file (see below).

## Open items for Girish

- No real MoneyWiz export file was available — import built against MoneyWiz's documented CSV layout with flexible header mapping (D20) and verified against realistic fixtures. **Drop your real export in the project root** and I'll validate/adjust next session.
- `fake-indexeddb` added as a dev-only dependency for the mandated Dexie round-trip tests (D8) — flag per §11.7; say the word to remove.
- Node.js was installed user-locally (D1) since the Mac had none.
