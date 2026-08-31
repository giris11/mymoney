# The oracle

`cases/*.json` is an independently checkable statement of **what this app's
arithmetic produces**, in a form that has nothing to do with TypeScript.

It exists because the owner is porting MyMoney to native Swift (SQLite +
CKSyncEngine), and because the 1,100-odd tests in `tests/` — the most valuable
artefact in this repository — cannot be run by a Swift implementation. They are
a specification of the money rules that happens to be written in TypeScript.
The oracle extracts the part a Swift implementation *can* be held to: inputs
paired with the answers they must produce.

A Swift port that reproduces every case in here is not merely "passing tests".
It is producing the same numbers, for the same reasons, as the build that
reconciled 58 accounts and 5,127 transactions against the owner's MoneyWiz
export.

## What is in here

| file | area | cases | what it pins |
|---|---|---|---|
| `money.json` | money | 71 | parsing, formatting, half-away-from-zero rounding, minor-unit scaling per currency |
| `fx.json` | fx | 25 | rate direction, per-contribution rounding, the missing-rate outcome |
| `balances.json` | balances | 16 | per-account balances, cleared vs pending, net worth with exclusions and archived accounts |
| `budgets.json` | budgets | 45 | weekly/monthly/yearly window boundaries incl. month-end clamping, spend against them |
| `reports.json` | reports | 27 | the golden month, category rollup with descendants, transfers excluded from flow |
| `import.json` | import | 95 | dedupe hashing, near-duplicate decisions, MoneyWiz Report parsing (incl. `►`), date-format and decimal-comma handling |

`index.json` lists the files, their case counts, the books they carry and every
`op` they use. **279 cases in total.**

## The rules the whole thing exists to preserve

These hold in every language, and every case in here is downstream of them:

1. **Amounts are integers in the currency's minor units.** Never a float, never
   a decimal type standing in for one. `1234` GBP is £12.34; `1234` JPY is
   ¥1234; `1234` BHD is 1.234 dinars.
2. **Rounding is half away from zero, applied exactly once.** `2.5 → 3` and
   `-2.5 → -3`. Banker's rounding is wrong here, and `Int(x + 0.5)` is wrong for
   negatives. In Swift: `x.rounded(.toNearestOrAwayFromZero)`.
3. **Currency conversion happens only at display/report time.** Stored amounts
   never change currency. A balance is always in its own account's currency.
4. **A missing FX rate is surfaced, never guessed.** Not zero, not the
   unconverted amount, not a triangulated cross rate. An explicit outcome the
   user is shown.

## Case shape

Every case is the same object:

```json
{
  "id": "reports.golden.category-top",
  "describes": "the golden month by top-level category: Food £150.00 …",
  "op": "reports.spendingByCategory",
  "input": { "book": "golden", "from": "2026-08-01", "to": "2026-08-31", "parentId": null },
  "expect": { "rows": [ … ], "totalMinor": 23700, "missingRateCount": 0 },
  "provenance": "hand-calculated",
  "carriedFrom": "tests/golden.test.ts",
  "note": "Rows sort by spentMinor descending, then by name."
}
```

- **`id`** — stable and unique across every file. Use it as the test name, so a
  Swift failure says `reports.golden.category-top` rather than "case 47".
- **`describes`** — one line saying what the case pins. Print it on failure.
- **`op`** — the operation to dispatch on. See the vocabulary below.
- **`input`** — named arguments. `book` (when present) names an entry in the
  file's own `books` map.
- **`expect`** — always an object with named fields, never a bare value. Scalar
  results are wrapped: `{"value": 3}`, `{"minor": -4567}`, `{"text": "0.01"}`,
  `{"date": "2026-06-25"}`.
- **`provenance`** — see below.
- **`carriedFrom`** *(optional)* — the test file whose written-out arithmetic
  this expectation was copied from.
- **`note`** *(optional)* — extra context worth printing on a failure.
- **`advisory`** *(optional)* — names fields of `expect` that are **not** hard
  requirements. See "Advisory fields".

### Provenance — and why it matters

- **`hand-calculated` (267 cases).** The expected value is a literal a human
  wrote. The generator still calls the implementation and **refuses to emit the
  file** unless the two agree, so these are statements about the money, not
  about the code.
- **`derived` (12 cases).** The expected value was captured by calling the real
  function. These prove *agreement* between two implementations. They cannot
  prove either is right.
- **`carriedFrom` (81 cases).** The strongest set: figures worked out by hand,
  in prose, in `tests/golden.test.ts`, `tests/budgets.test.ts` and
  `src/money/money.test.ts` — written down *before* any implementation agreed
  with them, and the acceptance criterion for this app since SPEC §12. If you
  only have time to make some of the oracle pass, make these pass first.

**Never "fix" a hand-calculated case by adopting what your implementation
returns.** That is the one move that turns an oracle back into a mirror.

## Books

`balances.json`, `budgets.json` and `reports.json` carry a `books` map: named,
fully explicit sets of records to load before running the case that names one.

```jsonc
{
  "baseCurrency": "GBP",
  "fxRates":   [ { "base": "EUR", "quote": "GBP", "rate": 0.85 } ],
  "accounts":  [ { "id": "cur", "name": "Current", "type": "current", "currency": "GBP",
                   "openingBalanceMinor": 100000, "archived": false,
                   "excludeFromNetWorth": false, "sortOrder": 0 } ],
  "categories":[ { "id": "groceries", "name": "Groceries", "kind": "expense",
                   "parentId": "food", "archived": false, "sortOrder": 0 } ],
  "payees":    [ { "id": "p-tesco", "name": "Tesco" } ],
  "tags":      [ { "id": "g-work", "name": "work" } ],
  "transactions": [ { "id": "t4", "accountId": "cur", "date": "2026-08-12",
                      "amountMinor": -10000, "currency": "GBP",
                      "payeeId": "p-bigshop", "categoryId": null, "tagIds": [],
                      "status": "cleared", "transferGroupId": null, "notes": "",
                      "splits": [ { "categoryId": "groceries", "amountMinor": -6000 },
                                  { "categoryId": "transport", "amountMinor": -4000 } ] } ]
}
```

A book carries only fields that mean something to the money rules. Storage
detail this codebase happens to keep — colours, dedupe hashes, created/updated
timestamps, lowercase name keys — is deliberately absent: a Swift port has no
obligation to have those columns.

`golden` is SPEC §12's golden month, the same scenario as `tests/golden.test.ts`
restated as data. Its figures are the ones the app has been accepted against.

## Op vocabulary

Dispatch on `op`. Names are `area.function`.

**money** — `money.decimalsFor`, `money.minorFactor`,
`money.roundHalfAwayFromZero`, `money.parseAmountToMinor`,
`money.formatMinorPlain`, `money.formatMinor` *(advisory)*, `money.sumSplits`.

**fx** — `fx.convertMinor` (→ `{"outcome": "converted", "minor": n}` or
`{"outcome": "missing-rate"}`), `fx.convertEach` (converts each element of
`minors` independently — it exists to pin that rounding is per contribution,
not per total).

**balances** — `balances.balanceFromAmounts`, `balances.countsTowardNetWorth`,
`balances.accountBalances`, `balances.netWorth`.

**budgets** — `budgets.windowContaining`, `budgets.shiftWindow`,
`budgets.shiftWindowRoundTrip`, `budgets.progress`.

**reports** — `reports.spendingByCategory`, `reports.incomeVsExpenseByMonth`,
`reports.cashFlowByMonth`, `reports.spendingByPayee`, `reports.spendingByTag`,
`reports.netWorthSeries`.

**categories** — `categories.descendantIds` (the rollup primitive; the returned
set is sorted in the fixture and its order carries no meaning),
`categories.categoryPathName`.

**import** — `import.normalizeForHash`, `import.makeDedupeHash`,
`import.levenshtein`, `import.similarPayee`, `import.checkDuplicate`,
`import.parseDateString`, `import.detectDateFormat`,
`import.detectDecimalStyle`, `import.parseImportAmount`,
`import.detectFormat`, `import.parseMoneyWizReportCsv`,
`import.parseMoneyWizCsv`, `import.parseWithMapping`, `import.guessMapping`.

Three import ops are **projections** of a single `parseMoneyWizReportCsv`
result rather than separate functions — parse once and pick the fields out:
`import.reportOpeningBalances`, `import.reportCategoryPaths`,
`import.reportRows`.

## Advisory fields

A case may name fields that a re-implementation is **not** bound by:

- `money.formatMinor` — the display string comes from ICU with the `en-GB`
  locale. The *number* is the contract; the glyphs are the platform's
  (Foundation renders JPY as `¥500` where ICU-en-GB says `JP¥500`). Compare
  against your own `NumberFormatter` and treat a difference as a locale note.
  `money.formatMinorPlain` is exact and is the one to hold yourself to.
- `warnings` on the import parsers — English prose written for a human. A port
  is bound by **when** a warning is raised, not by its wording. Compare counts
  strictly; compare text advisorily, if at all.

Everything without an `advisory` key is exact.

## How a Swift harness should consume this

1. **Add `cases/` to the test bundle as a resource** and decode it. The shape is
   stable; `oracleVersion` is `1` and will be bumped if it ever changes
   incompatibly.
2. **One XCTest per case, named by `id`**, so a failure is self-describing:

```swift
struct OracleCase: Decodable {
    let id: String
    let describes: String
    let op: String
    let input: JSONValue        // your own loosely-typed JSON enum
    let expect: JSONValue
    let provenance: String
    let carriedFrom: String?
    let advisory: [String]?
    let note: String?
}

func testOracle() throws {
    for file in try OracleFile.all() {
        for c in file.cases {
            XCTContext.runActivity(named: c.id) { _ in
                let actual = try run(c.op, input: c.input, books: file.books)
                assertMatches(actual, c.expect,
                              ignoring: c.advisory ?? [],
                              message: "\(c.id): \(c.describes)\n\(c.note ?? "")")
            }
        }
    }
}
```

3. **Compare integers exactly.** Every money value in `expect` is an `Int`. If
   your comparison needs a tolerance on a money field, something is already
   wrong.
4. **One field is a `Double`**: `pct` on `budgets.progress`. Compare it with a
   small epsilon (1e-9).
5. **Absent keys are meaningful.** `colour` is simply missing on a row that has
   no colour; `null` and absent are different claims. Decode optionals, do not
   default them.
6. **`null` is never zero.** A `null` amount means *refused*: the input could
   not be represented without changing the user's number. A `null`
   `openingBalanceMinor` means *we decline to state one*. Reproduce the refusal.
7. **Order matters where the fixture states it.** Report rows are sorted
   (amount descending, then name); balance rows are sorted by `sortOrder` then
   name; month rows ascend. The one exception is `categories.descendantIds`,
   which is a set.
8. **Start with the `carriedFrom` cases**, then `hand-calculated`, then
   `derived`.

## Regenerating

```
node_modules/.bin/vite-node tools/oracle/write.ts
```

`tests/oracle.test.ts` regenerates every fixture from the live source and
compares it **byte for byte** with what is committed, so the oracle cannot
silently drift from the code it describes. Regeneration is deliberately a
separate command and is **not** wired into `npm test`: a suite that rewrites its
own expectations cannot fail.

A failure of that test is a question, not a broken test — the engine's answers
moved. Read the diff and decide whether the money rules were meant to move. If
they were, regenerate and commit. If they were not, the oracle has just caught a
real bug before it reached a ledger.

## What this does NOT cover

Deliberately, so nobody mistakes a green oracle for a finished port:

- **Persistence, sync and backup.** Nothing here says anything about IndexedDB,
  SQLite, CKSyncEngine, conflict resolution or file formats.
- **Anything with an identity or a clock.** Record ids, `createdAt`/`updatedAt`,
  "today". Every book states its ids and timestamps outright precisely so the
  fixtures contain no non-determinism.
- **UI.** Layout, navigation, charts, colours, accessibility.
- **Write paths.** `saveTransaction`, `saveTransfer`, `commitImport`,
  `undoImport` and their validation live in `tests/` and have no oracle cases:
  the oracle states what the arithmetic *produces*, not what the app *accepts*.
  A port still needs its own tests for the split-must-sum-to-parent rule, the
  transfer-legs-stay-in-step rule, and undo.
- **Performance.** SPEC §9's scale requirements are shape assertions in
  `tests/scale.test.ts`, not numbers a fixture can carry.
