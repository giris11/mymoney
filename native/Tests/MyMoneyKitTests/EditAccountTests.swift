// Accounts: created, renamed, recoloured, archived, reordered, regrouped, and
// taken out of the totals.
//
// THE ASSERTION THAT APPEARS IN NEARLY EVERY TEST HERE is that the account is
// still on the list with its real balance. "Not counted" and "archived" are
// about a TOTAL; they are not about visibility, and a finance app in which
// money can become unfindable is worse than one with a wrong headline, because
// a wrong headline gets noticed.
import Foundation
import Testing

@testable import MyMoneyKit

struct EditAccountTests {

    private func names(_ store: LedgerStore) throws -> [String] {
        try store.accountsSnapshot().balances.map(\.account.name)
    }

    // MARK: - Creating and editing

    @Test("creating an account puts it at the end of the list with its opening balance")
    func create() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let account = try store.saveAccount(
            AccountDraft(
                name: "  Holiday   Fund ", type: .savings, currency: "gbp",
                openingBalanceMinor: 25_000, colour: "#ABC"
            )
        )
        #expect(account.name == "Holiday Fund", "whitespace collapsed, capitals kept")
        #expect(account.currency == "GBP", "uppercased")
        #expect(account.sortOrder == 3)
        #expect(try store.balance(of: account.id) == 25_000)
        #expect(try names(store).last == "Holiday Fund")
        #expect(try store.auditMoneyColumns().isEmpty)
    }

    @Test("RENAMING AND RECOLOURING TOUCH NOTHING ELSE -- including the flags the form has no field for")
    func renameKeepsEverything() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // w-c is archived, excluded from net worth, and carries three loan
        // fields. None of that is on the account form.
        let before = try #require(try store.liveAccount(id: "w-c"))
        let renamed = try store.saveAccount(
            AccountDraft(
                id: "w-c", name: "Gamma Loan", type: before.type, currency: before.currency,
                openingBalanceMinor: before.openingBalanceMinor, colour: "#ff8800",
                groupId: before.groupId
            )
        )
        #expect(renamed.name == "Gamma Loan")
        #expect(renamed.colour == "#ff8800")
        // THE PART THAT MATTERS: a rename must never pull an excluded property
        // back into net worth, or forget a loan's term.
        #expect(renamed.excludeFromNetWorth == true)
        #expect(renamed.archived == true)
        #expect(renamed.loanPrincipalMinor == 400_000)
        #expect(renamed.loanRatePct == 4.25)
        #expect(renamed.loanTermMonths == 240)
        #expect(try store.balance(of: "w-c") == 500_000)
        #expect(try store.accountsSnapshot().netWorth.totalBaseMinor == 111_950)
    }

    @Test("an account that states excludeFromNetWorth as FALSE keeps saying so after an edit")
    func absentAndFalseSurviveAnEdit() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // w-a omits the key; w-b states it false. They are different bytes in a
        // backup file and the same answer to every money question, and an edit
        // must not collapse them -- that is what would change the book's
        // fingerprint for no reason the owner could see.
        try store.saveAccount(
            AccountDraft(
                id: "w-a", name: "Alpha renamed", type: .current, currency: "GBP",
                openingBalanceMinor: 100_000, colour: "#111111", groupId: "g1"
            )
        )
        try store.saveAccount(
            AccountDraft(
                id: "w-b", name: "Beta renamed", type: .savings, currency: "EUR",
                openingBalanceMinor: 20_000, colour: "#222222"
            )
        )
        #expect(try store.liveAccount(id: "w-a")?.excludeFromNetWorth == nil)
        #expect(try store.liveAccount(id: "w-b")?.excludeFromNetWorth == false)
        #expect(
            try store.rawText(
                "SELECT typeof(exclude_from_net_worth) FROM accounts WHERE id = ?", "w-a"
            ) == "null"
        )
    }

    // MARK: - Archive and exclude

    @Test("AN ARCHIVED ACCOUNT STAYS VISIBLE WITH ITS REAL BALANCE, and leaves the total")
    func archivingIsNotHiding() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let totalBefore = try store.accountsSnapshot().netWorth.totalBaseMinor

        try store.setAccountArchived(id: "w-a", archived: true)

        let snapshot = try store.accountsSnapshot()
        let row = try #require(snapshot.balances.first { $0.account.id == "w-a" })
        #expect(row.account.archived)
        #expect(row.balanceMinor == 97_500, "the money is still there and still shown")
        #expect(row.txCount == 1)
        #expect(snapshot.balances.count == 3, "still on the list")
        #expect(snapshot.netWorth.totalBaseMinor == totalBefore - 97_500)
        // Its transactions are untouched, and its register still opens.
        #expect(try store.registerCount(scope: .account("w-a")) == 1)
    }

    @Test("AN EXCLUDED ACCOUNT STAYS VISIBLE WITH ITS REAL BALANCE, and leaves the total")
    func excludingIsNotHiding() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.setAccountExcluded(id: "w-a", excluded: true)

        let snapshot = try store.accountsSnapshot()
        let row = try #require(snapshot.balances.first { $0.account.id == "w-a" })
        #expect(row.excludedFromNetWorth)
        #expect(row.balanceMinor == 97_500)
        #expect(snapshot.netWorth.excludedCount == 1)
        #expect(snapshot.netWorth.excludedBaseMinor == 97_500, "and it says what it left out")
        #expect(snapshot.netWorth.totalBaseMinor == 14_450)
    }

    @Test("switching exclusion OFF writes a literal false, the way the web app writes it")
    func excludingOffWritesFalse() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.setAccountExcluded(id: "w-c", excluded: false)
        // Not NULL: absent and false are different bytes in the file, and the
        // web app's `setAccountExcluded` writes `false` here.
        #expect(try store.liveAccount(id: "w-c")?.excludeFromNetWorth == false)
        #expect(
            try store.rawText(
                "SELECT typeof(exclude_from_net_worth) FROM accounts WHERE id = ?", "w-c"
            ) == "integer"
        )
    }

    @Test("setting a flag to what it already is changes nothing at all")
    func idempotentFlags() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.setAccountArchived(id: "w-c", archived: true)  // already archived
        #expect(try store.localEdits().count == 0, "a tap that did nothing is not a change")
    }

    @Test("a group can be excluded in one go, and the count is of accounts that actually moved")
    func groupExclusion() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.moveAccount(id: "w-b", toGroup: "g1")  // g1 now holds w-a and w-b

        #expect(try store.setGroupExcluded(groupId: "g1", excluded: true) == 2)
        #expect(try store.setGroupExcluded(groupId: "g1", excluded: true) == 0, "already there")
        #expect(try store.liveAccount(id: "w-a")?.excludeFromNetWorth == true)
        #expect(try store.liveAccount(id: "w-b")?.excludeFromNetWorth == true)
        // Both still visible, both with their real balances.
        #expect(try store.accountsSnapshot().balances.count == 3)
        #expect(try store.balance(of: "w-a") == 97_500)
        // Undoing is the same call inverted.
        #expect(try store.setGroupExcluded(groupId: "g1", excluded: false) == 2)
        #expect(try store.accountsSnapshot().netWorth.totalBaseMinor == 111_950)
    }

    // MARK: - Order and groups

    @Test("REORDERING SWAPS NEIGHBOURS and normalises duplicate orders so the arrows always work")
    func reordering() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // Put all three in one group, then give two of them the SAME sort
        // order -- which a real imported book can carry, and which would make a
        // naive swap a silent no-op.
        for id in ["w-b", "w-c"] { try store.moveAccount(id: id, toGroup: "g1") }
        try store.connection.execute("UPDATE accounts SET sort_order = 0")
        #expect(try store.liveAccountsOrdered(inGroup: "g1").map(\.name) == ["Alpha", "Beta", "Gamma"])

        try store.reorderAccount(id: "w-c", .up)
        #expect(try store.liveAccountsOrdered(inGroup: "g1").map(\.name) == ["Alpha", "Gamma", "Beta"])
        #expect(try store.liveAccountsOrdered(inGroup: "g1").map(\.sortOrder) == [0, 1, 2])

        try store.reorderAccount(id: "w-c", .up)
        #expect(try store.liveAccountsOrdered(inGroup: "g1").map(\.name) == ["Gamma", "Alpha", "Beta"])
        // At the top, "up" is a no-op rather than an error.
        try store.reorderAccount(id: "w-c", .up)
        #expect(try store.liveAccountsOrdered(inGroup: "g1").map(\.name) == ["Gamma", "Alpha", "Beta"])
    }

    @Test("ungrouped accounts can be reordered too -- NULL is a group like any other")
    func reorderingUngrouped() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // w-b and w-c have no group. `group_id = ?` bound to NULL matches
        // nothing in SQL, so without the IS NULL branch this list is empty and
        // the arrows do nothing at all.
        #expect(try store.liveAccountsOrdered(inGroup: nil).map(\.name) == ["Beta", "Gamma"])
        try store.reorderAccount(id: "w-c", .up)
        #expect(try store.liveAccountsOrdered(inGroup: nil).map(\.name) == ["Gamma", "Beta"])
    }

    @Test("moving an account between groups changes ONE field and no money")
    func moveBetweenGroups() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try store.accountsSnapshot()

        try store.moveAccount(id: "w-b", toGroup: "g1")
        #expect(try store.liveAccount(id: "w-b")?.groupId == "g1")
        try store.moveAccount(id: "w-b", toGroup: nil)
        #expect(try store.liveAccount(id: "w-b")?.groupId == nil)

        let after = try store.accountsSnapshot()
        #expect(after.netWorth == before.netWorth)
        #expect(
            after.balances.map(\.balanceMinor).sorted()
                == before.balances.map(\.balanceMinor).sorted()
        )
        #expect(
            editError { try store.moveAccount(id: "w-b", toGroup: "nope") } == .unknownGroup("nope")
        )
    }

    @Test("groups are created, renamed, reordered and refused a duplicate name")
    func groups() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let savings = try store.saveAccountGroup(AccountGroupDraft(name: "Savings"))
        #expect(savings.sortOrder == 1)

        #expect(
            editError { try store.saveAccountGroup(AccountGroupDraft(name: "  savings ")) }
                == .nameTaken(what: "group", name: "Savings")
        )
        #expect(editError { try store.saveAccountGroup(AccountGroupDraft(name: " ")) }
            == .blankName(what: "group"))

        try store.saveAccountGroup(AccountGroupDraft(id: savings.id, name: "Rainy Day"))
        #expect(try store.accountGroup(id: savings.id)?.name == "Rainy Day")

        try store.reorderAccountGroup(id: savings.id, .up)
        #expect(
            try store.readAccountGroups(from: "live_account_groups")
                .sorted { $0.sortOrder < $1.sortOrder }.map(\.name) == ["Rainy Day", "Everyday"]
        )
    }

    // MARK: - Refusals

    @Test("DELETING AN ACCOUNT WITH TRANSACTIONS IS REFUSED, and the refusal offers archiving")
    func deleteRefusedWithHistory() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let error = try #require(editError { try store.deleteAccount(id: "w-a") })
        #expect(error == .accountHasTransactions(accountName: "Alpha", count: 1))
        #expect(error.problem.contains("1 transaction"))
        #expect(error.problem.contains("Archive it instead"))
        #expect(error.unchanged == "Nothing was deleted.")
        #expect(try store.liveCount("accounts") == 3)
        #expect(try store.liveCount("transactions") == 2)
    }

    @Test("an empty account can be deleted, is not destroyed, and comes back")
    func deleteAndUndo() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try store.deleteAccount(id: "w-c")
        #expect(receipt.name == "Gamma")
        #expect(try store.liveCount("accounts") == 2)
        // Not destroyed: the row and every field of it are still there.
        #expect(try store.connection.scalarInt("SELECT count(*) FROM accounts") == 3)
        #expect(
            try store.connection.scalarInt(
                "SELECT opening_balance_minor FROM accounts WHERE id='w-c'") == 500_000
        )

        try store.undoDelete(receipt)
        #expect(try store.liveCount("accounts") == 3)
        #expect(try store.liveAccount(id: "w-c")?.loanTermMonths == 240)
        #expect(editError { try store.undoDelete(receipt) } == .nothingToRestore(what: "account"))
    }

    @Test("deleting a group that still holds accounts is refused; the accounts are never moved")
    func deleteGroupRefused() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let error = try #require(editError { try store.deleteAccountGroup(id: "g1") })
        #expect(error == .groupHasAccounts(groupName: "Everyday", count: 1))
        #expect(error.unchanged == "Nothing was deleted.")
        #expect(try store.liveAccount(id: "w-a")?.groupId == "g1")

        try store.moveAccount(id: "w-a", toGroup: nil)
        let receipt = try store.deleteAccountGroup(id: "g1")
        #expect(try store.liveCount("account_groups") == 0)
        try store.undoDelete(receipt)
        #expect(try store.accountGroup(id: "g1")?.name == "Everyday")
    }

    @Test("THE CURRENCY IS LOCKED once there is history, and the refusal explains why")
    func currencyIsLocked() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let error = try #require(
            editError {
                try store.saveAccount(
                    AccountDraft(
                        id: "w-a", name: "Alpha", type: .current, currency: "EUR",
                        openingBalanceMinor: 100_000, colour: "#111111", groupId: "g1"
                    )
                )
            }
        )
        #expect(error == .currencyIsLocked(
            accountName: "Alpha", from: "GBP", to: "EUR", transactionCount: 1))
        #expect(error.problem.contains("silently re-label"))
        #expect(error.unchanged.contains("all its transactions"))
        #expect(try store.liveAccount(id: "w-a")?.currency == "GBP")
        #expect(try store.transaction(id: "t1")?.currency == "GBP")

        // An account with NO transactions may still change currency, and its
        // (empty) history follows it.
        let fresh = try store.saveAccount(
            AccountDraft(name: "Fresh", type: .cash, currency: "GBP")
        )
        let moved = try store.saveAccount(
            AccountDraft(id: fresh.id, name: "Fresh", type: .cash, currency: "JPY")
        )
        #expect(moved.currency == "JPY")
    }

    @Test("blank names, bad currencies and bad colours are refused by name")
    func shapeRefusals() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        func attempt(_ name: String, _ currency: String, _ colour: String) -> EditError? {
            editError {
                try store.saveAccount(
                    AccountDraft(name: name, type: .cash, currency: currency, colour: colour)
                )
            }
        }
        #expect(attempt("   ", "GBP", "#123456") == .blankName(what: "account"))
        #expect(attempt("A", "GB", "#123456") == .badCurrency("GB"))
        #expect(attempt("A", "GBPX", "#123456") == .badCurrency("GBPX"))
        // Not three ASCII letters: a Cyrillic lookalike would create an account
        // the web app could never have.
        #expect(attempt("A", "\u{0410}BC", "#123456") == .badCurrency("\u{0410}BC"))
        #expect(attempt("A", "GBP", "blue") == .badColour("blue"))
        #expect(attempt("A", "GBP", "#12345") == .badColour("#12345"))
        #expect(attempt("A", "GBP", "#12345g") == .badColour("#12345g"))
        #expect(attempt("A", "GBP", "#ABC") == nil, "three-digit hex is fine")
        #expect(try store.liveCount("accounts") == 4)
    }
}

/// THE GROUPS THE SIDEBAR DRAWS AND THE GROUPS A PICKER OFFERS ARE ONE LIST.
///
/// Two reads a moment apart, in a different order, is how an editor ends up
/// unable to select the group an account is already in -- which silently moves
/// the account out of it on save. So the snapshot carries the groups in the
/// order they are drawn, and that order is the one reordering changes.
struct AccountGroupOrderTests {
    @Test("the snapshot's groups are in SORT ORDER, and reordering changes it")
    func groupsAreOrderedAndReorderable() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // Ids deliberately in the OPPOSITE order to sortOrder, because reading
        // "ORDER BY id" would pass a weaker version of this test.
        try store.connection.execute(
            "INSERT INTO account_groups (id, name, sort_order, deleted_at) VALUES "
                + "('zzz', 'Later', 1, NULL), ('aaa', 'Earlier', 5, NULL)"
        )
        let drawn = try store.accountsSnapshot().groups
        let offered = try store.accountGroups()
        #expect(drawn.map(\.name) == ["Everyday", "Later", "Earlier"])
        #expect(drawn.map(\.id) == offered.map(\.id), "the sidebar and the picker are one list")

        try store.reorderAccountGroup(id: "aaa", .up)
        #expect(try store.accountsSnapshot().groups.map(\.name) == ["Everyday", "Earlier", "Later"])
    }
}
