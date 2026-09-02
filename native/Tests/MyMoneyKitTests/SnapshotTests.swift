// The widget's figures: that they are the app's own, that they say how old they
// are, and that every way of failing to read them ends in "nothing" rather than
// in a number.
//
// A widget is the one screen in this system nobody is looking at when it is
// drawn. Every failure mode here is therefore silent by nature, which is why
// each of them is a test: a snapshot from a future version decoded as zeros, a
// half-written file, a clock that disagrees, a book that has been emptied. All
// four produce a plausible home-screen figure if nobody wrote the branch.
import Foundation
import Testing

@testable import MyMoneyKit

struct SnapshotTests {

    private func demoStore() throws -> LedgerStore {
        let store = try LedgerStore.openInMemory()
        try store.importBackup(
            data: Data(
                try BackupWriter.text(
                    DemoBookTests.book(), exportedAt: "2026-09-01T08:00:00.000Z"
                ).utf8
            )
        )
        return store
    }

    // MARK: - The figures are the app's own

    @Test("THE WIDGET'S NET WORTH IS THE DASHBOARD'S NET WORTH, to the penny")
    func agreesWithTheDashboard() throws {
        let store = try demoStore()
        defer { store.close() }
        let book = try store.book()
        let dashboard = try Dashboard.summary(book: book, today: "2026-09-02")
        let snapshot = try #require(
            try store.ledgerSnapshot(
                book: book, today: "2026-09-02", asOf: "2026-09-02T09:00:00.000Z"
            )
        )

        // Not "close to" and not recomputed: the same integers, carried.
        #expect(snapshot.netWorthMinor == dashboard.netWorth.totalBaseMinor)
        #expect(snapshot.baseCurrency == dashboard.netWorth.baseCurrency)
        #expect(snapshot.monthSpentMinor == dashboard.thisMonth.expenseMinor)
        #expect(snapshot.monthIncomeMinor == dashboard.thisMonth.incomeMinor)
        #expect(snapshot.monthKey == dashboard.thisMonth.month)

        // The caveats travel with the figure. A total that leaves accounts or
        // currencies out must be markable as such on the widget too, or the
        // widget becomes the one screen that overstates it.
        #expect(snapshot.excludedAccountCount == dashboard.netWorth.excludedCount)
        #expect(snapshot.missingRateCurrencies == dashboard.netWorth.missingRateCurrencies)
        #expect(!snapshot.missingRateCurrencies.isEmpty, "the demo book has an unrated currency")
        #expect(snapshot.excludedAccountCount > 0, "the demo book has excluded accounts")

        #expect(snapshot.transactionCount == (try store.registerCount(scope: .allAccounts)))
        #expect(snapshot.accountCount == (try store.liveCount("accounts")))
    }

    @Test("the budgets are the biggest few, in an order that does not move under the thumb")
    func budgetOrder() throws {
        // FIVE BUDGETS, so that the cap and the ordering both have something to
        // do. The demo book carries none at all, and a test written against it
        // would have asserted "0 <= 3" and passed for ever.
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        for (name, amount) in [
            ("Groceries", Int64(40_000)), ("Fuel", 25_000), ("Coffee", 5_000),
            ("Holidays", 120_000), ("Books", 5_000),
        ] {
            _ = try store.saveBudget(
                BudgetDraft(
                    name: name, categoryIds: ["c-food"], amountMinor: amount,
                    period: .monthly, startDate: "2026-01-31"
                )
            )
        }
        let book = try store.book()
        let snapshot = try #require(
            try store.ledgerSnapshot(
                book: book, today: "2026-09-02", asOf: "2026-09-02T09:00:00.000Z"
            )
        )
        let dashboard = try Dashboard.summary(book: book, today: "2026-09-02")

        #expect(snapshot.budgetCount == 6, "five new ones plus the fixture's own")
        #expect(snapshot.budgets.count == LedgerSnapshot.budgetLimit)
        #expect(snapshot.budgetCount == dashboard.budgetCount)
        // Holidays 1,200.00, then the fixture's own Food at 500.00, then
        // Groceries at 400.00 -- by size, and nothing to do with the
        // alphabetical four the dashboard card happens to show.
        #expect(snapshot.budgets.map(\.name) == ["Holidays", "Food", "Groceries"])

        // The two smallest are equal at 50.00, and the order of the whole list
        // is stable across publishes -- so the widget shows the same three in
        // the same places every time rather than reshuffling under the thumb.
        let again = try #require(
            try store.ledgerSnapshot(book: try store.book(), today: "2026-09-02", asOf: "x")
        )
        #expect(again.budgets.map(\.id) == snapshot.budgets.map(\.id))
        // Largest limit first. NOT "closest to breaching", which would reorder
        // the widget every time a transaction landed.
        let limits = snapshot.budgets.map(\.limitMinor)
        #expect(limits == limits.sorted(by: >))

        // And each line is the app's own progress, carried.
        let everyBudget = try book.allBudgetProgress(refDate: "2026-09-02")
        for line in snapshot.budgets {
            let source = try #require(everyBudget.first { $0.budget.id == line.id })
            #expect(line.spentMinor == source.progress.spentMinor)
            #expect(line.limitMinor == source.progress.limitMinor)
            #expect(line.remainingMinor == source.progress.remainingMinor)
            #expect(line.over == source.progress.over)
            #expect(line.windowEnd == source.progress.window.end)
        }
    }

    @Test("THE LOCAL-EDIT COUNT IS ON THE WIDGET TOO")
    func carriesTheDivergence() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // Freshly imported: the copy and the file say the same thing.
        var snapshot = try #require(
            try store.ledgerSnapshot(today: "2026-09-02", asOf: "2026-09-02T09:00:00.000Z")
        )
        #expect(snapshot.localEditCount == 0)

        _ = try store.saveTransaction(EditFixture.expense())
        _ = try store.saveTransaction(EditFixture.expense(amountMinor: -100))
        snapshot = try #require(
            try store.ledgerSnapshot(today: "2026-09-02", asOf: "2026-09-02T09:00:00.000Z")
        )
        // Two changes this device has and the web app does not. A widget
        // showing a net worth that includes them must be able to say so.
        #expect(snapshot.localEditCount == 2)
        #expect(snapshot.sourceExportedAt != nil)
    }

    @Test("an empty device produces NO snapshot, not a snapshot of nothing")
    func emptyStore() throws {
        let store = try LedgerStore.openInMemory()
        defer { store.close() }
        // £0.00 on a home screen is a figure. "There is no book here" is not,
        // and it is the truth.
        #expect(try store.ledgerSnapshot(today: "2026-09-02", asOf: "x") == nil)
    }

    // MARK: - The file

    @Test("a snapshot survives a round trip through the file")
    func roundTrip() throws {
        let scratch = try ScratchDirectory()
        let store = try demoStore()
        defer { store.close() }
        let snapshot = try #require(
            try store.ledgerSnapshot(today: "2026-09-02", asOf: "2026-09-02T09:00:00.000Z")
        )
        try SnapshotFile.write(snapshot, to: scratch.url)
        #expect(SnapshotFile.read(from: scratch.url) == snapshot)
    }

    @Test("EVERY WAY OF NOT HAVING A SNAPSHOT READS AS nil, never as zero")
    func unreadable() throws {
        let scratch = try ScratchDirectory()

        // Nothing written yet.
        #expect(SnapshotFile.read(from: scratch.url) == nil)

        // Bytes that are not JSON -- what a half-finished write would leave if
        // it were not atomic.
        try Data("{\"version\": 1, \"asOf\"".utf8).write(to: SnapshotFile.url(in: scratch.url))
        #expect(SnapshotFile.read(from: scratch.url) == nil)

        // A FILE FROM A FUTURE VERSION. Well-formed JSON, decodes cleanly into
        // this build's fields, and must still be refused: an older widget left
        // on a home screen after an app update would otherwise draw the fields
        // it understood and zero for the rest.
        let store = try demoStore()
        defer { store.close() }
        let snapshot = try #require(
            try store.ledgerSnapshot(today: "2026-09-02", asOf: "2026-09-02T09:00:00.000Z")
        )
        var object = try #require(
            try JSONSerialization.jsonObject(
                with: try JSONEncoder().encode(snapshot)
            ) as? [String: Any]
        )
        object["version"] = LedgerSnapshot.currentVersion + 1
        try JSONSerialization.data(withJSONObject: object)
            .write(to: SnapshotFile.url(in: scratch.url))
        #expect(SnapshotFile.read(from: scratch.url) == nil)

        // And removing it means removing it.
        try SnapshotFile.write(snapshot, to: scratch.url)
        #expect(SnapshotFile.read(from: scratch.url) != nil)
        SnapshotFile.remove(from: scratch.url)
        #expect(SnapshotFile.read(from: scratch.url) == nil)
    }

    @Test("two snapshots of the same book differ only by their stamp")
    func sameFigures() throws {
        let store = try demoStore()
        defer { store.close() }
        let book = try store.book()
        let a = try #require(
            try store.ledgerSnapshot(book: book, today: "2026-09-02", asOf: "2026-09-02T09:00:00.000Z")
        )
        let b = try #require(
            try store.ledgerSnapshot(book: book, today: "2026-09-02", asOf: "2026-09-02T11:00:00.000Z")
        )
        #expect(a != b, "the stamp moved")
        #expect(a.sameFigures(as: b), "and nothing else did")
        // A different day is a different month figure eventually; a different
        // BOOK certainly is.
        let other = try #require(
            try store.ledgerSnapshot(book: book, today: "2026-07-02", asOf: "2026-09-02T09:00:00.000Z")
        )
        #expect(!a.sameFigures(as: other))
    }

    // MARK: - How old is too old

    @Test("THE AGE IS ALWAYS SAID, in words a glance can read")
    func freshnessWords() throws {
        func phrase(_ seconds: TimeInterval) -> String {
            SnapshotFreshness(age: seconds).phrase
        }
        #expect(phrase(0) == "just now")
        #expect(phrase(89) == "just now")
        #expect(phrase(90) == "1 minute ago")
        #expect(phrase(600) == "10 minutes ago")
        #expect(phrase(3600) == "1 hour ago")
        #expect(phrase(3 * 3600) == "3 hours ago")
        #expect(phrase(50 * 3600) == "2 days ago")
        #expect(SnapshotFreshness(age: 0).line == "as at just now")
    }

    @Test("past six hours the widget says so out loud")
    func staleness() {
        #expect(!SnapshotFreshness(age: 5 * 3600).isStale)
        #expect(SnapshotFreshness(age: 6 * 3600).isStale)
        #expect(SnapshotFreshness(age: 5 * 3600).longLine == "as at 5 hours ago")
        let stale = SnapshotFreshness(age: 30 * 3600).longLine
        #expect(stale.contains("open MyMoney"))
    }

    @Test("A CLOCK THAT DISAGREES DOES NOT PRODUCE \"in three hours\"")
    func clockSkew() throws {
        let now = try #require(SnapshotFreshness.instant("2026-09-02T09:00:00.000Z"))
        // Written three hours in the "future" -- two devices, one clock ahead.
        let ahead = try #require(
            SnapshotFreshness.of(asOf: "2026-09-02T12:00:00.000Z", now: now)
        )
        #expect(ahead.age == 0)
        #expect(ahead.phrase == "just now")

        let behind = try #require(
            SnapshotFreshness.of(asOf: "2026-09-02T06:00:00.000Z", now: now)
        )
        #expect(behind.phrase == "3 hours ago")

        // Both ISO shapes this app writes, and nothing else.
        #expect(SnapshotFreshness.of(asOf: "2026-09-02T06:00:00Z", now: now)?.phrase == "3 hours ago")
        #expect(SnapshotFreshness.of(asOf: "not a date", now: now) == nil)
    }
}
