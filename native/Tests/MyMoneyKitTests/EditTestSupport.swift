// Scaffolding the edit tests share.
//
// EVERY FIGURE, NAME AND ID BELOW IS INVENTED. The fixture is the same
// three-account, two-transaction book the writer and store suites use, so an
// edit is tested against exactly the book the round trip is already held to --
// including its awkward corners: an account that OMITS `excludeFromNetWorth`
// and one that states it `false`, a split with notes and one without, and a
// transaction (`t2`) whose `transferGroupId` names a group with only ONE leg in
// the book, which is what a half-imported transfer looks like.
//
// THE CLOCK AND THE IDS ARE PINNED. `StoreEnvironment.fixed` is what makes
// `createdAt`, `updatedAt` and every generated id assertable; without it every
// expectation about those fields would have to be "something changed", which is
// the assertion that passes when the wrong thing changed.
import Foundation
import Testing

@testable import MyMoneyKit

enum EditFixture {
    static let now = "2026-09-02T10:00:00.000Z"
    static let later = "2026-09-02T11:30:00.000Z"

    /// The fixture book in a store on disk, with a pinned clock and counted
    /// ids ("e-1", "e-2", ...).
    static func store(_ scratch: ScratchDirectory, now: String = EditFixture.now) throws
        -> LedgerStore
    {
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        store.environment = .fixed(now: now, idPrefix: "e")
        return store
    }

    /// A draft that saves: the GBP account, a real date, a small expense.
    static func expense(
        account: String = "w-a", amountMinor: Int64 = -350, payee: String = "Kiosk",
        category: String? = "c-food", date: String = "2026-09-01"
    ) -> TransactionDraft {
        TransactionDraft(
            accountId: account, date: date, amountMinor: amountMinor, payeeName: payee,
            categoryId: category
        )
    }
}

extension LedgerStore {
    /// A live account's balance, straight out of the same arithmetic the
    /// accounts screen uses.
    func balance(of accountId: String) throws -> Int64? {
        try accountBalances().first { $0.account.id == accountId }?.balanceMinor
    }

    /// The raw stored value of one column, for the assertions that are about
    /// what is ON DISK rather than about what a decoder hands back.
    func rawText(_ sql: String, _ id: String) throws -> String? {
        let statement = try connection.prepare(sql)
        defer { statement.finalize() }
        statement.bind(1, text: id)
        guard try statement.step() else { return nil }
        return try statement.optionalText(0)
    }
}

/// The error an expression threw, or nil. `#expect(throws:)` proves the TYPE;
/// these tests also have to read the SENTENCE, because the sentence is the
/// feature.
func editError(_ body: () throws -> some Any) -> EditError? {
    do {
        _ = try body()
        return nil
    } catch let error as EditError {
        return error
    } catch {
        return nil
    }
}
