// Keeping a schedule: writing it, refusing it, deleting it, and surviving the
// one thing that could destroy it.
//
// EVERY FIGURE, NAME AND ID IS INVENTED -- the same three-account fixture the
// rest of the store suite runs against.
import Foundation
import Testing

@testable import MyMoneyKit

struct ScheduleStoreTests {

    private func draft(
        id: String? = nil,
        name: String = "Rent",
        account: String = "w-a",
        amountMinor: Int64 = -45000,
        payee: String = "Landlord",
        category: String? = "c-food",
        cadence: Cadence = .monthly,
        start: String = "2026-09-03",
        end: ScheduleEnd = .never,
        expectsFrom: String? = "2026-09-02",
        autoPost: Bool = false,
        paused: Bool = false,
        remind: Bool = true
    ) -> ScheduleDraft {
        ScheduleDraft(
            id: id, name: name, accountId: account, amountMinor: amountMinor, payeeName: payee,
            categoryId: category, notes: "the flat", cadence: cadence, startDate: start, end: end,
            expectsFrom: expectsFrom, autoPost: autoPost, paused: paused, remind: remind
        )
    }

    // MARK: - Writing one

    @Test("a schedule saves and reads back field for field")
    func roundTrip() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveSchedule(draft(end: .afterOccurrences(12)))

        #expect(saved.id == "e-1")
        #expect(saved.createdAt == EditFixture.now)
        #expect(saved.updatedAt == EditFixture.now)

        let read = try #require(try store.schedule(id: "e-1"))
        #expect(read == saved)
        #expect(read.name == "Rent")
        #expect(read.accountId == "w-a")
        #expect(read.amountMinor == -45000)
        #expect(read.payeeName == "Landlord")
        #expect(read.categoryId == "c-food")
        #expect(read.notes == "the flat")
        #expect(read.cadence == .monthly)
        #expect(read.startDate == "2026-09-03")
        #expect(read.end == .afterOccurrences(12))
        #expect(read.expectsFrom == "2026-09-02")
        #expect(read.autoPost == false)
        #expect(read.autoPostFrom == nil)
        #expect(read.paused == false)
        #expect(read.remind)

        // Stored as an INTEGER, like every other amount in this database.
        #expect(try store.auditMoneyColumns().isEmpty)
        #expect(
            try store.connection.scalarText("SELECT typeof(amount_minor) FROM schedules")
                == "integer"
        )
    }

    @Test("the three end shapes each store what they mean, and nothing they do not")
    func endShapes() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let never = try store.saveSchedule(draft(name: "A", end: .never))
        let dated = try store.saveSchedule(draft(name: "B", end: .onDate("2027-09-03")))
        let counted = try store.saveSchedule(draft(name: "C", end: .afterOccurrences(6)))
        #expect(try store.schedule(id: never.id)?.end == .never)
        #expect(try store.schedule(id: dated.id)?.end == .onDate("2027-09-03"))
        #expect(try store.schedule(id: counted.id)?.end == .afterOccurrences(6))
    }

    @Test("EDITING keeps createdAt and the expectation floor, and moves updatedAt")
    func editingPreserves() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let first = try store.saveSchedule(draft())
        store.environment = .fixed(now: EditFixture.later, idPrefix: "e2")

        let changed = try store.saveSchedule(
            draft(id: first.id, name: "Rent (new flat)", amountMinor: -52000)
        )
        #expect(changed.id == first.id)
        #expect(changed.createdAt == EditFixture.now)
        #expect(changed.updatedAt == EditFixture.later)
        #expect(changed.name == "Rent (new flat)")
        #expect(changed.amountMinor == -52000)
        // THE FLOOR DOES NOT MOVE. Setting it again on every save would make a
        // row of overdue payments quietly disappear whenever the owner
        // corrected a typo in the name.
        #expect(changed.expectsFrom == "2026-09-02")
        #expect(try store.schedules().count == 1)
    }

    // MARK: - Refusals

    @Test("EVERY REFUSAL NAMES WHAT WAS WRONG and says the schedule is unchanged")
    func refusals() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        let blank = editError { try store.saveSchedule(draft(name: "   ")) }
        #expect(blank == .blankName(what: "schedule"))

        let zero = editError { try store.saveSchedule(draft(amountMinor: 0)) }
        #expect(zero == .scheduleAmountIsZero)
        #expect(zero?.problem.contains("needs an amount") == true)
        #expect(zero?.unchanged == "Nothing was saved \u{2014} the schedule is still as it was.")

        let account = editError { try store.saveSchedule(draft(account: "nope")) }
        #expect(account == .unknownAccount("nope"))

        let category = editError { try store.saveSchedule(draft(category: "nope")) }
        #expect(category == .unknownCategory("nope"))

        let date = editError { try store.saveSchedule(draft(start: "2026-02-30")) }
        #expect(date == .badDate("2026-02-30"))

        let backwards = editError {
            try store.saveSchedule(draft(start: "2026-09-03", end: .onDate("2026-01-01")))
        }
        #expect(
            backwards == .scheduleEndsBeforeItStarts(start: "2026-09-03", end: "2026-01-01")
        )
        #expect(backwards?.problem.contains("no payments in it at all") == true)

        let count = editError { try store.saveSchedule(draft(end: .afterOccurrences(0))) }
        #expect(count == .scheduleCountNotPositive(0))

        let unknown = editError { try store.saveSchedule(draft(id: "not-there")) }
        #expect(unknown == .unknownSchedule("not-there"))

        // NOTHING WAS WRITTEN by any of them.
        #expect(try store.liveCount("schedules") == 0)
    }

    @Test("the SCHEMA refuses a zero amount too, not only the Swift in front of it")
    func schemaRefusesZero() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveSchedule(draft())
        // The CHECK is the layer that a future query, a migration or another
        // tool still cannot get past.
        #expect(throws: SQLiteError.self) {
            try store.connection.execute("UPDATE schedules SET amount_minor = 0")
        }
        #expect(throws: SQLiteError.self) {
            try store.connection.execute("UPDATE schedules SET amount_minor = 100.0")
        }
        // And the end shape cannot be made incoherent.
        #expect(throws: SQLiteError.self) {
            try store.connection.execute("UPDATE schedules SET end_kind = 'after_count'")
        }
    }

    // MARK: - Deleting

    @Test("deleting a schedule is a tombstone, and undo brings back its history with it")
    func deleteAndUndo() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        try store.skipOccurrence(scheduleId: schedule.id, occurrenceDate: "2026-09-03")

        let receipt = try store.deleteSchedule(id: schedule.id)
        #expect(receipt.table == "schedules")
        #expect(receipt.name == "Rent")
        #expect(try store.schedules().isEmpty)
        #expect(try store.liveCount("schedules") == 0)
        #expect(try store.deletedCount("schedules") == 1)
        // NOTHING WAS DESTROYED: the row is still there, carrying its stamp.
        #expect(
            try store.connection.scalarInt("SELECT count(*) FROM schedules") == 1
        )

        try store.undoDelete(receipt)
        #expect(try store.schedules().count == 1)
        // And the decision it had taken about September is still taken.
        #expect(try store.scheduleHistory(id: schedule.id).count == 1)
    }

    // MARK: - The thing that could destroy them

    @Test("A RE-IMPORT OF THE OWNER'S OWN BACKUP DOES NOT WIPE HIS SCHEDULES")
    func importDoesNotWipeSchedules() throws {
        // The failure this test exists for: an import replaces the whole book,
        // and a schedule swept away by a routine refresh would be work
        // destroyed by an action the owner takes deliberately and often.
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        try store.skipOccurrence(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        #expect(try store.localEdits().count == 0)

        try store.importBackup(text: StoreFixture.backupText, replacingExistingBook: true)

        #expect(try store.schedules().count == 1)
        #expect(try store.schedule(id: schedule.id) == schedule)
        #expect(try store.scheduleHistory(id: schedule.id).count == 1)
        // The book itself was replaced, which is what an import is for.
        #expect(try store.liveCount("transactions") == 2)
        #expect(try store.localEdits().count == 0)
    }

    @Test("a store holding only schedules is still an EMPTY store, and can take its first book")
    func schedulesDoNotMakeAStoreNonEmpty() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        try store.saveSchedule(draft())
        // Now empty the book the way a restore would, leaving the schedule.
        try store.connection.transaction { try store.clearAllRows() }
        #expect(try store.isEmpty(), "a device with schedules and no book has no book")
        #expect(try store.liveCount("schedules") == 1)
    }

    @Test("SCHEDULES ARE NOT IN THE BACKUP FILE, and cannot change its content hash")
    func schedulesAreNotExported() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try store.exportContentHash(exportedAt: "2026-09-02T10:00:00.000Z")
        try store.saveSchedule(draft())
        let after = try store.exportContentHash(exportedAt: "2026-09-02T10:00:00.000Z")
        // The file describes the BOOK. A schedule is a plan this device keeps,
        // and a backup whose hash moved because of one would be a backup the
        // web app could not verify.
        #expect(before == after)
        #expect(try store.reproducesSourceFile())
    }

    @Test("A STORE FROM THE PREVIOUS BUILD UPGRADES, and its book is untouched")
    func migratingFromVersionThree() throws {
        let scratch = try ScratchDirectory()
        let path = scratch.file("old.sqlite").path
        let book: Book
        do {
            // Migration 3 is what the last build wrote: a ledger, no schedules.
            let old = try LedgerStore.open(path: path, upTo: 3)
            #expect(old.storeVersion == 3)
            #expect(
                try old.connection.scalarInt(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'schedules'"
                ) == 0
            )
            book = try StoreFixture.imported().book
            try old.writeBook(book)
            old.close()
        }
        let upgraded = try LedgerStore.open(path: path)
        #expect(upgraded.storeVersion == StoreSchema.version)
        #expect(try upgraded.schedules().isEmpty)
        // The capability is there, and the book that was already on the device
        // is identical record for record -- which is the only version of "it
        // still works" worth asserting.
        try upgraded.saveSchedule(draft())
        #expect(try upgraded.liveCount("schedules") == 1)
        expectSameBook(try upgraded.book(), book.sortedById(), "after upgrade:")
        #expect(try upgraded.auditMoneyColumns().isEmpty)
    }

    // MARK: - The divergence count

    @Test("A SCHEDULE DOES NOT MOVE THE DIVERGENCE COUNT; the transaction it posts does")
    func localEditCount() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveSchedule(draft())
        try store.setSchedulePaused(id: "e-1", paused: true)
        try store.setSchedulePaused(id: "e-1", paused: false)
        try store.skipOccurrence(scheduleId: "e-1", occurrenceDate: "2026-09-03")
        // The banner counts transactions the web app has not got. None of the
        // above is one: a schedule is in no balance, no report and no backup
        // file, and counting it would make the number mean something vaguer
        // than it says.
        //
        // AND THE IMPORT RESET IS WHAT MAKES THAT THE ONLY COHERENT CHOICE,
        // which is worth writing down because the absence of a
        // `recordLocalEdit` call in the schedules store reads like an
        // oversight and is not one. `resetLocalEdits` runs on import, because
        // at that instant the copy and the file are the same book again --
        // that is what the count means and why zero is honest. But schedules
        // SURVIVE an import (they are in `nativeTombstonedTables`, so a fresh
        // backup cannot sweep them away). If they counted, an import would
        // reset the number to zero while the schedules were still, in the
        // banner's own words, "not in your web app" -- a figure claiming a
        // parity that had never existed and could never be reached. Counting
        // them makes the number wrong in the one direction it must not be.
        #expect(try store.localEdits().count == 0)

        try store.postScheduled(
            SchedulePosting(scheduleId: "e-1", occurrenceDate: "2026-10-03")
        )
        #expect(try store.localEdits().count == 1, "a posted transaction IS a change")
    }

    // MARK: - Switches

    @Test("AUTO-POST STAMPS ITS FLOOR WHEN IT GOES ON, keeps it while it is on, and clears it")
    func autoPostFloorIsStamped() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        #expect(schedule.autoPostFrom == nil)

        try store.setScheduleAutoPost(id: schedule.id, autoPost: true)
        #expect(try store.schedule(id: schedule.id)?.autoPostFrom == "2026-09-02")

        // A later edit of an unrelated field must NOT move the floor forward --
        // that would make the app forget occurrences it was already entitled to
        // enter.
        store.environment = .fixed(now: "2026-10-15T09:00:00.000Z", idPrefix: "e2")
        try store.saveSchedule(draft(id: schedule.id, name: "Rent", autoPost: true))
        #expect(try store.schedule(id: schedule.id)?.autoPostFrom == "2026-09-02")

        // Off, then on again, IS a fresh decision and does move it: the owner
        // is switching it on today, not retrospectively for the weeks it was
        // off.
        try store.setScheduleAutoPost(id: schedule.id, autoPost: false)
        #expect(try store.schedule(id: schedule.id)?.autoPostFrom == nil)
        try store.setScheduleAutoPost(id: schedule.id, autoPost: true)
        #expect(try store.schedule(id: schedule.id)?.autoPostFrom == "2026-10-15")
    }

    @Test("pausing hides a schedule from what is due without touching anything it has done")
    func pausing() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        #expect(try store.upcoming(today: "2026-09-02").due.count == 1)

        try store.setSchedulePaused(id: schedule.id, paused: true)
        #expect(try store.upcoming(today: "2026-09-02").isEmpty)
        #expect(try store.schedules().count == 1, "it is switched off, not gone")

        try store.setSchedulePaused(id: schedule.id, paused: false)
        #expect(try store.upcoming(today: "2026-09-02").due.count == 1)
    }

    @Test("the switches refuse an id that is not there rather than doing nothing quietly")
    func switchesRefuseUnknownIds() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(editError { try store.setSchedulePaused(id: "x", paused: true) } == .unknownSchedule("x"))
        #expect(editError { try store.setScheduleAutoPost(id: "x", autoPost: true) } == .unknownSchedule("x"))
        #expect(editError { try store.setScheduleRemind(id: "x", remind: false) } == .unknownSchedule("x"))
    }

    // MARK: - The projection's inputs

    @Test("THE PROJECTION STARTS FROM TODAY'S BALANCE, not from one that already has next week in it")
    func balanceAsAtToday() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // A salary the owner has already entered, dated next week.
        try store.saveTransaction(
            TransactionDraft(
                accountId: "w-a", date: "2026-09-09", amountMinor: 100_000, payeeName: "Work"
            )
        )
        // w-a is 975.00 plus the 1,000.00 that has not arrived yet.
        #expect(try store.balance(of: "w-a") == 197_500)

        // A payment big enough to sink the account today, but not once the
        // salary lands. Counting the salary twice -- by starting from a balance
        // that already contains it AND replaying it -- would hide a real
        // shortfall.
        try store.saveSchedule(draft(amountMinor: -120_000, start: "2026-09-05"))
        let plan = try store.upcoming(today: "2026-09-02")
        let warning = try #require(plan.warnings.first)
        #expect(warning.balanceTodayMinor == 97500)
        #expect(warning.date == "2026-09-05")
        #expect(warning.projectedMinor == -22500)
    }

    @Test("the same payment dated after the salary lands does not warn at all")
    func theOrderOfTheTimelineMatters() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveTransaction(
            TransactionDraft(
                accountId: "w-a", date: "2026-09-09", amountMinor: 100_000, payeeName: "Work"
            )
        )
        try store.saveSchedule(draft(amountMinor: -120_000, start: "2026-09-11"))
        #expect(try store.upcoming(today: "2026-09-02").warnings.isEmpty)
    }

    @Test("an archived, net-worth-excluded loan account is projected like any other -- and warns about nothing")
    func loanAccountsDoNotWarn() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveSchedule(draft(account: "w-c", amountMinor: -900_000))
        let plan = try store.upcoming(today: "2026-09-02")
        #expect(plan.due.count == 1)
        #expect(plan.warnings.isEmpty, "a loan is below zero for years; that is not news")
    }
}
