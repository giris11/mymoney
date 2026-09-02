// Turning a due occurrence into money, and refusing to do it twice.
//
// EVERY FIGURE, NAME AND ID IS INVENTED.
//
// The two properties this file exists to hold:
//
//   * A POSTED TRANSACTION IS AN ORDINARY TRANSACTION. Same door, same
//     validation, same currency rule, same dedupe hash, same divergence count.
//     If posting ever grows its own INSERT, the assertions below stop agreeing
//     with the ones in EditTransactionTests.
//   * THE APP NEVER ENTERS ANYTHING BY ITSELF UNLESS IT WAS TOLD TO. There is a
//     test for the boring case -- a fresh book, opened, posts nothing -- because
//     that is the one somebody could break without noticing.
import Foundation
import Testing

@testable import MyMoneyKit

struct SchedulePostingTests {

    private func draft(
        name: String = "Rent",
        account: String = "w-a",
        amountMinor: Int64 = -45000,
        payee: String = "Landlord",
        category: String? = "c-food",
        cadence: Cadence = .monthly,
        start: String = "2026-09-03",
        end: ScheduleEnd = .never,
        expectsFrom: String? = "2026-09-02",
        autoPost: Bool = false
    ) -> ScheduleDraft {
        ScheduleDraft(
            name: name, accountId: account, amountMinor: amountMinor, payeeName: payee,
            categoryId: category, notes: "the flat", cadence: cadence, startDate: start, end: end,
            expectsFrom: expectsFrom, autoPost: autoPost
        )
    }

    // MARK: - Posting

    @Test("POSTING GOES THROUGH THE ORDINARY WRITE PATH, and looks like a typed transaction")
    func postingIsAnOrdinaryTransaction() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        let before = try #require(try store.balance(of: "w-a"))

        let posted = try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        )

        #expect(posted.date == "2026-09-03")
        #expect(posted.amountMinor == -45000)
        // The currency came from the ACCOUNT, which is the only correct source
        // for it -- the schedule never states one.
        #expect(posted.currency == "GBP")
        #expect(posted.categoryId == "c-food")
        #expect(posted.notes == "the flat")
        #expect(posted.status == .cleared)
        #expect(posted.transferGroupId == nil)
        // The payee was created by the same resolver a typed name goes through.
        let payeeId = try #require(posted.payeeId)
        #expect(try store.payeeName(id: payeeId) == "Landlord")
        // And it carries a dedupe hash, so a CSV of the same payment collides
        // with it instead of doubling it.
        #expect(!posted.dedupeHash.isEmpty)

        #expect(try store.balance(of: "w-a") == before - 45000)
        #expect(try store.localEdits().count == 1)
    }

    @Test("the occurrence's date and the transaction's date are allowed to differ")
    func datesCanDiffer() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        // The 3rd was a Sunday, the bank took it on the 5th, and it was £12
        // more than usual. All three facts are recordable, and the occurrence
        // is still the 3rd's.
        let posted = try store.postScheduled(
            SchedulePosting(
                scheduleId: schedule.id, occurrenceDate: "2026-09-03", date: "2026-09-05",
                amountMinor: -46200, notes: "went up"
            )
        )
        #expect(posted.date == "2026-09-05")
        #expect(posted.amountMinor == -46200)
        #expect(posted.notes == "went up")

        let history = try store.scheduleHistory(id: schedule.id)
        #expect(history.map(\.occurrenceDate) == ["2026-09-03"])
        #expect(history.first?.transactionId == posted.id)
        // And the occurrence is settled, so it is not offered again.
        #expect(try store.upcoming(today: "2026-09-02").due.isEmpty)
    }

    @Test("POSTING THE SAME OCCURRENCE TWICE IS REFUSED, and says nothing was entered")
    func noDoublePosting() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        )
        let error = editError {
            try store.postScheduled(
                SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
            )
        }
        #expect(
            error == .occurrenceAlreadySettled(
                scheduleName: "Rent", date: "2026-09-03", posted: true
            )
        )
        #expect(error?.unchanged == "No transaction was entered, and your book is unchanged.")
        #expect(try store.liveCount("transactions") == 3, "the second tap wrote nothing")
    }

    @Test("a date the schedule does not fall on is refused, with the reason")
    func notAnOccurrence() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        let error = editError {
            try store.postScheduled(
                SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-04")
            )
        }
        #expect(error == .notAnOccurrence(scheduleName: "Rent", date: "2026-09-04"))
    }

    @Test("a paused schedule enters nothing, even when asked directly")
    func pausedRefuses() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        try store.setSchedulePaused(id: schedule.id, paused: true)
        let error = editError {
            try store.postScheduled(
                SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
            )
        }
        #expect(error == .scheduleIsPaused(name: "Rent"))
    }

    @Test("A REFUSED POST LEAVES NOTHING BEHIND -- not the transaction, not the decision")
    func refusalIsAtomic() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // A category that exists when the schedule is made and is deleted
        // afterwards: the post gets as far as `saveTransaction` and is refused
        // there, INSIDE the one transaction that also writes the decision.
        let schedule = try store.saveSchedule(draft())
        try store.softDelete(table: "categories", id: "c-food", at: EditFixture.later)

        let error = editError {
            try store.postScheduled(
                SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
            )
        }
        #expect(error == .unknownCategory("c-food"))
        #expect(try store.liveCount("transactions") == 2)
        #expect(try store.scheduleHistory(id: schedule.id).isEmpty)
        #expect(try store.localEdits().count == 0)
        // And it is still due, which is the only honest answer.
        #expect(try store.upcoming(today: "2026-09-02").due.count == 1)
    }

    // MARK: - Skipping

    @Test("skipping settles an occurrence without entering anything, and can be taken back")
    func skipAndUnskip() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())

        try store.skipOccurrence(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        #expect(try store.upcoming(today: "2026-09-02").due.isEmpty)
        #expect(try store.liveCount("transactions") == 2, "a skip is not a transaction")

        // Posting a skipped one is refused until the skip is taken back, so the
        // two decisions cannot silently overwrite each other.
        let error = editError {
            try store.postScheduled(
                SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
            )
        }
        #expect(
            error == .occurrenceAlreadySettled(
                scheduleName: "Rent", date: "2026-09-03", posted: false
            )
        )

        try store.unskipOccurrence(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        #expect(try store.upcoming(today: "2026-09-02").due.count == 1)
        try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        )
        #expect(try store.upcoming(today: "2026-09-02").due.isEmpty)
    }

    @Test("A SKIP IS A TOMBSTONE WHEN IT IS TAKEN BACK, not a row that vanishes")
    func unskipTombstones() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        try store.skipOccurrence(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        try store.unskipOccurrence(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        #expect(try store.connection.scalarInt("SELECT count(*) FROM schedule_events") == 1)
        #expect(try store.liveCount("schedule_events") == 0)
        // Un-skipping something that was not skipped says so rather than
        // reporting success.
        #expect(
            editError { try store.unskipOccurrence(scheduleId: schedule.id, occurrenceDate: "2026-10-03") }
                == .nothingToRestore(what: "skipped payment")
        )
    }

    @Test("skipping something already entered is refused -- delete the transaction instead")
    func cannotSkipWhatIsAlreadyInTheBook() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        )
        let error = editError {
            try store.skipOccurrence(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        }
        #expect(
            error == .occurrenceAlreadySettled(
                scheduleName: "Rent", date: "2026-09-03", posted: true
            )
        )
    }

    // MARK: - The claim, checked against the book

    @Test("DELETING THE POSTED TRANSACTION MAKES THE OCCURRENCE DUE AGAIN, and undo settles it")
    func deletingTheTransactionReopensTheOccurrence() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        let posted = try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        )
        #expect(try store.upcoming(today: "2026-09-02").due.isEmpty)

        // A POSTING IS A CLAIM ABOUT THE BOOK, and the book has just stopped
        // agreeing with it. The honest answer is that the payment is not there.
        let receipt = try store.deleteTransaction(id: posted.id)
        let plan = try store.upcoming(today: "2026-09-02")
        #expect(plan.due.map(\.date) == ["2026-09-03"])
        #expect(plan.due.first?.reopened == true)
        #expect(try store.scheduleHistory(id: schedule.id).first?.transactionIsPresent == false)

        // And undoing the delete puts the transaction back, so the occurrence
        // is settled again -- no state anywhere had to be repaired.
        try store.undoDelete(receipt)
        #expect(try store.upcoming(today: "2026-09-02").due.isEmpty)
        #expect(try store.scheduleHistory(id: schedule.id).first?.transactionIsPresent == true)
    }

    @Test("a reopened occurrence can be entered again, and points at the new transaction")
    func reopenedCanBePostedAgain() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        let first = try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        )
        try store.deleteTransaction(id: first.id)
        let second = try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        )
        #expect(second.id != first.id)
        let history = try store.scheduleHistory(id: schedule.id)
        #expect(history.count == 1, "one occurrence is one decision, and the latest one stands")
        #expect(history.first?.transactionId == second.id)
    }

    @Test("AN IMPORT THAT REPLACES THE BOOK MAKES POSTED OCCURRENCES DUE AGAIN")
    func importReopensPostedOccurrences() throws {
        // The transaction was typed on this device, so the browser's backup has
        // never heard of it -- and an import replaces the whole book with that
        // file. The payment is genuinely not in the book any more, and the
        // schedule says so instead of insisting it was dealt with.
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        )
        try store.importBackup(text: StoreFixture.backupText, replacingExistingBook: true)

        let plan = try store.upcoming(today: "2026-09-02")
        #expect(plan.due.map(\.date) == ["2026-09-03"])
        #expect(plan.due.first?.reopened == true)
    }

    // MARK: - Traceability

    @Test("A POSTED TRANSACTION KNOWS WHICH SCHEDULE MADE IT, and which occurrence it was")
    func traceability() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        let posted = try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03", date: "2026-09-05")
        )
        let origin = try #require(try store.scheduleOrigin(forTransactionId: posted.id))
        #expect(origin.scheduleId == schedule.id)
        #expect(origin.scheduleName == "Rent")
        // The OCCURRENCE's date, not the transaction's -- which is the fact the
        // register cannot work out for itself.
        #expect(origin.occurrenceDate == "2026-09-03")
        #expect(origin.postedAt == EditFixture.now)

        // A transaction nobody scheduled has no origin, and asking is cheap.
        #expect(try store.scheduleOrigin(forTransactionId: "t1") == nil)

        // A deleted schedule stops claiming its transactions -- the row is
        // still in the book, and the badge stops pointing at something the
        // owner has removed.
        try store.deleteSchedule(id: schedule.id)
        #expect(try store.scheduleOrigin(forTransactionId: posted.id) == nil)
    }

    @Test("moving a schedule's dates leaves its history readable, marked as off the grid")
    func historyKeepsOrphans() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(draft())
        try store.postScheduled(
            SchedulePosting(scheduleId: schedule.id, occurrenceDate: "2026-09-03")
        )
        // The rent day moves to the 10th. The payment already made is still a
        // payment; it simply is not on the new calendar.
        try store.saveSchedule(
            ScheduleDraft(
                id: schedule.id, name: "Rent", accountId: "w-a", amountMinor: -45000,
                payeeName: "Landlord", categoryId: "c-food", notes: "the flat", cadence: .monthly,
                startDate: "2026-09-10", end: .never
            )
        )
        let history = try store.scheduleHistory(id: schedule.id)
        #expect(history.count == 1)
        #expect(history.first?.isOnTheGrid == false)
        #expect(history.first?.transactionIsPresent == true)
        // And the new grid's own dates are what is due now.
        #expect(try store.upcoming(today: "2026-09-02").due.map(\.date) == ["2026-09-10"])
    }

    // MARK: - Auto-post

    @Test("A FRESH BOOK OPENED FOR THE FIRST TIME POSTS NOTHING AT ALL")
    func nothingPostsItself() throws {
        // The boring test, and the one that matters most: nobody should ever
        // open this app and find transactions they did not make.
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveSchedule(draft(start: "2026-06-03", expectsFrom: "2026-06-03"))
        let result = try store.postDue(today: "2026-09-02")
        #expect(result.isEmpty)
        #expect(try store.liveCount("transactions") == 2)
        #expect(try store.localEdits().count == 0)
        // The three that are due are due -- waiting to be confirmed, not
        // ignored.
        #expect(try store.upcoming(today: "2026-09-02").overdue.count == 3)
    }

    @Test("auto-post enters today's occurrence and cannot reach back over the ones it missed")
    func autoPostRespectsItsFloor() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let schedule = try store.saveSchedule(
            draft(cadence: .weekly, start: "2026-08-05", expectsFrom: "2026-08-05")
        )
        // Switched on today. Everything before today stays for confirmation.
        try store.setScheduleAutoPost(id: schedule.id, autoPost: true)
        let result = try store.postDue(today: "2026-09-02")
        #expect(result.posted.count == 1)
        #expect(result.heldBack == 0)
        #expect(result.refusals.isEmpty)

        let plan = try store.upcoming(today: "2026-09-02")
        #expect(plan.overdue.count == 4, "the four it missed are still waiting to be confirmed")
        #expect(
            !plan.due.contains { $0.date == "2026-09-02" }, "today's is entered and gone from due"
        )
        #expect(try store.localEdits().count == 1)

        // Running it again the same day is a no-op: the occurrence is settled.
        #expect(try store.postDue(today: "2026-09-02").isEmpty)
    }

    @Test("an auto-post run is capped, and says how many it held back")
    func autoPostIsCapped() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // Three weekly schedules all due today, with a limit of two.
        for index in 1...3 {
            let saved = try store.saveSchedule(
                draft(name: "Weekly \(index)", cadence: .weekly, start: "2026-09-02")
            )
            try store.setScheduleAutoPost(id: saved.id, autoPost: true)
        }
        let result = try store.postDue(today: "2026-09-02", limit: 2)
        #expect(result.posted.count == 2)
        #expect(result.heldBack == 1)
        // The third is still due, on screen, rather than silently missing.
        #expect(try store.upcoming(today: "2026-09-02", horizonDays: 0).due.count == 1)
    }

    @Test("one schedule that cannot post does not stop the others, and does not go quiet")
    func autoPostReportsRefusals() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let broken = try store.saveSchedule(draft(name: "Broken", start: "2026-09-02"))
        let fine = try store.saveSchedule(
            draft(name: "Fine", category: nil, start: "2026-09-02")
        )
        try store.setScheduleAutoPost(id: broken.id, autoPost: true)
        try store.setScheduleAutoPost(id: fine.id, autoPost: true)
        try store.softDelete(table: "categories", id: "c-food", at: EditFixture.later)

        let result = try store.postDue(today: "2026-09-02")
        #expect(result.posted.count == 1)
        #expect(result.refusals.count == 1)
        #expect(result.refusals.first?.contains("Broken") == true)
        #expect(result.refusals.first?.contains("category") == true)
    }
}
