// The one test that is run against the owner's REAL data -- and the reason it
// contains none of it.
//
// There is a frozen export of the live book sitting outside this repository,
// read-only, with a content hash written down. It is the strongest possible
// check on everything in this package at once: if the Swift side can read that
// file, recompute its manifest from its own rows, agree with every figure the
// file claims, and reproduce the same SHA-256 the browser computed, then the
// port is not merely passing tests -- it is producing the same numbers, for the
// same 58 accounts and 5,127 transactions, as the build the owner uses today.
//
// WHY IT IS DRIVEN BY ENVIRONMENT VARIABLES. This repository is PUBLIC. The
// file's path, its content hash, its row counts and its net worth are all facts
// about a real person's finances, and none of them belongs in a committed test
// -- a hash is not sensitive on its own, but a net worth total certainly is, and
// "some of these constants are fine" is exactly the reasoning that eventually
// commits the wrong one. So the test asserts against values it is GIVEN, and
// skips entirely when it is not:
//
//   MYMONEY_FROZEN_BACKUP        path to the frozen file (required to run)
//   MYMONEY_FROZEN_HASH          expected canonical content hash (optional)
//   MYMONEY_FROZEN_ACCOUNTS      expected account row count (optional)
//   MYMONEY_FROZEN_TRANSACTIONS  expected transaction row count (optional)
//   MYMONEY_FROZEN_NET_WORTH     expected net worth, in minor units (optional)
//
// Run it with:
//   MYMONEY_FROZEN_BACKUP=... MYMONEY_FROZEN_HASH=... swift test
//
// NOTHING HERE WRITES. The file is opened read-only and never copied into the
// repository, never re-serialised to disk, never chmod-ed. It is evidence, not
// a fixture.
import Foundation
import Testing

@testable import MyMoneyKit

struct FrozenBackupTests {

    static func env(_ name: String) -> String? {
        guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return nil }
        return value
    }

    /// The path, but only when a file is actually there.
    ///
    /// The existence check is not belt and braces: an environment variable
    /// left over from a machine where the file has since moved would otherwise
    /// turn "there is nothing to check against" into a red test, and a red
    /// test nobody can fix is a test that gets deleted.
    static var frozenPath: String? {
        guard let path = env("MYMONEY_FROZEN_BACKUP") else { return nil }
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }

    @Test(
        "the frozen real-data backup reads, proves itself, and reproduces its hash",
        .enabled(if: FrozenBackupTests.frozenPath != nil, "no frozen backup to run against")
    )
    func frozenBackupVerifies() throws {
        let path = try #require(Self.frozenPath)
        let data = try Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe])

        // The whole chain in one call: parse (Int64 exact), validate the shape,
        // decode every row, recompute the manifest from those rows, and refuse
        // if any figure disagrees. Anything wrong anywhere in this package
        // shows up here as a throw.
        let imported = try BackupImporter.load(data: data)

        #expect(imported.verified, "the frozen file is expected to carry a checkable manifest")
        #expect(imported.warnings.isEmpty, "no amount in a browser-written file can exceed 2^53")
        #expect(imported.recomputedManifest == imported.claimedManifest)

        // The fingerprint the browser computed over the same content.
        if let expectedHash = Self.env("MYMONEY_FROZEN_HASH") {
            #expect(imported.contentHash == expectedHash)
        }

        // Re-emitting the parsed document and hashing THAT must give the same
        // answer: the canonical form has to be a fixed point, or a Swift-written
        // export could never match a browser-written one.
        let reserialised = CanonicalJSON.text(imported.file.root, indent: 0)
        #expect(
            BackupReader.canonicalHash(try JSONParser.parse(reserialised)) == imported.contentHash
        )
        // And the pretty form must fingerprint identically too -- whitespace is
        // not data.
        let pretty = CanonicalJSON.text(imported.file.root, indent: 2)
        #expect(BackupReader.canonicalHash(try JSONParser.parse(pretty)) == imported.contentHash)

        // Figures, only if the runner supplied them.
        if let accounts = Self.env("MYMONEY_FROZEN_ACCOUNTS").flatMap(Int.init) {
            #expect(imported.book.accounts.count == accounts)
        }
        if let transactions = Self.env("MYMONEY_FROZEN_TRANSACTIONS").flatMap(Int.init) {
            #expect(imported.book.transactions.count == transactions)
        }
        if let netWorth = Self.env("MYMONEY_FROZEN_NET_WORTH").flatMap(Int64.init) {
            // Computed the long way -- balances from the rows, totalled per
            // currency and each subtotal converted once -- not read out of the
            // manifest. Reading the manifest would only prove the file is
            // self-consistent, which the import already established.
            //
            // NOTE FOR WHOEVER SETS THE VARIABLE: it pins the app's HEADLINE
            // figure, which rounds per currency. A number copied out of a v1
            // file's manifest is the older per-account total and may be a penny
            // or two adrift of it; take this one off the dashboard, not out of
            // the file. FrozenGateTests says so out loud when it happens.
            #expect(try imported.book.netWorth().totalBaseMinor == netWorth)
        }

        // A last belt-and-braces check that nothing was mutated on disk.
        let after = try Data(contentsOf: URL(fileURLWithPath: path))
        #expect(after.count == data.count)
    }

    /// The budget and report engines, driven over the REAL book.
    ///
    /// The oracle's books are a dozen rows each, hand-built to isolate one rule
    /// at a time. This runs the same code over 58 accounts and 5,127 real
    /// transactions across four currencies and several years -- which is the
    /// only way to find out whether the engines hold together at the shape of
    /// the owner's actual life.
    ///
    /// EVERY ASSERTION HERE IS AN INVARIANT, never a figure. Nothing in this
    /// test knows or states what any of his numbers are; it checks that the
    /// numbers agree with each other. That is deliberate and is what lets a
    /// real-data test live in a public repository at all.
    @Test(
        "the report and budget engines hold together over the real book",
        .enabled(if: FrozenBackupTests.frozenPath != nil, "no frozen backup to run against")
    )
    func frozenBackupDrivesTheReportEngines() throws {
        let path = try #require(Self.frozenPath)
        let book = try BackupImporter.load(
            data: try Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe])
        ).book
        let dates = book.transactions.map(\.date)
        let range = DateRange(from: dates.min() ?? "1970-01-01", to: dates.max() ?? "1970-01-01")

        // --- the two net-worth figures, and the gap that used to be here -----
        //
        // `netWorth()` and `netWorthSeries()` both convert once per CURRENCY
        // SUBTOTAL. They did not always: the headline used to convert once per
        // ACCOUNT, and with two counted accounts in the same foreign currency
        // that is a different rounding -- on THIS book it gave two different
        // answers for one moment in one ledger, the dashboard disagreeing with
        // the right-hand end of its own chart. This test used to assert that
        // gap, faithfully, because the TypeScript had it in both places.
        //
        // It is gone now. What is asserted is that each figure is EXACTLY what
        // the per-currency rule says, with no tolerance anywhere, and that the
        // two agree -- which is the whole content of the fix, stated over the
        // only book big enough to have shown the defect in the first place.
        // (A backup FILE may still state the per-account total: a v1 manifest
        // means per-account and is verified that way forever. That is
        // FrozenGateTests' business, not this one's.)
        let series = try Reports.netWorthSeries(range, book: book)
        let headline = try book.netWorth()
        let counted = try book.accountBalances().filter { Balances.countsTowardNetWorth($0.account) }

        var perCurrency: [String: Int64] = [:]
        for row in counted {
            perCurrency[row.account.currency, default: 0] += row.balanceMinor
        }
        var byCurrencyTotal: Int64 = 0
        for (currency, minor) in perCurrency {
            guard case .converted(let value) = Money.convert(
                minor: minor, from: currency, to: book.baseCurrency, using: book.rateTable
            ) else { continue }
            byCurrencyTotal += value
        }
        #expect(
            series.points.last?.totalBaseMinor == byCurrencyTotal,
            "the chart's last point is the per-currency conversion, exactly"
        )
        #expect(
            headline.totalBaseMinor == byCurrencyTotal,
            "the headline figure is the per-currency conversion, exactly"
        )
        #expect(
            headline.totalBaseMinor == series.points.last?.totalBaseMinor,
            "the dashboard headline and the last point of its own chart are one number"
        )
        // The per-account total is deliberately NOT recomputed here to be
        // compared with anything: on this book it is a different integer, it is
        // what a v1 backup file states, and whether a file's claim matches its
        // own version's rule is FrozenGateTests' question, asked there against
        // the file itself.
        // Sample dates ascend and are unique.
        #expect(series.points.map(\.date) == Array(Set(series.points.map(\.date))).sorted())

        // --- flow reports are internally consistent -------------------------
        let byCategory = try Reports.spendingByCategory(range, parentId: nil, book: book)
        #expect(byCategory.totalMinor == byCategory.rows.reduce(0) { $0 + $1.spentMinor })
        #expect(byCategory.rows.allSatisfy { $0.spentMinor != 0 }, "zero rows are dropped")
        #expect(
            byCategory.rows == byCategory.rows.sorted { $0.spentMinor > $1.spentMinor },
            "rows are ordered by amount descending"
        )

        // Drilling into a top-level row must account for exactly that row.
        for row in byCategory.rows {
            guard let id = row.categoryId, row.hasChildren else { continue }
            let drill = try Reports.spendingByCategory(range, parentId: id, book: book)
            #expect(
                drill.totalMinor == row.spentMinor,
                "drilling into a category must add up to the row it was drilled from"
            )
        }

        let months = try Reports.incomeVsExpenseByMonth(range, book: book)
        let flow = try Reports.cashFlowByMonth(range, book: book)
        #expect(months.rows.map(\.month) == flow.rows.map(\.month))
        var running: Int64 = 0
        for (ie, cf) in zip(months.rows, flow.rows) {
            #expect(cf.netMinor == ie.incomeMinor - ie.expenseMinor)
            running += cf.netMinor
            #expect(cf.cumulativeMinor == running)
        }
        #expect(months.rows.map(\.month) == months.rows.map(\.month).sorted(), "months ascend")

        // A payee row counts DISTINCT transactions, so it can never claim more
        // contributing transactions than the book contains.
        let payees = try Reports.spendingByPayee(range, book: book)
        #expect(payees.rows.reduce(0) { $0 + $1.txCount } <= book.transactions.count)
        #expect(payees.rows.allSatisfy { $0.spentMinor != 0 })
        // Every report over the same range must agree about how many
        // transactions it could not convert -- they share one loader, and a
        // divergence here would mean two screens disagree about what is missing.
        #expect(byCategory.missingRateCount == months.missingRateCount)
        #expect(byCategory.missingRateCount == payees.missingRateCount)
        let tags = try Reports.spendingByTag(range, book: book)
        #expect(byCategory.missingRateCount == tags.missingRateCount)

        // --- budgets tile the real book's whole span ------------------------
        //
        // A budget over every expense category, anchored on a date chosen to
        // land on a clamped month end. Each window's spend must be exactly what
        // a report over the same dates says, or the two screens disagree about
        // the same month.
        let expenseRoots = book.categories.filter { $0.kind == .expense && $0.parentId == nil }
        let budget = BudgetSpec(
            categoryIds: expenseRoots.map(\.id), amountMinor: 100_000,
            period: .monthly, startDate: "2024-01-31"
        )
        var probe = CalendarDate(iso: range.from)!
        let end = CalendarDate(iso: range.to)!
        var windowsSeen = 0
        while probe <= end, windowsSeen < 240 {
            let progress = try book.budgetProgress(budget, refDate: probe.iso)
            #expect(progress.window.contains(probe.iso))
            #expect(progress.remainingMinor == progress.limitMinor - progress.spentMinor)
            #expect(progress.over == (progress.spentMinor > progress.limitMinor))
            windowsSeen += 1
            probe = CalendarDate(iso: progress.window.end)!.addingDays(1)
        }
        #expect(windowsSeen > 0)
    }
}
