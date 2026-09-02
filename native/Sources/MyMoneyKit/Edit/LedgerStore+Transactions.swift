// Adding, changing, removing and un-removing a transaction.
//
// ─────────────────────────────────────────────────────────────────────────────
// FOUR RULES, AND EVERY LINE BELOW IS ONE OF THEM
//
//  1. ALL OR NOTHING. Every public function here opens ONE SQLite transaction
//     and does everything inside it: the validation reads, the payee that had
//     to be created, the tag rows, the splits, the transaction itself, the
//     payee's re-learned category, the last-used-account setting, and the
//     divergence counter. A refusal thrown anywhere in there rolls back all of
//     it -- which is what lets `EditError.unchanged` say "nothing was saved"
//     as a fact rather than as an intention.
//
//     THE VALIDATION READS ARE INSIDE THE TRANSACTION TOO, not before it. That
//     is not fussiness: "does this account exist" answered outside the write is
//     an answer about a moment that has passed.
//
//  2. NOTHING IS EVER DESTROYED. There is no DELETE of a transaction row in
//     this file. Deleting stamps `deleted_at`; the row, its amount, its splits
//     and its tags all stay exactly where they were, which is why undo can be
//     exact rather than a reconstruction. StoreSchema.swift carries the finding
//     that bought this rule.
//
//  3. THE CURRENCY BELONGS TO THE ACCOUNT. It is read from the account row on
//     every save and never taken from the draft, because a transaction whose
//     currency disagrees with its account's is a number that means something
//     other than what it says.
//
//  4. A TRANSFER IS EDITED AS A PAIR. `saveTransaction` REFUSES a transfer leg
//     and says where to go instead; `saveTransfer` writes both legs together.
//     One leg written alone is how a transfer stops cancelling out and quietly
//     invents or destroys money.
import Foundation

/// What a delete took away, and everything undo needs to put it back.
///
/// A RECEIPT, NOT A COPY. It names the rows that were tombstoned by THIS call
/// -- and only those, so a transfer whose other leg was already in the bin from
/// an earlier delete is not resurrected by undoing this one. The data itself is
/// still in the database; there is nothing here to restore FROM.
public struct DeletedTransactions: Sendable, Hashable {
    public let ids: [String]
    /// The stamp written on those rows. `undoDelete` will not touch a row
    /// carrying a different one.
    public let deletedAt: String
    public let isTransfer: Bool
    /// What the row was called, by the register's own naming rule, so an undo
    /// prompt can say which transaction it is offering back.
    public let title: String
    public let amountMinor: Int64
    public let currency: String

    public var count: Int { ids.count }
}

/// Both legs of a transfer, as one thing.
public struct TransferPair: Sendable, Hashable {
    /// The leg money left: a NEGATIVE amount, in the from-account's currency.
    public let from: Transaction
    /// The leg money arrived in: a POSITIVE amount, in the to-account's
    /// currency.
    public let to: Transaction

    public var transferGroupId: String? { from.transferGroupId }
    /// True when the two legs are in different currencies, so a UI can show
    /// both figures rather than one.
    public var isCrossCurrency: Bool { from.currency != to.currency }
}

extension LedgerStore {

    // MARK: - Save

    /// Create or update one ordinary (non-transfer) transaction.
    @discardableResult
    public func saveTransaction(_ draft: TransactionDraft) throws -> Transaction {
        try connection.transaction {
            // Cheap, pure and first, so a mistyped date is refused before
            // anything has been looked up.
            guard CalendarDate(iso: draft.date) != nil else {
                throw EditError.badDate(draft.date)
            }

            guard let account = try liveAccount(id: draft.accountId) else {
                throw EditError.unknownAccount(draft.accountId)
            }

            var existing: Transaction? = nil
            if let id = draft.id {
                guard let found = try transaction(id: id) else {
                    throw EditError.unknownTransaction(id)
                }
                if let group = found.transferGroupId {
                    // Name the OTHER account in the refusal, so the sentence
                    // tells the owner what this row is rather than only what it
                    // is not.
                    let other = try transferLegs(inGroup: group)
                        .first { $0.id != found.id }
                        .flatMap { try liveAccount(id: $0.accountId)?.name }
                    throw EditError.transactionIsTransferLeg(otherAccountName: other)
                }
                existing = found
            }

            // The currency comes from the ACCOUNT (rule 3), and the split check
            // is stated in it, so the refusal reads as money.
            let currency = account.currency
            let tally = SplitTally.of(
                amountMinor: draft.amountMinor, splits: draft.splits, currency: currency
            )
            if let refusal = tally.refusal { throw refusal }

            if let categoryId = draft.categoryId {
                guard try liveRowExists("categories", id: categoryId) else {
                    throw EditError.unknownCategory(categoryId)
                }
            }
            for split in draft.splits {
                guard let categoryId = split.categoryId else { continue }
                guard try liveRowExists("categories", id: categoryId) else {
                    throw EditError.unknownCategory(categoryId)
                }
            }

            let payee = try getOrCreatePayee(named: draft.payeeName)
            let tags = try getOrCreateTags(named: draft.tagNames)
            let notes = draft.notes
            // The hash's fourth field: the payee name when there is one, else
            // the notes. The same rule the importer follows, so a transaction
            // typed by hand and the same transaction arriving in a CSV collide
            // instead of doubling.
            let hashSource = payee?.name ?? notes
            let now = environment.now()

            let saved = Transaction(
                id: existing?.id ?? environment.newId(),
                accountId: draft.accountId,
                date: draft.date,
                amountMinor: draft.amountMinor,
                currency: currency,
                payeeId: payee?.id,
                categoryId: draft.categoryId,
                tagIds: tags.map(\.id),
                notes: notes,
                status: draft.status,
                splits: draft.splits,
                transferGroupId: nil,
                // Provenance is not the form's to change. A transaction that
                // arrived in an import stays part of that import batch after
                // it is edited, so undoing the import still finds it.
                importBatchId: existing?.importBatchId,
                dedupeHash: Dedupe.makeDedupeHash(
                    accountId: draft.accountId, date: draft.date,
                    amountMinor: draft.amountMinor, payeeOrDescription: hashSource
                ),
                createdAt: existing?.createdAt ?? now,
                updatedAt: now
            )
            try upsertTransactionRow(saved, isNew: existing == nil)

            // Learning happens AFTER the write, so the transaction just saved
            // is one of the ones counted (D17).
            if let payee { try learnPayeeCategory(payeeId: payee.id) }
            // ...and for the payee it just moved AWAY from, or that category
            // would keep a vote from a transaction that no longer casts one.
            if let previous = existing?.payeeId, previous != payee?.id {
                try learnPayeeCategory(payeeId: previous)
            }

            try setLastUsedAccount(draft.accountId)
            try recordLocalEdit(at: now)
            return saved
        }
    }

    // MARK: - Delete and undo

    /// Tombstone a transaction. A transfer leg takes its partner with it,
    /// because half a transfer is money that appears to have vanished.
    @discardableResult
    public func deleteTransaction(id: String) throws -> DeletedTransactions {
        try connection.transaction { () throws -> DeletedTransactions in
            guard let target = try transaction(id: id) else {
                throw EditError.unknownTransaction(id)
            }
            let now = environment.now()
            let isTransfer = target.transferGroupId != nil

            // Both legs, or the one row. A transfer with only one leg left in
            // the book is money that appears to have vanished from one account
            // and arrived from nowhere in another.
            var toDelete: [String] = [target.id]
            if let group = target.transferGroupId {
                toDelete = try transferLegs(inGroup: group).map(\.id)
            }
            var ids: [String] = []
            for legId in toDelete {
                let stamped: Bool = try softDelete(table: "transactions", id: legId, at: now)
                if stamped { ids.append(legId) }
            }

            // The payee has one fewer transaction, so its learned category may
            // have changed.
            if let payeeId = target.payeeId { try learnPayeeCategory(payeeId: payeeId) }

            var name: String? = nil
            if let payeeId = target.payeeId { name = try payeeName(id: payeeId) }
            let title = Register.title(
                payeeName: name, notes: target.notes, isTransfer: isTransfer
            )
            // ONE change, whatever it touched: deleting a transfer is one thing
            // the owner did, not two.
            try recordLocalEdit(at: now)
            return DeletedTransactions(
                ids: ids,
                deletedAt: now,
                isTransfer: isTransfer,
                title: title.text,
                amountMinor: target.amountMinor,
                currency: target.currency
            )
        }
    }

    /// Put back exactly what that delete took.
    ///
    /// EXACT, not reconstructed: the rows never left, so this clears a stamp
    /// and the amount, splits, tags, notes, dates and ids are the ones that
    /// were there. It refuses a receipt whose rows are no longer in the state
    /// it left them in -- a row deleted again since, or restored already --
    /// rather than half-restoring and reporting success.
    @discardableResult
    public func undoDelete(_ receipt: DeletedTransactions) throws -> Int {
        try connection.transaction {
            var restored: [String] = []
            for id in receipt.ids {
                // The stamp is checked, so undo cannot resurrect a row that was
                // deleted again by a later, different action.
                let statement = try connection.prepare(
                    "UPDATE transactions SET deleted_at = NULL WHERE id = ? AND deleted_at = ?"
                )
                defer { statement.finalize() }
                statement.bind(1, text: id)
                statement.bind(2, text: receipt.deletedAt)
                try statement.run()
                if try changedRows() > 0 { restored.append(id) }
            }
            guard !restored.isEmpty else {
                throw EditError.nothingToRestore(what: "transaction")
            }
            for id in restored {
                if let payeeId = try transaction(id: id)?.payeeId {
                    try learnPayeeCategory(payeeId: payeeId)
                }
            }
            try recordLocalEdit(at: environment.now())
            return restored.count
        }
    }

    // MARK: - Transfers

    /// Create or update a transfer -- BOTH legs, in one transaction.
    @discardableResult
    public func saveTransfer(_ draft: TransferDraft) throws -> TransferPair {
        try connection.transaction {
            guard CalendarDate(iso: draft.date) != nil else {
                throw EditError.badDate(draft.date)
            }
            guard draft.fromAccountId != draft.toAccountId else {
                throw EditError.transferNeedsTwoAccounts
            }
            guard let fromAccount = try liveAccount(id: draft.fromAccountId) else {
                throw EditError.unknownAccount(draft.fromAccountId)
            }
            guard let toAccount = try liveAccount(id: draft.toAccountId) else {
                throw EditError.unknownAccount(draft.toAccountId)
            }
            guard draft.amountFromMinor > 0 else {
                throw EditError.transferAmountNotPositive(
                    side: .sent, amountMinor: draft.amountFromMinor,
                    currency: fromAccount.currency
                )
            }
            guard draft.amountToMinor > 0 else {
                throw EditError.transferAmountNotPositive(
                    side: .received, amountMinor: draft.amountToMinor,
                    currency: toAccount.currency
                )
            }

            var fromExisting: Transaction? = nil
            var toExisting: Transaction? = nil
            let groupId: String
            if let existingGroup = draft.transferGroupId {
                let legs = try transferLegs(inGroup: existingGroup)
                guard legs.count == 2 else {
                    throw EditError.transferNotFound(groupId: existingGroup, legs: legs.count)
                }
                // Identified by SIGN, not by position: which row is "the from
                // leg" is a fact about the money, and a pair that cannot say
                // which is which is a pair no edit can safely be applied to.
                fromExisting = legs.first { $0.amountMinor < 0 }
                toExisting = legs.first { $0.amountMinor > 0 }
                guard fromExisting != nil, toExisting != nil else {
                    throw EditError.transferLegsInconsistent(groupId: existingGroup)
                }
                groupId = existingGroup
            } else {
                groupId = environment.newId()
            }

            let now = environment.now()
            let fromLeg = Transaction(
                id: fromExisting?.id ?? environment.newId(),
                accountId: draft.fromAccountId,
                date: draft.date,
                // The sign is put on HERE, from the leg's role. The draft
                // carries magnitudes precisely so a form cannot get this wrong.
                amountMinor: -draft.amountFromMinor,
                currency: fromAccount.currency,
                payeeId: nil,
                categoryId: nil,
                tagIds: [],
                notes: draft.notes,
                status: draft.status,
                splits: [],
                transferGroupId: groupId,
                importBatchId: fromExisting?.importBatchId,
                dedupeHash: Dedupe.makeDedupeHash(
                    accountId: draft.fromAccountId, date: draft.date,
                    amountMinor: -draft.amountFromMinor,
                    payeeOrDescription: "Transfer to \(toAccount.name)"
                ),
                createdAt: fromExisting?.createdAt ?? now,
                updatedAt: now
            )
            let toLeg = Transaction(
                id: toExisting?.id ?? environment.newId(),
                accountId: draft.toAccountId,
                date: draft.date,
                amountMinor: draft.amountToMinor,
                currency: toAccount.currency,
                payeeId: nil,
                categoryId: nil,
                tagIds: [],
                notes: draft.notes,
                status: draft.status,
                splits: [],
                transferGroupId: groupId,
                importBatchId: toExisting?.importBatchId,
                dedupeHash: Dedupe.makeDedupeHash(
                    accountId: draft.toAccountId, date: draft.date,
                    amountMinor: draft.amountToMinor,
                    payeeOrDescription: "Transfer from \(fromAccount.name)"
                ),
                createdAt: toExisting?.createdAt ?? now,
                updatedAt: now
            )

            try upsertTransactionRow(fromLeg, isNew: fromExisting == nil)
            try upsertTransactionRow(toLeg, isNew: toExisting == nil)

            // An ordinary transaction becoming a transfer leg would leave its
            // old payee holding a vote it no longer casts.
            for previous in [fromExisting?.payeeId, toExisting?.payeeId].compactMap({ $0 }) {
                try learnPayeeCategory(payeeId: previous)
            }

            try setLastUsedAccount(draft.fromAccountId)
            try recordLocalEdit(at: now)
            return TransferPair(from: fromLeg, to: toLeg)
        }
    }

    /// Both legs of a transfer, or nil when this group is not a well-formed
    /// pair. Nil rather than a throw: a caller asking "is this a transfer I can
    /// open?" is asking a question, not making a request.
    public func transferPair(groupId: String) throws -> TransferPair? {
        let legs = try transferLegs(inGroup: groupId)
        guard legs.count == 2,
            let from = legs.first(where: { $0.amountMinor < 0 }),
            let to = legs.first(where: { $0.amountMinor > 0 })
        else { return nil }
        return TransferPair(from: from, to: to)
    }

    /// The editor's starting point, opened from EITHER leg. This is what makes
    /// "editing either side" true: whichever row was tapped, the same one draft
    /// comes back, and saving it writes both.
    public func transferDraft(forLegId id: String) throws -> TransferDraft? {
        guard let leg = try transaction(id: id), let group = leg.transferGroupId,
            let pair = try transferPair(groupId: group)
        else { return nil }
        return TransferDraft(
            transferGroupId: group,
            fromAccountId: pair.from.accountId,
            toAccountId: pair.to.accountId,
            date: pair.from.date,
            amountFromMinor: -pair.from.amountMinor,
            amountToMinor: pair.to.amountMinor,
            notes: pair.from.notes,
            status: pair.from.status
        )
    }

    /// The live legs of one transfer group, oldest id first for determinism.
    func transferLegs(inGroup groupId: String) throws -> [Transaction] {
        let statement = try connection.prepare(
            "SELECT id FROM live_transactions WHERE transfer_group_id = ? ORDER BY id"
        )
        defer { statement.finalize() }
        statement.bind(1, text: groupId)
        var ids: [String] = []
        while try statement.step() { ids.append(try statement.text(0)) }
        return try ids.compactMap { try transaction(id: $0) }
    }

    // MARK: - Opening the editor

    /// An existing transaction as a form holds it: ids resolved back into the
    /// names a person typed.
    ///
    /// Returns nil for a transfer leg -- use `transferDraft(forLegId:)`, which
    /// is the door that leads somewhere it is safe to save from.
    public func transactionDraft(forId id: String) throws -> TransactionDraft? {
        guard let tx = try transaction(id: id), tx.transferGroupId == nil else { return nil }
        return TransactionDraft(
            id: tx.id,
            accountId: tx.accountId,
            date: tx.date,
            amountMinor: tx.amountMinor,
            payeeName: try tx.payeeId.flatMap { try payeeName(id: $0) } ?? "",
            categoryId: tx.categoryId,
            tagNames: try tagNames(ids: tx.tagIds),
            notes: tx.notes,
            status: tx.status,
            splits: tx.splits
        )
    }

    func payeeName(id: String) throws -> String? {
        let statement = try connection.prepare("SELECT name FROM live_payees WHERE id = ?")
        defer { statement.finalize() }
        statement.bind(1, text: id)
        guard try statement.step() else { return nil }
        return try statement.text(0)
    }

    func tagNames(ids: [String]) throws -> [String] {
        guard !ids.isEmpty else { return [] }
        var byId: [String: String] = [:]
        let statement = try connection.prepare("SELECT id, name FROM live_tags")
        defer { statement.finalize() }
        while try statement.step() { byId[try statement.text(0)] = try statement.text(1) }
        // Order preserved from the transaction: a tag list is an array, and its
        // order is data.
        return ids.compactMap { byId[$0] }
    }

    // MARK: - The row writer

    /// INSERT a new transaction or UPDATE an existing live one, then replace
    /// its splits and tags wholesale.
    ///
    /// REPLACED, NOT MERGED. Splits and tags are positional child rows and the
    /// draft states the whole list, so a diff would be more code with more ways
    /// to leave a stale row behind. The DELETE is scoped to the one
    /// transaction, and the whole thing is inside the caller's transaction.
    ///
    /// The UPDATE names `deleted_at IS NULL` so a save can never quietly
    /// resurrect a tombstoned row. Un-deleting is `undoDelete`'s job and is
    /// never a side effect of an edit.
    private func upsertTransactionRow(_ tx: Transaction, isNew: Bool) throws {
        if isNew {
            let insert = try connection.prepare(
                """
                INSERT INTO transactions (
                    id, account_id, date, amount_minor, currency, payee_id, category_id, notes,
                    status, transfer_group_id, import_batch_id, dedupe_hash, created_at,
                    updated_at, deleted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """
            )
            defer { insert.finalize() }
            bindTransaction(tx, to: insert)
            try insert.run()
        } else {
            let update = try connection.prepare(
                """
                UPDATE transactions SET
                    account_id = ?2, date = ?3, amount_minor = ?4, currency = ?5, payee_id = ?6,
                    category_id = ?7, notes = ?8, status = ?9, transfer_group_id = ?10,
                    import_batch_id = ?11, dedupe_hash = ?12, created_at = ?13, updated_at = ?14
                WHERE id = ?1 AND deleted_at IS NULL
                """
            )
            defer { update.finalize() }
            bindTransaction(tx, to: update)
            try update.run()
            guard try changedRows() > 0 else {
                throw EditError.unknownTransaction(tx.id)
            }
        }

        let clearSplits = try connection.prepare(
            "DELETE FROM transaction_splits WHERE transaction_id = ?"
        )
        defer { clearSplits.finalize() }
        clearSplits.bind(1, text: tx.id)
        try clearSplits.run()

        let clearTags = try connection.prepare(
            "DELETE FROM transaction_tags WHERE transaction_id = ?"
        )
        defer { clearTags.finalize() }
        clearTags.bind(1, text: tx.id)
        try clearTags.run()

        if !tx.splits.isEmpty {
            let insert = try connection.prepare(
                "INSERT INTO transaction_splits "
                    + "(transaction_id, position, category_id, amount_minor, notes) "
                    + "VALUES (?, ?, ?, ?, ?)"
            )
            defer { insert.finalize() }
            for (position, split) in tx.splits.enumerated() {
                insert.bind(1, text: tx.id)
                insert.bind(2, integer: position)
                insert.bind(3, optionalText: split.categoryId)
                insert.bind(4, minorUnits: split.amountMinor)  // MONEY
                insert.bind(5, optionalText: split.notes)
                try insert.run()
            }
        }
        if !tx.tagIds.isEmpty {
            let insert = try connection.prepare(
                "INSERT INTO transaction_tags (transaction_id, position, tag_id) VALUES (?, ?, ?)"
            )
            defer { insert.finalize() }
            for (position, tagId) in tx.tagIds.enumerated() {
                insert.bind(1, text: tx.id)
                insert.bind(2, integer: position)
                insert.bind(3, text: tagId)
                try insert.run()
            }
        }
    }

    private func bindTransaction(_ tx: Transaction, to statement: SQLiteStatement) {
        statement.bind(1, text: tx.id)
        statement.bind(2, text: tx.accountId)
        statement.bind(3, text: tx.date)
        statement.bind(4, minorUnits: tx.amountMinor)  // MONEY: the Int64 binder
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
    }
}
