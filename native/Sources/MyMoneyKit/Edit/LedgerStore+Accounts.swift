// Accounts and the groups they sit in: create, rename, recolour, archive,
// reorder, regroup, and take out of the totals.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THAT OUTRANKS EVERYTHING ELSE IN THIS FILE
//
// "NOT COUNTED" IS NOT "HIDDEN", AND NEITHER IS "ARCHIVED". An account the
// owner archives, or flags out of net worth, keeps every transaction it has,
// keeps its real balance in its own currency, and stays on the accounts screen.
// The flags change what a TOTAL adds up and nothing else -- `Balances`'
// `countsTowardNetWorth` is the one place either flag is consulted, and
// `accountBalances` returns every account regardless.
//
// A finance app in which money can become unfindable is worse than a finance
// app with a wrong headline: a wrong headline is noticed, and money that has
// stopped appearing anywhere is not. So there is nothing in this file that
// removes an account from a list, and there is no "hidden" flag to add later.
//
// ARCHIVING IS ALSO THE ANSWER TO DELETING. `deleteAccount` refuses while the
// account still has transactions, and says so in the sentence, because the only
// alternatives are deleting somebody's history with the account or leaving
// orphaned rows referencing an id that is gone.
//
// EVERY WRITE IS ONE FIELD OR ONE ROW, INSIDE ONE TRANSACTION. Nothing here
// touches an amount, a transaction, or a currency -- with the single exception
// of `saveAccount`, which may change `openingBalanceMinor` because that IS the
// account editor's job, and which refuses to change the CURRENCY of an account
// that already has transactions recorded in the old one.
import Foundation

/// A tombstoned row and what it takes to bring it back.
public struct DeletedRecord: Sendable, Hashable {
    /// The SQL table. Checked on undo, so a receipt cannot be applied to the
    /// wrong kind of row.
    public let table: String
    public let id: String
    public let deletedAt: String
    /// What it was called, for the sentence offering it back.
    public let name: String
}

extension LedgerStore {

    // MARK: - Accounts

    /// Create or update an account.
    ///
    /// FIELDS THE DRAFT DOES NOT CARRY ARE PRESERVED, not defaulted:
    /// `excludeFromNetWorth` and the three loan fields come off the existing
    /// row untouched. Renaming an account must never quietly pull an excluded
    /// property back into net worth, and recolouring one must never forget its
    /// loan term.
    @discardableResult
    public func saveAccount(_ draft: AccountDraft) throws -> Account {
        try connection.transaction {
            let account = try writeAccount(draft)
            try recordLocalEdit(at: environment.now())
            return account
        }
    }

    /// THE ONE PLACE AN ACCOUNT ROW IS VALIDATED AND WRITTEN, and the whole of
    /// `saveAccount` except the counting.
    ///
    /// Called from inside a transaction and does not open one. It exists as a
    /// separate function for one reason: an IMPORT creates accounts too, and it
    /// is ONE act by the owner however many accounts a file turns out to name.
    /// The divergence counter belongs to the act, not to the row, so the
    /// counting sits in the public entry points and the checks -- the name, the
    /// currency code, the colour, the group, and the rule that an account's
    /// currency is immutable once it holds transactions -- sit here, where
    /// every caller gets them.
    @discardableResult
    func writeAccount(_ draft: AccountDraft) throws -> Account {
        let name = Names.clean(draft.name)
        guard !name.isEmpty else { throw EditError.blankName(what: "account") }
        let currency = Names.clean(draft.currency).uppercased()
        guard Validate.isCurrencyCode(currency) else {
            throw EditError.badCurrency(draft.currency)
        }
        let colour = Names.clean(draft.colour)
        guard Validate.isHexColour(colour) else { throw EditError.badColour(draft.colour) }

        var existing: Account? = nil
        if let id = draft.id {
            guard let found = try liveAccount(id: id) else {
                throw EditError.unknownAccount(id)
            }
            existing = found
        }

        if let groupId = draft.groupId, !groupId.isEmpty {
            guard try liveRowExists("account_groups", id: groupId) else {
                throw EditError.unknownGroup(groupId)
            }
        }

        // THE CURRENCY IS IMMUTABLE ONCE THERE IS HISTORY. Every stored
        // amount in this account IS an amount in the old currency; changing
        // the label would re-denominate all of them at a stroke, silently,
        // and there is no undo for "all my euros became pounds".
        if let existing, currency != existing.currency {
            let count = try liveTransactionCount(accountId: existing.id)
            if count > 0 {
                throw EditError.currencyIsLocked(
                    accountName: existing.name, from: existing.currency, to: currency,
                    transactionCount: count
                )
            }
        }

        let sortOrder = try draft.sortOrder ?? existing?.sortOrder
            ?? nextSortOrder("accounts")
        let account = Account(
            id: existing?.id ?? environment.newId(),
            name: name,
            type: draft.type,
            currency: currency,
            openingBalanceMinor: draft.openingBalanceMinor,
            colour: colour,
            groupId: (draft.groupId?.isEmpty ?? true) ? nil : draft.groupId,
            sortOrder: sortOrder,
            archived: draft.archived ?? existing?.archived ?? false,
            // Preserved, never defaulted. See the note above.
            excludeFromNetWorth: existing?.excludeFromNetWorth,
            loanPrincipalMinor: existing?.loanPrincipalMinor,
            loanRatePct: existing?.loanRatePct,
            loanTermMonths: existing?.loanTermMonths
        )

        if existing == nil {
            let insert = try connection.prepare(
                """
                INSERT INTO accounts (
                    id, name, type, currency, opening_balance_minor, colour, group_id,
                    sort_order, archived, exclude_from_net_worth, loan_principal_minor,
                    loan_rate_pct, loan_term_months, deleted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """
            )
            defer { insert.finalize() }
            bindAccount(account, to: insert)
            try insert.run()
        } else {
            let update = try connection.prepare(
                """
                UPDATE accounts SET
                    name = ?2, type = ?3, currency = ?4, opening_balance_minor = ?5,
                    colour = ?6, group_id = ?7, sort_order = ?8, archived = ?9,
                    exclude_from_net_worth = ?10, loan_principal_minor = ?11,
                    loan_rate_pct = ?12, loan_term_months = ?13
                WHERE id = ?1 AND deleted_at IS NULL
                """
            )
            defer { update.finalize() }
            bindAccount(account, to: update)
            try update.run()
            guard try changedRows() > 0 else { throw EditError.unknownAccount(account.id) }
        }

        // The transactions of an account whose currency just changed are
        // re-labelled WITH it -- reachable only when there are none, which
        // the check above has already established, so this is a no-op that
        // exists so the invariant "tx.currency == its account's" cannot be
        // broken by a route somebody adds later.
        if let existing, currency != existing.currency {
            let relabel = try connection.prepare(
                "UPDATE transactions SET currency = ? WHERE account_id = ?"
            )
            defer { relabel.finalize() }
            relabel.bind(1, text: currency)
            relabel.bind(2, text: account.id)
            try relabel.run()
        }

        return account
    }

    /// Retire an account, or bring it back. Touches ONE column.
    ///
    /// The account keeps its transactions, its balance and its place on the
    /// accounts screen; it drops out of net worth. That is the whole
    /// difference, and it is why archiving is the answer offered whenever a
    /// delete is refused.
    public func setAccountArchived(id: String, archived: Bool) throws {
        try setAccountFlag(id: id, column: "archived", value: archived)
    }

    /// "Show it, don't count it."
    ///
    /// Writes `exclude_from_net_worth` and NOTHING else -- no balance is
    /// recomputed, no transaction is touched, and the account stays exactly as
    /// visible as it was. A literal 0 is written when switching the flag OFF
    /// rather than a NULL, matching `setAccountExcluded` in the web app: absent
    /// and false are different bytes in a backup file (see
    /// `Account.excludeFromNetWorth`) and the same answer to every question the
    /// money rules ask, so the app writes the spelling the web app writes.
    public func setAccountExcluded(id: String, excluded: Bool) throws {
        try setAccountFlag(id: id, column: "exclude_from_net_worth", value: excluded)
    }

    private func setAccountFlag(id: String, column: String, value: Bool) throws {
        // The column name is one of two literals chosen HERE, never from a
        // caller: SQLite cannot bind an identifier, so the only safe version of
        // this helper is a private one whose call sites are visible above it.
        precondition(
            column == "archived" || column == "exclude_from_net_worth",
            "setAccountFlag is for the two account flags only"
        )
        try connection.transaction {
            guard let account = try liveAccount(id: id) else {
                throw EditError.unknownAccount(id)
            }
            let current =
                column == "archived" ? account.archived : (account.excludeFromNetWorth == true)
            // Already in that state: not an error, and not a change either --
            // so the divergence counter does not tick for a tap that did
            // nothing.
            if current == value { return }
            let statement = try connection.prepare(
                "UPDATE accounts SET \(column) = ? WHERE id = ? AND deleted_at IS NULL"
            )
            defer { statement.finalize() }
            statement.bind(1, flag: value)
            statement.bind(2, text: id)
            try statement.run()
            try recordLocalEdit(at: environment.now())
        }
    }

    /// Move an account into a group, or out of every group (`nil`).
    ///
    /// ORGANISATIONAL ONLY: `group_id` and nothing else. No balance, amount or
    /// total can move as a result, which is what makes regrouping a 58-account
    /// import safe to do quickly and safe to undo.
    public func moveAccount(id: String, toGroup groupId: String?) throws {
        try connection.transaction {
            guard let account = try liveAccount(id: id) else {
                throw EditError.unknownAccount(id)
            }
            let target = (groupId?.isEmpty ?? true) ? nil : groupId
            if let target {
                guard try liveRowExists("account_groups", id: target) else {
                    throw EditError.unknownGroup(target)
                }
            }
            if account.groupId == target { return }
            let statement = try connection.prepare(
                "UPDATE accounts SET group_id = ?, sort_order = ? WHERE id = ? AND deleted_at IS NULL"
            )
            defer { statement.finalize() }
            statement.bind(1, optionalText: target)
            // Landing at the END of its new group, rather than keeping an order
            // that meant something in the group it left.
            statement.bind(2, integer: try nextSortOrderAmongSiblings(groupId: target))
            statement.bind(3, text: id)
            try statement.run()
            try recordLocalEdit(at: environment.now())
        }
    }

    /// Swap an account one place up or down AMONG THE ACCOUNTS OF ITS OWN
    /// GROUP, and normalise that group's orders to 0..n-1 while doing it.
    ///
    /// The normalisation is not tidiness. A book imported from a file can carry
    /// duplicate `sortOrder` values -- nothing in the format forbids it -- and
    /// swapping two equal numbers is a no-op, so without this the arrows would
    /// simply not work and there would be nothing on screen to explain why.
    public func reorderAccount(id: String, _ direction: MoveDirection) throws {
        try connection.transaction {
            guard let account = try liveAccount(id: id) else {
                throw EditError.unknownAccount(id)
            }
            var siblings = try liveAccountsOrdered(inGroup: account.groupId)
            guard let index = siblings.firstIndex(where: { $0.id == id }) else { return }
            let target = direction == .up ? index - 1 : index + 1
            guard target >= 0, target < siblings.count else { return }  // already at the edge
            siblings.swapAt(index, target)

            let statement = try connection.prepare(
                "UPDATE accounts SET sort_order = ? WHERE id = ?"
            )
            defer { statement.finalize() }
            var changed = false
            for (position, sibling) in siblings.enumerated() where sibling.sortOrder != position {
                statement.bind(1, integer: position)
                statement.bind(2, text: sibling.id)
                try statement.run()
                changed = true
            }
            if changed { try recordLocalEdit(at: environment.now()) }
        }
    }

    /// Tombstone an account. REFUSED while it still holds transactions.
    @discardableResult
    public func deleteAccount(id: String) throws -> DeletedRecord {
        try connection.transaction {
            guard let account = try liveAccount(id: id) else {
                throw EditError.unknownAccount(id)
            }
            let count = try liveTransactionCount(accountId: id)
            guard count == 0 else {
                throw EditError.accountHasTransactions(accountName: account.name, count: count)
            }
            let now = environment.now()
            guard try softDelete(table: "accounts", id: id, at: now) else {
                throw EditError.unknownAccount(id)
            }
            try recordLocalEdit(at: now)
            return DeletedRecord(table: "accounts", id: id, deletedAt: now, name: account.name)
        }
    }

    // MARK: - Groups

    @discardableResult
    public func saveAccountGroup(_ draft: AccountGroupDraft) throws -> AccountGroup {
        try connection.transaction {
            let name = Names.clean(draft.name)
            guard !name.isEmpty else { throw EditError.blankName(what: "group") }

            var existing: AccountGroup? = nil
            if let id = draft.id {
                guard let found = try accountGroup(id: id) else { throw EditError.unknownGroup(id) }
                existing = found
            }
            // Groups are chosen from a short list by name, so two with the same
            // name is a menu the owner cannot use. Accounts are deliberately
            // NOT held to this: two accounts called "Savings" at two banks is an
            // ordinary thing to have.
            if let clash = try accountGroup(named: name), clash.id != existing?.id {
                throw EditError.nameTaken(what: "group", name: clash.name)
            }

            let group = AccountGroup(
                id: existing?.id ?? environment.newId(),
                name: name,
                sortOrder: try draft.sortOrder ?? existing?.sortOrder
                    ?? nextSortOrder("account_groups")
            )
            if existing == nil {
                let insert = try connection.prepare(
                    "INSERT INTO account_groups (id, name, sort_order, deleted_at) "
                        + "VALUES (?, ?, ?, NULL)"
                )
                defer { insert.finalize() }
                insert.bind(1, text: group.id)
                insert.bind(2, text: group.name)
                insert.bind(3, integer: group.sortOrder)
                try insert.run()
            } else {
                let update = try connection.prepare(
                    "UPDATE account_groups SET name = ?, sort_order = ? "
                        + "WHERE id = ? AND deleted_at IS NULL"
                )
                defer { update.finalize() }
                update.bind(1, text: group.name)
                update.bind(2, integer: group.sortOrder)
                update.bind(3, text: group.id)
                try update.run()
                guard try changedRows() > 0 else { throw EditError.unknownGroup(group.id) }
            }
            try recordLocalEdit(at: environment.now())
            return group
        }
    }

    /// Tombstone a group. REFUSED while accounts still sit in it -- deleting a
    /// group never moves or deletes an account, so the owner decides where they
    /// go.
    @discardableResult
    public func deleteAccountGroup(id: String) throws -> DeletedRecord {
        try connection.transaction {
            guard let group = try accountGroup(id: id) else { throw EditError.unknownGroup(id) }
            let count = try liveAccountCount(groupId: id)
            guard count == 0 else {
                throw EditError.groupHasAccounts(groupName: group.name, count: count)
            }
            let now = environment.now()
            guard try softDelete(table: "account_groups", id: id, at: now) else {
                throw EditError.unknownGroup(id)
            }
            try recordLocalEdit(at: now)
            return DeletedRecord(
                table: "account_groups", id: id, deletedAt: now, name: group.name
            )
        }
    }

    public func reorderAccountGroup(id: String, _ direction: MoveDirection) throws {
        try connection.transaction {
            var groups = try readAccountGroups(from: "live_account_groups")
                .sorted { ($0.sortOrder, $0.name) < ($1.sortOrder, $1.name) }
            guard let index = groups.firstIndex(where: { $0.id == id }) else {
                throw EditError.unknownGroup(id)
            }
            let target = direction == .up ? index - 1 : index + 1
            guard target >= 0, target < groups.count else { return }
            groups.swapAt(index, target)
            let statement = try connection.prepare(
                "UPDATE account_groups SET sort_order = ? WHERE id = ?"
            )
            defer { statement.finalize() }
            var changed = false
            for (position, group) in groups.enumerated() where group.sortOrder != position {
                statement.bind(1, integer: position)
                statement.bind(2, text: group.id)
                try statement.run()
                changed = true
            }
            if changed { try recordLocalEdit(at: environment.now()) }
        }
    }

    /// Flag every account CURRENTLY in a group in or out of net worth, and say
    /// how many actually changed.
    ///
    /// A SNAPSHOT, NOT A STANDING RULE. There is no group-level flag: an
    /// account moved into the group afterwards keeps whatever setting it had,
    /// and "un-exclude this one account inside an excluded group" therefore has
    /// an obvious meaning. Undoing it is the same call with `excluded`
    /// inverted. Same design as the web app's `setGroupExcluded`.
    @discardableResult
    public func setGroupExcluded(groupId: String, excluded: Bool) throws -> Int {
        try connection.transaction {
            guard try liveRowExists("account_groups", id: groupId) else {
                throw EditError.unknownGroup(groupId)
            }
            let statement = try connection.prepare(
                """
                UPDATE accounts SET exclude_from_net_worth = ?
                WHERE group_id = ? AND deleted_at IS NULL
                  AND coalesce(exclude_from_net_worth, 0) <> ?
                """
            )
            defer { statement.finalize() }
            statement.bind(1, flag: excluded)
            statement.bind(2, text: groupId)
            statement.bind(3, flag: excluded)
            try statement.run()
            let changed = try changedRows()
            if changed > 0 { try recordLocalEdit(at: environment.now()) }
            return changed
        }
    }

    // MARK: - Undo, for anything with a tombstone

    /// Bring back a row a delete tombstoned.
    ///
    /// The stamp is matched, so a receipt cannot restore a row that was deleted
    /// again afterwards by some other action -- it refuses instead, and says
    /// there is nothing in the bin.
    public func undoDelete(_ receipt: DeletedRecord) throws {
        try connection.transaction {
            guard StoreSchema.allTombstonedTables.contains(receipt.table) else {
                throw StoreError.corrupt("\"\(receipt.table)\" has no tombstones")
            }
            let statement = try connection.prepare(
                "UPDATE \(receipt.table) SET deleted_at = NULL WHERE id = ? AND deleted_at = ?"
            )
            defer { statement.finalize() }
            statement.bind(1, text: receipt.id)
            statement.bind(2, text: receipt.deletedAt)
            try statement.run()
            guard try changedRows() > 0 else {
                throw EditError.nothingToRestore(what: Self.noun(for: receipt.table))
            }
            try recordLocalEdit(at: environment.now())
        }
    }

    /// What to call a tombstoned row in a sentence. A table name would be a
    /// word the owner never chose ("account_groups"), so each one is spelled
    /// out and an unknown table falls back to "record" rather than to nothing.
    private static func noun(for table: String) -> String {
        switch table {
        case "accounts": return "account"
        case "account_groups": return "group"
        case "budgets": return "budget"
        case "schedules": return "schedule"
        default: return "record"
        }
    }

    // MARK: - Reads these mutations need

    /// The groups, in the order the accounts screen lays them out. Public
    /// because a picker needs them and the ordering rule should not be
    /// restated in a view.
    public func accountGroups() throws -> [AccountGroup] {
        try readAccountGroups(from: "live_account_groups")
            .sorted { ($0.sortOrder, $0.name) < ($1.sortOrder, $1.name) }
    }

    func accountGroup(id: String) throws -> AccountGroup? {
        let statement = try connection.prepare(
            "SELECT id, name, sort_order FROM live_account_groups WHERE id = ?"
        )
        defer { statement.finalize() }
        statement.bind(1, text: id)
        guard try statement.step() else { return nil }
        return AccountGroup(
            id: try statement.text(0), name: try statement.text(1),
            sortOrder: try statement.int(2)
        )
    }

    func accountGroup(named name: String) throws -> AccountGroup? {
        try readAccountGroups(from: "live_account_groups")
            .first { Names.key($0.name) == Names.key(name) }
    }

    /// The live accounts of one group, in the sidebar's own order.
    ///
    /// `group_id IS NULL` needs its own branch: `= ?` bound to NULL matches
    /// NOTHING in SQL, so the ungrouped accounts -- the ones an owner is most
    /// likely to be reordering, since that is where an import leaves them --
    /// would silently be an empty list.
    func liveAccountsOrdered(inGroup groupId: String?) throws -> [Account] {
        let sql =
            groupId == nil
            ? "SELECT id FROM live_accounts WHERE group_id IS NULL"
            : "SELECT id FROM live_accounts WHERE group_id = ?"
        let statement = try connection.prepare(sql)
        defer { statement.finalize() }
        if let groupId { statement.bind(1, text: groupId) }
        var ids: [String] = []
        while try statement.step() { ids.append(try statement.text(0)) }
        let accounts = try ids.compactMap { try liveAccount(id: $0) }
        // Ordered exactly as `Balances.accountBalances` orders them, so the
        // arrows move a row to where the eye expects it.
        let enGB = Locale(identifier: "en_GB")
        return accounts.enumerated()
            .sorted { lhs, rhs in
                if lhs.element.sortOrder != rhs.element.sortOrder {
                    return lhs.element.sortOrder < rhs.element.sortOrder
                }
                let byName = lhs.element.name.compare(
                    rhs.element.name, options: [], range: nil, locale: enGB
                )
                if byName != .orderedSame { return byName == .orderedAscending }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    private func nextSortOrderAmongSiblings(groupId: String?) throws -> Int {
        (try liveAccountsOrdered(inGroup: groupId).map(\.sortOrder).max() ?? -1) + 1
    }

    private func bindAccount(_ account: Account, to statement: SQLiteStatement) {
        statement.bind(1, text: account.id)
        statement.bind(2, text: account.name)
        statement.bind(3, text: account.type.rawValue)
        statement.bind(4, text: account.currency)
        statement.bind(5, minorUnits: account.openingBalanceMinor)  // MONEY
        statement.bind(6, text: account.colour)
        statement.bind(7, optionalText: account.groupId)
        statement.bind(8, integer: account.sortOrder)
        statement.bind(9, flag: account.archived)
        statement.bind(10, optionalFlag: account.excludeFromNetWorth)
        statement.bind(11, optionalMinorUnits: account.loanPrincipalMinor)
        statement.bind(12, optionalReal: account.loanRatePct)
        statement.bind(13, optionalInteger: account.loanTermMonths)
    }
}

/// The two shapes a form has to get right, checked without a regular
/// expression engine.
///
/// Hand-written because both are three lines and because
/// `NSRegularExpression` is a different matcher from JavaScript's -- the web
/// app's `/^[A-Z]{3}$/` and `/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/` are
/// ASCII-only, and a Foundation regex that accepted a Cyrillic "А" where an "A"
/// was expected would let the phone create an account the browser cannot.
enum Validate {
    /// Exactly three ASCII letters. The caller has already uppercased.
    static func isCurrencyCode(_ code: String) -> Bool {
        let scalars = Array(code.unicodeScalars)
        guard scalars.count == 3 else { return false }
        return scalars.allSatisfy { ("A"..."Z").contains($0) }
    }

    /// "#rgb" or "#rrggbb", hex digits only.
    static func isHexColour(_ colour: String) -> Bool {
        guard colour.hasPrefix("#") else { return false }
        let digits = Array(colour.unicodeScalars.dropFirst())
        guard digits.count == 3 || digits.count == 6 else { return false }
        return digits.allSatisfy {
            ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0)
        }
    }
}
