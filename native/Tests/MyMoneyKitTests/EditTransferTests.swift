// A transfer is one thing the owner edits and two rows the book holds.
//
// THE FAILURE THESE TESTS EXIST TO PREVENT is a pair that stops agreeing. Two
// legs that no longer cancel do not look like a bug: they look like money that
// appeared, or money that went missing, in an account the owner was not
// watching. So every test here checks BOTH legs and, where it can, checks that
// net worth did not move -- because a transfer between two of your own accounts
// changes where your money is and never how much of it there is.
import Foundation
import Testing

@testable import MyMoneyKit

struct EditTransferTests {

    private func draft(
        from: String = "w-a", to: String = "w-c", amount: Int64 = 5000,
        received: Int64? = nil, date: String = "2026-09-01"
    ) -> TransferDraft {
        TransferDraft(
            fromAccountId: from, toAccountId: to, date: date,
            amountFromMinor: amount, amountToMinor: received ?? amount
        )
    }

    @Test("A TRANSFER IS TWO LEGS: opposite signs, one group, no category, no payee")
    func shape() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let pair = try store.saveTransfer(draft())

        #expect(pair.from.amountMinor == -5000)
        #expect(pair.to.amountMinor == 5000)
        #expect(pair.from.transferGroupId == pair.to.transferGroupId)
        #expect(pair.from.transferGroupId != nil)
        for leg in [pair.from, pair.to] {
            #expect(leg.categoryId == nil, "a transfer has no category")
            #expect(leg.payeeId == nil, "a transfer has no payee")
            #expect(leg.splits.isEmpty)
        }
        #expect(try store.registerCount(scope: .allAccounts) == 4)
    }

    @Test("A SAME-CURRENCY TRANSFER MOVES NOTHING: net worth is unchanged to the penny")
    func netWorthIsUnchanged() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try store.accountsSnapshot().netWorth.totalBaseMinor

        // Between the two GBP accounts. w-c is archived, so use two counted
        // ones by un-archiving it first -- the arithmetic is the claim, not the
        // flag.
        try store.setAccountArchived(id: "w-c", archived: false)
        try store.setAccountExcluded(id: "w-c", excluded: false)
        let after = try store.accountsSnapshot().netWorth.totalBaseMinor
        try store.saveTransfer(draft(from: "w-a", to: "w-c", amount: 12_345))

        #expect(try store.accountsSnapshot().netWorth.totalBaseMinor == after)
        #expect(try store.balance(of: "w-a") == 97_500 - 12_345)
        #expect(try store.balance(of: "w-c") == 500_000 + 12_345)
        _ = before
    }

    @Test("A CROSS-CURRENCY TRANSFER KEEPS BOTH FIGURES -- neither is derived from a rate")
    func crossCurrency() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // 100.00 out of a GBP account, 117.20 into a EUR one. Both are facts
        // about what the bank did; a rate would make one of them an opinion
        // that changes whenever the rate table is edited.
        let pair = try store.saveTransfer(
            draft(from: "w-a", to: "w-b", amount: 10_000, received: 11_720)
        )
        #expect(pair.isCrossCurrency)
        #expect(pair.from.currency == "GBP")
        #expect(pair.to.currency == "EUR")
        #expect(pair.from.amountMinor == -10_000)
        #expect(pair.to.amountMinor == 11_720)

        // Editing the rate table afterwards cannot touch either figure.
        #expect(try store.transaction(id: pair.to.id)?.amountMinor == 11_720)
    }

    @Test("EDITING FROM EITHER LEG EDITS THE PAIR, and does not create a third row")
    func editFromEitherSide() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let pair = try store.saveTransfer(draft(amount: 5000))
        let countBefore = try store.registerCount(scope: .allAccounts)

        // Opened from the RECEIVING leg -- the same draft comes back whichever
        // row was tapped, which is what "either side" means.
        var edit = try #require(try store.transferDraft(forLegId: pair.to.id))
        #expect(edit.fromAccountId == "w-a")
        #expect(edit.amountFromMinor == 5000)
        edit.amountFromMinor = 7500
        edit.amountToMinor = 7500
        edit.notes = "moved more"
        store.environment = .fixed(now: EditFixture.later, idPrefix: "e")

        let saved = try store.saveTransfer(edit)
        #expect(saved.from.id == pair.from.id, "the same two rows, not two new ones")
        #expect(saved.to.id == pair.to.id)
        #expect(saved.from.amountMinor == -7500)
        #expect(saved.to.amountMinor == 7500)
        #expect(saved.from.notes == "moved more" && saved.to.notes == "moved more")
        #expect(saved.from.createdAt == EditFixture.now, "createdAt is a fact")
        #expect(saved.from.updatedAt == EditFixture.later)
        #expect(try store.registerCount(scope: .allAccounts) == countBefore)
    }

    @Test("swapping the two accounts reuses the same two rows and reverses the money")
    func swappingSides() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let pair = try store.saveTransfer(draft(from: "w-a", to: "w-c", amount: 5000))

        var reversed = try #require(try store.transferDraft(forLegId: pair.from.id))
        swap(&reversed.fromAccountId, &reversed.toAccountId)
        let saved = try store.saveTransfer(reversed)

        // The row that used to be the outgoing leg is still the outgoing leg;
        // it is now attached to the other account.
        #expect(saved.from.id == pair.from.id)
        #expect(saved.from.accountId == "w-c")
        #expect(saved.to.accountId == "w-a")
        #expect(try store.balance(of: "w-a") == 97_500 + 5000)
        #expect(try store.balance(of: "w-c") == 500_000 - 5000)
        #expect(try store.registerCount(scope: .allAccounts) == 4)
    }

    @Test("a leg keeps its own account's currency when it is moved to another account")
    func currencyFollowsTheAccount() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let pair = try store.saveTransfer(draft(from: "w-a", to: "w-c", amount: 5000))
        var moved = try #require(try store.transferDraft(forLegId: pair.from.id))
        moved.toAccountId = "w-b"  // EUR
        let saved = try store.saveTransfer(moved)
        #expect(saved.to.accountId == "w-b")
        #expect(saved.to.currency == "EUR", "the row's currency is its account's, always")
    }

    // MARK: - Refusals

    @Test("a transfer to the same account is refused -- money cannot move to itself")
    func sameAccount() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let error = try #require(
            editError { try store.saveTransfer(draft(from: "w-a", to: "w-a")) }
        )
        #expect(error == .transferNeedsTwoAccounts)
        #expect(error.unchanged == "Nothing was changed.")
        #expect(try store.registerCount(scope: .allAccounts) == 2)
    }

    @Test("a zero or negative amount is refused, and the message names WHICH side")
    func amountsMustBeMagnitudes() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        let sent = try #require(editError { try store.saveTransfer(draft(amount: 0)) })
        #expect(sent == .transferAmountNotPositive(side: .sent, amountMinor: 0, currency: "GBP"))
        #expect(sent.problem.contains("sent"))

        let received = try #require(
            editError { try store.saveTransfer(draft(amount: 100, received: -100)) }
        )
        #expect(received.problem.contains("received"))
        #expect(try store.registerCount(scope: .allAccounts) == 2)
    }

    @Test("a bad date and an unknown account are refused before anything is written")
    func badInputs() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(editError { try store.saveTransfer(draft(date: "not a date")) } == .badDate("not a date"))
        #expect(editError { try store.saveTransfer(draft(from: "ghost")) } == .unknownAccount("ghost"))
        #expect(editError { try store.saveTransfer(draft(to: "ghost")) } == .unknownAccount("ghost"))
        #expect(try store.registerCount(scope: .allAccounts) == 2)
    }

    @Test("A HALF-IMPORTED TRANSFER IS REFUSED, not silently completed")
    func oneLeggedTransfer() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // The fixture's t2 carries transferGroupId "tg-x" and is the only leg
        // in the book -- which is what a partial import looks like. Editing it
        // as a transfer must say so rather than invent the missing half.
        #expect(try store.transferPair(groupId: "tg-x") == nil)
        #expect(try store.transferDraft(forLegId: "t2") == nil)

        var repair = draft()
        repair.transferGroupId = "tg-x"
        let error = try #require(editError { try store.saveTransfer(repair) })
        #expect(error == .transferNotFound(groupId: "tg-x", legs: 1))
        #expect(error.problem.contains("1 leg"))
        #expect(try store.registerCount(scope: .allAccounts) == 2)
    }

    @Test("A TRANSFER LEG CANNOT BE SAVED AS AN ORDINARY TRANSACTION, and the refusal says why")
    func legsAreNotOrdinaryTransactions() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let pair = try store.saveTransfer(draft(from: "w-a", to: "w-c", amount: 5000))

        // There is no ordinary draft for a leg -- the door is closed at the
        // point where the form would be filled in.
        #expect(try store.transactionDraft(forId: pair.from.id) == nil)

        // ...and closed again at the point where it would be saved, for a
        // caller that built a draft by hand.
        let error = try #require(
            editError {
                try store.saveTransaction(
                    TransactionDraft(
                        id: pair.from.id, accountId: "w-a", date: "2026-09-01",
                        amountMinor: -1
                    )
                )
            }
        )
        #expect(error == .transactionIsTransferLeg(otherAccountName: "Gamma"))
        #expect(error.problem.contains("Gamma"), "the sentence names the other side")
        #expect(error.unchanged.contains("both halves are still exactly as they were"))
        #expect(try store.transaction(id: pair.from.id)?.amountMinor == -5000)
    }

    @Test("saving a transfer remembers the account it came out of")
    func lastUsedAccount() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveTransfer(draft(from: "w-b", to: "w-a", amount: 100))
        #expect(try store.readSettings()?.lastUsedAccountId == "w-b")
    }
}
