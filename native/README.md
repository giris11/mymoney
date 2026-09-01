# MyMoneyKit

The money rules of the MyMoney PWA, restated in Swift. **Library and tests
only** — no app, no UI, no persistence. This is the phase where correctness is
won, and it deliberately has nothing to show for it.

## Where this sits

This package is **native Phase 2**. That numbering is the native project's own
and is *not* SPEC §8's Phase 1/2/3:

- **Phase 0** froze a read-only copy of the real backup and built the 279-case
  oracle in `../tools/oracle/` — 267 of the cases hand-calculated, so a port can
  be held to something that was not generated from the code it is checking.
- **Phase 1** was a throwaway CloudKit probe (`~/CloudKitProbe`) run against a
  real container with fabricated rows, to find out whether CKSyncEngine can
  sync a ledger without silently losing rows. **Its gate failed on the delete
  path** — see the last section here, and D47–D51 in `../DECISIONS.md`.
- **Phase 2** is this: the money rules restated in Swift and held to the oracle
  and to the frozen file.

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

Each file's header comment explains why it is the way it is, including which
alternative was rejected. Start there rather than here.

## What the tests are

`Tests/MyMoneyKitTests/OracleTests.swift` runs the **real fixtures** in
`../tools/oracle/cases` — **all 279 cases across all six files**: money (71),
fx (25), balances (16), budgets (45), reports (27) and import (95). Nothing is
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

Only `MYMONEY_FROZEN_BACKUP` is needed; every other expectation is **read out
of the file's own manifest**, so the test states no balance, no total and no
hash of its own. `MYMONEY_FROZEN_NET_WORTH`, if you supply it, pins the app's
**headline** figure, which rounds per currency — a number copied out of a v1
backup's manifest is the older per-account total and can be a penny or two
adrift of it, so take that one off the dashboard rather than out of the file.
The gate says so out loud when the value it was given is the per-account one. Without the file — on CI, on any other machine, or with a
stale path — the three real-data tests **skip**, and the suite is green. A gate
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

All three tests open the file read-only and write nothing, anywhere. The
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

## What this package is not

No storage, no sync, no UI. Backups are read **and written** (`BackupWriter`);
what is missing is somewhere to write them *to*, and the file-picker and
share-sheet plumbing around it.

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

None of this is implemented here — this package has no persistence and no sync —
but all of it constrains what the storage layer is allowed to look like, and
every item was paid for with a real experiment against a real server rather than
reasoned from documentation. Full reasoning in `../DECISIONS.md`; the log is
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
