# PROGRESS.md

Status of every Phase 1 spec feature. Updated as work lands. (Phase 2/3 items are all **not started** by design — Phase 1 gate first.)

**Legend:** ✅ done · 🟡 partial · ⬜ not started

## Where this project is now (2026-09-01)

**The PWA is unchanged, live, and still the only thing holding the real book.**
1,130 tests pass, `tsc` is clean, nothing has been migrated, moved or turned
off. Sync remains **HELD in code** (`src/sync/held.ts`) four rounds in — it has
never run against real data and still awaits a review pass over the Dropbox
rebuild.

**A native iOS/macOS rewrite is being attempted alongside it** (D46). It has its
own phase numbering — **native Phase 0, 1, 2 — which is NOT SPEC §8's Phase
1/2/3.** Status of its gates:

| native phase | what it was | gate | result |
|---|---|---|---|
| 0 | freeze a real backup that proves itself; build an oracle a port can be held to | 279 fixture cases exist, 267 hand-calculated; the frozen file's manifest and content hash are pinned | **passed** |
| 1 | find out whether CloudKit can sync a ledger without silently losing rows, **before** any port begins | "no silent loss in any scripted scenario, and every conflict surfaces with all three record versions" | **FAILED**, on the delete path |
| 2 | restate the money rules in Swift and hold them to the oracle and the frozen file | all 279 oracle cases pass; every account balance recomputed from the rows; a re-export byte-identical to the frozen file | **passed** |

**The native Phase 1 gate failed, and the failure is worth stating plainly.**
Three of eleven scripted CloudKit scenarios destroyed data with **no error, no
event, no throw and no log line** — a stale delete overwrote an unseen edit, a
three-generations-stale delete was indistinguishable from a current one, and a
stale edit *resurrected* a deleted record. All three are delete-adjacent, and
none is reachable by handling errors better, because CloudKit produces no error:
`deleteRecord` carries a record id and nothing else, so there is no
optimistic-concurrency check to fail. This is fixable above CloudKit — a ledger
must never hard-delete, and deletion becomes a save of a tombstone (D48) — but
it is app-level work CloudKit does not do for you, it is invisible until it
costs a transaction, and **CloudKit's conflict handling does not count as solved
until tombstones exist and are under permanent automated test.** The second half
of the gate did pass, conditionally: every *edit* conflict surfaced with client,
server and a correctly populated ancestor, provided the whole `CKRecord` is
cached rather than its system fields (D47).

Nothing about the native work has touched the real data. The frozen backup was
opened read-only and is byte-identical afterwards, still `chmod 444`. The Swift
package is untracked (`native/`, not committed), and no account name, payee,
balance, total or hash from the real book appears in it or in these docs.

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

## The native rewrite (Swift, iOS/macOS) — 2026-09-01

Why this is being attempted at all, what it buys and what it costs is D46. The
short version: replication becomes the platform's problem instead of ours,
storage stops being a cache the browser may evict, and four pieces of
hand-written security code (PKCE flow, refresh-token store, compare-and-swap
write discipline, causal-ancestry conflict engine — 4,078 lines under
`src/sync/`) stop existing. Against that: Apple-only forever, and every bit of
the reconciliation that proves the money correct has to be earned again from
zero. **And the honest counter-argument is that the PWA works and the storage
risk has not materialised.**

### Native Phase 0 — the frozen file and the oracle · **done**

- A backup of the real book was taken, verified, and frozen **read-only**
  (`chmod 444`) outside the repository. Its manifest and canonical content hash
  are recorded outside the file itself, so it can be proved unchanged rather
  than assumed unchanged.
- `tools/oracle/cases/*.json` — **279 cases, 267 of them hand-calculated** (not
  generated from our own code) across money, fx, balances, budgets, reports and
  import. `tools/oracle/README.md` documents the format and is explicit about
  what it does **not** cover.
- The web app's own suite regenerates and byte-compares those cases, so they
  cannot drift from the TypeScript unnoticed.

### Native Phase 1 — the CloudKit probe · **gate FAILED (delete path)**

Throwaway app at `~/CloudKitProbe` driving a real CloudKit container with **50
fabricated rows**. No real financial data was read; nothing under
`/Users/gs/MyMoney/` was opened by it. Full log: `~/CloudKitProbe/results.log`.

| scenario | question | result |
|---|---|---|
| S1 / S1b | 50 records land intact; does money survive? | **not lost** — 50/50 identical; `Int64` exact at 2^53+1, −(2^53+1) and `Int64.max`, `objCType 'q'` (D50) |
| S2 | concurrent edit, same field | **not lost (loud)** — code 14 with client, server *and* a fully populated ancestor |
| S2c | concurrent edit, different fields | **not lost** — true three-way merge, both edits kept, no user involvement |
| S3a | remote delete vs local edit (tag cached) | **not lost** — refused and surfaced |
| S3b | local delete vs remote edit | ***LOST*** — peer's edit destroyed, zero errors, zero events |
| S3c | stale edit onto a deleted record, no cached tag | ***LOST*** — silent **resurrection** of a deleted row |
| S3d | 3-generations-stale delete vs current delete | ***LOST*** — identical outcomes, indistinguishable |
| S4a/S4b | `SIGKILL` mid-sync, then relaunch | **not lost** — 20/20 recovered, but as 20 *phantom self-conflicts* (D49) |
| S5 | rolled-back device | **not lost** — heals, provided rows and state serialization roll back together |
| S6 / S6b | 50 at once, then 600 | **not lost** — batches self-cap at 250; capping in the app was slower, not safer (D51) |
| anc / 2X | 13-variant ancestor matrix, three runs | the rule in D47: cache the whole record, not `encodeSystemFields` |

**Gate:** *"no silent loss in any scripted scenario, and every conflict surfaces
with all three record versions."*

- **Second clause: PASS**, conditionally — every edit conflict surfaced with
  client, server and a correctly populated ancestor, including after 12
  intervening generations, **provided the whole `CKRecord` is cached**. With
  `encodeSystemFields` the ancestor arrives with zero data keys and the merge
  silently degrades to a coin flip (D47).
- **First clause: FAIL.** S3b, S3c and S3d lost data with no signal of any kind.
- **Overall: FAIL, on the delete path.** Fixable above CloudKit with tombstones
  (D48), not by better error handling — there is no error to handle.

**What remains before this phase can be called passed:** tombstone records so
every delete is a save; the same three scenarios re-run against them; a
permanent test for the populated ancestor (Apple promises nothing about it);
phantom-self-conflict suppression after a crash; and `atomicByZone` /
state-serialization persistence handled for a first sync measured in minutes.

Incidentally established, because it cost an afternoon: the Team ID is
**AQ5Z6U57L5** (`D9URF77Y76` is the certificate's per-person identifier, not a
team id), and `CKContainer(identifier:)` **SIGTRAPs** the process if it is not
entitled for that container rather than throwing or returning nil.

### Native Phase 2 — `MyMoneyKit`, the money rules in Swift · **gate PASSED**

`/Users/gs/MyMoney/native/` — a dependency-free Swift 6 package (macOS 14+ /
iOS 17+, strict concurrency). **142 tests in 19 suites**, clean `swift build`
and `swift test` from a `rm -rf .build` rebuild, zero warnings. Library and
tests only: no app, no UI, no persistence, no sync.

| check | result |
|---|---|
| all 279 oracle cases, read from `tools/oracle/cases/` at test time, nothing copied | **279/279 pass** — money 71, fx 25, balances 16, budgets 45, reports 27, import 95 |
| coverage asserted, not assumed (a new TypeScript case turns the Swift suite red rather than going unrun) | in place |
| every account's closing balance recomputed **from the transaction rows** vs the file's own per-account figures | **58 of 58 exact**, zero mismatches |
| net worth recomputed from those balances at the file's own rates | equals the manifest; no missing-rate currencies |
| **re-export**: parsed document discarded, file rebuilt from the decoded Swift records, canonical content hash compared | **equal to the hash the browser computed** |
| stronger than the hash: whole-file **byte-for-byte** comparison | **identical**, every byte |
| the gate can go red: three deliberate sabotages | each produced its own distinct, named failure |

The gate is **env-gated and skips without the frozen file** (and on a stale
path), because this repository is public — every expectation is read out of the
file's own manifest, so the test states no balance, no total and no hash. The
frozen file was opened read-only and is byte-identical afterwards.

Two findings from driving the real book that are not in the oracle:
- **No amount in the book exceeds 2^53, and every split sums exactly to its
  parent.** Both were checked, not assumed.
- **`netWorth()` and `netWorthSeries()` round at different granularity**, so the
  headline figure and the right-hand end of the chart disagree by pennies on a
  book with two accounts in one foreign currency. The oracle cannot see it —
  its fixture books have one account per currency. Swift reproduces both
  behaviours faithfully rather than reconciling them (D54). **Open question for
  Girish; not a decision taken.**

**Judgement calls that a port silently gets wrong** are D53: JS-vs-Swift string
comparison *and equality*, sort stability, locale tiebreaks (a flagged guess —
the oracle does not exercise them), spelled-out character classes instead of
ICU regex, UTF-16 code-unit lengths, and preserved float operand order. Three
deliberate departures: the 2^53 parse ceiling is `Int64.max` instead (3 of 171
parity inputs differ, and the count is asserted), overflow refuses rather than
wraps, and duplicate ids are refused while non-summing splits are only warned.

### What is NOT built, and what each would take

| missing | note |
|---|---|
| **Tombstones and the delete path** | the native Phase 1 gate failure. Must exist and be tested before CloudKit counts as solved (D48) |
| **Persistence (SQLite)** | must keep the tri-state on optional fields, or the app cannot write a byte-identical file for a book the browser wrote (D52) |
| **Sync** | nothing is ported. The probe is a throwaway, not a foundation |
| `buildImportPlan` / `commitImport` / `undoImport` | the biggest gap, ~900 lines of TypeScript, and it has a live consequence: the parsers scale amounts at a *guessed* currency, so a 0- or 3-decimal currency read through the Swift parsers alone is only provisionally scaled until the plan builder lands |
| Write paths (`saveTransaction`, `saveTransfer`, `saveBudget`, `saveCategory`, `findOrCreateByPath`, `deleteCategory`) | the oracle states what the arithmetic *produces*, not what the app *accepts*; these need their own tests for split-must-sum, transfer-legs-in-step and undo |
| Backup **writing** to a destination | the writer exists and is hash-exact; what is missing is a file picker and share sheet |
| `allBudgetProgress`, `buildTree`, `categoryTree`, `fileSignature` | small, unused by the oracle, omitted rather than written untested |
| UI, charts, migration of the real book | out of scope for these phases by design |

**Not committed.** `native/` is untracked. `npm test` (1,130) and
`npx tsc --noEmit` still pass; nothing outside `native/` was modified by the
native work.

## Open items for Girish

**On the PWA:**

- **Sync is HELD in code and has never run.** The bullet that used to sit here
  told you to connect Google Drive; that is out of date — Drive was abandoned
  for Dropbox (D44/D45), and the hold (`src/sync/held.ts`) stays until a review
  pass over the *new* design comes back empty. It is green, which is exactly
  what the three previous rounds were.
- **No test drives the engine and the real transport together.** Engine tests
  fake the transport; transport tests fake `fetch`. The seam between them is the
  one place a defect could still hide.
- **Net-worth exclusion is built but nothing is excluded yet.** The property,
  the gift cards and the Money Lent & Owed group are all still counted in the
  headline figure. Tell me which should come out and I'll apply it — it changes
  only the total, never a balance or a transaction. (Names and amounts that used
  to be spelled out in this bullet have been removed: this repository is public.
  They are still in the git history, which is worth knowing about.)
- **`netWorth()` and `netWorthSeries()` disagree by pennies** on your book,
  because one rounds per account and the other per currency (D54). Neither
  number is stored and both are defensible, so this is your call, not mine —
  but the dashboard total and the right-hand end of the chart do not match, and
  it gets worse as more accounts share a currency.

**On the native rewrite:**

- **The native direction itself is the open question.** D46 lays out the case
  both ways, including the strongest argument against: the PWA works and the
  storage risk has not materialised. Nothing has been migrated and nothing is
  committed; saying no costs only the Swift package.
- **Tombstones are the gate the native work has not passed.** CloudKit deletes
  are unprotected and lose data silently (D48). No port should go further until
  soft-delete tombstones exist and the three losing scenarios are re-run green
  against them.
- **The `localeCompare` tiebreak in the Swift port is a guess.** It is pinned to
  `en_GB` where the browser supplies its own locale, the oracle does not
  exercise it, and it is flagged as a guess in the code rather than presented as
  a port (D53).
- **`~/CloudKitProbe` is a throwaway.** Delete it when it stops being useful;
  `results.log` is the part worth keeping, and its conclusions are recorded as
  D47–D51 so the log itself is not load-bearing.
**Standing flags:**

- `fake-indexeddb` added as a dev-only dependency for the mandated Dexie round-trip tests (D8) — flag per §11.7; say the word to remove.
- Node.js was installed user-locally (D1) since the Mac had none.
