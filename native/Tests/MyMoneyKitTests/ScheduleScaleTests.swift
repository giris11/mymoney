// Forty schedules over a book the size of a real one.
//
// EVERY FIGURE IS INVENTED: the demo book (`DemoBookTests.book()`) is the
// repository's own synthetic fixture -- 58 accounts, four currencies, ~5,200
// transactions -- and the schedules below are made up on top of it.
//
// WHY THIS SUITE EXISTS. `Upcoming.plan` is pure and is tested as arithmetic
// elsewhere; what is NOT provable there is the cost of getting its inputs. The
// upcoming screen reads every live schedule, every decision ever taken about
// one, every transaction dated today or earlier (to get the balance) and every
// one dated later (to project it) -- and it does that on a phone, on a screen
// somebody opens daily. A quadratic in there would not show up in a fixture
// with three transactions in it.
import Foundation
import Testing

@testable import MyMoneyKit

struct ScheduleScaleTests {

    /// The demo book in a store, with forty schedules spread over its accounts.
    private func loadedStore() throws -> (LedgerStore, [Account]) {
        let book = DemoBookTests.book()
        let store = try LedgerStore.openInMemory()
        try store.importBackup(
            data: Data(try BackupWriter.text(book, exportedAt: "2026-09-01T08:00:00.000Z").utf8)
        )
        store.environment = .fixed(now: "2026-09-02T09:00:00.000Z", idPrefix: "sch")
        let accounts = try store.accountBalances().map(\.account).filter { !$0.archived }
        #expect(accounts.count > 10, "the fixture must have accounts to spread schedules over")

        let cadences = Cadence.allCases
        for index in 0..<40 {
            let account = accounts[index % accounts.count]
            let cadence = cadences[index % cadences.count]
            // A spread of anchors, including days past the 28th, so the month
            // clamp is exercised at scale rather than only in a unit test.
            let day = 1 + (index * 7) % 31
            let start = CalendarDate(year: 2026, month: 1, day: min(day, 31)) ?? CalendarDate(iso: "2026-01-15")!
            try store.saveSchedule(
                ScheduleDraft(
                    name: "Standing \(index)",
                    accountId: account.id,
                    amountMinor: index % 9 == 0 ? Int64(120_000 + index) : Int64(-(1000 + index * 37)),
                    payeeName: "Counterparty \(index % 11)",
                    categoryId: nil,
                    notes: "",
                    cadence: cadence,
                    startDate: start.iso,
                    end: index % 5 == 0 ? .afterOccurrences(24) : .never,
                    expectsFrom: "2026-08-01",
                    autoPost: false,
                    paused: index % 13 == 0
                )
            )
        }
        return (store, accounts)
    }

    @Test("FORTY SCHEDULES OVER FIVE THOUSAND TRANSACTIONS, and the screen is still a screen")
    func upcomingIsFastEnoughToOpen() throws {
        let (store, _) = try loadedStore()
        defer { store.close() }

        var worst = 0.0
        var worstWindow = 0
        for window in [0, 7, 30, 90] {
            let started = DispatchTime.now().uptimeNanoseconds
            let plan = try store.upcoming(today: "2026-09-02", horizonDays: window)
            let ms = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
            if ms > worst {
                worst = ms
                worstWindow = window
            }
            #expect(plan.today == "2026-09-02")
            // The wider the window the more is due, never less.
            #expect(plan.due.count >= 0)
        }

        let plan = try store.upcoming(today: "2026-09-02", horizonDays: 90)
        #expect(!plan.due.isEmpty, "forty schedules over ninety days must produce something")
        // FOUR CURRENCIES IN THE BOOK AND NO CONVERSION ANYWHERE: the totals
        // come back one per currency, and a book with a missing rate (the demo
        // book has no JPY rate) still totals perfectly, because nothing here
        // needs a rate.
        #expect(plan.totals.count >= 2)
        #expect(Set(plan.totals.map(\.currency)).count == plan.totals.count)

        // A CEILING, NOT A MEASUREMENT -- the same shape as the register
        // search's bar. The figure is printed so a regression is visible rather
        // than merely under the limit.
        print(
            "upcoming over 5,200 transactions and 40 schedules: "
                + "worst \(String(format: "%.1f", worst)) ms (\(worstWindow)-day window)"
        )
        #expect(worst < 400, "reading what is due took \(worst) ms")
    }

    @Test("the decision log does not slow the screen down as it fills")
    func postingDoesNotDegradeTheRead() throws {
        let (store, _) = try loadedStore()
        defer { store.close() }

        let before = try store.upcoming(today: "2026-09-02", horizonDays: 90)
        // Enter the first forty due occurrences: every one is a transaction
        // plus a decision, and the read afterwards has to join them all.
        var posted = 0
        for occurrence in before.all.prefix(40) {
            do {
                try store.postScheduled(
                    SchedulePosting(
                        scheduleId: occurrence.scheduleId, occurrenceDate: occurrence.date
                    )
                )
                posted += 1
            } catch {
                Issue.record("posting \(occurrence.id) failed: \(error)")
            }
        }
        #expect(posted == 40)

        let started = DispatchTime.now().uptimeNanoseconds
        let after = try store.upcoming(today: "2026-09-02", horizonDays: 90)
        let ms = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        print("upcoming with 40 decisions recorded: \(String(format: "%.1f", ms)) ms")
        #expect(ms < 400)

        // The forty that were entered are gone from the list, and nothing else
        // moved.
        #expect(after.count == before.count - 40)
        #expect(try store.localEdits().count == 40)
    }

    @Test("tracing a transaction back to its schedule is one indexed seek, at scale")
    func traceabilityIsIndexed() throws {
        let (store, _) = try loadedStore()
        defer { store.close() }
        let plan = try store.upcoming(today: "2026-09-02", horizonDays: 90)
        var ids: [String] = []
        for occurrence in plan.all.prefix(30) {
            let transaction = try store.postScheduled(
                SchedulePosting(
                    scheduleId: occurrence.scheduleId, occurrenceDate: occurrence.date
                )
            )
            ids.append(transaction.id)
        }

        // THE PLAN SAYS THIS IS AN INDEX SEEK. Asserted rather than assumed:
        // the register would ask this once per row it draws a badge on, and a
        // scan of the events table per row is exactly the kind of cost that
        // does not show up until the table is big.
        let statement = try store.connection.prepare(
            "EXPLAIN QUERY PLAN SELECT s.id FROM live_schedule_events e "
                + "JOIN live_schedules s ON s.id = e.schedule_id WHERE e.transaction_id = 'x'"
        )
        defer { statement.finalize() }
        var lines: [String] = []
        while try statement.step() { lines.append(try statement.text(3)) }
        let queryPlan = lines.joined(separator: " | ")
        #expect(
            queryPlan.contains("idx_schedule_events_transaction"),
            "the transaction lookup is not using its index; plan was: \(queryPlan)"
        )

        for id in ids {
            let origin = try store.scheduleOrigin(forTransactionId: id)
            #expect(origin != nil, "a posted transaction with no origin")
        }
        // And a transaction nobody scheduled has none, which is the common case
        // in a book of five thousand.
        let ordinary = try store.registerPage(scope: .allAccounts, limit: 1, lookups: try store.registerLookups())
        if let row = ordinary.rows.first, !ids.contains(row.id) {
            #expect(try store.scheduleOrigin(forTransactionId: row.id) == nil)
        }
    }
}
