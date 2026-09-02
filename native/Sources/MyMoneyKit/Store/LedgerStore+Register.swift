// What a screen asks the store for: balances without decoding the book, and a
// register a page at a time.
//
// WHY THIS IS NOT `book()`. `LedgerStore.book()` reads every table and decodes
// every transaction, its splits and its tags. That is the right shape for the
// backup round trip, where the whole point is that nothing was lost. It is the
// wrong shape for a screen: a register that materialised 5,127 rows (and two
// child-table reads each) before drawing its first line would be slow at 5,000
// and unusable at 100,000, and it would hold the entire ledger in memory to
// show forty rows of it.
//
// So there are two reads here and they are deliberately narrow:
//
//   * `balanceContributions()` streams THREE COLUMNS and hands them to the same
//     `Balances` arithmetic the book path uses. It does not build a
//     `Transaction`. The rule is not restated -- see `BalanceContribution`.
//   * `registerPage(...)` returns one page in the register's order, resuming
//     from a cursor. Keyset, never OFFSET; the reasoning is on `RegisterCursor`.
//
// NOTHING IN HERE AGGREGATES MONEY IN SQL. `sum()` over integers raises
// "integer overflow" and `total()` silently returns a REAL that is wrong by one
// at the Int64 edge, so every total in this file is built by `Money`/`Balances`
// in Swift with overflow-checked adds. The only counting SQL does is of ROWS.
import Foundation

/// Which account (or all of them) a register read covers.
public enum RegisterScope: Sendable, Hashable {
    case allAccounts
    case account(String)
}

/// The names a register row needs, read once and reused for every page.
///
/// Payees, categories, tags and accounts are small (hundreds at most) and every
/// row needs them, so they are read whole. Transactions are the thing that
/// scales, and they are the thing that is paged.
public struct RegisterLookups: Sendable {
    public let accountsById: [String: Account]
    public let payeeNamesById: [String: String]
    public let categoriesById: [String: Category]
    public let tagNamesById: [String: String]

    public init(
        accountsById: [String: Account],
        payeeNamesById: [String: String],
        categoriesById: [String: Category],
        tagNamesById: [String: String]
    ) {
        self.accountsById = accountsById
        self.payeeNamesById = payeeNamesById
        self.categoriesById = categoriesById
        self.tagNamesById = tagNamesById
    }

    /// The category path, resolved through the tree ("Food › Dining › Coffee").
    /// Empty for an id naming nothing -- an orphan reads as uncategorised
    /// rather than as a blank line with no explanation.
    func categoryPath(_ id: String?) -> String? {
        guard let id else { return nil }
        let path = Categories.categoryPathName(categoriesById, id: id)
        return path.isEmpty ? nil : path
    }
}

extension LedgerStore {

    // MARK: - Balances without decoding the book

    /// Every live transaction as the three fields a balance is made of.
    ///
    /// One statement, one pass, no per-row allocation beyond the account id.
    public func balanceContributions() throws -> [BalanceContribution] {
        let statement = try connection.prepare(
            "SELECT account_id, amount_minor, status FROM live_transactions"
        )
        defer { statement.finalize() }
        var rows: [BalanceContribution] = []
        while try statement.step() {
            rows.append(
                BalanceContribution(
                    accountId: try statement.text(0),
                    amountMinor: try statement.minorUnits(1),
                    // The string comparison is here rather than in
                    // `BalanceContribution` so that type never has to know how
                    // a status is spelled in a column.
                    cleared: try statement.text(2) == TxStatus.cleared.rawValue
                )
            )
        }
        return rows
    }

    /// Balances for every account in the store, archived and excluded included,
    /// in the register's own account order.
    ///
    /// Identical, row for row, to `try book().accountBalances()` -- it is the
    /// same function over the same numbers, reached without decoding splits and
    /// tags. `StoreRegisterTests` asserts the two agree rather than trusting
    /// this sentence.
    public func accountBalances() throws -> [AccountBalance] {
        try Balances.accountBalances(
            accounts: try readAccounts(from: "live_accounts"),
            contributions: try balanceContributions()
        )
    }

    /// Balances, the net-worth headline, and the groups to lay them out in:
    /// everything the accounts screen needs, from ONE read of the ledger.
    ///
    /// One call rather than three because the headline and the rows beneath it
    /// must be the same book. Two reads a moment apart could not disagree today
    /// (nothing writes while a screen draws) but the shape that cannot disagree
    /// costs nothing extra, and this is a phase away from a sync engine.
    public func accountsSnapshot() throws -> AccountsSnapshot {
        let balances = try accountBalances()
        let settings = try readSettings()
        let base = (settings?.baseCurrency).flatMap { $0.isEmpty ? nil : $0 }
            ?? BackupImporter.fallbackBaseCurrency
        let rates = RateTable(rates: try readFxRates(from: "live_fx_rates"))
        return AccountsSnapshot(
            balances: balances,
            // IN THEIR OWN SORT ORDER, which is what the sidebar draws and what
            // reordering a group has to change. `readAccountGroups` returns
            // them by id -- deterministic, which is what the backup round trip
            // needs, and not an order anybody chose.
            groups: try accountGroups(),
            netWorth: try Balances.netWorth(balances, baseCurrency: base, rates: rates),
            baseCurrency: base
        )
    }

    // MARK: - The register

    /// The names every register row needs, read once.
    public func registerLookups() throws -> RegisterLookups {
        var accounts: [String: Account] = [:]
        for account in try readAccounts(from: "live_accounts") { accounts[account.id] = account }

        var payees: [String: String] = [:]
        for payee in try readPayees(from: "live_payees") { payees[payee.id] = payee.name }

        var categories: [String: Category] = [:]
        for category in try readCategories(from: "live_categories") {
            categories[category.id] = category
        }

        var tags: [String: String] = [:]
        for tag in try readTags(from: "live_tags") { tags[tag.id] = tag.name }

        return RegisterLookups(
            accountsById: accounts,
            payeeNamesById: payees,
            categoriesById: categories,
            tagNamesById: tags
        )
    }

    /// How many rows the register has, for the scope. A row count, not a total:
    /// see the header on why no money is added up in SQL.
    public func registerCount(scope: RegisterScope) throws -> Int {
        switch scope {
        case .allAccounts:
            return Int(try connection.scalarInt("SELECT count(*) FROM live_transactions") ?? 0)
        case .account(let id):
            let statement = try connection.prepare(
                "SELECT count(*) FROM live_transactions WHERE account_id = ?"
            )
            defer { statement.finalize() }
            statement.bind(1, text: id)
            guard try statement.step() else { return 0 }
            return try statement.int(0)
        }
    }

    /// How many rows a SEARCH has, for the scope.
    ///
    /// Counted in SQL rather than by paging until the pages run out, so
    /// "312 matches" is a fact the database produced in one pass rather than a
    /// number the app accumulated and could get wrong at a page boundary. An
    /// empty search falls through to the plain count above -- same answer, one
    /// fewer predicate.
    public func registerCount(scope: RegisterScope, search: RegisterSearch, lookups: RegisterLookups)
        throws -> Int
    {
        guard !search.isEmpty else { return try registerCount(scope: scope) }
        let predicate = searchPredicate(search, lookups: lookups)
        var conditions: [String] = []
        if case .account = scope { conditions.append("t.account_id = ?") }
        if !predicate.isEmpty { conditions.append(predicate.sql) }
        let whereClause = conditions.isEmpty ? "" : "WHERE " + conditions.joined(separator: " AND ")

        let statement = try connection.prepare(
            "SELECT count(*) FROM live_transactions t \(whereClause)"
        )
        defer { statement.finalize() }
        var slot: Int32 = 1
        if case .account(let id) = scope {
            statement.bind(slot, text: id)
            slot += 1
        }
        _ = statement.bind(predicate.bindings, from: slot)
        guard try statement.step() else { return 0 }
        return try statement.int(0)
    }

    /// One page of the register, newest first, resuming after `cursor`.
    ///
    /// `limit + 1` rows are asked for and at most `limit` are returned: the
    /// extra row is how "is there more?" is answered without a second query and
    /// without guessing from a short page.
    public func registerPage(
        scope: RegisterScope,
        after cursor: RegisterCursor? = nil,
        limit: Int = 60,
        lookups: RegisterLookups
    ) throws -> RegisterPage {
        try registerPage(
            scope: scope, search: .none, after: cursor, limit: limit, lookups: lookups
        )
    }

    /// One page of the register, filtered by a search.
    ///
    /// THE SAME QUERY, with one more predicate. Same order, same cursor, same
    /// row construction -- see the header of `LedgerStore+Search.swift` for why
    /// searching is not allowed to become a second read path. An empty search
    /// adds no predicate at all, so the ordinary register pays nothing for the
    /// search box existing.
    public func registerPage(
        scope: RegisterScope,
        search: RegisterSearch,
        after cursor: RegisterCursor? = nil,
        limit: Int = 60,
        lookups: RegisterLookups
    ) throws -> RegisterPage {
        precondition(limit > 0, "a register page of no rows is not a page")

        let predicate = searchPredicate(search, lookups: lookups)
        var conditions: [String] = []
        if case .account = scope { conditions.append("t.account_id = ?") }
        if !predicate.isEmpty { conditions.append(predicate.sql) }
        if cursor != nil {
            // Row-value comparison: ONE expression over the whole sort key, and
            // the form SQLite can drive an index seek from (3.15+). Spelling it
            // out as nested ORs would be the same predicate and a table scan.
            conditions.append(Register.cursorPredicate(qualifiedBy: "t"))
        }
        let whereClause = conditions.isEmpty ? "" : "WHERE " + conditions.joined(separator: " AND ")

        let sql = """
            SELECT t.id, t.account_id, t.date, t.amount_minor, t.currency, t.payee_id,
                   t.category_id, t.notes, t.status, t.transfer_group_id, t.created_at,
                   (SELECT count(*) FROM transaction_splits s WHERE s.transaction_id = t.id),
                   (SELECT count(DISTINCT s.category_id) FROM transaction_splits s
                     WHERE s.transaction_id = t.id AND s.category_id IS NOT NULL)
            FROM live_transactions t
            \(whereClause)
            ORDER BY \(Register.orderClause(qualifiedBy: "t"))
            LIMIT ?
            """

        let statement = try connection.prepare(sql)
        defer { statement.finalize() }
        var slot: Int32 = 1
        if case .account(let id) = scope {
            statement.bind(slot, text: id)
            slot += 1
        }
        // In the order the conditions were appended above, which is the order
        // their placeholders appear in the statement. `bind(_:from:)` returns
        // the next free slot rather than letting this function guess it.
        slot = statement.bind(predicate.bindings, from: slot)
        if let cursor {
            statement.bind(slot, text: cursor.date)
            statement.bind(slot + 1, text: cursor.createdAt)
            statement.bind(slot + 2, text: cursor.id)
            slot += 3
        }
        statement.bind(slot, integer: Int64(limit) + 1)

        struct Raw {
            let id: String
            let accountId: String
            let date: String
            let amountMinor: Int64
            let currency: String
            let payeeId: String?
            let categoryId: String?
            let notes: String
            let status: TxStatus
            let transferGroupId: String?
            let createdAt: String
            let splitCount: Int
            let splitCategoryCount: Int
        }

        var raw: [Raw] = []
        while try statement.step() {
            let id = try statement.text(0)
            raw.append(
                Raw(
                    id: id,
                    accountId: try statement.text(1),
                    date: try statement.text(2),
                    amountMinor: try statement.minorUnits(3),
                    currency: try statement.text(4),
                    payeeId: try statement.optionalText(5),
                    categoryId: try statement.optionalText(6),
                    notes: try statement.text(7),
                    status: try Self.enumeration(
                        try statement.text(8), TxStatus.self, "transactions[\(id)].status"
                    ),
                    transferGroupId: try statement.optionalText(9),
                    createdAt: try statement.text(10),
                    splitCount: try statement.int(11),
                    splitCategoryCount: try statement.int(12)
                )
            )
        }

        let hasMore = raw.count > limit
        if hasMore { raw.removeLast(raw.count - limit) }

        // The other leg of every transfer on this page, in ONE query rather
        // than one per row. `IN (?, ?, ...)` over an indexed column: the page's
        // worth of ids, never the table's.
        let transferGroups = Array(Set(raw.compactMap(\.transferGroupId)))
        let legsByGroup = try transferLegs(groups: transferGroups)
        let tagNames = try tagNamesByTransaction(ids: raw.map(\.id), lookups: lookups)

        let rows: [RegisterRow] = raw.map { row in
            let account = lookups.accountsById[row.accountId]
            let isTransfer = row.transferGroupId != nil
            let payeeName = row.payeeId.flatMap { lookups.payeeNamesById[$0] }
            let title = Register.title(
                payeeName: payeeName, notes: row.notes, isTransfer: isTransfer
            )
            // "The other leg" is decided PER ROW, not per page. When both legs
            // are on screen -- which is the ordinary case, since they share a
            // date -- each must name the one across from it, so the only
            // transaction excluded from the search is this one.
            let otherName = row.transferGroupId
                .flatMap { group in
                    legsByGroup[group]?.first { $0.id != row.id }?.accountId
                }
                .flatMap { lookups.accountsById[$0]?.name }
            return RegisterRow(
                id: row.id,
                accountId: row.accountId,
                // An account id naming nothing is a broken book, not a reason
                // to hide a row that has the owner's money on it.
                accountName: account?.name ?? "Unknown account",
                accountColour: account?.colour ?? "#888888",
                date: row.date,
                title: title.text,
                titleIsPlaceholder: title.isPlaceholder,
                categoryLine: Register.categoryLine(
                    isTransfer: isTransfer,
                    amountMinor: row.amountMinor,
                    otherAccountName: otherName,
                    splitCategoryCount: row.splitCategoryCount,
                    hasSplits: row.splitCount > 0,
                    categoryPath: lookups.categoryPath(row.categoryId)
                ),
                amountMinor: row.amountMinor,
                currency: row.currency,
                status: row.status,
                notes: row.notes,
                tagNames: tagNames[row.id] ?? [],
                cursor: RegisterCursor(date: row.date, createdAt: row.createdAt, id: row.id)
            )
        }

        return RegisterPage(rows: rows, nextCursor: hasMore ? rows.last?.cursor : nil)
    }

    // MARK: - Page helpers

    /// transferGroupId -> every leg in that group, as (transaction id, account
    /// id), in a stable order.
    ///
    /// ALL the legs, not "the other one", because which leg is "the other" is a
    /// question only a particular ROW can answer -- and both legs of a transfer
    /// share a date, so both are usually on the same page. Deciding it once per
    /// page would leave each of them describing a transfer to nowhere. The
    /// caller filters by its own id; a group with only one leg in the book
    /// yields nothing, and the row says "another account" rather than inventing
    /// one.
    private func transferLegs(
        groups: [String]
    ) throws -> [String: [(id: String, accountId: String)]] {
        guard !groups.isEmpty else { return [:] }
        var out: [String: [(id: String, accountId: String)]] = [:]
        // Chunked so the statement never approaches SQLITE_MAX_VARIABLE_NUMBER,
        // which is a limit of the library and not of the book.
        for chunk in stride(from: 0, to: groups.count, by: 200).map({
            Array(groups[$0..<min($0 + 200, groups.count)])
        }) {
            let placeholders = Array(repeating: "?", count: chunk.count).joined(separator: ", ")
            let statement = try connection.prepare(
                """
                SELECT transfer_group_id, id, account_id FROM live_transactions
                WHERE transfer_group_id IN (\(placeholders))
                ORDER BY transfer_group_id, id
                """
            )
            defer { statement.finalize() }
            for (offset, group) in chunk.enumerated() {
                statement.bind(Int32(offset + 1), text: group)
            }
            while try statement.step() {
                out[try statement.text(0), default: []].append(
                    (id: try statement.text(1), accountId: try statement.text(2))
                )
            }
        }
        return out
    }

    /// transactionId -> tag names, in the order the transaction carries them.
    private func tagNamesByTransaction(
        ids: [String], lookups: RegisterLookups
    ) throws -> [String: [String]] {
        guard !ids.isEmpty else { return [:] }
        var out: [String: [String]] = [:]
        for chunk in stride(from: 0, to: ids.count, by: 200).map({
            Array(ids[$0..<min($0 + 200, ids.count)])
        }) {
            let placeholders = Array(repeating: "?", count: chunk.count).joined(separator: ", ")
            let statement = try connection.prepare(
                """
                SELECT transaction_id, tag_id FROM transaction_tags
                WHERE transaction_id IN (\(placeholders))
                ORDER BY transaction_id, position
                """
            )
            defer { statement.finalize() }
            for (offset, id) in chunk.enumerated() {
                statement.bind(Int32(offset + 1), text: id)
            }
            while try statement.step() {
                let txId = try statement.text(0)
                let tagId = try statement.text(1)
                // An unknown tag id is dropped rather than shown as a blank
                // chip; the row's money is unaffected either way.
                if let name = lookups.tagNamesById[tagId] {
                    out[txId, default: []].append(name)
                }
            }
        }
        return out
    }
}

/// Everything the accounts screen draws, from one read.
public struct AccountsSnapshot: Sendable {
    /// Every account, archived and excluded included, in sidebar order.
    public let balances: [AccountBalance]
    /// The groups, in their own sort order. An account whose `groupId` names
    /// none of these belongs in the ungrouped section.
    public let groups: [AccountGroup]
    public let netWorth: NetWorth
    public let baseCurrency: String

    public init(
        balances: [AccountBalance], groups: [AccountGroup], netWorth: NetWorth,
        baseCurrency: String
    ) {
        self.balances = balances
        self.groups = groups
        self.netWorth = netWorth
        self.baseCurrency = baseCurrency
    }
}
