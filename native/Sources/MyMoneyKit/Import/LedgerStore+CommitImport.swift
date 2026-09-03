// Writing an import plan into the book, and taking the whole of it back out
// again.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE WRITES MONEY. It is the only thing in this package that turns a
// file somebody was sent into transactions in the owner's ledger, and every
// mistake available to it is a silent one: a wrong scale, a wrong currency, a
// row written twice, a row not written at all. So the rules below are not
// stylistic, and none of them is optional.
//
//  1. ONE TRANSACTION. Everything -- the accounts created, the categories, the
//     payees, the tags, every row, the batch, the money audit and the
//     divergence count -- happens inside one `BEGIN IMMEDIATE`. A failure
//     anywhere rolls back all of it, so "nothing was imported" is a FACT the
//     refusal states rather than an intention it expresses.
//
//  2. IT ADDS. IT NEVER REPLACES. `importBackup` restores a backup and
//     REPLACES the whole book; this brings rows INTO a book that stays where it
//     is. The two are a single line apart in a diff and a whole ledger apart in
//     effect, so the difference is enforced rather than documented: this path
//     takes an `ImportPlan` (which cannot describe a book, only rows to add),
//     it has no "replacing" flag to pass, and it COUNTS EVERY TABLE before and
//     after itself. If one row was removed anywhere, or one row appeared that
//     the batch does not record, the whole import is rolled back
//     (`StoreError.importIsNotAdditive`). See `refuseUnlessAdditive`.
//
//  3. IT GOES THROUGH THE EDITORS' OWN WRITERS. `writeTransaction` and
//     `writeAccount` are the same functions the transaction editor and the
//     account editor call, with the same checks -- the currency is read off the
//     account, the splits must balance, the categories must exist. There is no
//     bulk path with its own idea of what a valid row is, because that second
//     idea is always the one that turns out to be wrong.
//
//  4. THE OWNER'S DIVERGENCE COUNT GOES UP BY ONE. An import is ONE act, not
//     three hundred and forty-eight of them. `recordLocalEdit` is called once,
//     at the end, inside the transaction.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE BUGS, AND WHERE EACH ONE IS STOPPED HERE
//
//   D30 -- A TRANSACTION IS STORED IN ITS ACCOUNT'S CURRENCY. Enforced
//   structurally: `writeTransaction` reads the currency off the account row and
//   this file has no way to hand it one. A row whose file declared something
//   else keeps its amount, is written in the account's currency, and says
//   "originally EUR" in its notes -- disclosed, never converted, because a
//   guessed rate is a made-up number (SPEC §6).
//
//   D31 -- SCALE IS RESOLVED AFTER THE ACCOUNT IS KNOWN. The plan did that. But
//   a plan is built against a SNAPSHOT of the book, and a snapshot can go stale
//   between the preview and the tap -- an account with no transactions in it
//   can have its currency changed. So the write CHECKS: every row carries the
//   currency it was resolved at (`ImportPlanRow.resolvedCurrency`), and if the
//   account no longer holds that currency the import is REFUSED
//   (`EditError.importPlanIsStale`). Writing a two-decimal figure into a
//   nought-decimal account is a hundredfold error that looks like a real
//   number, and nothing downstream can tell.
//
//   D32 -- A DUPLICATE MATCH IS CONSUMED. The plan did that too, and this file
//   keeps it TRUE ON THE WAY BACK IN: a row is written with the dedupe key
//   `payee-else-description`, which is the same key the plan matched with, so
//   re-importing the same file finds N existing rows for N incoming rows and
//   adds nothing. Get that key wrong and the second import doubles the book.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND UNDO. An import writes down what it created -- accounts, categories,
// payees, tags, and its transactions by `import_batch_id` -- so the whole thing
// can be taken back as a unit. Undo REMOVES WHAT THE IMPORT CREATED AND NOTHING
// ELSE:
//
//   * a category the owner has since filed something under is kept;
//   * an account they have since put a transaction in is kept;
//   * a payee or tag still in use is kept;
//   * and NOTHING IS RESURRECTED. Removing here is a tombstone save like every
//     other removal in this package, and `softDelete` only touches rows that
//     are still live -- so a transaction the owner deleted last week keeps the
//     day they deleted it, and undoing the import does not bring it back.
import Foundation

// MARK: - What a commit did

/// The receipt an import hands back: what landed, and everything the owner has
/// to be told about it.
///
/// A DIFFERENT TYPE FROM `StoreImportResult` on purpose. That one is what
/// RESTORING A BACKUP returns -- a whole book replaced, a content hash, a round
/// trip. This one is what ADDING ROWS returns, and the thing it carries that
/// the other cannot is a batch id: an import of rows can be undone, and a
/// restore cannot.
public struct ImportReceipt: Sendable, Hashable {
    /// The batch row, holding the id lists undo works from.
    public let batch: ImportBatch
    /// The transactions written, in FILE ORDER.
    public let transactionIds: [String]
    /// The transfer groups created, one per pair of legs that both landed.
    public let transferGroupIds: [String]

    // What was in the file, and what became of it. All four are needed to say
    // one honest sentence about an import; the counts a preview showed are not
    // the same claim, because the owner may have changed a decision since.
    public let rowsRead: Int
    /// Rows identical to something already in the book. Not written.
    public let duplicatesSkipped: Int
    /// Near-duplicates the owner left set to skip. Not written.
    public let decisionsSkipped: Int
    /// Rows that could not be read at all. Not written; each one is in the
    /// plan's `problems`, with its row number and the reason.
    public let unreadableRows: Int

    /// Rows that WERE written whose file declared a currency other than the
    /// account's. Stored in the account's currency and marked in the notes.
    public let currencyMismatchCount: Int
    /// Rows that WERE written which name another account in the file's transfer
    /// column but whose opposite leg was not written. Each is now an ordinary
    /// transaction, and reports read an uncategorised transaction BY SIGN -- so
    /// each is real income or real spending as far as every chart is concerned.
    public let unpairedTransferCount: Int

    public var batchId: String { batch.id }
    public var fileName: String { batch.fileName }
    /// Transactions written. The batch's own `rowCount`, which is the number of
    /// rows that LANDED and not the number the file held.
    public var transactionCount: Int { batch.rowCount }
    public var accountsCreated: Int { batch.createdAccountIds.count }
    public var categoriesCreated: Int { batch.createdCategoryIds.count }
    public var payeesCreated: Int { batch.createdPayeeIds.count }
    public var tagsCreated: Int { batch.createdTagIds.count }

    /// What happened, in the owner's words. The counts that are zero are left
    /// out, so the sentence is about this import rather than about the shape of
    /// this struct.
    public var summary: String {
        var parts = ["Added \(transactionCount) transaction\(transactionCount == 1 ? "" : "s")"]
        if accountsCreated > 0 {
            parts.append("\(accountsCreated) new account\(accountsCreated == 1 ? "" : "s")")
        }
        if duplicatesSkipped > 0 {
            parts.append("\(duplicatesSkipped) already in your book")
        }
        if decisionsSkipped > 0 {
            parts.append("\(decisionsSkipped) you chose to skip")
        }
        if unreadableRows > 0 {
            parts.append("\(unreadableRows) that could not be read")
        }
        return parts.joined(separator: ", ") + "."
    }
}

/// What undoing an import took back, and what it deliberately left alone.
public struct UndoneImport: Sendable, Hashable {
    public let batchId: String
    public let fileName: String
    /// The transactions removed. Tombstoned, not destroyed.
    public let transactionIds: [String]
    public let accountIds: [String]
    public let categoryIds: [String]
    public let payeeIds: [String]
    public let tagIds: [String]
    /// Things the import created that are STILL IN USE and were therefore kept:
    /// an account with a transaction in it, a category something is filed
    /// under, a payee or tag still on a live row. Named rather than counted, so
    /// a screen can say which.
    public let keptAccountIds: [String]
    public let keptCategoryIds: [String]
    public let undoneAt: String

    public var transactionCount: Int { transactionIds.count }

    public var summary: String {
        var parts = [
            "Removed \(transactionCount) transaction\(transactionCount == 1 ? "" : "s")"
        ]
        let kept = keptAccountIds.count + keptCategoryIds.count
        if kept > 0 {
            parts.append("kept \(kept) thing\(kept == 1 ? "" : "s") you have used since")
        }
        return parts.joined(separator: ", ") + "."
    }
}

/// A TEST SEAM, called after each stage of a commit with the stage's name and
/// how much of it has landed.
///
/// Deliberately not on the public API, for the reason `writeBook`'s equivalent
/// is not: a production caller that can interpose on a half-written import is a
/// production caller that can leave one behind.
typealias ImportCommitProbe = (_ step: String, _ done: Int) throws -> Void

extension LedgerStore {

    // MARK: - Commit

    /// Write an import plan into the book. ADDITIVE, ALL OR NOTHING, UNDOABLE.
    ///
    /// Rows the plan marked importable are written; duplicates, refused rows
    /// and near-duplicates the owner left set to skip are not. Accounts,
    /// categories, payees and tags the file needs are created and RECORDED on
    /// the batch, which is what makes `undoImport` able to remove exactly what
    /// this call added.
    ///
    /// Refuses -- having written nothing -- when:
    ///
    ///   * there is no book on this device (`EditError.noBook`);
    ///   * the plan would write nothing at all
    ///     (`EditError.importWouldWriteNothing`) -- including the case that
    ///     matters most, a re-import of a file already in the book;
    ///   * an account the plan resolved amounts against has changed currency
    ///     since (`EditError.importPlanIsStale`), or has been deleted
    ///     (`EditError.unknownAccount`);
    ///   * a category the plan chose has been deleted since
    ///     (`EditError.unknownCategory`);
    ///   * the money audit finds a stored amount that is not an integer
    ///     (`StoreError.moneyIsNotAnInteger`);
    ///   * or the write turned out not to be purely additive
    ///     (`StoreError.importIsNotAdditive`).
    @discardableResult
    public func commitImport(_ plan: ImportPlan) throws -> ImportReceipt {
        try commitImport(plan, probe: nil)
    }

    @discardableResult
    func commitImport(_ plan: ImportPlan, probe: ImportCommitProbe?) throws -> ImportReceipt {
        try connection.transaction {
            // ASKED INSIDE THE TRANSACTION, all of it. "Does this account
            // exist", answered before the write, is an answer about a moment
            // that has passed -- and this write is the one that must not be
            // wrong.
            guard try readSettings() != nil else { throw EditError.noBook }

            let importable = plan.rows.filter(\.isImportable)
            let accountsToCreate = plan.newAccounts.filter(\.create)
            guard !importable.isEmpty || !accountsToCreate.isEmpty else {
                throw EditError.importWouldWriteNothing(
                    rowsRead: plan.rowsRead,
                    duplicates: plan.exactDuplicateCount + plan.nearDuplicateCount,
                    unreadable: plan.errorCount
                )
            }

            // Rule 2's arithmetic starts here.
            let before = try rowCensus()

            let now = environment.now()
            let batchId = environment.newId()
            // Everything created, in creation order, which is what the batch
            // records and what undo walks.
            var createdAccountIds: [String] = []
            var createdCategoryIds: [String] = []
            var createdPayeeIds: [String] = []
            var createdTagIds: [String] = []

            // ── 1. accounts ────────────────────────────────────────────────
            var accountsByKey: [String: ImportTargetAccount] = [:]
            var accountsById: [String: ImportTargetAccount] = [:]
            for account in try liveTargetAccounts() {
                accountsByKey[Import.nameKey(account.name)] = account
                accountsById[account.id] = account
            }
            for planned in accountsToCreate {
                let key = Import.nameKey(planned.name)
                // Already here under this name -- created by hand, or by
                // another import, since the preview was built. Its rows go into
                // the account that exists rather than into a second one beside
                // it with the same name.
                if accountsByKey[key] != nil { continue }
                let account = try writeAccount(
                    AccountDraft(
                        name: planned.name,
                        // The file says what an account is CALLED and what
                        // currency it holds; it does not say what KIND it is.
                        // "Current" is the one the account editor defaults to,
                        // and it is a label the owner can change in one tap --
                        // unlike the currency, which is locked once there is
                        // history.
                        type: .current,
                        currency: planned.currency,
                        // Stated by the file (a MoneyWiz Report states each
                        // account's balance, and the parser works backwards to
                        // an opening figure), else zero -- which is what every
                        // other layout has always produced.
                        openingBalanceMinor: planned.openingBalanceMinor ?? 0,
                        colour: Self.importAccountPalette[
                            createdAccountIds.count % Self.importAccountPalette.count
                        ]
                    )
                )
                let target = ImportTargetAccount(
                    id: account.id, name: account.name, currency: account.currency
                )
                accountsByKey[key] = target
                accountsById[account.id] = target
                createdAccountIds.append(account.id)
            }
            try probe?("accounts", createdAccountIds.count)

            /// The account a row lands in: the one the plan resolved, else the
            /// one that now carries the file's name for it.
            func target(for row: ImportPlanRow) throws -> ImportTargetAccount {
                if let id = row.accountId {
                    // DELETED SINCE THE PREVIEW. The web app skips the row
                    // here; this refuses the whole import instead. Dropping
                    // rows quietly out of a write the owner asked for is how a
                    // statement half-arrives, and half of a statement is worse
                    // than none of it -- the balance is wrong and nothing says
                    // so.
                    guard let account = accountsById[id] else {
                        throw EditError.unknownAccount(id)
                    }
                    return account
                }
                let key = Import.nameKey(row.row.accountName ?? "")
                guard let account = accountsByKey[key] else {
                    throw StoreError.corrupt(
                        "row \(row.rowNumber) is marked importable but names no account this "
                            + "import created or found"
                    )
                }
                return account
            }

            // ── 2. category paths the book does not have ───────────────────
            //
            // KIND IS INFERRED ONCE PER PATH, and the first rule is the one
            // that matters: if the path starts at a root the book already has,
            // it takes THAT root's kind. Otherwise the sign of the first row
            // using it decides. Without the first rule a refund filed under
            // "Food & Drink" forks a second, income-kinded "Food & Drink" tree
            // beside the real one, and every report then has two.
            let roots = try liveCategories(parentId: nil)
            var leafByPathKey: [String: String] = [:]
            for path in plan.newCategoryPaths {
                let key = Import.pathKey(path)
                // Every row that used this path may have been skipped since the
                // plan was built (a decision, an unticked account). Creating a
                // category nothing is filed under would leave the owner a
                // category they never chose and no transaction to explain it.
                guard let usedBy = importable.first(
                    where: { Import.pathKey($0.row.categoryPath) == key }
                ) else { continue }
                guard let first = path.first else { continue }
                let signKind: CategoryKind = (usedBy.amountMinor ?? 0) < 0 ? .expense : .income
                let rootMatches = roots.filter { Import.nameKey($0.name) == Import.nameKey(first) }
                let kind =
                    (rootMatches.first { $0.kind == signKind } ?? rootMatches.first)?.kind
                    ?? signKind
                let resolved = try getOrCreateCategoryPath(path, kind: kind)
                leafByPathKey[key] = resolved.leafId
                createdCategoryIds.append(contentsOf: resolved.created)
            }
            try probe?("categories", createdCategoryIds.count)

            // ── 3. tags, once for the whole file ───────────────────────────
            //
            // Resolved in one pass rather than per row: a per-row get-or-create
            // is an indexed lookup per tag per row, which is most of what made
            // a day-one import of years of history freeze the browser tab.
            // Only tags on rows that will actually be written are created.
            var tagNames: [String] = []
            var seenTagKeys = Set<String>()
            for row in importable {
                for raw in row.row.tags {
                    let clean = Names.clean(raw)
                    if clean.isEmpty { continue }
                    let key = Import.nameKey(clean)
                    if seenTagKeys.insert(key).inserted { tagNames.append(clean) }
                }
            }
            let tagIdsBefore = try allIds(in: "tags")
            var tagIdByKey: [String: String] = [:]
            for tag in try getOrCreateTags(named: tagNames) {
                tagIdByKey[tag.nameLower] = tag.id
                if !tagIdsBefore.contains(tag.id) { createdTagIds.append(tag.id) }
            }
            try probe?("tags", createdTagIds.count)

            /// One row's tag ids: row order, de-duplicated, blanks dropped. A
            /// transaction's tag order is DATA -- it is an array in the backup
            /// file, and a different order is a different file.
            func tagIds(for names: [String]) -> [String] {
                var out: [String] = []
                var seen = Set<String>()
                for raw in names {
                    let key = Import.nameKey(Names.clean(raw))
                    if key.isEmpty || !seen.insert(key).inserted { continue }
                    if let id = tagIdByKey[key] { out.append(id) }
                }
                return out
            }

            // ── 4. the rows ────────────────────────────────────────────────
            let payeeIdsBefore = try allIds(in: "payees")
            var payeeByKey: [String: Payee] = [:]
            var payeesTouched = Set<String>()
            var transferGroupByPair: [String: String] = [:]
            var transferGroupIds: [String] = []
            var transactionIds: [String] = []
            var currencyMismatchCount = 0
            var unpairedTransferCount = 0

            for (index, row) in plan.rows.enumerated() where row.isImportable {
                let account = try target(for: row)
                guard let date = row.row.date, let amountMinor = row.amountMinor else {
                    throw StoreError.corrupt(
                        "row \(row.rowNumber) is marked importable but has no date or no amount"
                    )
                }

                // D31, CHECKED AT THE WRITE. The plan divided this figure into
                // minor units at some currency; if the account no longer holds
                // that currency the figure is at the wrong scale and there is
                // nothing here that can put it right -- the file is not in
                // hand any more. Refuse, and say what to do.
                if let resolved = row.resolvedCurrency, resolved != account.currency {
                    throw EditError.importPlanIsStale(
                        accountName: account.name, plannedIn: resolved, nowHolds: account.currency
                    )
                }

                // A transfer pair only links when BOTH legs are written. A
                // surviving single leg is an ordinary transaction -- and one
                // that every report reads by sign as real income or real
                // spending, which is why it is counted and disclosed.
                let partner = row.transferPairIndex.flatMap { j -> ImportPlanRow? in
                    plan.rows.indices.contains(j) ? plan.rows[j] : nil
                }
                let paired = partner?.isImportable ?? false
                var transferGroupId: String? = nil
                if paired, let j = row.transferPairIndex {
                    let key = "\(min(index, j)):\(max(index, j))"
                    if let existing = transferGroupByPair[key] {
                        transferGroupId = existing
                    } else {
                        let fresh = environment.newId()
                        transferGroupByPair[key] = fresh
                        transferGroupIds.append(fresh)
                        transferGroupId = fresh
                    }
                }
                if row.row.transferAccountName != nil && !paired { unpairedTransferCount += 1 }

                var payeeId: String? = nil
                if let raw = row.row.payeeName {
                    let key = Import.nameKey(raw)
                    let payee: Payee?
                    if let cached = payeeByKey[key] {
                        payee = cached
                    } else {
                        payee = try getOrCreatePayee(named: raw)
                        if let payee { payeeByKey[key] = payee }
                    }
                    if let payee {
                        payeeId = payee.id
                        payeesTouched.insert(payee.id)
                        if !payeeIdsBefore.contains(payee.id),
                            !createdPayeeIds.contains(payee.id)
                        {
                            createdPayeeIds.append(payee.id)
                        }
                    }
                }

                // A paired transfer leg gets NO category: money moving between
                // two of the owner's own accounts is not spending, and a
                // category on it would put it in a report as though it were.
                var categoryId: String? = nil
                if !paired {
                    categoryId =
                        row.chosenCategoryId ?? leafByPathKey[Import.pathKey(row.row.categoryPath)]
                }

                let mismatched = row.row.currency != nil && row.row.currency != account.currency
                if mismatched { currencyMismatchCount += 1 }

                let written = try writeTransaction(
                    PendingTransaction(
                        id: environment.newId(),
                        isNew: true,
                        accountId: account.id,
                        date: date,
                        amountMinor: amountMinor,
                        payeeId: payeeId,
                        categoryId: categoryId,
                        tagIds: tagIds(for: row.row.tags),
                        notes: Self.importedNotes(row, paired: paired, mismatchedCurrency: mismatched),
                        // Everything in a statement has already happened.
                        status: .cleared,
                        splits: [],
                        transferGroupId: transferGroupId,
                        importBatchId: batchId,
                        // THE SAME KEY THE PLAN MATCHED WITH -- the row's own
                        // payee else its description, RAW, not the cleaned
                        // payee name and not the notes this file just built.
                        // Get this wrong and re-importing the same file finds
                        // nothing to collide with and doubles the book.
                        dedupeSource: row.row.payeeName ?? row.row.description ?? "",
                        createdAt: now,
                        updatedAt: now
                    )
                )
                transactionIds.append(written.id)
                try probe?("transaction", transactionIds.count)
            }

            // ── 5. the batch ───────────────────────────────────────────────
            let batch = ImportBatch(
                id: batchId,
                source: plan.source,
                fileName: plan.fileName,
                // What LANDED, not what the file held.
                rowCount: transactionIds.count,
                importedAt: now,
                createdAccountIds: createdAccountIds,
                createdCategoryIds: createdCategoryIds,
                createdPayeeIds: createdPayeeIds,
                createdTagIds: createdTagIds,
                // ACCOUNT groups, not transfer groups. An import never makes
                // one: accounts it creates are ungrouped, and the owner files
                // them where they want them afterwards.
                createdGroupIds: [],
                // Absent, not empty. Only the sample-data batch writes these
                // two (D19), and "the key was not there" and "the list was
                // empty" are different claims in the file format.
                createdBudgetIds: nil,
                createdFxRateIds: nil
            )
            try writeImportBatches([batch])
            try probe?("batch", 1)

            // ── 6. what the payees have just learned ───────────────────────
            //
            // AFTER the rows are written, so the transactions just imported are
            // among the ones counted (D17) -- and INSIDE the transaction, which
            // is where this package differs from the web app deliberately: a
            // rolled-back import must not leave a payee pointing at a category
            // it learned from transactions that do not exist.
            for payeeId in payeesTouched.sorted() {
                try learnPayeeCategory(payeeId: payeeId)
            }

            // ── 7. the two checks, before anything is committed ────────────
            //
            // The money audit is the same one `importBackup` and `createBook`
            // run, in the same place: a store that somehow holds a
            // floating-point amount is never committed. It is a check on the
            // ASSUMPTIONS rather than on the writers -- a STRICT table with a
            // typeof CHECK makes it unreachable from here, which is exactly why
            // it is worth asking.
            if let problem = try auditMoneyColumns().first { throw problem }
            try refuseUnlessAdditive(before: before, after: try rowCensus(), batch: batch)
            try probe?("audit", 0)

            // ONE change. However many rows a file turned out to hold, the
            // owner did one thing.
            try recordLocalEdit(at: now)

            return ImportReceipt(
                batch: batch,
                transactionIds: transactionIds,
                transferGroupIds: transferGroupIds,
                rowsRead: plan.rowsRead,
                duplicatesSkipped: plan.exactDuplicateCount,
                decisionsSkipped: plan.nearDuplicateCount
                    - plan.rows.count { $0.action == .needsDecision && $0.isImportable },
                unreadableRows: plan.errorCount,
                currencyMismatchCount: currencyMismatchCount,
                unpairedTransferCount: unpairedTransferCount
            )
        }
    }

    /// The colours a created account is given, matching `ACCOUNT_PALETTE` in
    /// src/import/importer.ts so that the same file imported in either app
    /// produces the same-looking list.
    static let importAccountPalette = [
        "#2563eb", "#059669", "#db2777", "#b45309", "#7c3aed", "#0e7490",
    ]

    /// What an imported row says in its notes.
    ///
    /// Four parts, joined with an em dash, and each one is there because
    /// dropping it loses something the file said:
    ///
    ///   * the DESCRIPTION, unless it is just the payee name again;
    ///   * the row's own NOTES;
    ///   * "(transfer)" when the file called this a transfer leg and its
    ///     partner is not being written -- so a row that a report is about to
    ///     read as income says on its face that it is half of a move;
    ///   * "originally EUR" when the file declared a currency other than the
    ///     account's. The amount is stored in the ACCOUNT's currency and is
    ///     never converted (D30); this is the only record that the file said
    ///     something else.
    static func importedNotes(
        _ row: ImportPlanRow, paired: Bool, mismatchedCurrency: Bool
    ) -> String {
        var parts: [String] = []
        if let description = row.row.description, !description.isEmpty {
            let payee = row.row.payeeName ?? ""
            if payee.isEmpty || Import.nameKey(description) != Import.nameKey(payee) {
                parts.append(description)
            }
        }
        if let notes = row.row.notes, !notes.isEmpty { parts.append(notes) }
        if row.row.transferAccountName != nil, !paired { parts.append("(transfer)") }
        if mismatchedCurrency, let declared = row.row.currency {
            parts.append("originally \(declared)")
        }
        return parts.joined(separator: " \u{2014} ")
    }

    // MARK: - Undo

    /// Take one import back out of the book, as a unit.
    ///
    /// Removes the batch's transactions, and then each thing the batch created
    /// THAT NOTHING ELSE IS USING: an account with no transactions left in it,
    /// a category nothing is filed under and nothing budgets over, a payee or a
    /// tag on no live row. Anything the owner has used since is KEPT and named
    /// in the receipt -- undoing an import is not a licence to remove a
    /// category somebody has spent a month filing into.
    ///
    /// REMOVAL IS A TOMBSTONE, as it is everywhere else in this package, and
    /// `softDelete` only touches rows that are still live. So a transaction
    /// from this import that the owner deleted last Tuesday keeps last
    /// Tuesday's stamp, and nothing here brings back a row that a later edit
    /// removed.
    ///
    /// Throws `EditError.unknownImportBatch` for a batch that is not in the
    /// book -- one already undone, or one that was never here.
    @discardableResult
    public func undoImport(batchId: String) throws -> UndoneImport {
        try connection.transaction {
            guard let batch = try importBatches().first(where: { $0.id == batchId }) else {
                throw EditError.unknownImportBatch(batchId)
            }
            let now = environment.now()

            // ── 1. the transactions ────────────────────────────────────────
            //
            // BY `import_batch_id`, not by the ids this call happens to know:
            // a transaction that arrived in this import and has been EDITED
            // since is still part of it (the editor preserves provenance
            // precisely so this stays true), and a transaction that was moved
            // to another account is still one of the rows this import added.
            var transactionIds: [String] = []
            var payeesTouched = Set<String>()
            let doomed = try connection.prepare(
                "SELECT id, payee_id FROM live_transactions WHERE import_batch_id = ? ORDER BY id"
            )
            defer { doomed.finalize() }
            doomed.bind(1, text: batchId)
            while try doomed.step() {
                transactionIds.append(try doomed.text(0))
                if let payeeId = try doomed.optionalText(1) { payeesTouched.insert(payeeId) }
            }
            for id in transactionIds {
                try softDelete(table: "transactions", id: id, at: now)
            }

            // ── 2. accounts it created, if they are empty now ──────────────
            var accountIds: [String] = []
            var keptAccountIds: [String] = []
            for id in batch.createdAccountIds {
                guard try liveRowExists("accounts", id: id) else { continue }
                let remaining = try liveTransactionCount(accountId: id)
                if remaining > 0 {
                    keptAccountIds.append(id)
                    continue
                }
                try softDelete(table: "accounts", id: id, at: now)
                accountIds.append(id)
            }

            // ── 3. categories, to a fixpoint ───────────────────────────────
            //
            // A category can only go when it has no live children, so the loop
            // repeats until a pass removes nothing: leaves go first, and their
            // parents become removable on the next pass. A category still used
            // by a transaction (its own or one of its splits) or named by a
            // budget is KEPT -- the owner has since made it theirs.
            var categoryIds: [String] = []
            var keptCategoryIds: [String] = []
            var pending = batch.createdCategoryIds
            var progressed = true
            while progressed && !pending.isEmpty {
                progressed = false
                for id in pending {
                    guard try liveRowExists("categories", id: id) else {
                        pending.removeAll { $0 == id }
                        continue
                    }
                    if try liveCategories(parentId: id).count > 0 { continue }  // children first
                    if try categoryIsInUse(id) {
                        keptCategoryIds.append(id)
                        pending.removeAll { $0 == id }
                        continue
                    }
                    // A payee's LEARNED default never blocks a removal (D18):
                    // it is a suggestion this app worked out, not a choice the
                    // owner made, so it is cleared and the payee re-learns.
                    let clear = try connection.prepare(
                        "UPDATE payees SET default_category_id = NULL WHERE default_category_id = ?"
                    )
                    defer { clear.finalize() }
                    clear.bind(1, text: id)
                    try clear.run()

                    try softDelete(table: "categories", id: id, at: now)
                    categoryIds.append(id)
                    pending.removeAll { $0 == id }
                    progressed = true
                }
            }
            // Whatever the fixpoint could not reach is still in use, through a
            // child that is itself in use.
            keptCategoryIds.append(contentsOf: pending)

            // ── 4. payees and tags nothing is left pointing at ─────────────
            var payeeIds: [String] = []
            for id in batch.createdPayeeIds {
                guard try liveRowExists("payees", id: id) else { continue }
                guard try countOfOne(
                    "SELECT count(*) FROM live_transactions WHERE payee_id = ?", id
                ) == 0 else { continue }
                try softDelete(table: "payees", id: id, at: now)
                payeeIds.append(id)
                payeesTouched.remove(id)
            }
            var tagIds: [String] = []
            for id in batch.createdTagIds {
                guard try liveRowExists("tags", id: id) else { continue }
                guard try countOfOne(
                    "SELECT count(*) FROM transaction_tags tt "
                        + "JOIN live_transactions t ON t.id = tt.transaction_id "
                        + "WHERE tt.tag_id = ?",
                    id
                ) == 0 else { continue }
                try softDelete(table: "tags", id: id, at: now)
                tagIds.append(id)
            }

            // ── 5. the lists only a sample-data batch carries (D19) ────────
            //
            // `commitImport` never fills these -- an import of a statement
            // makes no budgets, no rates and no account groups. They are here
            // because a RESTORED book carries the web app's batches too, and an
            // undo that silently left half of one behind would be an undo the
            // owner cannot trust.
            for id in batch.createdBudgetIds ?? [] {
                try softDelete(table: "budgets", id: id, at: now)
            }
            for id in batch.createdFxRateIds ?? [] {
                // A rate row has a fixed id (`EUR:GBP`), so editing the rate a
                // sample wrote OVERWRITES it rather than adding a row -- after
                // which it is the owner's own rate, and removing it would drop
                // their EUR accounts out of net worth. A batch-created rate
                // carries the batch's timestamp; any later edit moves `as_of`,
                // which is the proof that this is no longer that row.
                let asOf = try scalarTextOfOne("SELECT as_of FROM live_fx_rates WHERE id = ?", id)
                guard asOf == batch.importedAt else { continue }
                try softDelete(table: "fx_rates", id: id, at: now)
            }
            for id in batch.createdGroupIds {
                guard try liveAccountCount(groupId: id) == 0 else { continue }
                try softDelete(table: "account_groups", id: id, at: now)
            }

            // ── 6. the batch row itself ────────────────────────────────────
            try softDelete(table: "import_batches", id: batchId, at: now)

            // The import taught these payees a category from rows that no
            // longer exist; un-teach it, or an import the owner REJECTED goes
            // on dictating suggestions for ever.
            for payeeId in payeesTouched.sorted() {
                guard try liveRowExists("payees", id: payeeId) else { continue }
                try learnPayeeCategory(payeeId: payeeId)
            }

            // ONE change, like the import it undoes.
            try recordLocalEdit(at: now)

            return UndoneImport(
                batchId: batchId,
                fileName: batch.fileName,
                transactionIds: transactionIds,
                accountIds: accountIds,
                categoryIds: categoryIds,
                payeeIds: payeeIds,
                tagIds: tagIds,
                keptAccountIds: keptAccountIds,
                keptCategoryIds: keptCategoryIds,
                undoneAt: now
            )
        }
    }

    // MARK: - Reading the batches

    /// Every import still in the book, most recent first.
    ///
    /// Ties are broken by id so the order is total: two imports can share a
    /// timestamp (a file imported twice in the same millisecond is not a
    /// realistic worry, but a fixed clock in a test is), and a list that
    /// reorders itself between two reads is a list nothing can be selected from
    /// reliably.
    public func importBatches() throws -> [ImportBatch] {
        try readImportBatches(from: "live_import_batches")
            .sorted {
                $0.importedAt == $1.importedAt
                    ? $0.id < $1.id
                    : $0.importedAt > $1.importedAt
            }
    }

    // MARK: - The additive check

    /// One account, reduced to the three things the import needs of it.
    struct ImportTargetAccount: Sendable, Hashable {
        let id: String
        let name: String
        let currency: String
    }

    /// How many live and how many tombstoned rows each ledger table holds.
    struct RowCensus: Sendable, Hashable {
        let live: [String: Int]
        let deleted: [String: Int]
    }

    func rowCensus() throws -> RowCensus {
        var live: [String: Int] = [:]
        var deleted: [String: Int] = [:]
        for table in StoreSchema.allTombstonedTables {
            live[table] = try liveCount(table)
            deleted[table] = try deletedCount(table)
        }
        return RowCensus(live: live, deleted: deleted)
    }

    /// THE CHECK THAT MAKES RULE 2 A FACT.
    ///
    /// Two questions of every ledger table, including the ones this import has
    /// no business touching at all -- budgets, rates, groups, and the
    /// schedules that are this app's own and are not in any backup file:
    ///
    ///   * did anything get REMOVED? Nothing here removes a row, so the count
    ///     of tombstones must not have moved. A restore, by contrast, clears
    ///     every table -- which is precisely the behaviour this refuses to be
    ///     confused with.
    ///   * did exactly the recorded rows APPEAR? The batch is the list undo
    ///     works from, so a row created and not recorded is a row undo can
    ///     never remove, and a row recorded but not created is a batch that
    ///     lies about what it did. Both are caught by counting.
    ///
    /// Anything else -- a payee's re-learned category, an account's sort order
    /// -- is a CHANGE to a row rather than a row appearing or disappearing, and
    /// is what every ordinary save does too.
    func refuseUnlessAdditive(before: RowCensus, after: RowCensus, batch: ImportBatch) throws {
        var added: [String: Int] = [:]
        added["accounts"] = batch.createdAccountIds.count
        added["categories"] = batch.createdCategoryIds.count
        added["payees"] = batch.createdPayeeIds.count
        added["tags"] = batch.createdTagIds.count
        added["account_groups"] = batch.createdGroupIds.count
        added["import_batches"] = 1
        added["transactions"] = batch.rowCount

        for table in StoreSchema.allTombstonedTables {
            let wasDeleted = before.deleted[table] ?? 0
            let isDeleted = after.deleted[table] ?? 0
            guard wasDeleted == isDeleted else {
                throw StoreError.importIsNotAdditive(
                    table: table, expected: wasDeleted, found: isDeleted, kind: "removed"
                )
            }
            let expected = (before.live[table] ?? 0) + (added[table] ?? 0)
            let found = after.live[table] ?? 0
            guard expected == found else {
                throw StoreError.importIsNotAdditive(
                    table: table, expected: expected, found: found, kind: "live"
                )
            }
        }
    }

    // MARK: - Small reads this file needs

    /// Every live account, as the import holds one.
    func liveTargetAccounts() throws -> [ImportTargetAccount] {
        let statement = try connection.prepare(
            "SELECT id, name, currency FROM live_accounts ORDER BY id"
        )
        defer { statement.finalize() }
        var out: [ImportTargetAccount] = []
        while try statement.step() {
            out.append(
                ImportTargetAccount(
                    id: try statement.text(0),
                    name: try statement.text(1),
                    currency: try statement.text(2)
                )
            )
        }
        return out
    }

    /// Every id in a table, TOMBSTONES INCLUDED.
    ///
    /// Used to tell an id that was just created from one that was already here.
    /// The base table rather than the live view, because a tombstoned row's id
    /// is taken: a get-or-create that skipped past it made a NEW row, and that
    /// new row is one this import created and must record.
    func allIds(in table: String) throws -> Set<String> {
        guard StoreSchema.allTombstonedTables.contains(table) else {
            throw StoreError.corrupt("\"\(table)\" is not a table with ids to list")
        }
        let statement = try connection.prepare("SELECT id FROM \(table)")
        defer { statement.finalize() }
        var out: Set<String> = []
        while try statement.step() { out.insert(try statement.text(0)) }
        return out
    }

    /// Is this category still holding anything? A live transaction filed under
    /// it, a split of a live transaction, or a live budget that names it.
    private func categoryIsInUse(_ id: String) throws -> Bool {
        if try countOfOne("SELECT count(*) FROM live_transactions WHERE category_id = ?", id) > 0 {
            return true
        }
        if try countOfOne(
            "SELECT count(*) FROM transaction_splits s "
                + "JOIN live_transactions t ON t.id = s.transaction_id WHERE s.category_id = ?",
            id
        ) > 0 {
            return true
        }
        return try countOfOne(
            "SELECT count(*) FROM budget_categories bc "
                + "JOIN live_budgets b ON b.id = bc.budget_id WHERE bc.category_id = ?",
            id
        ) > 0
    }

    private func countOfOne(_ sql: String, _ id: String) throws -> Int {
        let statement = try connection.prepare(sql)
        defer { statement.finalize() }
        statement.bind(1, text: id)
        guard try statement.step() else { return 0 }
        return try statement.int(0)
    }

    private func scalarTextOfOne(_ sql: String, _ id: String) throws -> String? {
        let statement = try connection.prepare(sql)
        defer { statement.finalize() }
        statement.bind(1, text: id)
        guard try statement.step() else { return nil }
        return try statement.optionalText(0)
    }
}
