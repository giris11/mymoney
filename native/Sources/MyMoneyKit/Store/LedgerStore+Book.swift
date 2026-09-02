// The book, into the store and back out.
//
// ONE RULE GOVERNS EVERY LINE HERE: what goes in must come out identical --
// not equivalent, IDENTICAL -- because the property this layer is judged on is
// that a backup imported and re-exported produces the same canonical content
// hash, and the hash notices things a balance never would.
//
// The three places that is easy to get wrong, and where the code is therefore
// more careful than it looks:
//
//   1. THREE-STATE FLAGS. `Account.excludeFromNetWorth` is `Bool?`: absent,
//      false, or true. A backup's hash covers key PRESENCE, so a row that
//      omitted the flag and a row that stated `false` are different files for
//      the same book, and both occur in the wild. NULL / 0 / 1.
//
//   2. ABSENT VERSUS EMPTY ARRAYS. `ImportBatch.createdBudgetIds` is `[String]?`
//      -- absent on every batch except the sample-data one (D19). `NULL` is
//      absent; `'[]'` is an empty list; they are different files.
//
//   3. ORDER. `splits`, `tagIds` and `categoryIds` are JSON arrays, and an
//      array in a different order is a different document with a different
//      hash. Every child table carries an explicit `position` and every read
//      orders by it. Nothing here relies on rowid order, which SQLite does not
//      promise.
//
// A NOTE ON `ORDER BY id`. The reads below order by id for determinism only.
// The FILE's row order is decided by BackupWriter, which sorts with
// `jsStringLess` (UTF-16 code units, matching the browser). SQLite's TEXT
// ordering is BINARY -- byte-wise UTF-8 -- and the two differ for characters
// outside the Basic Multilingual Plane. Never let SQLite's ordering reach the
// file.
import Foundation

extension LedgerStore {

    // MARK: - Id lists as canonical JSON

    /// An id list as compact canonical JSON. Through CanonicalJSON rather than
    /// a hand-rolled join, so that a payee id containing a quote or a lone
    /// surrogate is escaped exactly the way the rest of this package escapes it.
    static func idsToJSON(_ ids: [String]) -> String {
        CanonicalJSON.text(.array(ids.map(JSONValue.string)), indent: 0)
    }

    static func idsFromJSON(_ text: String, context: String) throws -> [String] {
        guard let parsed = try? JSONParser.parse(text), let items = parsed.arrayValue else {
            throw StoreError.corrupt("\(context) is not a JSON array: \(text.prefix(80))")
        }
        return try items.map {
            guard let value = $0.stringValue else {
                throw StoreError.corrupt("\(context) contains a non-string id")
            }
            return value
        }
    }

    // MARK: - Writing

    /// Replace everything in the store with `book`, in ONE transaction.
    ///
    /// `afterEachTable` is a TEST SEAM and nothing else -- it is how
    /// StoreAtomicityTests injects a failure partway through a write, watches
    /// the store from a second connection while it runs, and takes a "power
    /// cut" copy of the files mid-transaction. It is
    /// deliberately not on the public API: a production caller that could
    /// interpose on a half-written book is a production caller that can leave
    /// one behind.
    func writeBook(_ book: Book, afterEachTable: ((String) throws -> Void)? = nil) throws {
        try connection.transaction {
            try clearAllRows()

            try writeAccountGroups(book.accountGroups)
            try afterEachTable?("account_groups")
            try writeAccounts(book.accounts)
            try afterEachTable?("accounts")
            try writeCategories(book.categories)
            try afterEachTable?("categories")
            try writePayees(book.payees)
            try afterEachTable?("payees")
            try writeTags(book.tags)
            try afterEachTable?("tags")
            try writeImportBatches(book.importBatches)
            try afterEachTable?("import_batches")
            try writeBudgets(book.budgets)
            try afterEachTable?("budgets")
            try writeFxRates(book.fxRates)
            try afterEachTable?("fx_rates")
            try writeTransactions(book.transactions)
            try afterEachTable?("transactions")
            try writeSettings(book.settings)
            try afterEachTable?("settings")
        }
    }

    /// Empty every ledger table, TOMBSTONES INCLUDED.
    ///
    /// THE ONE PLACE THIS PACKAGE PHYSICALLY REMOVES A LEDGER ROW, and it is
    /// not a deletion in the sense the tombstone rule is about. That rule
    /// (StoreSchema.swift) is about a row an OWNER deletes, which must survive
    /// as a tombstone so that sync sees a conflict-protected save instead of a
    /// silent loss. This is a RESTORE: the whole store is being replaced by a
    /// file, in one transaction, with nothing visible in between. Keeping the
    /// old book's tombstones would be worse than dropping them -- they would
    /// claim that rows in the incoming file had been deleted.
    ///
    /// It is reachable only from `writeBook`, which is reachable only from an
    /// import that has already refused to overwrite a non-empty store unless
    /// told to.
    func clearAllRows() throws {
        // Children first even though the foreign keys cascade: an explicit
        // order does not depend on `PRAGMA foreign_keys` being on.
        for table in StoreSchema.childTables + StoreSchema.tombstonedTables + ["settings"] {
            try connection.execute("DELETE FROM \(table)")
        }
    }

    private func writeAccountGroups(_ groups: [AccountGroup]) throws {
        let statement = try connection.prepare(
            "INSERT INTO account_groups (id, name, sort_order, deleted_at) VALUES (?, ?, ?, NULL)"
        )
        defer { statement.finalize() }
        for group in groups {
            statement.bind(1, text: group.id)
            statement.bind(2, text: group.name)
            statement.bind(3, integer: group.sortOrder)
            try statement.run()
        }
    }

    private func writeAccounts(_ accounts: [Account]) throws {
        let statement = try connection.prepare(
            """
            INSERT INTO accounts (
                id, name, type, currency, opening_balance_minor, colour, group_id, sort_order,
                archived, exclude_from_net_worth, loan_principal_minor, loan_rate_pct,
                loan_term_months, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """
        )
        defer { statement.finalize() }
        for account in accounts {
            statement.bind(1, text: account.id)
            statement.bind(2, text: account.name)
            statement.bind(3, text: account.type.rawValue)
            statement.bind(4, text: account.currency)
            // MONEY: the Int64 binder, the only one that reaches this column.
            statement.bind(5, minorUnits: account.openingBalanceMinor)
            statement.bind(6, text: account.colour)
            statement.bind(7, optionalText: account.groupId)
            statement.bind(8, integer: account.sortOrder)
            statement.bind(9, flag: account.archived)
            // THREE STATES. See the file comment.
            statement.bind(10, optionalFlag: account.excludeFromNetWorth)
            statement.bind(11, optionalMinorUnits: account.loanPrincipalMinor)
            // NOT money: an interest percentage.
            statement.bind(12, optionalReal: account.loanRatePct)
            statement.bind(13, optionalInteger: account.loanTermMonths)
            try statement.run()
        }
    }

    /// Internal rather than private because `createBook` seeds the starter tree
    /// through it. One category writer, so a seeded row and an imported row are
    /// written by the same statement into the same columns.
    func writeCategories(_ categories: [Category]) throws {
        let statement = try connection.prepare(
            """
            INSERT INTO categories (
                id, name, parent_id, kind, icon, colour, archived, sort_order, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """
        )
        defer { statement.finalize() }
        for category in categories {
            statement.bind(1, text: category.id)
            statement.bind(2, text: category.name)
            statement.bind(3, optionalText: category.parentId)
            statement.bind(4, text: category.kind.rawValue)
            statement.bind(5, optionalText: category.icon)
            statement.bind(6, optionalText: category.colour)
            statement.bind(7, flag: category.archived)
            statement.bind(8, integer: category.sortOrder)
            try statement.run()
        }
    }

    private func writePayees(_ payees: [Payee]) throws {
        let statement = try connection.prepare(
            "INSERT INTO payees (id, name, name_lower, default_category_id, deleted_at) "
                + "VALUES (?, ?, ?, ?, NULL)"
        )
        defer { statement.finalize() }
        for payee in payees {
            statement.bind(1, text: payee.id)
            statement.bind(2, text: payee.name)
            statement.bind(3, text: payee.nameLower)
            statement.bind(4, optionalText: payee.defaultCategoryId)
            try statement.run()
        }
    }

    private func writeTags(_ tags: [Tag]) throws {
        let statement = try connection.prepare(
            "INSERT INTO tags (id, name, name_lower, deleted_at) VALUES (?, ?, ?, NULL)"
        )
        defer { statement.finalize() }
        for tag in tags {
            statement.bind(1, text: tag.id)
            statement.bind(2, text: tag.name)
            statement.bind(3, text: tag.nameLower)
            try statement.run()
        }
    }

    private func writeImportBatches(_ batches: [ImportBatch]) throws {
        let statement = try connection.prepare(
            """
            INSERT INTO import_batches (
                id, source, file_name, row_count, imported_at, created_account_ids,
                created_category_ids, created_payee_ids, created_tag_ids, created_group_ids,
                created_budget_ids, created_fx_rate_ids, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """
        )
        defer { statement.finalize() }
        for batch in batches {
            statement.bind(1, text: batch.id)
            statement.bind(2, text: batch.source.rawValue)
            statement.bind(3, text: batch.fileName)
            statement.bind(4, integer: batch.rowCount)
            statement.bind(5, text: batch.importedAt)
            statement.bind(6, text: Self.idsToJSON(batch.createdAccountIds))
            statement.bind(7, text: Self.idsToJSON(batch.createdCategoryIds))
            statement.bind(8, text: Self.idsToJSON(batch.createdPayeeIds))
            statement.bind(9, text: Self.idsToJSON(batch.createdTagIds))
            statement.bind(10, text: Self.idsToJSON(batch.createdGroupIds))
            // ABSENT versus EMPTY: NULL is "the key was not in the row",
            // '[]' is "the key was there and the list was empty".
            statement.bind(11, optionalText: batch.createdBudgetIds.map(Self.idsToJSON))
            statement.bind(12, optionalText: batch.createdFxRateIds.map(Self.idsToJSON))
            try statement.run()
        }
    }

    private func writeBudgets(_ budgets: [Budget]) throws {
        let statement = try connection.prepare(
            """
            INSERT INTO budgets (
                id, name, amount_minor, period, start_date, rollover, archived, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            """
        )
        defer { statement.finalize() }
        let link = try connection.prepare(
            "INSERT INTO budget_categories (budget_id, position, category_id) VALUES (?, ?, ?)"
        )
        defer { link.finalize() }
        for budget in budgets {
            statement.bind(1, text: budget.id)
            statement.bind(2, text: budget.name)
            statement.bind(3, minorUnits: budget.amountMinor)  // MONEY, in base currency (D22)
            statement.bind(4, text: budget.period.rawValue)
            statement.bind(5, text: budget.startDate)
            statement.bind(6, flag: budget.rollover)
            statement.bind(7, flag: budget.archived)
            try statement.run()
            for (position, categoryId) in budget.categoryIds.enumerated() {
                link.bind(1, text: budget.id)
                link.bind(2, integer: position)
                link.bind(3, text: categoryId)
                try link.run()
            }
        }
    }

    private func writeFxRates(_ rates: [FxRate]) throws {
        let statement = try connection.prepare(
            "INSERT INTO fx_rates (id, base, quote, rate, as_of, source, deleted_at) "
                + "VALUES (?, ?, ?, ?, ?, ?, NULL)"
        )
        defer { statement.finalize() }
        for rate in rates {
            statement.bind(1, text: rate.id)
            statement.bind(2, text: rate.base)
            statement.bind(3, text: rate.quote)
            // NOT money. A rate is genuinely not a decimal quantity, and this
            // is one of only two REAL columns in the schema (StoreSchema's
            // `realColumns` names both, so the question has an answer).
            statement.bind(4, real: rate.rate)
            statement.bind(5, text: rate.asOf)
            statement.bind(6, text: rate.source.rawValue)
            try statement.run()
        }
    }

    private func writeTransactions(_ transactions: [Transaction]) throws {
        let statement = try connection.prepare(
            """
            INSERT INTO transactions (
                id, account_id, date, amount_minor, currency, payee_id, category_id, notes,
                status, transfer_group_id, import_batch_id, dedupe_hash, created_at, updated_at,
                deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """
        )
        defer { statement.finalize() }
        let split = try connection.prepare(
            "INSERT INTO transaction_splits (transaction_id, position, category_id, amount_minor, notes) "
                + "VALUES (?, ?, ?, ?, ?)"
        )
        defer { split.finalize() }
        let tag = try connection.prepare(
            "INSERT INTO transaction_tags (transaction_id, position, tag_id) VALUES (?, ?, ?)"
        )
        defer { tag.finalize() }

        for tx in transactions {
            statement.bind(1, text: tx.id)
            statement.bind(2, text: tx.accountId)
            statement.bind(3, text: tx.date)
            statement.bind(4, minorUnits: tx.amountMinor)  // MONEY
            statement.bind(5, text: tx.currency)
            statement.bind(6, optionalText: tx.payeeId)
            statement.bind(7, optionalText: tx.categoryId)
            statement.bind(8, text: tx.notes)
            statement.bind(9, text: tx.status.rawValue)
            statement.bind(10, optionalText: tx.transferGroupId)
            statement.bind(11, optionalText: tx.importBatchId)
            statement.bind(12, text: tx.dedupeHash)
            statement.bind(13, text: tx.createdAt)
            statement.bind(14, text: tx.updatedAt)
            try statement.run()

            for (position, item) in tx.splits.enumerated() {
                split.bind(1, text: tx.id)
                split.bind(2, integer: position)
                split.bind(3, optionalText: item.categoryId)
                split.bind(4, minorUnits: item.amountMinor)  // MONEY
                split.bind(5, optionalText: item.notes)
                try split.run()
            }
            for (position, tagId) in tx.tagIds.enumerated() {
                tag.bind(1, text: tx.id)
                tag.bind(2, integer: position)
                tag.bind(3, text: tagId)
                try tag.run()
            }
        }
    }

    /// The settings row.
    ///
    /// `row_json` is written from `BackupWriter.settingsRow`, which is the same
    /// function that writes the row into a backup file: typed fields rendered
    /// from the record, plus the DEVICE-LOCAL `sync*` keys carried through
    /// verbatim. That gives the store exactly one path from record to stored
    /// bytes and back, and it is why an export of an unchanged book can match
    /// the browser's hash despite this package modelling only half the row.
    ///
    /// The typed columns beside it are an INDEX over that JSON, not a second
    /// truth -- reconstruction never reads them. `StoreFidelityTests` pins that
    /// they agree with the record anyway, because a stale index is a lie even
    /// when nothing depends on it.
    func writeSettings(_ settings: Settings?) throws {
        guard let settings else { return }
        let statement = try connection.prepare(
            """
            INSERT INTO settings (
                id, schema_version, base_currency, theme, last_backup_at, onboarded,
                last_used_account_id, created_at, auto_fx_enabled, last_fx_sync_at,
                last_fx_sync_source, row_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: settings.id)
        statement.bind(2, integer: settings.schemaVersion)
        statement.bind(3, text: settings.baseCurrency)
        statement.bind(4, text: settings.theme.rawValue)
        statement.bind(5, optionalText: settings.lastBackupAt)
        statement.bind(6, flag: settings.onboarded)
        statement.bind(7, optionalText: settings.lastUsedAccountId)
        statement.bind(8, text: settings.createdAt)
        statement.bind(9, flag: settings.autoFxEnabled)
        statement.bind(10, optionalText: settings.lastFxSyncAt)
        statement.bind(11, optionalText: settings.lastFxSyncSource)
        statement.bind(
            12, text: CanonicalJSON.text(BackupWriter.settingsRow(settings), indent: 0)
        )
        try statement.run()
    }

    // MARK: - Reading

    /// The whole book. Tombstoned rows are excluded -- by construction, because
    /// every read below names a `live_*` view rather than a base table.
    ///
    /// `includingDeleted: true` names the base tables instead. It exists for
    /// diagnostics and for whatever sync eventually needs; nothing in the money
    /// rules may call it, because a deleted transaction is not part of a
    /// balance.
    public func book(includingDeleted: Bool = false) throws -> Book {
        func source(_ table: String) -> String { includingDeleted ? table : "live_\(table)" }

        let accountGroups = try readAccountGroups(from: source("account_groups"))
        let accounts = try readAccounts(from: source("accounts"))
        let categories = try readCategories(from: source("categories"))
        let payees = try readPayees(from: source("payees"))
        let tags = try readTags(from: source("tags"))
        let importBatches = try readImportBatches(from: source("import_batches"))
        let budgets = try readBudgets(from: source("budgets"))
        let fxRates = try readFxRates(from: source("fx_rates"))
        let transactions = try readTransactions(from: source("transactions"))
        let settings = try readSettings()

        return Book(
            accounts: accounts,
            accountGroups: accountGroups,
            transactions: transactions,
            categories: categories,
            payees: payees,
            tags: tags,
            budgets: budgets,
            fxRates: fxRates,
            importBatches: importBatches,
            settings: settings,
            // Resolved exactly as BackupImporter resolves it: an empty
            // baseCurrency counts as unstated (the TypeScript's `||`, where ""
            // is falsy), not as a value. A total in an unnamed currency is not
            // a number.
            baseCurrency: (settings?.baseCurrency).flatMap { $0.isEmpty ? nil : $0 }
                ?? BackupImporter.fallbackBaseCurrency
        )
    }

    func readAccountGroups(from table: String) throws -> [AccountGroup] {
        let statement = try connection.prepare(
            "SELECT id, name, sort_order FROM \(table) ORDER BY id"
        )
        defer { statement.finalize() }
        var rows: [AccountGroup] = []
        while try statement.step() {
            rows.append(
                AccountGroup(
                    id: try statement.text(0),
                    name: try statement.text(1),
                    sortOrder: try statement.int(2)
                )
            )
        }
        return rows
    }

    func readAccounts(from table: String) throws -> [Account] {
        let statement = try connection.prepare(
            """
            SELECT id, name, type, currency, opening_balance_minor, colour, group_id, sort_order,
                   archived, exclude_from_net_worth, loan_principal_minor, loan_rate_pct,
                   loan_term_months
            FROM \(table) ORDER BY id
            """
        )
        defer { statement.finalize() }
        var rows: [Account] = []
        while try statement.step() {
            let id = try statement.text(0)
            rows.append(
                Account(
                    id: id,
                    name: try statement.text(1),
                    type: try Self.enumeration(
                        try statement.text(2), AccountType.self, "accounts[\(id)].type"
                    ),
                    currency: try statement.text(3),
                    // MONEY: the accessor that refuses anything but an integer.
                    openingBalanceMinor: try statement.minorUnits(4),
                    colour: try statement.text(5),
                    groupId: try statement.optionalText(6),
                    sortOrder: try statement.int(7),
                    archived: try statement.flag(8),
                    excludeFromNetWorth: try statement.optionalFlag(9),
                    loanPrincipalMinor: try statement.optionalMinorUnits(10),
                    loanRatePct: try statement.optionalReal(11),
                    loanTermMonths: try statement.optionalInt(12)
                )
            )
        }
        return rows
    }

    func readCategories(from table: String) throws -> [Category] {
        let statement = try connection.prepare(
            "SELECT id, name, parent_id, kind, icon, colour, archived, sort_order "
                + "FROM \(table) ORDER BY id"
        )
        defer { statement.finalize() }
        var rows: [Category] = []
        while try statement.step() {
            let id = try statement.text(0)
            rows.append(
                Category(
                    id: id,
                    name: try statement.text(1),
                    parentId: try statement.optionalText(2),
                    kind: try Self.enumeration(
                        try statement.text(3), CategoryKind.self, "categories[\(id)].kind"
                    ),
                    icon: try statement.optionalText(4),
                    colour: try statement.optionalText(5),
                    archived: try statement.flag(6),
                    sortOrder: try statement.int(7)
                )
            )
        }
        return rows
    }

    func readPayees(from table: String) throws -> [Payee] {
        let statement = try connection.prepare(
            "SELECT id, name, name_lower, default_category_id FROM \(table) ORDER BY id"
        )
        defer { statement.finalize() }
        var rows: [Payee] = []
        while try statement.step() {
            rows.append(
                Payee(
                    id: try statement.text(0),
                    name: try statement.text(1),
                    // Passed EXPLICITLY rather than letting Payee default it
                    // from the name: `nameLower` is stored data, and a row
                    // whose lowercase form was computed by another build's
                    // locale rules must come back as it went in.
                    nameLower: try statement.text(2),
                    defaultCategoryId: try statement.optionalText(3)
                )
            )
        }
        return rows
    }

    func readTags(from table: String) throws -> [Tag] {
        let statement = try connection.prepare(
            "SELECT id, name, name_lower FROM \(table) ORDER BY id"
        )
        defer { statement.finalize() }
        var rows: [Tag] = []
        while try statement.step() {
            rows.append(
                Tag(
                    id: try statement.text(0),
                    name: try statement.text(1),
                    nameLower: try statement.text(2)
                )
            )
        }
        return rows
    }

    private func readImportBatches(from table: String) throws -> [ImportBatch] {
        let statement = try connection.prepare(
            """
            SELECT id, source, file_name, row_count, imported_at, created_account_ids,
                   created_category_ids, created_payee_ids, created_tag_ids, created_group_ids,
                   created_budget_ids, created_fx_rate_ids
            FROM \(table) ORDER BY id
            """
        )
        defer { statement.finalize() }
        var rows: [ImportBatch] = []
        while try statement.step() {
            let id = try statement.text(0)
            func list(_ index: Int32, _ name: String) throws -> [String] {
                try Self.idsFromJSON(try statement.text(index), context: "import_batches[\(id)].\(name)")
            }
            func optionalList(_ index: Int32, _ name: String) throws -> [String]? {
                guard let text = try statement.optionalText(index) else { return nil }
                return try Self.idsFromJSON(text, context: "import_batches[\(id)].\(name)")
            }
            rows.append(
                ImportBatch(
                    id: id,
                    source: try Self.enumeration(
                        try statement.text(1), ImportSource.self, "import_batches[\(id)].source"
                    ),
                    fileName: try statement.text(2),
                    rowCount: try statement.int(3),
                    importedAt: try statement.text(4),
                    createdAccountIds: try list(5, "createdAccountIds"),
                    createdCategoryIds: try list(6, "createdCategoryIds"),
                    createdPayeeIds: try list(7, "createdPayeeIds"),
                    createdTagIds: try list(8, "createdTagIds"),
                    createdGroupIds: try list(9, "createdGroupIds"),
                    // NULL stays nil: absent and empty are different claims.
                    createdBudgetIds: try optionalList(10, "createdBudgetIds"),
                    createdFxRateIds: try optionalList(11, "createdFxRateIds")
                )
            )
        }
        return rows
    }

    // Internal, not private: the budgets editor reads the live view through
    // this so there is exactly one place that turns budget rows -- and their
    // separately stored category links -- back into a `Budget`.
    func readBudgets(from table: String) throws -> [Budget] {
        // The category lists first, in one pass, ordered by position. A query
        // per budget would be correct and would also be a query per budget.
        var categoryIds: [String: [String]] = [:]
        let links = try connection.prepare(
            "SELECT budget_id, category_id FROM budget_categories ORDER BY budget_id, position"
        )
        defer { links.finalize() }
        while try links.step() {
            categoryIds[try links.text(0), default: []].append(try links.text(1))
        }

        let statement = try connection.prepare(
            "SELECT id, name, amount_minor, period, start_date, rollover, archived "
                + "FROM \(table) ORDER BY id"
        )
        defer { statement.finalize() }
        var rows: [Budget] = []
        while try statement.step() {
            let id = try statement.text(0)
            rows.append(
                Budget(
                    id: id,
                    name: try statement.text(1),
                    categoryIds: categoryIds[id] ?? [],
                    amountMinor: try statement.minorUnits(2),  // MONEY
                    period: try Self.enumeration(
                        try statement.text(3), BudgetPeriod.self, "budgets[\(id)].period"
                    ),
                    startDate: try statement.text(4),
                    rollover: try statement.flag(5),
                    archived: try statement.flag(6)
                )
            )
        }
        return rows
    }

    func readFxRates(from table: String) throws -> [FxRate] {
        let statement = try connection.prepare(
            "SELECT id, base, quote, rate, as_of, source FROM \(table) ORDER BY id"
        )
        defer { statement.finalize() }
        var rows: [FxRate] = []
        while try statement.step() {
            let id = try statement.text(0)
            rows.append(
                FxRate(
                    // The stored id, not a recomputed "base:quote". They agree
                    // in every file the app has written, and if some file ever
                    // disagrees the store must hand back what it was given.
                    id: id,
                    base: try statement.text(1),
                    quote: try statement.text(2),
                    rate: try statement.real(3),
                    asOf: try statement.text(4),
                    source: try Self.enumeration(
                        try statement.text(5), FxRateSource.self, "fx_rates[\(id)].source"
                    )
                )
            )
        }
        return rows
    }

    private func readTransactions(from table: String) throws -> [Transaction] {
        // Splits and tags in one pass each, ordered by position, because ORDER
        // IS DATA -- see the file comment. Grouped in memory rather than joined,
        // so a transaction with no splits needs no outer join and a
        // transaction with three splits is not three transaction rows to
        // de-duplicate.
        var splits: [String: [Split]] = [:]
        let splitRows = try connection.prepare(
            "SELECT transaction_id, category_id, amount_minor, notes "
                + "FROM transaction_splits ORDER BY transaction_id, position"
        )
        defer { splitRows.finalize() }
        while try splitRows.step() {
            splits[try splitRows.text(0), default: []].append(
                Split(
                    categoryId: try splitRows.optionalText(1),
                    amountMinor: try splitRows.minorUnits(2),  // MONEY
                    notes: try splitRows.optionalText(3)
                )
            )
        }

        var tagIds: [String: [String]] = [:]
        let tagRows = try connection.prepare(
            "SELECT transaction_id, tag_id FROM transaction_tags ORDER BY transaction_id, position"
        )
        defer { tagRows.finalize() }
        while try tagRows.step() {
            tagIds[try tagRows.text(0), default: []].append(try tagRows.text(1))
        }

        let statement = try connection.prepare(
            """
            SELECT id, account_id, date, amount_minor, currency, payee_id, category_id, notes,
                   status, transfer_group_id, import_batch_id, dedupe_hash, created_at, updated_at
            FROM \(table) ORDER BY id
            """
        )
        defer { statement.finalize() }
        var rows: [Transaction] = []
        while try statement.step() {
            let id = try statement.text(0)
            rows.append(
                Transaction(
                    id: id,
                    accountId: try statement.text(1),
                    date: try statement.text(2),
                    amountMinor: try statement.minorUnits(3),  // MONEY
                    currency: try statement.text(4),
                    payeeId: try statement.optionalText(5),
                    categoryId: try statement.optionalText(6),
                    tagIds: tagIds[id] ?? [],
                    notes: try statement.text(7),
                    status: try Self.enumeration(
                        try statement.text(8), TxStatus.self, "transactions[\(id)].status"
                    ),
                    splits: splits[id] ?? [],
                    transferGroupId: try statement.optionalText(9),
                    importBatchId: try statement.optionalText(10),
                    dedupeHash: try statement.text(11),
                    createdAt: try statement.text(12),
                    updatedAt: try statement.text(13)
                )
            )
        }
        return rows
    }

    /// The settings record, decoded from `row_json` through the very decoder a
    /// backup file goes through. One path from bytes to record, so the store
    /// cannot disagree with the file about what a settings row means.
    func readSettings() throws -> Settings? {
        let statement = try connection.prepare("SELECT row_json FROM settings WHERE id = 'app'")
        defer { statement.finalize() }
        guard try statement.step() else { return nil }
        let text = try statement.text(0)
        guard let parsed = try? JSONParser.parse(text) else {
            throw StoreError.corrupt("settings.row_json is not valid JSON")
        }
        do {
            return try Settings(row: RowReader(parsed, context: "settings"), value: parsed)
        } catch let error as RecordDecodeError {
            throw StoreError.corrupt("settings.row_json: \(error.description)")
        }
    }

    // MARK: - Enumerations

    /// A stored string back into its enum, naming the row when it is not one.
    ///
    /// Unreachable through this package's own writers -- the CHECK constraints
    /// in StoreSchema list the same cases, and every record was validated by
    /// the backup decoder before it was written. It throws rather than
    /// defaulting because the alternative is a store edited by another tool
    /// silently becoming a book where every unknown account type is "current".
    static func enumeration<T: RawRepresentable & CaseIterable>(
        _ raw: String, _ type: T.Type, _ context: String
    ) throws -> T where T.RawValue == String {
        guard let value = T(rawValue: raw) else {
            let known = T.allCases.map { "\"\($0.rawValue)\"" }.joined(separator: ", ")
            throw StoreError.corrupt("\(context) is \"\(raw)\", which is not one of \(known)")
        }
        return value
    }
}
