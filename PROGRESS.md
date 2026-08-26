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
8. ✅ Adversarial review pass (7 lenses, 29 findings) + fixes — see "Review findings fixed" below
9. ✅ Browser verification: onboarding → sample data → quick add → budgets/periods → all reports+drill-down → MoneyWiz import → re-import dedupe (27/27 caught) → backup export → dark/light → mobile → production build with active service worker
10. ✅ Handover: dev server running, docs updated

## Phase 1 features (spec §8.1)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Accounts CRUD, groups, colours, archive, net worth header | ✅ | currency locked once used; delete blocked while referenced (archive instead) |
| 2 | Transactions CRUD, splits, transfers, refunds, pending/cleared, tags, notes | ✅ | transfer legs sync; refund = positive amount in expense category (D14) |
| 2b | Virtualised register, instant search + filters | ✅ | @tanstack/react-virtual; all seven filter axes; deep links from sidebar/reports/budgets |
| 3 | Categories (multi-level, seeded, editable), payees w/ autocomplete, tags | ✅ | payee→category learning; Settings rules list (D17) |
| 4 | Multi-currency + manual + **live** rates | ✅ | display-time conversion only; missing rate surfaced, never guessed. Live rates (D34) pulled forward from Phase 2 at your request: free no-key sources, LKR/INR verified end-to-end, manual rates never overwritten, offline-safe |
| 5 | MoneyWiz CSV import (detect, map, preview, dedupe, undo) | ✅ | verified in-browser: 27-row import, re-import → 27/27 exact duplicates auto-skipped |
| 5b | Generic CSV import with column-mapping UI + saved mappings | ✅ | mapping saved per header signature; debit/credit pairs, decimal commas, date formats |
| 6 | Budgets: per period, progress bars, over/under | ✅ | descendants included; period navigation; missing-rate chip |
| 7 | Dashboard (net worth, month income/spend, budgets, recent, top categories) | ✅ | |
| 8 | Reports ×6 with date-range picker | ✅ | category drill-down with breadcrumbs; labelled bar lists; base-currency |
| 9 | Backup export / restore / 7-day nudge | ✅ | all-or-nothing restore with typed confirmation; round-trip tested |
| 10 | PWA: installable, offline, icons, subpath-safe | 🟡 | SW + manifest + icons verified on production build; iOS per-device splash images deferred (D26) — icons/standalone/offline all in place |
| 11 | Dark/light mode, responsive, onboarding, sample data | ✅ | sample data is one undoable batch, groups labelled "Sample ·" |
| — | Test suite (spec §10) | ✅ | 387 tests: money maths, balances, import parsing incl. edge cases, dedupe + near-dups, budget periods, backup round-trip, golden hand-calculated month, plus 93 regression tests from the review pass |

## Definition of done (spec §12) — status

Everything except the physical-iPhone steps has been machine-verified (onboarding, add/edit/delete incl. split + transfer, MoneyWiz import + duplicate detection on second import, dashboard + six reports + budgets with hand-calculated numbers, backup export→wipe→restore equality in tests, dark/light, `npm test` clean). **Left for Girish:** install on the iPhone home screen, airplane-mode check, and a real MoneyWiz export file (see below).

## Review findings fixed (post-build hardening)

A seven-lens adversarial review found 29 issues; the ones that proved real are
fixed, each with a regression test that fails without the fix.

**Money correctness — these were the serious ones:**
- Imported transactions kept the *file's* currency while balances and net worth
  sum per account assuming the *account's* currency — a EUR row in a GBP account
  silently corrupted the balance, net worth and the net-worth chart. Now always
  stored in the account's currency, with the difference disclosed (D30).
- Amount scale was chosen before the account was known, so a ¥500 row imported
  as ¥50,000 (100x) and valid 3-decimal amounts were rejected outright (D31).
- Duplicate detection let one existing transaction absorb any number of matching
  rows, so two legitimate identical purchases in one file both vanished (D32).

**Data safety:** undo now un-teaches the payee categories the import taught;
removing sample data no longer deletes an FX rate you have since edited into
your own; backups no longer record a save the browser never confirmed (D33).

**Interaction:** a stray Escape used to close *every* open dialog — backing out
of a delete confirmation discarded the edits underneath, and closing a dropdown
inside Quick Add threw away the draft. Dialogs now stack properly, trap focus,
and return focus to whatever opened them. A misplaced click no longer discards
an in-progress import.

**Accessibility:** faint text now clears WCAG AA on every surface in both themes
(it was 3.10:1); segmented controls and colour swatches follow the ARIA radio
pattern; the pickers announce their highlighted option.

**Also added:** a date-format override for MoneyWiz imports (D20 promised it),
saved column mappings that work for headerless CSVs, and a pre-paint theme stamp
so dark mode no longer flashes white on launch (D29).

Two findings were investigated and judged **not** real: a proposed transfer-pairing
rewrite (proved equivalent to the existing code over 774 permutations) and a
QuickAdd first-open path that was already correct.

## Live exchange rates + LKR/INR (added 2026-08-26 on request)

**Currencies:** LKR added, INR was already there. Both use 100 minor units, so
the existing money math needed no change; en-GB formats them as `LKR 1,234.56`
and `₹1,234.56`. The picker was widened with regional neighbours (PKR, BDT, NPR,
MYR, PHP, IDR, AED, SAR…). Live rates cover 160+ currencies regardless.

**Live rates** are a Phase 2 item (SPEC §8.2) pulled forward at your request —
logged as D34 rather than editing your spec. What that means in practice:

- **"Real-time" = today's rate.** Free no-key providers publish once daily;
  intraday ticks exist only behind paid APIs, which the zero-cost constraint
  rules out. Daily reference rates are the right granularity for personal
  finance and what MoneyWiz uses. The UI says this plainly.
- **Two independent free sources**, both verified live at build time and both
  carrying LKR and INR, cross-checking to within 0.1%.
- **On by default**, because you asked for it — one switch in Settings → Rates
  returns the app to making no network requests at all. Onboarding now names
  that single request rather than overstating the privacy promise.
- **Rates you type are never overwritten**, in either direction; refreshes
  report which ones they kept.
- **Offline is a non-event**: saved rates stay in use, nothing is guessed.

Verified in the browser against the live API: ₹130,000.00 → £998.81 and
LKR 500,000.00 → £1,116.27, with net worth matching a hand calculation to the
penny, and a deliberately sabotaged fetch leaving every figure untouched.

## Open items for Girish

- No real MoneyWiz export file was available — import built against MoneyWiz's documented CSV layout with flexible header mapping (D20) and verified against realistic fixtures. **Drop your real export in the project root** and I'll validate/adjust next session.
- `fake-indexeddb` added as a dev-only dependency for the mandated Dexie round-trip tests (D8) — flag per §11.7; say the word to remove.
- Node.js was installed user-locally (D1) since the Mac had none.
