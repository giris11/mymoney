// Budgets as a thing the owner can change, against a real database on disk.
//
// EVERY EXPECTATION IS HAND-CALCULATED against the invented fixture book (see
// StoreTestSupport.swift) -- the oracle's 45 budget cases are about window
// grids and spend arithmetic, and say nothing about saving, archiving or
// deleting one, because saving is not arithmetic.
//
// THE TWO CLAIMS THIS FILE EXISTS TO MAKE:
//
//   1. NOTHING IS EVER HARD-DELETED. The web app hard-deletes a budget; this
//      app tombstones it, and the row is still on disk afterwards. That is
//      asserted below by reading the raw table rather than the live view,
//      because "it disappeared from the list" is exactly what a hard delete
//      looks like too.
//   2. EVERY CHANGE IS COUNTED. The divergence banner is the machinery that
//      stops two ledgers quietly disagreeing, and a mutation that forgot to
//      call `recordLocalEdit` would be a change the owner is never told about.
import Foundation
import Testing

@testable import MyMoneyKit

/// The fixture book's own budget: "Food", over `c-food`, monthly, anchored on
/// 31 January -- which is the clamped-anchor case, and is why it was put in the
/// fixture in the first place.
private let fixtureBudgetId = "b1"

private func draft(
    id: String? = nil, name: String = "Coffee", categories: [String] = ["c-food"],
    amountMinor: Int64 = 12_500, period: BudgetPeriod = .monthly,
    startDate: String = "2026-09-01", archived: Bool? = nil
) -> BudgetDraft {
    BudgetDraft(
        id: id, name: name, categoryIds: categories, amountMinor: amountMinor,
        period: period, startDate: startDate, archived: archived
    )
}

struct EditBudgetSaveTests {

    @Test("a new budget is created with a generated id, and counted as a change")
    func createsABudget() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(try store.localEdits().count == 0)

        let saved = try store.saveBudget(draft())
        #expect(saved.id == "e-1")
        #expect(saved.name == "Coffee")
        #expect(saved.categoryIds == ["c-food"])
        #expect(saved.amountMinor == 12_500)
        #expect(saved.period == .monthly)
        #expect(saved.startDate == "2026-09-01")
        #expect(!saved.archived)
        // Phase 2, and NOT invented as true by a save that does not offer it.
        #expect(!saved.rollover)

        #expect(try store.budgets().count == 2)
        #expect(try store.budget(id: "e-1") == saved)

        let edits = try store.localEdits()
        #expect(edits.count == 1)
        #expect(edits.firstAt == EditFixture.now)
    }

    @Test("editing a budget rewrites its categories rather than appending to them")
    func updatesCategories() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        let created = try store.saveBudget(draft(categories: ["c-food", "c-sub"]))
        #expect(created.categoryIds == ["c-food", "c-sub"])

        let updated = try store.saveBudget(
            draft(id: created.id, name: "Coffee & cake", categories: ["c-sub"], amountMinor: 9_900)
        )
        #expect(updated.id == created.id)
        #expect(updated.name == "Coffee & cake")
        #expect(updated.amountMinor == 9_900)
        // The old link row is GONE, not left behind to widen the budget
        // silently. A budget that kept covering a category the owner removed
        // would over-report spending for ever.
        #expect(updated.categoryIds == ["c-sub"])
        #expect(try store.budget(id: created.id)?.categoryIds == ["c-sub"])
        #expect(try store.budgets().count == 2)
    }

    @Test("the owner's order of categories is kept, and duplicates collapse")
    func categoryOrderAndDuplicates() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveBudget(
            draft(categories: ["c-sub", "c-food", "c-sub", "", "c-food"])
        )
        #expect(saved.categoryIds == ["c-sub", "c-food"])
        #expect(try store.budget(id: saved.id)?.categoryIds == ["c-sub", "c-food"])
    }

    @Test("a name is trimmed and collapsed exactly as every other name is")
    func nameIsCleaned() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveBudget(draft(name: "  Eating   out \n"))
        #expect(saved.name == "Eating out")
    }

    @Test("rollover survives an edit that does not offer it")
    func rolloverIsPreserved() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // The fixture's budget has rollover false; write one that is true
        // through the book writer, then edit it through the editor.
        let rolling = Budget(
            id: "b-roll", name: "Rolling", categoryIds: ["c-food"], amountMinor: 1_000,
            period: .weekly, startDate: "2026-01-05", rollover: true
        )
        try store.connection.transaction {
            let statement = try store.connection.prepare(
                "INSERT INTO budgets (id, name, amount_minor, period, start_date, rollover, "
                    + "archived, deleted_at) VALUES (?, ?, ?, ?, ?, 1, 0, NULL)"
            )
            defer { statement.finalize() }
            statement.bind(1, text: rolling.id)
            statement.bind(2, text: rolling.name)
            statement.bind(3, minorUnits: rolling.amountMinor)
            statement.bind(4, text: rolling.period.rawValue)
            statement.bind(5, text: rolling.startDate)
            try statement.run()
            let link = try store.connection.prepare(
                "INSERT INTO budget_categories (budget_id, position, category_id) VALUES (?, 0, ?)"
            )
            defer { link.finalize() }
            link.bind(1, text: rolling.id)
            link.bind(2, text: "c-food")
            try link.run()
        }

        let edited = try store.saveBudget(draft(id: "b-roll", name: "Still rolling"))
        #expect(edited.rollover)
    }

    @Test("archived state survives an edit that does not mention it")
    func archivedIsPreserved() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveBudget(draft())
        try store.setBudgetArchived(id: saved.id, archived: true)
        let edited = try store.saveBudget(draft(id: saved.id, name: "Renamed"))
        #expect(edited.archived)
        #expect(edited.name == "Renamed")
    }
}

struct EditBudgetRefusalTests {

    @Test("a blank name is refused, and nothing is written")
    func blankName() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let error = editError { try store.saveBudget(draft(name: "   ")) }
        #expect(error == .blankName(what: "budget"))
        #expect(try store.budgets().count == 1)
        #expect(try store.localEdits().count == 0)
    }

    @Test("a budget of nothing is refused, and says why in the owner's words")
    func zeroAmount() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let zero = try #require(editError { try store.saveBudget(draft(amountMinor: 0)) })
        #expect(zero == .budgetAmountNotPositive(0))
        #expect(zero.problem.contains("keep under"))
        #expect(zero.unchanged.contains("Nothing was saved"))

        let negative = editError { try store.saveBudget(draft(amountMinor: -100)) }
        #expect(negative == .budgetAmountNotPositive(-100))
        #expect(try store.budgets().count == 1)
        #expect(try store.localEdits().count == 0)
    }

    @Test("a budget over no categories is refused")
    func noCategories() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(editError { try store.saveBudget(draft(categories: [])) } == .budgetNeedsACategory)
        #expect(editError { try store.saveBudget(draft(categories: ["", ""])) } == .budgetNeedsACategory)
        #expect(try store.localEdits().count == 0)
    }

    /// A check the web app does not make. In a copy restored from a file, a
    /// category id naming nothing is far more likely a mistake than a choice.
    @Test("a category that is not in this copy is refused at creation")
    func unknownCategory() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let error = editError { try store.saveBudget(draft(categories: ["c-food", "nope"])) }
        #expect(error == .unknownCategory("nope"))
        #expect(try store.budgets().count == 1)
    }

    @Test("a date that is not a date is refused, never rolled into the next month")
    func badStartDate() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // 30 February does not exist. Rolling it to 2 March would move every
        // window of the grid by two days, for ever, invisibly.
        #expect(editError { try store.saveBudget(draft(startDate: "2026-02-30")) } == .badDate("2026-02-30"))
        #expect(editError { try store.saveBudget(draft(startDate: "1 Sep 2026")) } == .badDate("1 Sep 2026"))
        #expect(try store.localEdits().count == 0)
    }

    @Test("editing a budget that is not here is refused rather than creating one")
    func unknownBudget() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let error = try #require(editError { try store.saveBudget(draft(id: "ghost")) })
        #expect(error == .unknownBudget("ghost"))
        // An id that was not found must not silently become a new budget --
        // that is how an edit turns into a duplicate.
        #expect(try store.budgets().count == 1)
        #expect(try store.localEdits().count == 0)
    }

    @Test("a deleted budget cannot be edited back into existence")
    func editingATombstonedBudget() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        _ = try store.deleteBudget(id: fixtureBudgetId)
        #expect(
            editError { try store.saveBudget(draft(id: fixtureBudgetId)) }
                == .unknownBudget(fixtureBudgetId)
        )
    }
}

struct EditBudgetArchiveTests {

    @Test("archiving takes a budget out of the live list without deleting it")
    func archiveAndUnarchive() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.setBudgetArchived(id: fixtureBudgetId, archived: true)

        let book = try store.book()
        #expect(try book.allBudgetProgress(refDate: "2026-09-15").isEmpty)
        #expect(Budgets.archived(book.budgets).map(\.id) == [fixtureBudgetId])
        // Still one budget in the book: archiving hid it from a list, not from
        // the file.
        #expect(try store.budgets().count == 1)

        try store.setBudgetArchived(id: fixtureBudgetId, archived: false)
        #expect(try store.book().allBudgetProgress(refDate: "2026-09-15").count == 1)
        #expect(try store.localEdits().count == 2)
    }

    @Test("archiving something already archived is not a change")
    func archivingTwiceCountsOnce() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.setBudgetArchived(id: fixtureBudgetId, archived: true)
        try store.setBudgetArchived(id: fixtureBudgetId, archived: true)
        // The divergence counter must not tick for a tap that did nothing --
        // "3 changes your web app does not have" has to mean three changes.
        #expect(try store.localEdits().count == 1)
    }

    @Test("archiving a budget that is not here is refused")
    func archiveUnknown() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(
            editError { try store.setBudgetArchived(id: "ghost", archived: true) }
                == .unknownBudget("ghost")
        )
    }
}

struct EditBudgetDeleteTests {

    /// THE CLAIM: a delete is a tombstone save. Asserted by reading the RAW
    /// table, because "it left the list" is what a hard delete looks like too.
    @Test("deleting writes a tombstone -- the row is still on disk")
    func deleteIsATombstone() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        let receipt = try store.deleteBudget(id: fixtureBudgetId)
        #expect(receipt.table == "budgets")
        #expect(receipt.id == fixtureBudgetId)
        #expect(receipt.name == "Food")
        #expect(receipt.deletedAt == EditFixture.now)

        #expect(try store.budgets().isEmpty)
        #expect(try store.budget(id: fixtureBudgetId) == nil)
        // …and yet:
        let stored = try store.rawText(
            "SELECT deleted_at FROM budgets WHERE id = ?", fixtureBudgetId
        )
        #expect(stored == EditFixture.now)
        // Reading with tombstones included finds it, whole.
        #expect(try store.book(includingDeleted: true).budgets.map(\.id) == [fixtureBudgetId])
    }

    @Test("an undo brings the budget back exactly, because nothing was destroyed")
    func undoRestoresIt() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try #require(try store.budget(id: fixtureBudgetId))

        let receipt = try store.deleteBudget(id: fixtureBudgetId)
        try store.undoDelete(receipt)

        #expect(try store.budget(id: fixtureBudgetId) == before)
        // Delete and undo are both changes this copy has that the file does
        // not -- the count is of what the owner DID, not of the net effect.
        #expect(try store.localEdits().count == 2)
    }

    @Test("the undo sentence calls a budget a budget")
    func undoOfAMissingBudget() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = DeletedRecord(
            table: "budgets", id: fixtureBudgetId, deletedAt: "2020-01-01T00:00:00.000Z",
            name: "Food"
        )
        let error = try #require(editError { try store.undoDelete(receipt) })
        #expect(error == .nothingToRestore(what: "budget"))
    }

    @Test("deleting a budget touches no transaction")
    func deleteTouchesNoMoney() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try store.book().transactions
        let balanceBefore = try store.balance(of: "w-a")

        _ = try store.deleteBudget(id: fixtureBudgetId)

        #expect(try store.book().transactions == before)
        #expect(try store.balance(of: "w-a") == balanceBefore)
    }

    @Test("deleting a budget that is not here is refused")
    func deleteUnknown() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(editError { try store.deleteBudget(id: "ghost") } == .unknownBudget("ghost"))
        #expect(try store.localEdits().count == 0)
    }
}

struct BudgetListOrderTests {

    private func store(_ scratch: ScratchDirectory) throws -> LedgerStore {
        let store = try EditFixture.store(scratch)
        for (index, name) in ["zebra", "Apple", "mango"].enumerated() {
            _ = try store.saveBudget(
                draft(name: name, amountMinor: Int64(index + 1) * 1_000, startDate: "2026-09-01")
            )
        }
        return store
    }

    /// Ordered by name BEFORE any spend is calculated, so a transaction landing
    /// mid-month cannot reorder the list under the owner's thumb. The
    /// comparison is locale-aware, so "Apple" and "apple" sort together rather
    /// than every capital letter coming first.
    @Test("the budgets list is in name order, case-insensitively")
    func nameOrder() throws {
        let scratch = try ScratchDirectory()
        let store = try store(scratch)
        let lines = try store.book().allBudgetProgress(refDate: "2026-09-15")
        #expect(lines.map(\.budget.name) == ["Apple", "Food", "mango", "zebra"])
    }

    @Test("the archived list is in the same order and holds only archived budgets")
    func archivedOrder() throws {
        let scratch = try ScratchDirectory()
        let store = try store(scratch)
        let all = try store.budgets()
        let names = all.filter { ["zebra", "Food"].contains($0.name) }.map(\.id)
        for id in names { try store.setBudgetArchived(id: id, archived: true) }

        let book = try store.book()
        #expect(try book.allBudgetProgress(refDate: "2026-09-15").map(\.budget.name) == ["Apple", "mango"])
        #expect(Budgets.archived(book.budgets).map(\.name) == ["Food", "zebra"])
    }
}

struct BudgetStoreReadTests {

    /// The cache token exists so a caller can hold onto a `Book` safely. The
    /// claim it has to support is exactly this: a write moves it, a read does
    /// not.
    @Test("the write token moves on a write and stands still on a read")
    func writeToken() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        let start = store.writeToken()
        _ = try store.book()
        _ = try store.budgets()
        _ = try store.accountsSnapshot()
        #expect(store.writeToken() == start, "reading must not look like a write")

        _ = try store.saveBudget(draft())
        let afterSave = store.writeToken()
        #expect(afterSave > start)

        _ = try store.deleteBudget(id: fixtureBudgetId)
        #expect(store.writeToken() > afterSave)
    }

    @Test("a refused write leaves the token where it was")
    func refusedWriteDoesNotMoveTheToken() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let start = store.writeToken()
        _ = editError { try store.saveBudget(draft(name: "")) }
        // The transaction rolled back, so nothing was written -- and a cache
        // keyed on this token must not throw away a perfectly good book
        // because somebody mistyped a name.
        #expect(store.writeToken() == start)
    }

    @Test("the earliest transaction date is the book's, and nil when there is none")
    func earliestDate() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // The fixture's two transactions are dated 2026-08-03 and 2026-08-22.
        #expect(try store.earliestTransactionDate() == "2026-08-03")

        let empty = try scratch.store("empty.sqlite")
        #expect(try empty.earliestTransactionDate() == nil)
    }

    /// A deleted transaction is not the earliest anything: the read goes
    /// through the live view, like every other read in this package.
    @Test("a deleted transaction does not set the earliest date")
    func earliestDateIgnoresTombstones() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        _ = try store.deleteTransaction(id: "t1")  // the 2026-08-03 one
        #expect(try store.earliestTransactionDate() == "2026-08-22")
    }
}
