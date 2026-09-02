// The small reads and get-or-creates every mutation needs, in one place.
//
// EVERY FUNCTION HERE IS CALLED FROM INSIDE A TRANSACTION, and none of them
// opens one. That is why they are internal: a caller that ran `getOrCreatePayee`
// outside a transaction would create a payee and then, if the save it was part
// of failed, leave it behind -- a payee the owner never typed, in the
// autocomplete, for ever. The public mutations wrap them; nothing else may.
import Foundation
import SQLite3

extension LedgerStore {

    // MARK: - How many rows the last statement changed

    /// `sqlite3_changes` on this store's handle.
    ///
    /// Used as a POSTCONDITION rather than as information: an UPDATE that
    /// matched nothing is a row somebody else deleted between the check and the
    /// write, and a save that reports success having changed nothing is the
    /// worst outcome available to an app whose one job is not to lose an entry.
    /// It is throwing so that call sites read as `try changedRows()` alongside
    /// the statements they are checking.
    func changedRows() throws -> Int {
        try connection.checkUsable()
        return Int(sqlite3_changes(connection.handle))
    }

    // MARK: - Existence

    /// A live row's existence, without decoding it. `id` is bound, never
    /// interpolated; the TABLE name is checked against the schema's own list,
    /// because SQLite cannot bind one.
    func liveRowExists(_ table: String, id: String) throws -> Bool {
        guard StoreSchema.tombstonedTables.contains(table) else {
            throw StoreError.corrupt("\"\(table)\" has no live view")
        }
        let statement = try connection.prepare("SELECT 1 FROM live_\(table) WHERE id = ?")
        defer { statement.finalize() }
        statement.bind(1, text: id)
        return try statement.step()
    }

    /// One live account, decoded. nil when it is missing or tombstoned.
    func liveAccount(id: String) throws -> Account? {
        let statement = try connection.prepare(
            """
            SELECT id, name, type, currency, opening_balance_minor, colour, group_id, sort_order,
                   archived, exclude_from_net_worth, loan_principal_minor, loan_rate_pct,
                   loan_term_months
            FROM live_accounts WHERE id = ?
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: id)
        guard try statement.step() else { return nil }
        return Account(
            id: try statement.text(0),
            name: try statement.text(1),
            type: try Self.enumeration(try statement.text(2), AccountType.self, "accounts.type"),
            currency: try statement.text(3),
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
    }

    /// One live transaction, whole -- splits and tags included. The editor
    /// opens on this.
    public func transaction(id: String) throws -> Transaction? {
        let statement = try connection.prepare(
            """
            SELECT id, account_id, date, amount_minor, currency, payee_id, category_id, notes,
                   status, transfer_group_id, import_batch_id, dedupe_hash, created_at, updated_at
            FROM live_transactions WHERE id = ?
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: id)
        guard try statement.step() else { return nil }
        return Transaction(
            id: try statement.text(0),
            accountId: try statement.text(1),
            date: try statement.text(2),
            amountMinor: try statement.minorUnits(3),
            currency: try statement.text(4),
            payeeId: try statement.optionalText(5),
            categoryId: try statement.optionalText(6),
            tagIds: try tagIds(ofTransaction: id),
            notes: try statement.text(7),
            status: try Self.enumeration(try statement.text(8), TxStatus.self, "transactions.status"),
            splits: try splits(ofTransaction: id),
            transferGroupId: try statement.optionalText(9),
            importBatchId: try statement.optionalText(10),
            dedupeHash: try statement.text(11),
            createdAt: try statement.text(12),
            updatedAt: try statement.text(13)
        )
    }

    func splits(ofTransaction id: String) throws -> [Split] {
        let statement = try connection.prepare(
            "SELECT category_id, amount_minor, notes FROM transaction_splits "
                + "WHERE transaction_id = ? ORDER BY position"
        )
        defer { statement.finalize() }
        statement.bind(1, text: id)
        var out: [Split] = []
        while try statement.step() {
            out.append(
                Split(
                    categoryId: try statement.optionalText(0),
                    amountMinor: try statement.minorUnits(1),
                    notes: try statement.optionalText(2)
                )
            )
        }
        return out
    }

    func tagIds(ofTransaction id: String) throws -> [String] {
        let statement = try connection.prepare(
            "SELECT tag_id FROM transaction_tags WHERE transaction_id = ? ORDER BY position"
        )
        defer { statement.finalize() }
        statement.bind(1, text: id)
        var out: [String] = []
        while try statement.step() { out.append(try statement.text(0)) }
        return out
    }

    /// How many LIVE transactions an account holds. The figure a refusal quotes
    /// when it declines to delete the account or change its currency.
    func liveTransactionCount(accountId: String) throws -> Int {
        let statement = try connection.prepare(
            "SELECT count(*) FROM live_transactions WHERE account_id = ?"
        )
        defer { statement.finalize() }
        statement.bind(1, text: accountId)
        guard try statement.step() else { return 0 }
        return try statement.int(0)
    }

    func liveAccountCount(groupId: String) throws -> Int {
        let statement = try connection.prepare(
            "SELECT count(*) FROM live_accounts WHERE group_id = ?"
        )
        defer { statement.finalize() }
        statement.bind(1, text: groupId)
        guard try statement.step() else { return 0 }
        return try statement.int(0)
    }

    // MARK: - Payees

    /// The payee with this name, creating it when there is none.
    ///
    /// MATCHED CASE-INSENSITIVELY, on `name_lower`, which is the whole reason
    /// that column exists: "tesco", "Tesco" and " TESCO " typed on three
    /// different days are one payee, and a ledger where they are three is a
    /// ledger whose reports are wrong in a way nobody notices.
    ///
    /// The name is STORED as the owner typed it (cleaned of stray whitespace).
    /// The first spelling wins; a later different capitalisation reuses the
    /// existing row rather than renaming it, matching `getOrCreatePayee` in the
    /// web app. Renaming is a separate, deliberate act.
    func getOrCreatePayee(named raw: String) throws -> Payee? {
        let name = Names.clean(raw)
        guard !name.isEmpty else { return nil }
        let key = Names.key(name)

        let lookup = try connection.prepare(
            "SELECT id, name, name_lower, default_category_id FROM live_payees "
                + "WHERE name_lower = ? ORDER BY id LIMIT 1"
        )
        defer { lookup.finalize() }
        lookup.bind(1, text: key)
        if try lookup.step() {
            return Payee(
                id: try lookup.text(0),
                name: try lookup.text(1),
                nameLower: try lookup.text(2),
                defaultCategoryId: try lookup.optionalText(3)
            )
        }

        let payee = Payee(id: environment.newId(), name: name, nameLower: key, defaultCategoryId: nil)
        let insert = try connection.prepare(
            "INSERT INTO payees (id, name, name_lower, default_category_id, deleted_at) "
                + "VALUES (?, ?, ?, NULL, NULL)"
        )
        defer { insert.finalize() }
        insert.bind(1, text: payee.id)
        insert.bind(2, text: payee.name)
        insert.bind(3, text: payee.nameLower)
        try insert.run()
        return payee
    }

    /// Recompute a payee's learned default category (D17, SPEC 7.4).
    ///
    /// The most frequent category across this payee's live transactions. A
    /// SPLIT transaction contributes each of its split categories instead of
    /// its own -- that is what the LEFT JOIN below expresses, and it matters:
    /// a weekly supermarket shop split into Food and Household should teach
    /// both, not neither.
    ///
    /// TIES: most recent date wins, and after that the LOWEST CATEGORY ID.
    /// The web app leaves the final tie to Map insertion order, which for it is
    /// the order rows came out of IndexedDB. SQLite makes no such promise
    /// either, so an unbroken tie here would mean the same book could learn two
    /// different answers on two runs. The id is arbitrary but it is STABLE, and
    /// stable beats faithful when the thing being copied is itself undefined.
    func learnPayeeCategory(payeeId: String) throws {
        let statement = try connection.prepare(
            """
            SELECT t.date,
                   CASE WHEN s.transaction_id IS NULL THEN t.category_id ELSE s.category_id END
            FROM live_transactions t
            LEFT JOIN transaction_splits s ON s.transaction_id = t.id
            WHERE t.payee_id = ?
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: payeeId)

        struct Score { var count = 0; var latest = "" }
        var scores: [String: Score] = [:]
        while try statement.step() {
            let date = try statement.text(0)
            guard let categoryId = try statement.optionalText(1) else { continue }
            var score = scores[categoryId] ?? Score()
            score.count += 1
            if date > score.latest { score.latest = date }
            scores[categoryId] = score
        }

        var best: String? = nil
        var bestScore = Score()
        for (categoryId, score) in scores {
            let better: Bool
            if best == nil {
                better = true
            } else if score.count != bestScore.count {
                better = score.count > bestScore.count
            } else if score.latest != bestScore.latest {
                better = score.latest > bestScore.latest
            } else {
                better = categoryId < best!
            }
            if better {
                best = categoryId
                bestScore = score
            }
        }

        let update = try connection.prepare("UPDATE payees SET default_category_id = ? WHERE id = ?")
        defer { update.finalize() }
        update.bind(1, optionalText: best)
        update.bind(2, text: payeeId)
        try update.run()
    }

    // MARK: - Tags

    /// Look up or create each tag name. Blanks skipped, case-insensitive
    /// duplicates collapsed, order preserved -- because a transaction's tag
    /// order is DATA (it is an array in the backup file, and an array in a
    /// different order is a different file).
    func getOrCreateTags(named names: [String]) throws -> [Tag] {
        var out: [Tag] = []
        var seen = Set<String>()
        for raw in names {
            let name = Names.clean(raw)
            if name.isEmpty { continue }
            let key = Names.key(name)
            if seen.contains(key) { continue }
            seen.insert(key)

            let lookup = try connection.prepare(
                "SELECT id, name, name_lower FROM live_tags WHERE name_lower = ? ORDER BY id LIMIT 1"
            )
            defer { lookup.finalize() }
            lookup.bind(1, text: key)
            if try lookup.step() {
                out.append(
                    Tag(
                        id: try lookup.text(0), name: try lookup.text(1),
                        nameLower: try lookup.text(2)
                    )
                )
                continue
            }
            let tag = Tag(id: environment.newId(), name: name, nameLower: key)
            let insert = try connection.prepare(
                "INSERT INTO tags (id, name, name_lower, deleted_at) VALUES (?, ?, ?, NULL)"
            )
            defer { insert.finalize() }
            insert.bind(1, text: tag.id)
            insert.bind(2, text: tag.name)
            insert.bind(3, text: tag.nameLower)
            try insert.run()
            out.append(tag)
        }
        return out
    }

    // MARK: - Settings

    /// Remember which account was last written to, so Quick Add can default to
    /// it. Written through `BackupWriter.settingsRow`, the same function that
    /// writes this row into a backup file, so the device-local `sync*` keys this
    /// package does not model are carried through untouched rather than dropped.
    ///
    /// A store with no settings row does nothing here rather than inventing
    /// one: a settings row this app fabricated would claim a schema version, a
    /// base currency and a creation date it has no business deciding.
    func setLastUsedAccount(_ accountId: String?) throws {
        guard let settings = try readSettings() else { return }
        if settings.lastUsedAccountId == accountId { return }
        let updated = Settings(
            id: settings.id,
            schemaVersion: settings.schemaVersion,
            baseCurrency: settings.baseCurrency,
            theme: settings.theme,
            lastBackupAt: settings.lastBackupAt,
            onboarded: settings.onboarded,
            lastUsedAccountId: accountId,
            savedMappings: settings.savedMappings,
            createdAt: settings.createdAt,
            autoFxEnabled: settings.autoFxEnabled,
            lastFxSyncAt: settings.lastFxSyncAt,
            lastFxSyncSource: settings.lastFxSyncSource,
            raw: settings.raw
        )
        let row = BackupWriter.settingsRow(updated)
        let statement = try connection.prepare(
            "UPDATE settings SET last_used_account_id = ?, row_json = ? WHERE id = ?"
        )
        defer { statement.finalize() }
        statement.bind(1, optionalText: accountId)
        statement.bind(2, text: CanonicalJSON.text(row, indent: 0))
        statement.bind(3, text: settings.id)
        try statement.run()
    }

    // MARK: - Sort orders

    /// One past the highest `sort_order` among LIVE rows of a table -- where a
    /// newly created row goes. Tombstoned rows are ignored: a restored row
    /// keeps its own order, and a deleted one should not push new rows down the
    /// list for ever.
    func nextSortOrder(_ table: String) throws -> Int {
        guard StoreSchema.tombstonedTables.contains(table) else {
            throw StoreError.corrupt("\"\(table)\" has no live view")
        }
        let value = try connection.scalarInt(
            "SELECT coalesce(max(sort_order), -1) + 1 FROM live_\(table)"
        )
        return Int(value ?? 0)
    }
}
