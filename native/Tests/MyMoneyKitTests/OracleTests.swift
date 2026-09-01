// The oracle, run against Swift. EVERY case, in every file.
//
// tools/oracle/cases/*.json is 284 cases -- 272 of them HAND-CALCULATED, not
// captured from any implementation -- that state what this app's arithmetic
// produces, in a form that has nothing to do with TypeScript. tools/oracle/
// README.md says why it exists: the 1,100-odd tests in tests/ are the most
// valuable artefact in the repository and a Swift implementation cannot run a
// single one of them. This file is the harness that README describes.
//
// THE RULE, quoted from it because it is the one that matters: "Never 'fix' a
// hand-calculated case by adopting what your implementation returns. That is
// the one move that turns an oracle back into a mirror." Nothing in this file
// relaxes a comparison to make something pass. Where the oracle itself marks a
// field advisory -- `money.formatMinor`'s glyphs, the import parsers' warning
// PROSE -- that is honoured and said out loud at the point of comparison; the
// number, the count and the timing are always exact.
//
// COVERAGE IS ASSERTED, NOT ASSUMED. `everyCaseDispatches` fails if any case in
// any file names an op this harness cannot run, and `theOracleIsWhatWeThinkItIs`
// fails if the file set or the case counts move. Between them, a green run
// cannot mean less than it did yesterday: a case added on the TypeScript side
// makes this suite red rather than quietly going unrun.
import Foundation
import Testing

@testable import MyMoneyKit

struct OracleTests {
    // MARK: Locating and loading the fixtures

    /// The cases live in the repository, not in the test bundle: they are the
    /// SAME FILES the TypeScript suite regenerates and compares byte for byte
    /// (tests/oracle.test.ts). Copying them into Tests/ would create a second
    /// copy that could drift, and a drifting oracle is worse than none.
    static let casesDirectory: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // .../native/Tests/MyMoneyKitTests
        .deletingLastPathComponent()   // .../native/Tests
        .deletingLastPathComponent()   // .../native
        .deletingLastPathComponent()   // the repository root
        .appendingPathComponent("tools/oracle/cases")

    struct OracleCase {
        let id: String
        let describes: String
        let op: String
        let input: JSONValue
        let expect: JSONValue
        let provenance: String
        let advisory: Set<String>
        let note: String?
    }

    struct OracleFile {
        let name: String
        let books: [String: JSONValue]
        let cases: [OracleCase]
    }

    static func load(_ name: String) throws -> OracleFile {
        let url = casesDirectory.appendingPathComponent(name)
        let parsed = try JSONParser.parse(try Data(contentsOf: url))
        let books = parsed["books"]?.objectValue ?? [:]
        let cases = (parsed["cases"]?.arrayValue ?? []).map { raw in
            OracleCase(
                id: raw["id"]?.stringValue ?? "<no id>",
                describes: raw["describes"]?.stringValue ?? "",
                op: raw["op"]?.stringValue ?? "",
                input: raw["input"] ?? .object([:]),
                expect: raw["expect"] ?? .object([:]),
                provenance: raw["provenance"]?.stringValue ?? "",
                advisory: Set((raw["advisory"]?.arrayValue ?? []).compactMap(\.stringValue)),
                note: raw["note"]?.stringValue
            )
        }
        return OracleFile(name: name, books: books, cases: cases)
    }

    /// A book from the fixture's own `books` map, decoded through the SAME
    /// record decoder a backup goes through. Deliberately not a bespoke reader:
    /// if the decoder gets a field wrong, the oracle should catch it.
    static func book(_ value: JSONValue) throws -> Book {
        let members = value.objectValue ?? [:]
        func rows(_ key: String) -> [JSONValue] { members[key]?.arrayValue ?? [] }
        return Book(
            accounts: try decodeRows(rows("accounts"), table: "accounts", make: Account.init(row:)),
            accountGroups: [],
            transactions: try decodeRows(rows("transactions"), table: "transactions", make: Transaction.init(row:)),
            categories: try decodeRows(rows("categories"), table: "categories", make: Category.init(row:)),
            payees: try decodeRows(rows("payees"), table: "payees", make: Payee.init(row:)),
            tags: try decodeRows(rows("tags"), table: "tags", make: Tag.init(row:)),
            budgets: [],
            fxRates: try decodeRows(rows("fxRates"), table: "fxRates", make: FxRate.init(row:)),
            importBatches: [],
            settings: nil,
            baseCurrency: members["baseCurrency"]?.stringValue ?? "GBP"
        )
    }

    static func rateTable(_ value: JSONValue?) -> RateTable {
        RateTable((value?.arrayValue ?? []).map { row in
            FXRateRow(
                base: row["base"]?.stringValue ?? "",
                quote: row["quote"]?.stringValue ?? "",
                rate: row["rate"]?.doubleValue ?? 0
            )
        })
    }

    /// The two tree fields the `categories.*` cases actually state.
    ///
    /// Their fixtures carry an id, sometimes a name, and a parentId -- and
    /// nothing else. Decoding them as full `Category` records would mean
    /// inventing a `kind` neither op looks at, and a fixture that is partly
    /// invention is no longer an oracle.
    struct OracleCategory: NamedCategoryTreeNode {
        let id: String
        let name: String
        let parentId: String?
    }

    static func categoryNodes(_ value: JSONValue?) -> [OracleCategory] {
        (value?.arrayValue ?? []).map { raw in
            OracleCategory(
                id: raw["id"]?.stringValue ?? "",
                name: raw["name"]?.stringValue ?? "",
                parentId: raw["parentId"]?.stringValue
            )
        }
    }

    static func mapping(_ value: JSONValue) -> ColumnMapping {
        func index(_ key: String) -> Int { Int(value[key]?.intValue ?? -1) }
        return ColumnMapping(
            date: index("date"), amount: index("amount"), debit: index("debit"),
            credit: index("credit"), payee: index("payee"), description: index("description"),
            category: index("category"), account: index("account"), currency: index("currency"),
            tags: index("tags"), notes: index("notes"),
            dateFormat: value["dateFormat"]?.stringValue ?? "auto",
            decimal: value["decimal"]?.stringValue ?? "auto",
            negate: value["negate"]?.boolValue ?? false,
            headerRow: value["headerRow"]?.boolValue ?? true
        )
    }

    static func window(_ value: JSONValue) -> PeriodWindow {
        PeriodWindow(
            start: value["start"]?.stringValue ?? "",
            end: value["end"]?.stringValue ?? ""
        )
    }

    static func period(_ raw: String?) -> BudgetPeriod {
        BudgetPeriod(rawValue: raw ?? "") ?? .monthly
    }

    // MARK: Running a file

    func run(_ file: OracleFile) throws {
        for testCase in file.cases {
            let label = "\(testCase.id) [\(testCase.provenance)]: \(testCase.describes)"
            let comment = Comment(rawValue: testCase.note.map { "\(label)\n\($0)" } ?? label)
            do {
                try dispatch(testCase, in: file, comment: comment)
            } catch {
                Issue.record("\(label)\nthrew: \(error)")
            }
        }
    }

    // swiftlint:disable:next cyclomatic_complexity
    func dispatch(_ c: OracleCase, in file: OracleFile, comment: Comment) throws {
        let input = c.input
        switch c.op {

        // ---- money -------------------------------------------------------
        case "money.decimalsFor":
            let got = Money.decimals(for: input["currency"]!.stringValue!)
            #expect(Int64(got) == c.expect["value"]!.intValue!, comment)

        case "money.minorFactor":
            let got = Money.minorFactor(for: input["currency"]!.stringValue!)
            #expect(got == c.expect["value"]!.intValue!, comment)

        case "money.roundHalfAwayFromZero":
            let got = Money.roundHalfAwayFromZero(input["x"]!.doubleValue!)
            #expect(Int64(exactly: got) == c.expect["value"]!.intValue!, comment)

        case "money.parseAmountToMinor":
            let separator: DecimalSeparator = input["decimal"]?.stringValue == "comma" ? .comma : .dot
            let got = Money.parseToMinor(
                input["input"]!.stringValue!,
                currency: input["currency"]!.stringValue!,
                decimal: separator
            )
            // `null` is never zero: a null expectation means REFUSED, and
            // reproducing the refusal is the requirement.
            #expect(got == c.expect["minor"]!.intValue, comment)

        case "money.formatMinorPlain":
            let got = Money.formatPlain(input["minor"]!.intValue!, currency: input["currency"]!.stringValue!)
            #expect(got == c.expect["text"]!.stringValue!, comment)

        case "money.formatMinor":
            // ADVISORY. The glyphs are the platform's -- Foundation and a
            // browser's Intl disagree about how to write yen -- so what is
            // asserted is the part that is a fact about the money: the sign and
            // the digits, with grouping separators and currency signs removed.
            let minor = input["minor"]!.intValue!
            let currency = input["currency"]!.stringValue!
            let got = Money.format(minor, currency: currency)
            #expect(
                numericSkeleton(got) == Money.formatPlain(minor, currency: currency),
                Comment(rawValue: "\(comment.rawValue)\nadvisory: rendered as \(got)")
            )

        case "money.sumSplits":
            let amounts = input["amounts"]!.arrayValue!.map { $0.intValue! }
            let got = try Money.sum(amounts)
            #expect(got == c.expect["value"]!.intValue!, comment)

        // ---- fx ----------------------------------------------------------
        case "fx.convertMinor":
            let outcome = Money.convert(
                minor: input["minor"]!.intValue!,
                from: input["from"]!.stringValue!,
                to: input["to"]!.stringValue!,
                using: Self.rateTable(input["rates"])
            )
            let wanted = c.expect["outcome"]!.stringValue!
            if wanted == "missing-rate" {
                #expect(outcome == .missingRate, comment)
            } else {
                #expect(outcome == .converted(c.expect["minor"]!.intValue!), comment)
            }

        case "fx.convertEach":
            let table = Self.rateTable(input["rates"])
            let from = input["from"]!.stringValue!
            let to = input["to"]!.stringValue!
            let minors = input["minors"]!.arrayValue!.map { $0.intValue! }
            let each = minors.map { Money.convert(minor: $0, from: from, to: to, using: table).minor }
            #expect(each == c.expect["each"]!.arrayValue!.map(\.intValue), comment)
            #expect(try Money.sum(each.compactMap { $0 }) == c.expect["sumOfConverted"]!.intValue!, comment)
            let together = Money.convert(
                minor: try Money.sum(minors), from: from, to: to, using: table
            )
            #expect(together.minor == c.expect["convertedSum"]!.intValue!, comment)

        // ---- balances ----------------------------------------------------
        case "balances.balanceFromAmounts":
            let got = try Balances.balanceFromAmounts(
                input["openingMinor"]!.intValue!,
                input["amounts"]!.arrayValue!.map { $0.intValue! }
            )
            #expect(got == c.expect["value"]!.intValue!, comment)

        case "balances.countsTowardNetWorth":
            // The fixture's account carries only the two fields the answer
            // depends on, so it is read as those two fields -- padding it out
            // into a full Account would be inventing data the case does not
            // state. `excludeFromNetWorth` absent must behave as false, which
            // is the point of balances.counts.flag-absent.
            let raw = input["account"]!
            let account = Account(
                id: "x", name: "", type: .current, currency: "GBP", openingBalanceMinor: 0,
                archived: raw["archived"]?.boolValue ?? false,
                excludeFromNetWorth: raw["excludeFromNetWorth"] == .bool(true)
            )
            #expect(Balances.countsTowardNetWorth(account) == c.expect["value"]!.boolValue!, comment)

        case "balances.accountBalances":
            let book = try Self.book(file.books[input["book"]!.stringValue!]!)
            let rows = try book.accountBalances()
            let want = c.expect["rows"]!.arrayValue!
            #expect(rows.count == want.count, comment)
            for (got, expected) in zip(rows, want) {
                #expect(got.account.id == expected["accountId"]!.stringValue!, comment)
                #expect(got.account.name == expected["name"]!.stringValue!, comment)
                #expect(got.account.currency == expected["currency"]!.stringValue!, comment)
                #expect(got.balanceMinor == expected["balanceMinor"]!.intValue!, comment)
                #expect(got.clearedMinor == expected["clearedMinor"]!.intValue!, comment)
                #expect(Int64(got.txCount) == expected["txCount"]!.intValue!, comment)
                #expect(got.excludedFromNetWorth == expected["excludedFromNetWorth"]!.boolValue!, comment)
            }

        case "balances.netWorth":
            let book = try Self.book(file.books[input["book"]!.stringValue!]!)
            let got = try book.netWorth()
            #expect(got.totalBaseMinor == c.expect["totalBaseMinor"]!.intValue!, comment)
            #expect(got.baseCurrency == c.expect["baseCurrency"]!.stringValue!, comment)
            #expect(
                Set(got.missingRateCurrencies)
                    == Set(c.expect["missingRateCurrencies"]!.arrayValue!.compactMap(\.stringValue)),
                comment
            )
            #expect(Int64(got.excludedCount) == c.expect["excludedCount"]!.intValue!, comment)
            // null is not zero: nil here means "we decline to state a figure",
            // and a 0 would be a claim the excluded accounts are worth nothing.
            #expect(got.excludedBaseMinor == c.expect["excludedBaseMinor"]!.intValue, comment)

        // ---- budgets -----------------------------------------------------
        case "budgets.windowContaining":
            let period = Self.period(input["period"]?.stringValue)
            let startDate = input["startDate"]!.stringValue!
            let got = try Budgets.windowContaining(
                period: period, startDate: startDate, date: input["date"]!.stringValue!
            )
            #expect(got.start == c.expect["start"]!.stringValue!, comment)
            #expect(got.end == c.expect["end"]!.stringValue!, comment)
            // Two cases state properties OF the returned window rather than
            // extra return values, so they are computed here from what came
            // back -- exactly as the fixture computed them.
            if let weeks = c.expect["wholeWeeksFromAnchor"]?.doubleValue {
                let anchor = CalendarDate(iso: startDate)!
                let start = CalendarDate(iso: got.start)!
                #expect(Double(start.daysSince(anchor)) / 7 == weeks, comment)
            }
            if let span = c.expect["spanDays"]?.intValue {
                let start = CalendarDate(iso: got.start)!
                let end = CalendarDate(iso: got.end)!
                #expect(Int64(end.daysSince(start)) == span, comment)
            }

        case "budgets.shiftWindow":
            let got = try Budgets.shiftWindow(
                period: Self.period(input["period"]?.stringValue),
                startDate: input["startDate"]!.stringValue!,
                window: Self.window(input["window"]!),
                by: Int(input["n"]!.intValue!)
            )
            #expect(got.start == c.expect["start"]!.stringValue!, comment)
            #expect(got.end == c.expect["end"]!.stringValue!, comment)

        case "budgets.shiftWindowRoundTrip":
            let period = Self.period(input["period"]?.stringValue)
            let startDate = input["startDate"]!.stringValue!
            let n = Int(input["n"]!.intValue!)
            let forward = try Budgets.shiftWindow(
                period: period, startDate: startDate, window: Self.window(input["window"]!), by: n
            )
            let backAgain = try Budgets.shiftWindow(
                period: period, startDate: startDate, window: forward, by: -n
            )
            #expect(forward.start == c.expect["forward"]!["start"]!.stringValue!, comment)
            #expect(forward.end == c.expect["forward"]!["end"]!.stringValue!, comment)
            #expect(backAgain.start == c.expect["backAgain"]!["start"]!.stringValue!, comment)
            #expect(backAgain.end == c.expect["backAgain"]!["end"]!.stringValue!, comment)

        case "budgets.progress":
            let book = try Self.book(file.books[input["book"]!.stringValue!]!)
            let raw = input["budget"]!
            let spec = BudgetSpec(
                categoryIds: (raw["categoryIds"]?.arrayValue ?? []).compactMap(\.stringValue),
                amountMinor: raw["amountMinor"]!.intValue!,
                period: Self.period(raw["period"]?.stringValue),
                startDate: raw["startDate"]!.stringValue!
            )
            let got = try book.budgetProgress(spec, refDate: input["refDate"]!.stringValue!)
            let wantWindow = Self.window(c.expect["window"]!)
            #expect(got.window == wantWindow, comment)
            #expect(got.spentMinor == c.expect["spentMinor"]!.intValue!, comment)
            #expect(got.limitMinor == c.expect["limitMinor"]!.intValue!, comment)
            #expect(got.remainingMinor == c.expect["remainingMinor"]!.intValue!, comment)
            // The oracle's rule 4: `pct` is the ONE Double in the fixtures, and
            // it is a ratio for a progress bar. Everything else is compared
            // exactly; this one gets 1e-9 and nothing else does.
            #expect(abs(got.pct - c.expect["pct"]!.doubleValue!) < 1e-9, comment)
            #expect(got.over == c.expect["over"]!.boolValue!, comment)
            #expect(Int64(got.missingRateCount) == c.expect["missingRateCount"]!.intValue!, comment)

        // ---- categories --------------------------------------------------
        case "categories.descendantIds":
            let got = Categories.descendantIds(
                Self.categoryNodes(input["categories"]),
                rootIds: (input["rootIds"]?.arrayValue ?? []).compactMap(\.stringValue)
            )
            // The fixture sorts the ids for stability and says the order
            // carries no meaning, so this is the one place a set comparison is
            // the honest one.
            #expect(
                got.sorted(by: jsStringLess)
                    == c.expect["ids"]!.arrayValue!.compactMap(\.stringValue),
                comment
            )

        case "categories.categoryPathName":
            var byId: [String: OracleCategory] = [:]
            for node in Self.categoryNodes(input["categories"]) { byId[node.id] = node }
            let got = Categories.categoryPathName(byId, id: input["id"]!.stringValue!)
            #expect(got == c.expect["text"]!.stringValue!, comment)

        // ---- reports -----------------------------------------------------
        case "reports.spendingByCategory":
            let book = try Self.book(file.books[input["book"]!.stringValue!]!)
            let got = try Reports.spendingByCategory(
                Self.range(input), parentId: input["parentId"]?.stringValue, book: book
            )
            let want = c.expect["rows"]!.arrayValue!
            #expect(got.rows.count == want.count, comment)
            for (row, expected) in zip(got.rows, want) {
                #expect(row.categoryId == expected["categoryId"]!.stringValue, comment)
                #expect(row.name == expected["name"]!.stringValue!, comment)
                #expect(row.spentMinor == expected["spentMinor"]!.intValue!, comment)
                #expect(row.hasChildren == expected["hasChildren"]!.boolValue!, comment)
                // Absent and null are different claims: a row with no colour
                // must have no colour, not an empty one.
                #expect(row.colour == expected["colour"]?.stringValue, comment)
            }
            #expect(got.totalMinor == c.expect["totalMinor"]!.intValue!, comment)
            #expect(Int64(got.missingRateCount) == c.expect["missingRateCount"]!.intValue!, comment)

        case "reports.incomeVsExpenseByMonth":
            let book = try Self.book(file.books[input["book"]!.stringValue!]!)
            let got = try Reports.incomeVsExpenseByMonth(Self.range(input), book: book)
            let want = c.expect["rows"]!.arrayValue!
            #expect(got.rows.count == want.count, comment)
            for (row, expected) in zip(got.rows, want) {
                #expect(row.month == expected["month"]!.stringValue!, comment)
                #expect(row.incomeMinor == expected["incomeMinor"]!.intValue!, comment)
                #expect(row.expenseMinor == expected["expenseMinor"]!.intValue!, comment)
            }
            #expect(Int64(got.missingRateCount) == c.expect["missingRateCount"]!.intValue!, comment)

        case "reports.cashFlowByMonth":
            let book = try Self.book(file.books[input["book"]!.stringValue!]!)
            let got = try Reports.cashFlowByMonth(Self.range(input), book: book)
            let want = c.expect["rows"]!.arrayValue!
            #expect(got.rows.count == want.count, comment)
            for (row, expected) in zip(got.rows, want) {
                #expect(row.month == expected["month"]!.stringValue!, comment)
                #expect(row.netMinor == expected["netMinor"]!.intValue!, comment)
                #expect(row.cumulativeMinor == expected["cumulativeMinor"]!.intValue!, comment)
            }
            #expect(Int64(got.missingRateCount) == c.expect["missingRateCount"]!.intValue!, comment)

        case "reports.spendingByPayee":
            let book = try Self.book(file.books[input["book"]!.stringValue!]!)
            let limit = input["limit"]?.intValue.map { Int($0) }
            let got = try Reports.spendingByPayee(Self.range(input), limit: limit, book: book)
            let want = c.expect["rows"]!.arrayValue!
            #expect(got.rows.count == want.count, comment)
            for (row, expected) in zip(got.rows, want) {
                #expect(row.payeeId == expected["payeeId"]!.stringValue, comment)
                #expect(row.name == expected["name"]!.stringValue!, comment)
                #expect(row.spentMinor == expected["spentMinor"]!.intValue!, comment)
                #expect(Int64(row.txCount) == expected["txCount"]!.intValue!, comment)
            }
            #expect(Int64(got.missingRateCount) == c.expect["missingRateCount"]!.intValue!, comment)

        case "reports.spendingByTag":
            let book = try Self.book(file.books[input["book"]!.stringValue!]!)
            let got = try Reports.spendingByTag(Self.range(input), book: book)
            let want = c.expect["rows"]!.arrayValue!
            #expect(got.rows.count == want.count, comment)
            for (row, expected) in zip(got.rows, want) {
                #expect(row.tagId == expected["tagId"]!.stringValue!, comment)
                #expect(row.name == expected["name"]!.stringValue!, comment)
                #expect(row.spentMinor == expected["spentMinor"]!.intValue!, comment)
                #expect(Int64(row.txCount) == expected["txCount"]!.intValue!, comment)
            }
            #expect(Int64(got.missingRateCount) == c.expect["missingRateCount"]!.intValue!, comment)

        case "reports.netWorthSeries":
            let book = try Self.book(file.books[input["book"]!.stringValue!]!)
            let got = try Reports.netWorthSeries(Self.range(input), book: book)
            let want = c.expect["points"]!.arrayValue!
            #expect(got.points.count == want.count, comment)
            for (point, expected) in zip(got.points, want) {
                #expect(point.date == expected["date"]!.stringValue!, comment)
                #expect(point.totalBaseMinor == expected["totalBaseMinor"]!.intValue!, comment)
            }
            #expect(
                got.missingRateCurrencies
                    == c.expect["missingRateCurrencies"]!.arrayValue!.compactMap(\.stringValue),
                comment
            )

        // ---- import: dedupe ----------------------------------------------
        case "import.normalizeForHash":
            let got = Dedupe.normalizeForHash(input["input"]!.stringValue!)
            #expect(got == c.expect["value"]!.stringValue!, comment)

        case "import.makeDedupeHash":
            let got = Dedupe.makeDedupeHash(
                accountId: input["accountId"]!.stringValue!,
                date: input["date"]!.stringValue!,
                amountMinor: input["amountMinor"]!.intValue!,
                payeeOrDescription: input["payeeOrDescription"]!.stringValue!
            )
            #expect(got == c.expect["value"]!.stringValue!, comment)

        case "import.levenshtein":
            let got = Dedupe.levenshtein(input["a"]!.stringValue!, input["b"]!.stringValue!)
            #expect(Int64(got) == c.expect["value"]!.intValue!, comment)

        case "import.similarPayee":
            let got = Dedupe.similarPayee(input["a"]!.stringValue!, input["b"]!.stringValue!)
            #expect(got == c.expect["value"]!.boolValue!, comment)

        case "import.checkDuplicate":
            let raw = input["candidate"]!
            let candidate = Dedupe.Candidate(
                accountId: raw["accountId"]!.stringValue!,
                date: raw["date"]!.stringValue!,
                amountMinor: raw["amountMinor"]!.intValue!,
                payeeOrDescription: raw["payeeOrDescription"]!.stringValue!
            )
            // The fixture's existing rows carry a payee NAME, not a payee id --
            // which is exactly the shape `checkDuplicate` takes, because the
            // caller is the one holding the payee table. The dedupe hash is
            // recomputed from the row's own four fields, as every save path
            // does (D10).
            var payeeNames: [String: String] = [:]
            let existing: [Transaction] = (input["existing"]?.arrayValue ?? []).map { row in
                let id = row["id"]!.stringValue!
                let accountId = row["accountId"]!.stringValue!
                let date = row["date"]!.stringValue!
                let amountMinor = row["amountMinor"]!.intValue!
                let payeeName = row["payeeName"]!.stringValue!
                payeeNames[id] = payeeName
                return Transaction(
                    id: id, accountId: accountId, date: date, amountMinor: amountMinor,
                    currency: "GBP",
                    dedupeHash: Dedupe.makeDedupeHash(
                        accountId: accountId, date: date, amountMinor: amountMinor,
                        payeeOrDescription: payeeName
                    )
                )
            }
            let got = Dedupe.checkDuplicate(
                candidate, existingByAccount: existing, payeeNameOf: { payeeNames[$0.id] ?? "" }
            )
            #expect(got.exact == c.expect["exact"]!.boolValue!, comment)
            #expect(got.nearDuplicateOf?.id == c.expect["nearDuplicateOfId"]!.stringValue, comment)

        // ---- import: dates, decimals, amounts -----------------------------
        case "import.parseDateString":
            let got = Import.parseDateString(
                input["value"]!.stringValue!,
                format: DateOrderOption(input["format"]?.stringValue ?? "auto")
            )
            #expect(got == c.expect["date"]!.stringValue, comment)

        case "import.detectDateFormat":
            let got = Import.detectDateFormat(
                (input["values"]?.arrayValue ?? []).compactMap(\.stringValue)
            )
            #expect(got.rawValue == c.expect["value"]!.stringValue!, comment)

        case "import.detectDecimalStyle":
            let got = Import.detectDecimalStyle(
                (input["values"]?.arrayValue ?? []).compactMap(\.stringValue),
                decimals: Int(input["decimals"]?.intValue ?? 2)
            )
            #expect(got.rawValue == c.expect["value"]!.stringValue!, comment)

        case "import.parseImportAmount":
            let got = Import.parseImportAmount(
                input["value"]!.stringValue!,
                currency: input["currency"]!.stringValue!,
                decimal: DecimalStyleOption(input["decimal"]?.stringValue ?? "auto")
            )
            #expect(got == c.expect["minor"]!.intValue, comment)

        // ---- import: format detection and parsing -------------------------
        case "import.detectFormat":
            let headers = (input["headers"]?.arrayValue ?? []).compactMap(\.stringValue)
            let isReport = Import.isMoneyWizReportCsv(headers: headers)
            let isFlat = Import.isMoneyWizCsv(headers: headers)
            #expect(isReport == c.expect["isReport"]!.boolValue!, comment)
            #expect(isFlat == c.expect["isFlat"]!.boolValue!, comment)
            // THE PRECEDENCE TRAP, asserted rather than assumed: a Report file
            // answers yes to BOTH tests, so the chosen format has to ask the
            // Report question first.
            let chosen = isReport ? "moneywiz-report" : (isFlat ? "moneywiz-flat" : "generic-csv")
            #expect(chosen == c.expect["chosen"]!.stringValue!, comment)

        case "import.guessMapping":
            let got = Import.guessMapping(
                headers: (input["headers"]?.arrayValue ?? []).compactMap(\.stringValue),
                sampleRows: (input["sampleRows"]?.arrayValue ?? []).map { row in
                    (row.arrayValue ?? []).compactMap(\.stringValue)
                }
            )
            #expect(got == Self.mapping(c.expect["mapping"]!), comment)

        case "import.parseWithMapping":
            let table = CSV.parse(input["csv"]!.stringValue!)
            let got = Import.parseWithMapping(
                table.data,
                mapping: Self.mapping(input["mapping"]!),
                fixedCurrency: input["fixedCurrency"]?.stringValue ?? ""
            )
            expectRows(got, c.expect["rows"]!.arrayValue!, comment)

        case "import.parseMoneyWizCsv":
            let result = Import.parseMoneyWizCsv(
                input["csv"]!.stringValue!,
                dateFormat: DateOrderOption(input["dateFormat"]?.stringValue ?? "auto")
            )
            expectRows(result.rows, c.expect["rows"]!.arrayValue!, comment)
            if let headers = c.expect["headers"]?.arrayValue {
                #expect(result.headers == headers.compactMap(\.stringValue), comment)
            }
            #expect(result.detectedDateFormat.rawValue == c.expect["detectedDateFormat"]!.stringValue!, comment)
            expectWarnings(result.warnings, c.expect["warnings"], advisory: c.advisory, comment: comment)

        case "import.parseMoneyWizReportCsv":
            let result = Import.parseMoneyWizReportCsv(
                input["csv"]!.stringValue!,
                dateFormat: DateOrderOption(input["dateFormat"]?.stringValue ?? "auto")
            )
            expectRows(result.rows, c.expect["rows"]!.arrayValue!, comment)
            expectAccounts(result.accounts, c.expect["accounts"]!.arrayValue!, comment)
            #expect(result.detectedDateFormat.rawValue == c.expect["detectedDateFormat"]!.stringValue!, comment)
            expectWarnings(result.warnings, c.expect["warnings"], advisory: c.advisory, comment: comment)

        case "import.reportOpeningBalances":
            let result = Import.parseMoneyWizReportCsv(input["csv"]!.stringValue!)
            expectAccounts(result.accounts, c.expect["accounts"]!.arrayValue!, comment)

        case "import.reportCategoryPaths":
            let result = Import.parseMoneyWizReportCsv(input["csv"]!.stringValue!)
            let want = c.expect["paths"]!.arrayValue!.map { path in
                (path.arrayValue ?? []).compactMap(\.stringValue)
            }
            #expect(result.rows.map(\.categoryPath) == want, comment)

        case "import.reportRows":
            let result = Import.parseMoneyWizReportCsv(input["csv"]!.stringValue!)
            expectRows(result.rows, c.expect["rows"]!.arrayValue!, comment)
            if let warningCount = c.expect["warningCount"]?.intValue {
                #expect(Int64(result.warnings.count) == warningCount, comment)
            }
            #expect(result.detectedDateFormat.rawValue == c.expect["detectedDateFormat"]!.stringValue!, comment)

        default:
            Issue.record("\(c.id): op \"\(c.op)\" is not dispatched by this harness")
        }
    }

    static func range(_ input: JSONValue) -> DateRange {
        DateRange(from: input["from"]!.stringValue!, to: input["to"]!.stringValue!)
    }

    /// Compare parsed rows field by field -- but ONLY the fields the case
    /// actually states.
    ///
    /// A case that names four fields is a claim about four fields; asserting
    /// the other ten against whatever this implementation produced would be
    /// writing new expectations and calling them oracle. Keys the case does
    /// name are exact, including the difference between `null` and a value.
    func expectRows(_ got: [ParsedRow], _ want: [JSONValue], _ comment: Comment) {
        #expect(got.count == want.count, comment)
        for (row, expected) in zip(got, want) {
            let where_ = Comment(rawValue: "\(comment.rawValue)\nrow index \(row.index)")
            if let v = expected["index"] { #expect(Int64(row.index) == v.intValue, where_) }
            if let v = expected["date"] { #expect(row.date == v.stringValue, where_) }
            if let v = expected["amountMinor"] { #expect(row.amountMinor == v.intValue, where_) }
            if let v = expected["currency"] { #expect(row.currency == v.stringValue, where_) }
            if let v = expected["accountName"] { #expect(row.accountName == v.stringValue, where_) }
            if let v = expected["payeeName"] { #expect(row.payeeName == v.stringValue, where_) }
            if let v = expected["description"] { #expect(row.description == v.stringValue, where_) }
            if let v = expected["notes"] { #expect(row.notes == v.stringValue, where_) }
            if let v = expected["transferAccountName"] {
                #expect(row.transferAccountName == v.stringValue, where_)
            }
            if let v = expected["amountText"] { #expect(row.amountText == v.stringValue, where_) }
            if let v = expected["amountRule"] { #expect(row.amountRule.rawValue == v.stringValue, where_) }
            if let v = expected["error"] { #expect(row.error == v.stringValue, where_) }
            if let v = expected["categoryPath"]?.arrayValue {
                #expect(row.categoryPath == v.compactMap(\.stringValue), where_)
            }
            if let v = expected["tags"]?.arrayValue {
                #expect(row.tags == v.compactMap(\.stringValue), where_)
            }
        }
    }

    func expectAccounts(_ got: [ReportAccount], _ want: [JSONValue], _ comment: Comment) {
        #expect(got.count == want.count, comment)
        for (account, expected) in zip(got, want) {
            let where_ = Comment(rawValue: "\(comment.rawValue)\naccount \(account.name)")
            #expect(account.name == expected["name"]!.stringValue!, where_)
            #expect(account.currency == expected["currency"]!.stringValue!, where_)
            #expect(account.currentBalanceMinor == expected["currentBalanceMinor"]!.intValue, where_)
            // null is a REFUSAL, not zero: an opening balance the parser
            // declines to state must come back nil, because a plausible wrong
            // one poisons that account's every figure for ever.
            #expect(account.openingBalanceMinor == expected["openingBalanceMinor"]!.intValue, where_)
        }
    }

    /// Warnings: the COUNT is exact, the PROSE is advisory.
    ///
    /// The oracle says so outright -- "a port is bound by when a warning is
    /// raised, not by its wording" -- and marks `warnings` advisory on the
    /// parser cases. So the count and the order are asserted hard (they encode
    /// which conditions fired, and in what sequence), and a wording difference
    /// is recorded as a note on the same activity rather than a failure.
    func expectWarnings(
        _ got: [String], _ expected: JSONValue?, advisory: Set<String>, comment: Comment
    ) {
        guard let want = expected?.arrayValue?.compactMap(\.stringValue) else { return }
        #expect(got.count == want.count, Comment(rawValue: "\(comment.rawValue)\nwarnings: \(got)"))
        guard advisory.contains("warnings") else {
            #expect(got == want, comment)
            return
        }
        for (mine, theirs) in zip(got, want) where mine != theirs {
            Issue.record(
                Comment(
                    rawValue: """
                        \(comment.rawValue)
                        ADVISORY (not a failure of the money rules): warning wording differs.
                          oracle: \(theirs)
                          swift:  \(mine)
                        """
                )
            )
        }
    }

    /// Digits, sign and decimal point only -- everything a locale is allowed to
    /// decide is stripped out.
    func numericSkeleton(_ text: String) -> String {
        var out = ""
        for ch in text where ch.isASCII && (ch.isNumber || ch == "." || ch == "-") {
            out.append(ch)
        }
        // A leading minus can be written after the currency sign ("£-5") or
        // before it ("-£5"); normalise to the plain form's leading minus.
        if out.contains("-") {
            out = "-" + out.replacingOccurrences(of: "-", with: "")
        }
        return out
    }

    // MARK: The tests

    /// The six fixture files and the case counts `index.json` claims for them.
    /// Kept here as literals so that a case appearing or vanishing on the
    /// TypeScript side is a RED SUITE, not a quietly smaller one.
    static let census: [(file: String, area: String, count: Int)] = [
        ("money.json", "money", 71),
        ("fx.json", "fx", 25),
        ("balances.json", "balances", 19),
        ("budgets.json", "budgets", 45),
        ("reports.json", "reports", 29),
        ("import.json", "import", 95),
    ]

    @Test("oracle: money.json (71 cases)")
    func money() throws { try run(try Self.load("money.json")) }

    @Test("oracle: fx.json (25 cases)")
    func fx() throws { try run(try Self.load("fx.json")) }

    @Test("oracle: balances.json (19 cases)")
    func balances() throws { try run(try Self.load("balances.json")) }

    @Test("oracle: budgets.json (45 cases)")
    func budgets() throws { try run(try Self.load("budgets.json")) }

    @Test("oracle: reports.json (29 cases)")
    func reports() throws { try run(try Self.load("reports.json")) }

    @Test("oracle: import.json (95 cases)")
    func importing() throws { try run(try Self.load("import.json")) }

    /// Every case in every file names an op this harness can run.
    ///
    /// Without this, adding a case on the TypeScript side with a new op would
    /// leave the Swift suite green while proving strictly less than it did
    /// before -- the exact failure mode an oracle is supposed to prevent. The
    /// list is spelled out rather than derived from the fixtures, because a
    /// list derived from the fixtures would agree with them by construction.
    @Test("oracle: every case in every file dispatches")
    func everyCaseDispatches() throws {
        let known: Set<String> = [
            "money.decimalsFor", "money.minorFactor", "money.roundHalfAwayFromZero",
            "money.parseAmountToMinor", "money.formatMinorPlain", "money.formatMinor",
            "money.sumSplits",
            "fx.convertMinor", "fx.convertEach",
            "balances.balanceFromAmounts", "balances.countsTowardNetWorth",
            "balances.accountBalances", "balances.netWorth",
            "budgets.windowContaining", "budgets.shiftWindow", "budgets.shiftWindowRoundTrip",
            "budgets.progress",
            "categories.descendantIds", "categories.categoryPathName",
            "reports.spendingByCategory", "reports.incomeVsExpenseByMonth",
            "reports.cashFlowByMonth", "reports.spendingByPayee", "reports.spendingByTag",
            "reports.netWorthSeries",
            "import.normalizeForHash", "import.makeDedupeHash", "import.levenshtein",
            "import.similarPayee", "import.checkDuplicate",
            "import.parseDateString", "import.detectDateFormat", "import.detectDecimalStyle",
            "import.parseImportAmount", "import.detectFormat", "import.guessMapping",
            "import.parseWithMapping", "import.parseMoneyWizCsv", "import.parseMoneyWizReportCsv",
            "import.reportOpeningBalances", "import.reportCategoryPaths", "import.reportRows",
        ]
        for entry in Self.census {
            let file = try Self.load(entry.file)
            #expect(!file.cases.isEmpty, "\(entry.file) has no cases -- the fixture path is probably wrong")
            for c in file.cases {
                #expect(known.contains(c.op), "\(entry.file): op \"\(c.op)\" has no Swift implementation")
            }
        }
    }

    /// The oracle is the size and shape this harness thinks it is.
    ///
    /// Six files, 284 cases, none of them skipped and none of them missing. If
    /// this fails, the answer is never to edit the numbers: it is that the
    /// fixtures moved, and somebody has to decide whether the money rules were
    /// meant to move with them.
    @Test("oracle: all six files are driven, and all 284 cases")
    func theOracleIsWhatWeThinkItIs() throws {
        let present = Set(
            try FileManager.default.contentsOfDirectory(atPath: Self.casesDirectory.path)
                .filter { $0.hasSuffix(".json") && $0 != "index.json" }
        )
        #expect(present == Set(Self.census.map(\.file)), "the oracle has gained or lost a file")

        var total = 0
        for entry in Self.census {
            let file = try Self.load(entry.file)
            #expect(file.cases.count == entry.count, "\(entry.file) (\(entry.area)) changed size")
            #expect(Set(file.cases.map(\.id)).count == file.cases.count, "\(entry.file) has a duplicate id")
            total += file.cases.count
        }
        #expect(total == 284, "the oracle is no longer 284 cases")
    }

    /// THE INVARIANT THE ORIGINAL DEFECT VIOLATED: the headline figure and the
    /// right-hand end of the chart are the SAME NUMBER for the SAME BOOK.
    ///
    /// `netWorth` (balances.json) and `netWorthSeries` (reports.json) are
    /// different functions in different files, and they used to round
    /// differently -- one per account, one per currency -- so the dashboard
    /// headline and the last point of the net-worth chart disagreed by a penny
    /// on the owner's real book. Nothing could catch it while every fixture
    /// book had at most one counted account per currency, because there the
    /// two rules are the same arithmetic.
    ///
    /// The two books named here have several counted accounts sharing a
    /// currency, and each one's series range ends after its last transaction,
    /// so the final point is the whole book -- exactly what the headline
    /// states. Comparing the two FIXTURES (not two Swift results) is
    /// deliberate: it means "fixing" one file's expectation without the other
    /// is a red suite rather than a quietly restored bug.
    @Test("oracle: the headline figure and the last point of the chart agree")
    func headlineMatchesChart() throws {
        let balances = try Self.load("balances.json")
        let reports = try Self.load("reports.json")
        for book in ["rounding-pair", "shared-currency"] {
            let headline = try #require(
                balances.cases.first {
                    $0.op == "balances.netWorth" && $0.input["book"]?.stringValue == book
                },
                "balances.json no longer carries a netWorth case for the \(book) book"
            )
            let chart = try #require(
                reports.cases.first {
                    $0.op == "reports.netWorthSeries" && $0.input["book"]?.stringValue == book
                },
                "reports.json no longer carries a netWorthSeries case for the \(book) book"
            )
            let lastPoint = try #require(chart.expect["points"]?.arrayValue?.last)
            #expect(
                headline.expect["totalBaseMinor"]?.intValue == lastPoint["totalBaseMinor"]?.intValue,
                """
                \(book): \(headline.id) says \(headline.expect["totalBaseMinor"]?.intValue ?? -1)                 and the last point of \(chart.id) says \(lastPoint["totalBaseMinor"]?.intValue ?? -1).                 Two figures for one book, and that disagreement IS the defect these books exist to catch.
                """
            )
        }
    }

    /// The hand-calculated cases are the ones that state what the money SHOULD
    /// do, independently of any implementation, and the README says to make
    /// them pass first. They are counted here so a reader of a green run knows
    /// how much of what passed is a statement about money rather than a
    /// statement about agreement between two programs.
    @Test("oracle: the provenance mix is the documented one")
    func provenanceCensus() throws {
        var hand = 0
        var derived = 0
        for entry in Self.census {
            for c in try Self.load(entry.file).cases {
                if c.provenance == "hand-calculated" { hand += 1 } else { derived += 1 }
            }
        }
        #expect(hand == 272, "the hand-calculated count moved")
        #expect(derived == 12, "the derived count moved")
    }
}
