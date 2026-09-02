# MyMoneyKit

The money rules of the MyMoney PWA, restated in Swift, a local SQLite store to
hold them, and — in `App/` — a small **read-only** SwiftUI app for iOS and macOS
that shows the result. The package is still where correctness is won; the app
only draws what the package computes and contains no arithmetic of its own.

## Where this sits

This package is **native Phase 2**. That numbering is the native project's own
and is *not* SPEC §8's Phase 1/2/3:

- **Phase 0** froze a read-only copy of the real backup and built the oracle in
  `../tools/oracle/` — 279 cases then, 284 now, 272 of them hand-calculated, so
  a port can be held to something that was not generated from the code it is
  checking. (The five added since were the answer to a defect the first 279
  could not see: every book had at most one counted account per currency.)
- **Phase 1** was a throwaway CloudKit probe (`~/CloudKitProbe`) run against a
  real container with fabricated rows, to find out whether CKSyncEngine can
  sync a ledger without silently losing rows. **Its gate failed on the delete
  path** — see the last section here, and D47–D51 in `../DECISIONS.md`.
- **Phase 2** was the money rules restated in Swift and held to the oracle and
  to the frozen file.
- **Phase 3** is `Sources/MyMoneyKit/Store/`: persistence, on the system
  libsqlite3, with no third-party dependency. Soft delete from the first
  migration, and one property standing over the whole thing — a backup imported
  into the store and exported back out reproduces the **same canonical content
  hash**.

Why a native rewrite is being attempted at all — what it buys, what it costs,
and the strongest argument against it — is **D46** in `../DECISIONS.md`. The
port's judgement calls are **D52–D54**. Read those before changing anything
here; several files are the way they are because of a decision recorded there
rather than because of a Swift preference.

```
swift build
swift test
```

No dependencies, so both work offline from a clean checkout.

### Building the apps with warnings as errors

The package is held to it with `swift build -Xswiftc -warnings-as-errors`. The
**apps** need one extra setting, and it is not optional:

```
xcodebuild -project App/MyMoneyNative.xcodeproj -scheme MyMoneyNative \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  SWIFT_TREAT_WARNINGS_AS_ERRORS=YES GCC_TREAT_WARNINGS_AS_ERRORS=YES \
  SWIFT_SUPPRESS_WARNINGS=NO \
  build
```

**Why `SWIFT_SUPPRESS_WARNINGS=NO` is there.** Xcode compiles a package
dependency with `-suppress-warnings` by default, so that somebody else's
warnings do not fill your build log. `MyMoneyKit` is a package dependency of
this project even though it is the same repository — so a command-line
`SWIFT_TREAT_WARNINGS_AS_ERRORS=YES`, which applies to every target, hands the
package both flags at once and the build fails outright with

```
error: conflicting options '-warnings-as-errors' and '-suppress-warnings'
```

That is a **failure, not a pass** — four builds that exit 65 having compiled
nothing look very like four clean builds if only the warning count is read.
`SWIFT_SUPPRESS_WARNINGS=NO` un-suppresses the package, which is also the
stricter reading: the kit is compiled warnings-as-errors here as well as under
`swift build`.

Run it for `Debug` and `Release`, and for `-destination 'platform=macOS'` as
well as the simulator: a warning that only Release emits is still a warning.

## What is in it

| area | what it decides |
|---|---|
| `Money/` | Int64 minor units; parsing, exact formatting, per-currency precision, half-away-from-zero rounding, split summing |
| `Money/FX.swift` | display-time conversion, rate direction, the missing-rate outcome |
| `Model/` | the record types from `src/db/types.ts`, decoded from JSON without losing an integer |
| `JSON/` | a strict parser, the canonical form, ECMAScript number printing, SHA-256 |
| `Backup/` | `src/backup/`'s format, both ways: validation, the versioned manifest (v1 means per-account net worth, v2 per-currency), the content fingerprint, and writing a file back out of the records |
| `Domain/Balances.swift` | account balances and net worth — totalled per currency and converted once — with archived and excluded accounts out of the total and still holding their real balance |
| `Domain/CalendarDate.swift` | a calendar date with no timezone, and dayjs's month-end clamping |
| `Domain/Categories.swift` | the rollup primitive: a category plus every descendant |
| `Domain/Budgets.swift` | period windows that tile the timeline, and spend against them |
| `Reports/` | the six report aggregations, in base currency, transfers excluded |
| `Import/` | CSV reading, per-file date and decimal detection, dedupe keys, the two MoneyWiz layouts |
| `Schedule/` | standing arrangements: the occurrence grid (built on `Insights/Cadence.swift`, never a second copy of it), what is due, the below-zero projection, and the local reminder plan |
| `Store/` | the SQLite ledger: a schema mirroring the model, money as INTEGER minor units that SQLite cannot turn into a float, tombstones on every deletable row, versioned migrations, and an atomic all-or-nothing restore |

Each file's header comment explains why it is the way it is, including which
alternative was rejected. Start there rather than here.

## What the tests are

`Tests/MyMoneyKitTests/OracleTests.swift` runs the **real fixtures** in
`../tools/oracle/cases` — **all 284 cases across all six files**: money (71),
fx (25), balances (19), budgets (45), reports (29) and import (95). Nothing is
copied; the same files the TypeScript suite regenerates and byte-compares are
read from the repository at test time.

Coverage is asserted rather than assumed. `everyCaseDispatches` fails if any
case names an op the harness cannot run, and `theOracleIsWhatWeThinkItIs` fails
if the file set, the case counts or the provenance mix move — so a case added
on the TypeScript side turns this suite red instead of quietly going unrun.

Where the oracle itself marks a field **advisory** — `money.formatMinor`'s
glyphs, the import parsers' warning *prose* — that is honoured and said out loud
at the point of comparison. The number, the count and the ordering are always
exact; nothing is relaxed to make something pass.

Everything else is either a case the oracle cannot reach (Int64 past 2^53,
overflow, ordering ties, whether budget windows tile the timeline for a decade,
whether excluding an account changes a spend report) or a cross-implementation
check whose expectations were captured from the browser's own
`src/backup/canonical.ts`.

### The store's own tests

Seven suites, none of which touch the owner's data:

| suite | what it pins |
|---|---|
| `StoreSchemaTests` | every table is `STRICT`, every money column is `ANY` + typeof CHECK and is listed in `StoreSchema.moneyColumns`, every deletable table has a tombstone and a filtering view — and **a store at the older schema opens, upgrades, and keeps its money exact** |
| `StoreTypeAffinityTests` | each of SQLite's four coercion behaviours, measured; each of the four defences, fired |
| `StoreRoundTripTests` | the content-hash property, plus the three fidelity traps: a tri-state flag, absent-versus-empty arrays, and the device-local half of the settings row |
| `StoreAtomicityTests` | all-or-nothing, from three observers; refusing to overwrite a book unasked; refusing a file that does not add up before any write |
| `StoreSoftDeleteTests` | a deleted row is still there, comes back, and changes the arithmetic while it is gone |
| `StoreRegisterTests` | paging returns *exactly* the register — no row twice, none missed, same order as a second statement of the rule in Swift; every running balance equals a sum over the rows below it; the cheap balance read equals `book()`'s; and the register's indexes are shown to be **used**, against SQLite's own query plan |
| `DemoBookTests` | the invented 58-account, 5,200-row demo book imports, balances and round-trips — and a copy of it with one manifest figure moved by a penny is refused, naming the account |

## The Phase 2 gate: verifying against the frozen real backup

The strongest check there is, and it is **not** wired into a plain `swift test`
because this repository is public and the file's figures are the owner's
finances. Point it at the file:

```sh
MYMONEY_FROZEN_BACKUP=/path/to/mymoney-backup-YYYY-MM-DD.json \
MYMONEY_FROZEN_HASH=<the canonical content hash> \
MYMONEY_FROZEN_ACCOUNTS=<n> \
MYMONEY_FROZEN_TRANSACTIONS=<n> \
MYMONEY_FROZEN_NET_WORTH=<minor units> \
swift test
```

The same variable also runs two more gates, both in `StoreFrozenGateTests` and
both on an `:memory:` store, so the owner's data is never written to a disk
anywhere — no temporary file, no WAL, nothing to forget to delete.

* **Phase 3** — the real book through the SQLite store and back out to the
  identical canonical hash, with `requiringExactRoundTrip: true` so a mismatch
  is a rollback rather than a warning.
* **Phase 4** — the real book through the *register*: paged sixty at a time, the
  all-accounts register is exactly as many rows as the file says the
  transactions table has, strictly descending on the whole sort key, with no id
  twice. Then, for every account, the running balance is started at that
  account's balance and stepped down its whole register: the figure left at the
  bottom must be the opening balance the account row carries. A row missed,
  repeated, or attributed to the wrong account shows up as a number that does
  not land.

Only `MYMONEY_FROZEN_BACKUP` is needed; every other expectation is **read out
of the file's own manifest**, so the test states no balance, no total and no
hash of its own. `MYMONEY_FROZEN_NET_WORTH`, if you supply it, pins the app's
**headline** figure, which rounds per currency — a number copied out of a v1
backup's manifest is the older per-account total and can be a penny or two
adrift of it, so take that one off the dashboard rather than out of the file.
The gate says so out loud when the value it was given is the per-account one. Without the file — on CI, on any other machine, or with a
stale path — the four real-data tests **skip**, and the suite is green. A gate
that went red on a laptop that has never seen the owner's data would be turned
off within a week, and a turned-off gate proves nothing.

`FrozenGateTests.swift` is the gate itself, and it asks three questions:

1. **Every account's closing balance, recomputed from the transaction rows**
   through `Balances.accountBalances` — the code a screen would use, and a
   different implementation from the one the import used to check the manifest
   — against the per-account figures the file carries. All of them, or it
   fails, naming each account and the difference **in minor units**.
2. **Net worth**, recomputed from those balances at the rates in the file —
   under the arithmetic **the file's own manifest version names** (v1 rounds
   per account, v2 per currency; see the next section), never under whichever
   rule this build prefers today. The app's headline figure is checked against
   the current rule in the same breath, so both claims are pinned and neither
   is taken on trust from the other.
3. **The export.** The parsed document is thrown away and the file is written
   back out of the decoded Swift records; the canonical content hash must be
   the one the browser computed. Balance-equivalence is not enough — two files
   can agree about every total and disagree about a field, and it is the field
   that gets lost in a migration. It goes one better than the hash, which
   ignores `exportedAt`, and compares the whole thing **byte for byte**. The
   writer is handed the manifest rule read off the file, for the same reason
   question 2 uses it: reproducing a file written under the older rule means
   writing that rule, and stamping a v2 manifest here would change one integer
   and prove nothing about the other 5,127 rows.

When the hash does not match, `JSONDiff` says which field diverged
(`tables.accounts[7].excludeFromNetWorth: the export invented this key`) rather
than leaving 100,000 candidate fields and a mismatched checksum.

A second test drives the **budget and report engines** over the same 5,127 real
transactions, asserting only INVARIANTS — that a drill-down adds up to the row
it was drilled from, that cumulative cash flow is the running sum of its months,
that every report agrees about how many transactions it could not convert, that
the budget windows tile the book's whole span. It never states a figure, which
is what lets a real-data test live in a public repository at all.

All four tests open the file read-only and write nothing, anywhere. The
export exists as a `String` in memory, is compared, and is dropped.

## One net-worth rule, and a version so old files keep theirs

Net worth is computed in three places — `Balances.netWorth` (the headline),
`Reports.netWorthSeries` (the chart) and `Manifest.compute` (the file) — and
they used to disagree about **when to round**. Converting each account and
adding up is not the same arithmetic as adding each currency up and converting
the subtotal once:

```
705 + 705 EUR at 0.85   per account:  round(599.25) + round(599.25) = 1198
                        per currency: round(1410 × 0.85 = 1198.5)   = 1199
```

All three now sum **per currency** and convert once — including the
"not counted" total that sits beside the headline. It rounds once instead of
once per account, so the error cannot grow with the number of accounts; it is
the ordinary accounting treatment; and it is what the chart always did, so the
chart's history stays truthful instead of being retroactively re-rounded.

The manifest could not simply follow. An import recomputes every figure and
**refuses** on a disagreement, and every backup already written carries a
per-account total — so re-rounding the arithmetic would have made every one of
them unrestorable, a data-loss bug introduced while fixing a cosmetic one. So
the rule is carried by `manifestVersion`:

- **version 1 MEANS per-account.** Frozen forever; v1 files are recomputed the
  v1 way and stay restorable.
- **version 2 means per-currency**, and is what this build writes.
- Verifying a found file uses the rule **that file's own version names**
  (`Manifest.netWorthRule(of:)`), never this build's preference.
- `Manifest.compute` takes the rule as a **required** argument and stamps the
  version *from* it, so a file cannot claim one version while holding the
  other's arithmetic.

`Manifest.swift` and `src/backup/manifest.ts` must move together — they are two
statements of one file format, not two implementations of a similar idea.
`ManifestVersionTests.swift` pins the selection itself over the smallest book
where the two rules differ, which is the TypeScript suite's own v1 fixture read
out of `../tests/fixtures/` rather than copied.

**Why no existing test caught the original defect, in either language:** every
oracle book and every other fixture has at most one counted account per
currency, which is exactly the shape in which the two rules cannot disagree.
That is what a real book is for, and the frozen gate now fails if the headline
figure ever goes back to rounding per account.

## The store

`Store/` is a persistence layer over the libsqlite3 that ships with the OS
(`import SQLite3` — the SDK's own module map, so the package stays
dependency-free). Four things in it are worth reading before changing anything:

**Money cannot become a float, and that took more than declaring the column
`INTEGER`.** SQLite has no column types, only *affinity*, which is a preference
applied to whatever you hand it. A plain `INTEGER` column stores `100.5` as a
float and silently converts the string `'100'` to `100`. A `STRICT` table
refuses both of those — and still accepts `100.0` and `'100'`, because both
convert *losslessly* and lossless is all `STRICT` asks for. So every money
column is declared **`ANY` with a `CHECK (typeof(x) = 'integer')` inside a
`STRICT` table**, which is the one combination that refuses all of them: `ANY`
applies no affinity conversion, so the `CHECK` finally sees what was actually
passed. `ANY` here is the *strongest* declaration available, not the weakest.
`bind(_:minorUnits:)` takes an `Int64` and has no `Double` overload, as a second
layer that fails at compile time rather than on somebody's phone. Every
measurement behind that paragraph is executed by `StoreTypeAffinityTests`, so a
future libsqlite3 that behaves differently turns the suite red instead of
quietly turning the design off.

**Nothing is ever hard-deleted.** Every table an owner can delete from carries
`deleted_at`, and reads go through `live_*` views that carry the
`WHERE deleted_at IS NULL` — so a query written next year cannot forget it. The
reason is D48, bought with a real CloudKit experiment: a delete carries no
change tag, gets no conflict protection, and loses an offline device's edit with
no error at all. Deletion has to be a *save*. Sync is not in this phase; the
schema is shaped for it now because retrofitting tombstones comes too late for
every row deleted before the retrofit.

**A restore is all-or-nothing, and it is proved by breaking it.** The file is
parsed, validated and made to prove itself against its own manifest before the
database is opened for writing at all; then one transaction clears, writes,
records provenance, audits every money column and commits.
`StoreAtomicityTests` injects a failure partway through and then asks three
different observers what the store contains: the same connection after the
throw, a *second connection while the import is still running*, and a copy of
the database and its write-ahead log taken mid-transaction — which is what a
power cut leaves behind. All three see the previous book, untouched.

**The store remembers how the book arrived.** Two facts cannot be derived from
the rows and both change the content hash: the file's `schemaVersion`, and its
manifest version, which *selects the net-worth rule* (v1 rounds per account, v2
per currency — one penny apart on a book with two counted accounts in a
currency). They live in `store_meta`, which is why there are two exports:
`exportBackup…` writes what this build would write today, and
`exportReproducingSource…` reproduces the file the store was loaded from, under
its own rule. The second is evidence rather than a feature.

## The app in `App/`

`App/MyMoneyNative.xcodeproj` — one target, iOS 17 and macOS 14, bundle id
`com.gs.MyMoneyNative`, automatic signing, team `AQ5Z6U57L5`. The project file is
hand-written (no xcodegen on this machine) and uses a file-system-synchronized
group, so adding a Swift file to `App/MyMoneyNative/` needs no project edit.

Three screens: **accounts and net worth**, laid out as the web app's sidebar
lays them out; a **register**, newest first, paged from a cursor; and **import**,
which shows what it verified afterwards and names what disagreed when it refuses.

Two rules it is built around:

* **Read-only, and it says so on every screen.** There is no editor, no add and
  no delete, and `LedgerService` exposes no method that could become one. The web
  app is the system of record and the banner says which app holds the truth.
* **Every figure comes from `Money`.** No `NumberFormatter` is constructed
  anywhere in the app target. `Formatting.swift` says so and explains why; a
  second formatter would be a second answer to "what is this amount".

## Scheduled and recurring payments

`Schedule/` plus `Store/LedgerStore+Schedules.swift`, and migration 4. A
schedule is an amount, an account, a payee, a category, one of the six cadences
and a start date, ending never, on a date, or after a count.

**It is a plan, not money.** Nothing in `Schedule/` is in a balance, a report or
a backup file. The only way one becomes money is `postScheduled`, which builds
an ordinary `TransactionDraft` and hands it to `saveTransaction` — the same door
Quick Add and Siri use, so it gets the same validation, the same
currency-from-the-account rule, the same dedupe hash and the same local-edit
count. There is no second writer.

**One cadence arithmetic.** Every date comes from `Cadence.date(from:steps:)`,
the function the recurrence detector already uses, and occurrence *n* is always
measured from the ANCHOR rather than from occurrence *n−1*. That is what makes
**monthly on the 31st the last day of every month** — 31 Jan, 28 Feb, 31 Mar —
instead of a schedule that February permanently drags back to the 28th. A
detected pattern can be turned into a schedule in one tap, and a test asserts
the schedule's first date is the very date the insights screen predicted.

**Entering is deliberate.** A due item opens a sheet showing exactly what will
be written, with the amount and the date editable, and writes nothing until the
button is pressed. Auto-post is per schedule, off by default, and **cannot reach
back before the day it was switched on** — so turning it on for a schedule
anchored in 2024 does not fill the register with two years of transactions. A
run is capped and says what it held back, and what it entered is announced on
the screen.

**And auto-post never re-enters something that has already been through the
book.** An occurrence whose transaction is gone is offered for confirmation,
never entered automatically, however trusted the schedule is. There are exactly
two ways it can be gone and neither is a reason to write it again unasked: the
owner deleted it (putting it straight back overrules him about his own money) or
an import replaced the book with a file that may well already contain that
payment (writing it again makes a duplicate). The occurrences after it are
unaffected — one deleted payment does not switch auto-post off either.

**Nothing is lost and nothing is silently repeated.** Skipping is a recorded
decision that can be taken back — from the schedule's own history, on the rows
where it would actually do something (a skip the schedule still falls on; never
a posting, which is undone by deleting its transaction); a posting is a CLAIM
about the book, checked
against `live_transactions` on every read, so a transaction that was deleted —
or wiped by a fresh import — makes its occurrence due again rather than leaving
a hole nobody can see. Schedules are **not** in `tombstonedTables`, deliberately:
an import replaces the book and must not sweep away the owner's own
arrangements.

**The warning is the point.** The upcoming screen projects each account forward
from its balance *as at today* — the same `Balances.accountBalances`, fed only
the transactions dated today or earlier — plus the transactions already entered
for later dates, plus what is scheduled, and names the day and the payment that
takes it below zero. Per account, in that account's own currency, so no exchange
rate is involved; only current, savings and cash accounts warn, because a credit
card and a loan live below zero by design. Worst measured read over the
5,200-row demo book with forty schedules: **8.9 ms**.

**The projection stops where the screen stops.** A payment the owner has already
entered with next June's date is real, and it is not in this window; without
that bound it produced a warning naming a date in 2027 with no schedule behind
it, on a screen whose own footer says it is counting what is scheduled below.
Dropping those steps cannot change a crossing found inside the window: the
timeline runs in date order, so everything removed comes strictly after
everything kept.

**A paused schedule says nothing at all**, and that includes its problems. It
will enter nothing, so a "needs attention" row about its missing account is a
job with no consequence attached, and that list is worth reading exactly as long
as nothing in it can safely be ignored. Everything reappears the moment it is
unpaused.

**What a schedule deliberately cannot be**, said on the screen rather than left
as a missing option: a transfer (it needs a second account, a second amount
across currencies, and a projection that moves money out of one account and into
another on one day — half of that shipped for real money is worse than none) or
a split (which must sum exactly to its parent, a promise an amount that varies
per occurrence cannot make months ahead). Both are entered by hand, or entered
from here and then edited.

**Moving a grid is said before it is done.** Changing the cadence or the first
date moves every occurrence, and decisions taken under the old grid become
orphans — still the owner's, still listed, no longer attached to anything the
schedule will do again. The editor counts them (`ScheduleCalendar.datesOffTheGrid`,
the same function the history marks its rows with) and says how many, next to
the controls that caused it. It is a sentence, not a refusal: changing the rent
day is an ordinary thing to do.

**Reminders are local.** `Schedule/DueReminders.swift` decides which days get a
notification and what it says; `App/MyMoneyNative/DueNotifications.swift` hands
that to iOS. One notification per day rather than one per payment (iOS keeps 64
pending requests for the whole app and silently drops the rest), capped at half
that budget, and **no figures and no names unless the owner switches the detail
on** — a lock screen is a public surface.

## The things only the native app can do

Four capabilities that a browser cannot have, plus a search that had to be SQL.
Each is small on purpose, and each says out loud what it does *not* do.

**Face ID / Touch ID lock** — `Device/AppLockPolicy.swift` (the rules, tested)
and `App/MyMoneyNative/AppLock.swift` (LocalAuthentication, and the screen).
Locked on every launch; locked on return from the background after a grace
period the owner chooses (default: one minute). `.deviceOwnerAuthentication`,
so the device passcode is always behind the biometry. Every uncertainty locks —
no reading of when the app left, a clock that appears to go backwards, an
unrecognised failure. **It is a curtain, not a safe:** it draws a view over the
app, stores no secret and encrypts nothing, and `AppLockSettings.honestyLine`
says so on the settings screen with a test pinning the wording. Off by default,
and it refuses to switch on until the device has proved once, in front of the
owner, that it can authenticate.

**Widgets** — `App/MyMoneyWidgets/`, reading one small JSON file the app
publishes into an App Group container (`Device/LedgerSnapshot.swift`,
`Device/SnapshotFile.swift`). The widget opens no database and computes
nothing: every figure was worked out by `Dashboard.summary` while the app was
running. Every family prints how old the figures are, and a snapshot it cannot
read is "Open MyMoney once" rather than £0.00 — a zero on a home screen is a
figure. The local-edit count travels with it.

> **`MYMONEY_WIDGETS` is 0, and turning it on needs one thing done in Xcode.**
> An App Group is a signing capability, and Xcode's automatic signing works out
> what a target needs by reading *every* entitlements file that target can
> resolve to, on any platform — so a group declared for the Mac alone makes an
> iPhone device build fail with "Provisioning profile doesn't include the App
> Groups capability". This machine's Xcode has no Apple ID signed in and cannot
> create a profile that carries it, so the switch ships at 0: everything builds
> and signs, the app publishes nothing, and the widget says to open the app.
> To turn it on: **Signing & Capabilities → + App Groups →
> `group.com.gs.MyMoneyNative`, on both targets**, then set `MYMONEY_WIDGETS`
> to 1. No code changes. `MYMONEY_WIDGETS=1` on an `xcodebuild` command line is
> enough for the simulator, which needs no profile.

**App Intents / Siri / Shortcuts** — `App/MyMoneyNative/Intents.swift`. Adds a
payment without opening the app, through `LedgerService` and therefore through
`LedgerStore.saveTransaction`: the same validated, local-edit-counting
transaction the Quick Add sheet uses. There is no second write path, and the
intents live in the app target rather than an extension for exactly that reason
— an extension would be a second process with a second SQLite connection. The
one place a `Double` gets near money is the amount parameter, which the system
types; `QuickEntry.minorUnits(spokenAmount:currency:)` converts it exactly or
refuses it.

**Share sheet and Files** — `Import/IncomingFile.swift` and
`App/MyMoneyNative/IncomingDocument.swift`. A file arriving from another app is
identified from its **bytes**, never its name: a backup called `.csv` still goes
to `BackupImporter` with its manifest check intact. Arriving is not importing —
the file lands on the Import screen with the ordinary confirmation, because an
import replaces the copy on this device. A `.csv` is read and described and
**not** written: there is no validated path from a statement's rows into the
book yet, and half of one would be the second write path this app is built
without.

**Search** — `Domain/RegisterSearch.swift` and `Store/LedgerStore+Search.swift`.
Payees, notes, amounts, categories (including the ones only on a split),
accounts, tags and dates, over the whole register, in SQL. The small tables are
resolved to id sets in Swift and handed to the database as `IN` lists, so the
only per-row text work is the note; paging is the same keyset cursor as the
ordinary register, so memory is one page whatever the book's size. Worst
measured query over the 5,465-row demo book: **6.2 ms**. There is deliberately
no FTS index — it would be a second copy of the book kept in step by triggers,
and one that drifted would not look like a broken index, it would look like a
transaction that is not there. And there is **no running balance down a search**:
a balance is the account's figure minus every newer row, and a filtered list has
gaps in it, so the screen says so instead of printing numbers that are not
balances.

## What this package is not

No sync. Backups are read **and written** (`BackupWriter`) and stored (`Store/`);
what is missing is the share-sheet plumbing for writing one back out — the app
imports and displays, and deliberately offers no export.

The import side stops at the PARSERS. `buildImportPlan`, `commitImport` and
`undoImport` are not here, and one consequence is worth knowing: the parsers
scale amounts at a guessed currency and detect the decimal style at two
decimals, because the row's account is not known yet. The TypeScript importer
corrects that afterwards (`needsRescale` / `decimalStyleDetector` in
`src/import/importer.ts`) by re-deriving the amount from `amountText` once the
real currency is known. `ParsedRow` carries `amountText` and `amountRule` for
exactly that purpose, and until the plan builder is ported a 0- or 3-decimal
currency read through these parsers alone is only provisionally scaled.

## What the next phase must carry in from the CloudKit probe

Item 1 and item 5 are now implemented, in `Store/`; the rest is still ahead and
constrains what the sync layer is allowed to look like. Every item was
paid for with a real experiment against a real server rather than reasoned from
documentation. Full reasoning in `../DECISIONS.md`; the log is
`~/CloudKitProbe/results.log`.

1. **A ledger must never hard-delete (D48).** `deleteRecord` carries a record id
   and nothing else — no change tag, therefore no optimistic-concurrency check,
   therefore **no error**. Three scripted scenarios lost data silently: a stale
   delete destroyed an unseen edit, a stale edit *resurrected* a deleted record,
   and a three-generations-stale delete was indistinguishable from a current
   one. Deletion has to become a **save of a tombstone**, which does get
   conflict protection. Until that exists and those three scenarios are green
   against it, CloudKit's conflict handling is not solved.
2. **Cache the whole `CKRecord`, not `encodeSystemFields` (D47).** The ancestor
   in `serverRecordChanged` is reconstructed *client-side* from base values the
   record instance still carries; rebuild the record from system fields and it
   arrives with zero data keys, and every conflict silently degrades to a coin
   flip. Costs about 0.8 KB per row on local disk and nothing on the wire.
   Apple documents one sentence about it and its own sample never uses it, so
   this needs a permanent test that fails the day it stops being true.
3. **Read `failedRecordSaves` (D49).** The delegate is the only failure channel;
   the throw from `sendChanges()` is an echo of what the delegate was already
   handed, and in the default configuration the app never calls `sendChanges()`
   at all. Ignoring the failure list is legal, silent, and gets no compiler
   help. Also: recognise client == server (change tag aside) as
   already-applied, or a crash mid-sync produces a burst of phantom
   self-conflicts.
4. **Money crosses CloudKit intact (D50).** `Int64` round-trips as `objCType
   'q'`, exact at 2^53+1 and at `Int64.max`. Keep it that way: no `NSNumber`
   convenience, no `Double`, anywhere.
5. **The SQLite schema must keep optional fields tri-state (D52).** The backup's
   content hash covers key *presence*: absent and `null` are different bytes. A
   column declared `NOT NULL DEFAULT 0` throws that away, and the app can then
   no longer write a byte-identical file for a book the browser wrote — which is
   the check `FrozenGateTests` exists to make.
6. **The first sync is a migration (D51).** `RecordZoneChangeBatch` caps itself
   at 250 and capping in the app is slower, not safer; `atomicByZone` defaults
   to `false`, so a partial failure leaves the zone half-written; and the state
   serialization must be persisted on every `stateUpdate` or the migration
   restarts from the beginning.
