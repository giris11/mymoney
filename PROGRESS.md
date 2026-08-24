# PROGRESS.md

Status of every Phase 1 spec feature. Updated as work lands. (Phase 2/3 items are all **not started** by design — Phase 1 gate first.)

**Legend:** ✅ done · 🟡 partial · ⬜ not started

## Build plan (Phase 1)

1. ✅ SPEC.md saved verbatim, git init, spec committed
2. ⬜ Project scaffold: Vite + React + TS + Tailwind 4 + PWA + Vitest, icons, config
3. ⬜ Foundation: data model + Dexie schema v1, money math, seed categories, contracts
4. ⬜ Domain modules (parallel): transactions/balances, import engine, budgets, backup, reports aggregation — each with tests
5. ⬜ App shell: layout (sidebar / bottom tabs), hash router, theme, UI kit
6. ⬜ Pages (parallel): Transactions register + editor + quick add, Dashboard, Budgets, Reports, Settings, Import wizard, Onboarding + sample data
7. ⬜ Integration: wiring, typecheck, full test suite, hand-calculated golden tests
8. ⬜ Adversarial review pass (money correctness, import edge cases, spec compliance) + fixes
9. ⬜ Browser verification: onboarding → transactions → import → reports → dark mode → PWA build
10. ⬜ Handover: dev server running, docs updated

## Phase 1 features (spec §8.1)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Accounts CRUD, groups, colours, archive, net worth header | ⬜ | |
| 2 | Transactions CRUD, splits, transfers, refunds, pending/cleared, tags, notes | ⬜ | |
| 2b | Virtualised register, instant search + filters | ⬜ | |
| 3 | Categories (multi-level, seeded, editable), payees w/ autocomplete, tags | ⬜ | |
| 4 | Multi-currency + manual rates table | ⬜ | |
| 5 | MoneyWiz CSV import (detect, map, preview, dedupe, undo) | ⬜ | |
| 5b | Generic CSV import with column-mapping UI + saved mappings | ⬜ | |
| 6 | Budgets: per period, progress bars, over/under | ⬜ | |
| 7 | Dashboard (net worth, month income/spend, budgets, recent, top categories) | ⬜ | |
| 8 | Reports ×6 with date-range picker | ⬜ | |
| 9 | Backup export / restore / 7-day nudge | ⬜ | |
| 10 | PWA: installable, offline, icons, subpath-safe | ⬜ | iOS splash images deferred (D26) |
| 11 | Dark/light mode, responsive, onboarding, sample data | ⬜ | |
| — | Test suite (spec §10) | ⬜ | |

## Open items for Girish

- No real MoneyWiz export file was in the repo — import built against MoneyWiz's documented CSV layout with flexible header mapping (D20). **Drop your real export in the project root** and I'll validate/adjust in the next session.
