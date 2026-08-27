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
| — | Test suite (spec §10) | ✅ | 852 tests: money maths, balances, import parsing incl. edge cases, dedupe + near-dups, budget periods, backup round-trip, golden hand-calculated month, plus 93 regression tests from the review pass |

## Definition of done (spec §12) — status

Everything except the physical-iPhone steps has been machine-verified (onboarding, add/edit/delete incl. split + transfer, MoneyWiz import + duplicate detection on second import, dashboard + six reports + budgets with hand-calculated numbers, backup export→wipe→restore equality in tests, dark/light, `npm test` clean). **Left for Girish:** install on the iPhone home screen and the airplane-mode check. (The real MoneyWiz export has since been imported and reconciled — see below.)

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

## Live deployment and post-handover features (2026-08-26)

**The app is live at https://giris11.github.io/mymoney/** (public repo
`giris11/mymoney`, deployed by GitHub Actions which runs the full suite before
publishing). HTTPS means the service worker registers, so it is a genuinely
installable, offline-capable PWA — the LAN-http route never could be.

**Girish's real MoneyWiz history is imported and verified**: 58 accounts,
5,127 transactions, net worth £429,327.86. Every account balance was checked
against the export — 58/58 exact — and re-checked after grouping: still 58/58.

Added on request after he started using it:
| Feature | Notes |
|---|---|
| MoneyWiz **Report** export format | His real export uses a different layout to the flat one originally built (per-account header rows, `sep=` preamble, `Account` column meaning currency on header rows). Opening balances derived so every closing balance matches (D30–D31 apply; format work in `moneywizReport.ts`) |
| Live exchange rates | Free, no-key sources; LKR + INR + TRY (D34) |
| Account grouping | Ten MoneyWiz-style groups, inferred from names with confidence flags (D38) |
| Exclude from net worth | Per account or whole group (D39) |
| Duplicate transaction | From row or editor, dated today with an original-date escape (D40) |
| Working Back/Forward | Register filters and report drill-down live in the URL (D41) |
| Google Drive sync | Your own Drive, your own Google credentials, `drive.file` scope (D42) |

**Browser-verified on the live site**: grouping applied without moving any
balance; Back returns from a filtered view (8 rows → 321); duplicate opens a
prefilled copy with the date-difference note; CI green on every deploy.

## Google Drive sync (2026-08-27)

Built because opening the live site in a second browser showed onboarding again.
Nothing was lost — browser storage is per-origin *and* per-browser, so Chrome and
Safari each hold their own database — but "restore from a backup file every time
I switch browser" is not a workable answer, so sync was pulled forward from
Phase 3 (SPEC §8.3), logged as D42.

> **SUPERSEDED BY D44/D45.** Sync now runs on Dropbox, not Google Drive, and
> `docs/DRIVE-SETUP.md` has become `docs/DROPBOX-SETUP.md`. The two paragraphs
> below describe the Drive design as it stood, and are left as the record of
> it; what is true today is that MyMoney ships its own public Dropbox app key,
> nothing is pasted in to set a device up, and the app is registered for App
> folder access so it can see only the folder Dropbox creates for it. Sync is
> HELD (`src/sync/held.ts`) either way.

**It runs on your own Google credentials.** No account, no server, no shipped
secret: the app talks to Google as you, using a client id from your own Google
Cloud project, and stores one file in your own Drive. Setup on this Mac is
already done — project `mymoney-506723`, Drive API on, consent screen complete,
app **published** so the grant never expires. The client id lives in
Settings → Sync; `docs/DROPBOX-SETUP.md` is the current equivalent.

**Permission is `drive.file`** — an app can only see files it created itself. It
cannot list, open or touch anything else in your Drive, and because that scope is
non-sensitive Google requires no review and no fee, ever. A test fails if the
scope is ever widened.

**If two devices both changed, it asks.** There is no last-write-wins and no
timestamp tie-break. You see each side with its device name, time and row
counts, and the copy you do not keep is written to a restorable backup file
first — if that write fails, the whole resolution is abandoned rather than
proceeding. Choosing nothing changes nothing.

**Privacy line, updated honestly:** Google is now a second outbound host after
the rates provider. The app's claim is "no external requests except exchange
rates, and your own Drive when you switch it on". Both are switchable off, and
with both off it makes no network requests at all.

Building it caught a real latent bug: `updateSettings` read-modify-wrote outside
a transaction, so a concurrent write could be silently lost — in the sync path
that could mark a device clean while it still held unsynced changes, and the
next pull would overwrite them. Now atomic, with a test that fails without it.

### It was reviewed before you trusted it, and it failed

Sync is the first feature in this app that can destroy data, so it was put
through an adversarial review — six independent lenses, every finding then given
to two skeptics whose job was to refute it. Eighteen defects were raised;
**seventeen were confirmed**, several reproduced against the real engine. Sync
as first shipped could have lost your transactions. Nothing was lost, because it
never ran.

The fatal one: the code compared Drive's *revision number* to decide whether the
remote was the one it descended from. Two devices could both write "revision 2"
holding different books, and the loser would read the numbers as equal, report
**"up to date"**, and let the next sync quietly pull its own rows away — no
conflict dialog, no safety file. Also confirmed: a transaction typed while a
sync was downloading got applied over and the evidence erased; the "we save the
losing copy first" promise went through a browser download whose success cannot
be observed (on iOS Safari, routinely nothing saved) before destroying the book;
changing your base currency never synced and got silently reverted; and
restoring a conflict backup handed the browser the *other* device's identity.

**All seventeen are fixed** (D43). Snapshots now carry real causal ancestry — an
id and its parent — so the question is "is this the remote I descend from?"
rather than "is this number the number I remember". A clean device that diverged
now raises a conflict instead of a silent pull, because it may be holding the
only copy. The safety backup goes somewhere its success can actually be
confirmed. Each fix was falsified by mutation: switching a guard off reproduces
exactly its own defect and nothing else. **852 → 972 tests**, tsc and build
clean.

**Status:** fixed, deployed, CI green. Still awaiting your one-time approval in
Google's own consent window (that click is yours, not mine), then a first
"Sync now" and a two-browser check.

**Two things to know before the first sync:**
- **"Sync automatically" is deliberately off and now says so.** It was a dead
  switch — nothing ever called sync on its own. Turning on unattended syncing is
  your call, not one to make for you, so it tells the truth and waits.
- **If `mymoney-sync.json` is ever deleted from Drive, the app will not quietly
  start over.** It used to re-seed a second file at revision 1, leaving devices
  comparing two unrelated histories as though they were one. Now it stops and
  says the file is gone, and offers a **"Start a new sync file from this
  device"** button behind a confirmation — the choice is yours to make
  explicitly, never one the app makes for you.

## Open items for Girish

- **Drive sync is reviewed, fixed and not yet connected.** Press Connect on
  Settings → Sync, approve in Google's window (it will warn the app is
  "unverified" — it is yours, and the warning is what Google shows for any app
  it has not reviewed), then Sync now.
- **No test drives the engine and the real transport together.** Engine tests
  fake the transport; transport tests fake `fetch`. The seam between them is the
  one place a defect could still hide.
- **Net-worth exclusion is built but nothing is excluded yet.** 68 Saint's Mary
  Drive (£90,000), the gift cards and Money Lent & Owed are all still counted
  inside the £429,327.86. Tell me which should come out and I'll apply it —
  it changes only the total, never a balance or a transaction.
- `fake-indexeddb` added as a dev-only dependency for the mandated Dexie round-trip tests (D8) — flag per §11.7; say the word to remove.
- Node.js was installed user-locally (D1) since the Mac had none.
