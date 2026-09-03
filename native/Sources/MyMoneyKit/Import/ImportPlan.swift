// Everything between "we parsed the file" and "we wrote anything", ported from
// the planning half of src/import/importer.ts (SPEC §7.4).
//
// NOTHING HERE TOUCHES A DATABASE. `buildPlan` is a pure function of (parsed
// rows, a snapshot of the book, options) and it returns a value. That is not a
// stylistic preference: this is the code that decides what money is about to be
// written into the owner's book, and a pure function can be handed a hand-built
// book of four transactions and asked exactly what it would do. The commit step
// that follows is a separate file and a separate decision.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE BUGS THIS FILE EXISTS TO NOT HAVE AGAIN
//
// All three were found the hard way in the web app and are recorded in
// DECISIONS.md. Each one is a silent wrong number -- no crash, no error, just a
// balance that stops being true -- so each one gets a named step below and a
// counter the preview can show the owner.
//
//   D30 -- A TRANSACTION IS STORED IN ITS ACCOUNT'S CURRENCY, NEVER THE
//   FILE'S. Balances, net worth and every chart sum `amountMinor` per account
//   with no currency check, so a EUR row banked in a GBP account corrupts all
//   three at once and nothing downstream can tell. The currency a row declares
//   describes the PURCHASE; the ledger is the account's. Rows that disagree are
//   counted in `currencyMismatchCount` and disclosed -- never converted, because
//   a guessed rate is a made-up number (SPEC §6).
//
//   D31 -- SCALE IS RESOLVED AFTER THE ACCOUNT IS KNOWN. A parser has to pick a
//   currency before it knows which account a row lands in, so its minor-unit
//   scale can be wrong in both directions: a ¥500 row read at two decimals
//   becomes ¥50,000, and a valid 3-decimal "12.345" is rejected outright at
//   GBP's two. `ParsedRow` therefore carries the raw amount cell, and step 1
//   re-derives the amount once the account -- and so the real currency -- is
//   known. Where the text cannot be re-read at all, the row is REFUSED rather
//   than written at a scale we know is wrong (`ambiguousScaleCount`).
//
//   D32 -- A DUPLICATE MATCH IS CONSUMED. One existing transaction may explain
//   at most ONE incoming row. Without that, two legitimate identical purchases
//   in one file both match the single transaction already in the book and both
//   get skipped: real spending, silently gone. Consuming the match keeps
//   re-importing the same file a no-op (N rows meet N existing transactions)
//   while letting genuine repeats through.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND THE FOURTH THING, WHICH IS NOT A DECISION NUMBER BUT COSTS THE SAME
//
// An unpaired transfer leg becomes an ordinary uncategorised transaction, and
// every report in this app classifies an uncategorised transaction BY SIGN. A
// £500 leg whose partner never arrived is therefore £500 of invented income or
// invented spending. They are counted (`unpairedTransferCount`) and said out
// loud, never quietly absorbed.
//
// IN-FILE REPEATS ARE NOT DUPLICATES. Duplicates are only ever detected against
// what is ALREADY in the book. Two identical same-day coffees in one export are
// two coffees; auto-skipping the second would lose real spending with nothing
// on screen to explain it.
import Foundation

// MARK: - What the file says about the accounts in it

/// One account exactly as the FILE declares it, in file order.
///
/// The name, the currency and the opening balance travel together on purpose.
/// An opening balance is a count of minor units, which means nothing without
/// the scale it was read at, and a currency is the only thing that fixes that
/// scale. The web app carried these as two parallel `Map`s keyed by name and
/// had to keep them in step by hand; one value cannot fall out of step with
/// itself.
///
/// Only a layout that states each account's FINAL balance can supply an opening
/// balance -- in practice MoneyWiz's Report export, via `reportPlanOptions`.
/// `openingBalanceMinor` is nil when the file could not be trusted to state one
/// (see `MoneyWizReport.swift`: a single unimportable row in an account refuses
/// that account's opening balance outright, because balance − Σ(the rows that
/// did parse) is not an opening balance, it is that number plus the rows that
/// did not).
public struct DeclaredAccount: Sendable, Hashable {
    public let name: String
    /// ISO code as the file states it for this account's LEDGER -- which beats
    /// any currency a row of that account declares (a row's currency describes
    /// the purchase, D30).
    public let currency: String
    /// In this account's minor units, or nil when the file cannot state one.
    public let openingBalanceMinor: Int64?

    public init(name: String, currency: String, openingBalanceMinor: Int64?) {
        self.name = name
        self.currency = currency
        self.openingBalanceMinor = openingBalanceMinor
    }
}

// MARK: - What is already in the book

/// The snapshot of the owner's book that a plan is resolved against.
///
/// A plain value, supplied by the caller, so that planning has no opinion about
/// where a book is stored and can be tested without one.
///
/// `transactions` MUST BE THE LIVE ROWS. Deletion in this app is a tombstone
/// save behind the `live_*` views (never a hard delete), and a tombstoned
/// transaction handed in here would sit in the dedupe index and absorb an
/// incoming row -- so a re-import after a delete would silently skip the row the
/// owner deleted on purpose. Read from the live views, always.
///
/// The caller MAY narrow `transactions` to the accounts and the date window the
/// file covers; planning filters to that window itself, so passing the whole
/// table is correct, just larger.
public struct ImportLedger: Sendable {
    public let accounts: [Account]
    public let categories: [Category]
    public let payees: [Payee]
    public let tags: [Tag]
    public let transactions: [Transaction]

    public init(
        accounts: [Account] = [], categories: [Category] = [], payees: [Payee] = [],
        tags: [Tag] = [], transactions: [Transaction] = []
    ) {
        self.accounts = accounts
        self.categories = categories
        self.payees = payees
        self.tags = tags
        self.transactions = transactions
    }

    /// Everything a plan needs, out of a decoded book.
    public init(book: Book) {
        self.init(
            accounts: book.accounts, categories: book.categories, payees: book.payees,
            tags: book.tags, transactions: book.transactions
        )
    }
}

// MARK: - Options

public struct ImportPlanOptions: Sendable {
    public let source: ImportSource
    /// Shown to the owner, and recorded on the batch if this is ever committed.
    public let fileName: String
    /// A generic CSV may pin EVERY row to one chosen account, whatever the rows
    /// say. When set it beats the row's own account name for every row.
    public let fixedAccountId: String?
    /// The currency for a row that declares none and lands in an account that
    /// does not exist yet. Usually the book's base currency.
    public let defaultCurrency: String
    /// What the file itself says about its accounts, in file order. Empty for
    /// every layout that does not state balances.
    public let declaredAccounts: [DeclaredAccount]
    /// An account the OWNER named for a file that names none of its own, which
    /// this book may not have yet.
    ///
    /// WHY THIS EXISTS. A plain bank CSV has no Account column: every row of it
    /// is implicitly "the account this statement is for", and the file never
    /// says which. `fixedAccountId` answers that by pointing at an account
    /// already in the book -- and on a book with no accounts at all there is
    /// nothing for it to point at, so the file had nowhere to go and the screen
    /// had nothing to offer but giving up. Naming the account is the obvious
    /// answer and it was the one thing the planner could not express.
    ///
    /// IT IS A DECLARATION, NOT A SPECIAL CASE. Everything below treats it
    /// exactly as it treats an account name the FILE stated: matched against
    /// the book first -- so typing the name of an account that is already here
    /// files the rows into THAT account rather than standing a second one
    /// beside it -- created otherwise, listed and untickable-able in the
    /// preview like any other new account, and its currency fixes the
    /// minor-unit scale its rows are read at (D31), because the currency of the
    /// account a row lands in is the currency that row is stored in (D30).
    ///
    /// Ignored when `fixedAccountId` names an account that exists: an id beats
    /// a name, because an id cannot be ambiguous.
    public let fixedNewAccount: DeclaredAccount?

    public init(
        source: ImportSource, fileName: String, defaultCurrency: String,
        fixedAccountId: String? = nil, declaredAccounts: [DeclaredAccount] = [],
        fixedNewAccount: DeclaredAccount? = nil
    ) {
        self.source = source
        self.fileName = fileName
        self.defaultCurrency = defaultCurrency
        self.fixedAccountId = fixedAccountId
        self.declaredAccounts = declaredAccounts
        self.fixedNewAccount = fixedNewAccount
    }
}

// MARK: - The plan

/// What would happen to one row. Raw values match the web app's strings so the
/// two implementations can be compared field for field.
public enum ImportRowAction: String, Sendable, Hashable {
    /// Will be written, unless the owner unticks its account.
    case add = "import"
    /// An identical transaction is already in the book. Skipped, and counted.
    case skipExactDuplicate = "skip_exact_duplicate"
    /// Close to something already in the book. NEVER resolved automatically.
    case needsDecision = "needs_decision"
    /// Cannot be understood. Reported with its row number and the reason.
    case error
}

/// The owner's answer for a `needsDecision` row. Defaults to `.skip`: a near
/// duplicate is never silently doubled, and never silently dropped either --
/// it is shown.
public enum ImportDecision: String, Sendable, Hashable {
    case add = "import"
    case skip
}

/// A row the plan could not understand, in the owner's terms.
///
/// This type exists so that "reported" is a thing the plan HAS rather than a
/// thing a screen has to remember to go and look for. A row that cannot be
/// imported is never dropped from `rows` either -- it stays in file order with
/// `action == .error`, so a preview can show it in place.
public struct ImportRowProblem: Sendable, Hashable, CustomStringConvertible {
    /// 1-based data-row number in the source file, as the parser recorded it.
    public let rowNumber: Int
    public let reason: String

    public var description: String { "Row \(rowNumber): \(reason)" }
}

/// An account this import would CREATE.
public struct NewAccountPlan: Sendable, Hashable {
    public let name: String
    public let currency: String
    /// The owner can untick creation in the preview; rows bound for it then
    /// stop being importable (they are not written to some other account).
    public var create: Bool
    /// Derived by the file's own arithmetic, in this account's minor units, so
    /// that the account's closing balance comes out right. nil ⇒ created with
    /// zero, which is what every layout that cannot state a balance produces.
    public let openingBalanceMinor: Int64?
}

/// One parsed row, resolved against the book.
public struct ImportPlanRow: Sendable, Hashable {
    /// The row exactly as parsed. Never rewritten -- what the file said stays
    /// available next to what the plan decided.
    public let row: ParsedRow
    public internal(set) var action: ImportRowAction
    /// The amount AT THE ACCOUNT'S CURRENCY (D31), which is the number that
    /// would be written. Equal to `row.amountMinor` whenever the parser's scale
    /// guess was already right. nil only on an error row.
    public internal(set) var amountMinor: Int64?
    /// The currency `amountMinor` was resolved AT: the currency of the account
    /// this row lands in, never the one the file declares (D30).
    ///
    /// RECORDED RATHER THAN RECOMPUTED, because the commit step has to check
    /// it. A plan is built against a SNAPSHOT of the book handed in by the
    /// caller, and the book can move between the preview and the tap: an
    /// account with no transactions in it can have its currency changed, and a
    /// plan that resolved "500" at GBP's two decimals must not then be written
    /// into a JPY account at a hundred times its value. Carrying the currency
    /// on the row lets the write REFUSE (LedgerStore+CommitImport.swift) rather
    /// than re-deriving from a file it can no longer see. nil on a row that
    /// never got as far as an account.
    public internal(set) var resolvedCurrency: String?
    /// Why this row cannot be imported. nil unless `action == .error`.
    public internal(set) var error: String?
    /// The existing transaction this row nearly duplicates.
    public internal(set) var nearDuplicateOf: Transaction?
    /// The owner's choice, for a `needsDecision` row.
    public internal(set) var decision: ImportDecision?
    /// Learned payee → category suggestion, when the row brings no category.
    public internal(set) var suggestedCategoryId: String?
    /// The category that would be applied: the resolved path, else the
    /// suggestion, else none.
    public internal(set) var chosenCategoryId: String?
    /// The existing account this row lands in. nil ⇒ the account is new; see
    /// `ImportPlan.newAccounts`.
    public internal(set) var accountId: String?
    /// The account this row lands in when that account does not exist yet, BY
    /// NAME: the file's own name for it, or the one the owner typed for a file
    /// that has no Account column at all. nil whenever `accountId` is set, and
    /// nil on a row that never reached an account.
    ///
    /// RECORDED RATHER THAN RE-DERIVED, and that is a defect fixed rather than
    /// a convenience. The commit step used to find the account it had just
    /// created by reading `row.row.accountName` -- which quietly assumed that
    /// the only way to reach a new account is for the FILE to have named it.
    /// It is not: an account the owner names for a file that names none has no
    /// `accountName` on any of its rows, and every one of them would have gone
    /// looking for an account called "" and refused the whole import. Between
    /// the plan and the write there is now ONE answer to "where does this row
    /// go", and the plan is the thing that holds it.
    public internal(set) var newAccountName: String?
    /// Index into `ImportPlan.rows` of the paired transfer leg.
    public internal(set) var transferPairIndex: Int?
    /// The file declared a currency other than the account's. The amount is
    /// still stored in the ACCOUNT's currency; nothing is converted (D30).
    public internal(set) var currencyMismatch: Bool = false
    /// The parser's scale could not be confirmed AND the raw text cannot be
    /// re-read (no single cell produced this amount). Always an error row: a
    /// number known to be at the wrong scale is not written (D31).
    public internal(set) var ambiguousScale: Bool = false
    /// Would this row be written if the plan were committed right now?
    ///
    /// Stored rather than computed, and refreshed by every edit alongside the
    /// totals, so that a screen drawing twenty thousand rows asks a Bool rather
    /// than rebuilding an account lookup per row -- and so that a row can never
    /// disagree with the count it was counted in.
    public internal(set) var isImportable: Bool = false

    /// 1-based data-row number in the source file.
    public var rowNumber: Int { row.index }
}

/// What this import would do, in full, before anything is written.
///
/// The counters are STORED and refreshed by every mutation rather than left to
/// a caller to recompute (the web app's `refreshPlanCounts` is a call you can
/// forget, and a stale "12 to add" over a plan that would write 9 is exactly
/// the kind of quiet lie this feature cannot afford). `rows` and `newAccounts`
/// are `private(set)` for the same reason: the only ways to change a plan are
/// the two the preview actually offers, and both recount.
public struct ImportPlan: Sendable {
    public let source: ImportSource
    public let fileName: String
    public private(set) var rows: [ImportPlanRow]
    public private(set) var newAccounts: [NewAccountPlan]
    /// Category paths that do not resolve in the book, in first-use order.
    public let newCategoryPaths: [[String]]
    public let newPayees: [String]
    public let newTags: [String]
    /// Accounts the file states an opening balance for that ALREADY exist here,
    /// by their name IN THIS APP. Their opening balance is deliberately left
    /// alone -- silently rewriting a balance the owner set (or a previous
    /// import derived from a longer history) would move money they never
    /// touched. The cost is that these accounts can end up disagreeing with the
    /// figure in the file, so the preview has to name them.
    public let existingAccountsWithOpeningBalance: [String]

    // MARK: Totals a person can check

    /// Data rows the parser produced from the file. Every one of them is in
    /// `rows`, in file order, whatever happened to it.
    public var rowsRead: Int { rows.count }
    /// Transactions that would be written if this were committed now.
    public private(set) var importableCount: Int = 0
    /// Rows identical to something already in the book. Skipped.
    public private(set) var exactDuplicateCount: Int = 0
    /// Rows close to something already in the book. Awaiting a decision.
    public private(set) var nearDuplicateCount: Int = 0
    /// Rows that cannot be imported. Each one is in `problems`.
    public private(set) var errorCount: Int = 0
    /// Accounts that would be created (ticked ones only).
    public private(set) var accountsToCreateCount: Int = 0
    /// Rows that WILL be written, name another account in the file's transfer
    /// column, and whose opposite leg is not being written. Each becomes an
    /// ordinary uncategorised transaction, which reports read by sign as real
    /// income or real spending.
    public private(set) var unpairedTransferCount: Int = 0
    /// Rows that WILL be written whose declared currency is not their
    /// account's. Stored in the account's currency, disclosed, never converted.
    public private(set) var currencyMismatchCount: Int = 0
    /// Rows whose amount is provably at the wrong scale and cannot be re-read.
    /// All of them are error rows; none of them is written.
    public private(set) var ambiguousScaleCount: Int = 0

    /// Every row that cannot be imported, with its row number and the reason.
    public var problems: [ImportRowProblem] {
        rows.compactMap { pr in
            guard pr.action == .error else { return nil }
            return ImportRowProblem(rowNumber: pr.rowNumber, reason: pr.error ?? "Unparseable row")
        }
    }

    /// The rows that would be written if this were committed now.
    public var importableRows: [ImportPlanRow] { rows.filter(\.isImportable) }

    // MARK: The two edits a preview offers

    /// Answer a near-duplicate row. Ignored for any other kind of row -- an
    /// error or an exact duplicate is not a decision the owner gets to make.
    public mutating func setDecision(_ decision: ImportDecision, forRowAt index: Int) {
        guard rows.indices.contains(index), rows[index].action == .needsDecision else { return }
        rows[index].decision = decision
        refreshCounts()
    }

    /// Tick or untick creating one of the accounts this import would make.
    /// Matched the way every account lookup in this file is matched: case and
    /// whitespace insensitively.
    public mutating func setCreateAccount(named name: String, _ create: Bool) {
        let key = Import.nameKey(name)
        guard let i = newAccounts.firstIndex(where: { Import.nameKey($0.name) == key }) else { return }
        newAccounts[i].create = create
        refreshCounts()
    }

    // MARK: Counting

    private var createByAccountKey: [String: Bool] {
        var out: [String: Bool] = [:]
        for na in newAccounts { out[Import.nameKey(na.name)] = na.create }
        return out
    }

    /// Ported from `isEffectiveImport`: an error or an exact duplicate is out,
    /// a near duplicate is out unless the owner said otherwise, and a row bound
    /// for a new account is out if that account has been unticked.
    static func isEffective(_ pr: ImportPlanRow, createByAccountKey: [String: Bool]) -> Bool {
        if pr.action == .error || pr.action == .skipExactDuplicate { return false }
        if pr.action == .needsDecision && pr.decision != .add { return false }
        if pr.accountId != nil { return true }
        // THE PLAN'S OWN ANSWER, not the file's. `newAccountName` is the name
        // this row was actually resolved to -- which is the file's for a file
        // that names its accounts and the owner's for one that does not.
        // Reading `row.accountName` here would leave every row of a pinned
        // import un-importable, silently, with a preview saying zero.
        return createByAccountKey[Import.nameKey(pr.newAccountName ?? "")] == true
    }

    /// A row that will be written as an ORDINARY transaction even though the
    /// file called it a transfer leg: either nothing paired with it, or its
    /// partner is not being written (a skipped duplicate, an untick'd account,
    /// a decision). Reports classify an uncategorised transaction BY SIGN, so
    /// every one of these silently becomes real income or real spending.
    private static func importsAsPlainTransfer(_ pr: ImportPlanRow, rows: [ImportPlanRow]) -> Bool {
        guard pr.row.transferAccountName != nil, pr.isImportable else { return false }
        guard let j = pr.transferPairIndex, rows.indices.contains(j) else { return true }
        return !rows[j].isImportable
    }

    /// The one place any of these numbers is decided. Every mutation ends here,
    /// so a total the owner is shown cannot be left over from before their last
    /// edit.
    mutating func refreshCounts() {
        let createByKey = createByAccountKey
        for i in rows.indices {
            rows[i].isImportable = Self.isEffective(rows[i], createByAccountKey: createByKey)
        }
        exactDuplicateCount = rows.count { $0.action == .skipExactDuplicate }
        nearDuplicateCount = rows.count { $0.action == .needsDecision }
        errorCount = rows.count { $0.action == .error }
        ambiguousScaleCount = rows.count { $0.ambiguousScale }
        accountsToCreateCount = newAccounts.count { $0.create }
        importableCount = rows.count(where: \.isImportable)
        // Only rows that will actually be written can mislead anyone about
        // currency, so a mismatch on a skipped duplicate is not disclosed.
        currencyMismatchCount = rows.count { $0.currencyMismatch && $0.isImportable }
        unpairedTransferCount = rows.count { Self.importsAsPlainTransfer($0, rows: rows) }
    }

    init(
        source: ImportSource, fileName: String, rows: [ImportPlanRow],
        newAccounts: [NewAccountPlan], newCategoryPaths: [[String]], newPayees: [String],
        newTags: [String], existingAccountsWithOpeningBalance: [String]
    ) {
        self.source = source
        self.fileName = fileName
        self.rows = rows
        self.newAccounts = newAccounts
        self.newCategoryPaths = newCategoryPaths
        self.newPayees = newPayees
        self.newTags = newTags
        self.existingAccountsWithOpeningBalance = existingAccountsWithOpeningBalance
        refreshCounts()
    }
}

// MARK: - Building the plan

extension Import {

    /// What a MoneyWiz Report export declares about its accounts, ready to hand
    /// to `buildPlan`.
    ///
    /// An account with no readable currency is dropped: its opening balance is
    /// a count of minor units at an unknown scale, which is not a number. The
    /// parser already refuses one for a currency-less account; this keeps that
    /// true even for a hand-built list.
    public static func reportPlanOptions(_ accounts: [ReportAccount]) -> [DeclaredAccount] {
        accounts.compactMap { a in
            guard !a.currency.isEmpty else { return nil }
            return DeclaredAccount(
                name: a.name, currency: a.currency, openingBalanceMinor: a.openingBalanceMinor
            )
        }
    }

    /// Resolve parsed rows against the book. Writes nothing, reads nothing but
    /// its arguments, and returns the whole plan for the preview screen.
    public static func buildPlan(
        rows: [ParsedRow], ledger: ImportLedger, options: ImportPlanOptions
    ) -> ImportPlan {
        let accountByKey = lastWins(ledger.accounts.map { (nameKey($0.name), $0) })
        let accountById = lastWins(ledger.accounts.map { ($0.id, $0) })
        // Payees and tags are keyed by their STORED `name_lower`, because that
        // is the column the commit step will query (`live_payees WHERE
        // name_lower = ?`). Keying them by the name instead would let the
        // preview promise a payee it is about to create while the write finds
        // the existing one -- a plan that does not describe what happens.
        // `nameKey` is the same rule that column is written with (`Names.key`),
        // so for every row this app has ever written the two agree; where a row
        // arrived some other way, the stored key is the one that decides.
        let payeeByKey = lastWins(ledger.payees.map { ($0.nameLower, $0) })
        let tagKeys = Set(ledger.tags.map(\.nameLower))
        let fixedAccount = options.fixedAccountId.flatMap { accountById[$0] }

        // THE ACCOUNT THE OWNER NAMED, for a file that names none of its own.
        // Only when no existing account was pinned by id, and only when the
        // name is actually a name -- a blank one would file every row under an
        // account called "", which is not somewhere anybody can find money.
        let pinnedName: String? = {
            guard fixedAccount == nil, let pinned = options.fixedNewAccount else { return nil }
            let name = Names.clean(pinned.name)
            return name.isEmpty ? nil : name
        }()

        // The file's declarations, re-keyed the way every account lookup here
        // is keyed, so "Everyday  Current" in a header row still finds
        // "Everyday Current". First occurrence fixes the ORDER, last occurrence
        // fixes the VALUE -- which is what a JavaScript Map does, and the web
        // app's behaviour for a file that names one account twice.
        //
        // THE OWNER'S PINNED ACCOUNT IS ONE OF THEM, and going in here rather
        // than into a branch of its own is the whole point: its currency then
        // fixes the scale of its rows, and its opening balance (if it ever
        // carries one) lands, by exactly the code a Report header row uses.
        // It goes in LAST so a file that declares the same name wins -- the
        // file is describing an export, the picker is describing an intention.
        var declaredOrder: [String] = []
        var declaredByKey: [String: DeclaredAccount] = [:]
        let declarations =
            (pinnedName == nil ? [] : [options.fixedNewAccount].compactMap { $0 })
            + options.declaredAccounts
        for d in declarations {
            let key = nameKey(d.name)
            if declaredByKey[key] == nil { declaredOrder.append(key) }
            declaredByKey[key] = d
        }

        var planRows = rows.map {
            ImportPlanRow(row: $0, action: .add, amountMinor: $0.amountMinor, error: $0.error)
        }
        var newAccounts: [NewAccountPlan] = []
        var newAccountIndexByKey: [String: Int] = [:]
        let decimalStyleFor = decimalStyleDetector(rows)

        // ── 1. account, then currency, then scale, then errors ──────────────
        //
        // ORDER MATTERS AND THIS IS THE ORDER (D31). The ACCOUNT fixes the
        // currency, the currency fixes the minor-unit scale, and only then can
        // an amount be judged. The parser had to guess a currency before the
        // account was known, so a "500" bound for a JPY account is still a
        // hundred times too big at this point, and a valid 3-decimal "12.345"
        // was rejected outright at GBP's two.
        for i in planRows.indices {
            let row = planRows[i].row
            // KNOWN FOR EVERY ROW OF A PINNED IMPORT, INCLUDING ONE THAT
            // CANNOT BE READ. The preview counts an account's skipped rows by
            // the name they were bound for; a row that failed its date has no
            // account name of its own, and without this it would vanish from
            // the account's line entirely -- so the file's row count and the
            // account's "n added, m skipped" would stop adding up.
            if let pinnedName, accountByKey[nameKey(pinnedName)] == nil {
                planRows[i].newAccountName = pinnedName
            }
            if row.date == nil {
                planRows[i].action = .error
                planRows[i].error = row.error ?? "Unparseable row"
                planRows[i].amountMinor = nil
                continue
            }
            // THE NAME THIS ROW GOES UNDER. The owner's pinned name where
            // there is one -- it is exactly as good an answer as a column, and
            // for a file with no Account column it is the only one -- else the
            // file's own. `fixedAccountId` still beats both, unchanged.
            let rowAccountName = pinnedName ?? row.accountName
            let key = rowAccountName.map(nameKey) ?? ""
            let existing = fixedAccount ?? (rowAccountName != nil ? accountByKey[key] : nil)
            if existing == nil && rowAccountName == nil {
                planRows[i].action = .error
                planRows[i].error = row.error ?? "No account for this row"
                planRows[i].amountMinor = nil
                continue
            }
            // A transaction is ALWAYS denominated in its account's currency
            // (D30). An existing account dictates it. A new account takes it
            // from the FILE's declaration for that account -- a Report export
            // states the account's ledger currency on its header row, while a
            // row's Currency column describes the purchase -- and only then
            // from the row, and only then from the book's default.
            let currency =
                existing?.currency
                ?? newAccountIndexByKey[key].map { newAccounts[$0].currency }
                ?? declaredByKey[key]?.currency
                ?? row.currency
                ?? options.defaultCurrency

            // Recorded BEFORE the amount is worked out, so that a row which
            // then fails to parse still says which currency it was judged at.
            planRows[i].resolvedCurrency = currency
            resolveAmount(&planRows[i], at: currency, decimalStyleFor: decimalStyleFor)

            if planRows[i].amountMinor == nil || planRows[i].error != nil {
                planRows[i].action = .error
                planRows[i].error = planRows[i].error ?? "Unparseable row"
                planRows[i].amountMinor = nil
                continue  // an error row must not conjure an account nobody uses
            }
            if let existing {
                planRows[i].accountId = existing.id
            } else {
                // WRITTEN ON THE ROW, not left to be worked out again later.
                // See `ImportPlanRow.newAccountName`.
                let name = Names.clean(rowAccountName ?? "")
                planRows[i].newAccountName = name
                if newAccountIndexByKey[key] == nil {
                    newAccountIndexByKey[key] = newAccounts.count
                    newAccounts.append(
                        NewAccountPlan(
                            name: name,
                            currency: currency,
                            create: true,
                            openingBalanceMinor: declaredByKey[key]?.openingBalanceMinor
                        )
                    )
                }
            }
            // Rows for a new account keep `.add`; the id only exists at commit.
            planRows[i].currencyMismatch = row.currency != nil && row.currency != currency
        }

        // ── 1b. accounts the file declares that no row uses ─────────────────
        //
        // A Report export lists every account, including ones with no
        // transactions in the exported window -- and some of those hold real
        // money. Nothing in `rows` can conjure them, so they are added here
        // from the file's own declarations, and they arrive like any other new
        // account: listed, tickable, and carrying the balance that makes net
        // worth right. Dropping them silently would leave the total short with
        // nothing on screen to explain it.
        for key in declaredOrder {
            guard let d = declaredByKey[key] else { continue }
            if accountByKey[key] != nil || newAccountIndexByKey[key] != nil { continue }
            guard let opening = d.openingBalanceMinor else { continue }  // nothing to import at all
            // An account with no name is not an account the owner can find
            // their money in. `reportPlanOptions` cannot produce one (a header
            // row is only a header row because its Name cell is filled), but
            // this is the only step that creates an account nothing in the file
            // asked for, so it checks rather than assumes.
            let name = Names.clean(d.name)
            guard !name.isEmpty else { continue }
            newAccountIndexByKey[key] = newAccounts.count
            newAccounts.append(
                NewAccountPlan(
                    name: name, currency: d.currency, create: true,
                    openingBalanceMinor: opening
                )
            )
        }

        // Accounts the file states a balance for that we already hold. Their
        // opening balance is NOT rewritten, so the preview has to name them as
        // possibly-not-matching the file.
        var existingAccountsWithOpeningBalance: [String] = []
        for key in declaredOrder where declaredByKey[key]?.openingBalanceMinor != nil {
            if let existing = accountByKey[key] { existingAccountsWithOpeningBalance.append(existing.name) }
        }

        /// The currency a row would be STORED in -- its account's, never the
        /// file's. Step 1 has already decided this for every row that reached
        /// an account, and reading its answer back is what stops the two from
        /// ever drifting apart; only a row that failed before an account was
        /// known has none, and no such row reaches the comparisons below.
        func accountCurrency(_ pr: ImportPlanRow) -> String {
            pr.resolvedCurrency ?? options.defaultCurrency
        }

        // ── 2. transfer pairing ─────────────────────────────────────────────
        //
        // Scanning in file order and taking the first still-unpaired opposite
        // leg makes this "the k-th outgoing leg pairs with the k-th incoming
        // leg" for a given (account pair, date) -- FILE ORDER decides. That is
        // the only signal available across currencies: both legs' amounts are
        // stored explicitly and a rate may never be guessed (SPEC §6), so
        // -€100 and +£85 cannot be matched by magnitude. Where the magnitudes
        // CAN be compared (both accounts hold the same currency) they must
        // match exactly -- and that test uses each row's ACCOUNT currency,
        // never the currency the file declares (D30).
        //
        // The two legs need not share a date: real exports routinely book the
        // money leaving on one day and arriving the next. A same-date partner
        // must never be lost to a day-apart one, so this runs twice -- the
        // first pass is exactly the same-date rule, and the second can only
        // ever see legs the first left over.
        func pairTransfers(maxGapDays: Int) {
            for i in planRows.indices {
                guard planRows[i].action != .error, planRows[i].transferPairIndex == nil,
                      let aTarget = planRows[i].row.transferAccountName,
                      let aDate = planRows[i].row.date.flatMap(CalendarDate.init(iso:)),
                      let aAmount = planRows[i].amountMinor
                else { continue }
                for j in (i + 1)..<planRows.count {
                    guard planRows[j].action != .error, planRows[j].transferPairIndex == nil,
                          let bTarget = planRows[j].row.transferAccountName,
                          let bDate = planRows[j].row.date.flatMap(CalendarDate.init(iso:)),
                          let bAmount = planRows[j].amountMinor
                    else { continue }
                    if nameKey(aTarget) != nameKey(planRows[j].row.accountName ?? "") { continue }
                    if nameKey(bTarget) != nameKey(planRows[i].row.accountName ?? "") { continue }
                    if abs(aDate.daysSince(bDate)) > maxGapDays { continue }
                    let opposite = (aAmount < 0 && bAmount > 0) || (aAmount > 0 && bAmount < 0)
                    if !opposite { continue }
                    if accountCurrency(planRows[i]) == accountCurrency(planRows[j]),
                       abs(aAmount) != abs(bAmount) { continue }
                    planRows[i].transferPairIndex = j
                    planRows[j].transferPairIndex = i
                    break
                }
            }
        }
        pairTransfers(maxGapDays: 0)
        pairTransfers(maxGapDays: 1)

        // ── 3. category paths ───────────────────────────────────────────────
        let resolver = CategoryPathResolver(ledger.categories)
        var newPathOrder: [String] = []
        var newPathByKey: [String: [String]] = [:]
        for i in planRows.indices {
            if planRows[i].action == .error { continue }
            if planRows[i].transferPairIndex != nil { continue }  // paired legs get no category
            let path = planRows[i].row.categoryPath
            if path.isEmpty { continue }
            let preferKind: CategoryKind = (planRows[i].amountMinor ?? 0) < 0 ? .expense : .income
            if let resolved = resolver.resolve(path, preferring: preferKind) {
                planRows[i].chosenCategoryId = resolved
            } else {
                let key = pathKey(path)
                if newPathByKey[key] == nil {
                    newPathOrder.append(key)
                    newPathByKey[key] = path.map(Names.clean)
                }
            }
        }

        // ── 4. payees, and the categories they have taught us ───────────────
        var newPayeeOrder: [String] = []
        var newPayeeByKey: [String: String] = [:]
        for i in planRows.indices {
            if planRows[i].action == .error { continue }
            guard let raw = planRows[i].row.payeeName else { continue }
            let clean = Names.clean(raw)
            let key = nameKey(clean)
            guard let existing = payeeByKey[key] else {
                if newPayeeByKey[key] == nil {
                    newPayeeOrder.append(key)
                    newPayeeByKey[key] = clean
                }
                continue
            }
            // Suggest the learned category only when the row brings none of its
            // own -- what the file says about a transaction beats what a payee
            // usually means.
            if let learned = existing.defaultCategoryId,
               planRows[i].row.categoryPath.isEmpty,
               planRows[i].transferPairIndex == nil {
                planRows[i].suggestedCategoryId = learned
            }
        }
        for i in planRows.indices where planRows[i].action != .error {
            if planRows[i].chosenCategoryId == nil {
                planRows[i].chosenCategoryId = planRows[i].suggestedCategoryId
            }
        }

        // ── 5. tags ─────────────────────────────────────────────────────────
        var newTagOrder: [String] = []
        var newTagByKey: [String: String] = [:]
        for pr in planRows where pr.action != .error {
            for raw in pr.row.tags {
                let clean = Names.clean(raw)
                if clean.isEmpty { continue }
                let key = nameKey(clean)
                if tagKeys.contains(key) || newTagByKey[key] != nil { continue }
                newTagOrder.append(key)
                newTagByKey[key] = clean
            }
        }

        // ── 6. duplicates, against the EXISTING book only ───────────────────
        markDuplicates(&planRows, ledger: ledger)

        return ImportPlan(
            source: options.source,
            fileName: options.fileName,
            rows: planRows,
            newAccounts: newAccounts,
            newCategoryPaths: newPathOrder.compactMap { newPathByKey[$0] },
            newPayees: newPayeeOrder.compactMap { newPayeeByKey[$0] },
            newTags: newTagOrder.compactMap { newTagByKey[$0] },
            existingAccountsWithOpeningBalance: existingAccountsWithOpeningBalance
        )
    }

    // MARK: - Step 1 helpers: scale (D31)

    /// Re-derive a row's amount at the currency its ACCOUNT actually holds, and
    /// refuse it where that cannot be done.
    ///
    /// Three outcomes, and the third is the one that matters:
    ///
    ///  * the parser's scale is already right (both the currency it guessed and
    ///    the account's have two decimals) -- nothing to do;
    ///  * the scale is unconfirmed and the raw cell is available -- re-read it
    ///    at the real currency. Idempotent: re-deriving an already-correct row
    ///    gives the same number back;
    ///  * the scale is unconfirmed and NO single cell produced this amount (a
    ///    debit column and a credit column were both filled) -- then the number
    ///    is provably at the wrong scale and there is nothing to re-read. It
    ///    becomes an ERROR. The web app writes it anyway, at a scale it knows
    ///    is wrong, which is a hundredfold error in a real ledger with nothing
    ///    on screen to explain it; a named refusal is recoverable and a
    ///    plausible wrong number is not.
    private static func resolveAmount(
        _ pr: inout ImportPlanRow, at currency: String,
        decimalStyleFor: (String) -> DecimalStyle
    ) {
        let row = pr.row
        // The parser scaled at some currency it had to guess; two decimals on
        // both sides is the only case where its answer is certainly right.
        let scaleConfirmed =
            Money.decimals(for: currency) == 2 && Money.decimals(for: row.currency ?? "GBP") == 2
        if scaleConfirmed { return }

        guard let text = row.amountText else {
            guard row.amountMinor != nil else { return }  // already an error; say it once
            pr.ambiguousScale = true
            pr.amountMinor = nil
            pr.error =
                "This row's amount came from two separate columns, so it cannot be re-read at "
                + "\(currency)'s scale. Importing it would be off by a factor of "
                + "\(scaleFactorWord(from: row.currency ?? "GBP", to: currency))."
            return
        }
        let rescaled = amountAtCurrency(row, text: text, currency: currency, decimal: decimalStyleFor(currency))
        pr.amountMinor = rescaled
        // With a valid date and an amount cell, the only error the parser can
        // still be carrying is about the amount -- and it reached it at the
        // wrong scale, so its verdict is discarded either way.
        pr.error = rescaled == nil ? "Unrecognised amount \u{201C}\(text)\u{201D}" : nil
    }

    /// Re-derive a row's signed amount at `currency` from the raw cell text.
    /// nil when the text genuinely does not parse at this currency either --
    /// then it IS a row error.
    private static func amountAtCurrency(
        _ row: ParsedRow, text: String, currency: String, decimal: DecimalStyle
    ) -> Int64? {
        guard let parsed = parseImportAmount(text, currency: currency, decimal: .fixed(decimal))
        else { return nil }
        switch row.amountRule {
        case .debit: return parsed == 0 ? 0 : -abs(parsed)  // never store -0
        case .flip: return parsed == 0 ? 0 : -parsed
        case .asWritten: return parsed
        }
    }

    /// "100" / "1,000" — for saying how wrong a refused row would have been.
    private static func scaleFactorWord(from: String, to: String) -> String {
        let factor = max(Money.minorFactor(for: from), Money.minorFactor(for: to))
            / max(1, min(Money.minorFactor(for: from), Money.minorFactor(for: to)))
        return factor >= 1000 ? "1,000" : "\(factor)"
    }

    /// The decimal style stays a per-FILE decision (D27) but depends on how
    /// many decimals the currency has, so it is detected once per distinct
    /// SCALE -- never per row, which would let one file read "1.234" as a
    /// thousand in one row and as one-point-two in the next.
    private static func decimalStyleDetector(_ rows: [ParsedRow]) -> (String) -> DecimalStyle {
        let texts = rows.compactMap(\.amountText)
        // A tiny reference box so the memo survives across calls without making
        // the closure escaping-mutable state anyone else can see.
        final class Memo: @unchecked Sendable { var byDecimals: [Int: DecimalStyle] = [:] }
        let memo = Memo()
        return { currency in
            let decimals = Money.decimals(for: currency)
            if let hit = memo.byDecimals[decimals] { return hit }
            let style = detectDecimalStyle(texts, decimals: decimals)
            memo.byDecimals[decimals] = style
            return style
        }
    }

    // MARK: - Step 3 helper: the category tree

    /// Resolves a path of names against the existing tree, one level at a time.
    private struct CategoryPathResolver {
        private let roots: [Category]
        private let childrenByParent: [String: [Category]]

        init(_ categories: [Category]) {
            // An empty parentId is the same claim as an absent one -- both mean
            // top level, and both occur in files written by different builds.
            roots = categories.filter { ($0.parentId ?? "").isEmpty }
            var children: [String: [Category]] = [:]
            for c in categories {
                guard let parent = c.parentId, !parent.isEmpty else { continue }
                children[parent, default: []].append(c)
            }
            childrenByParent = children
        }

        /// The leaf's id, or nil when any level of the path is missing.
        /// A level with more than one match prefers the kind the row's SIGN
        /// implies, so a refund cannot fork a duplicate tree of the wrong kind.
        func resolve(_ path: [String], preferring kind: CategoryKind) -> String? {
            var current: Category? = nil
            for segment in path {
                let key = Import.nameKey(segment)
                let pool = current.map { childrenByParent[$0.id] ?? [] } ?? roots
                let matches = pool.filter { Import.nameKey($0.name) == key }
                guard let picked = matches.first(where: { $0.kind == kind }) ?? matches.first
                else { return nil }
                current = picked
            }
            return current?.id
        }
    }

    // MARK: - Step 6: duplicates (D32)

    /// Mark rows that duplicate something ALREADY in the book, consuming each
    /// match so one existing transaction can never explain two incoming rows.
    ///
    /// Two passes, and the order between them is load-bearing: EXACT matches
    /// run first so that a near duplicate can never steal the transaction an
    /// exact re-import needs.
    ///
    /// Both passes are INDEXED rather than scanned. A linear search per row
    /// over an account's candidates makes a first import quadratic (in the web
    /// app: twenty thousand rows against fifty thousand existing, seventeen
    /// seconds of frozen main thread), and this runs on a phone.
    private static func markDuplicates(_ planRows: inout [ImportPlanRow], ledger: ImportLedger) {
        let dedupeIndices = planRows.indices.filter {
            planRows[$0].action != .error && planRows[$0].accountId != nil
        }
        guard !dedupeIndices.isEmpty else { return }

        let dates = dedupeIndices.compactMap { planRows[$0].row.date }
        guard let minDate = dates.min().flatMap(CalendarDate.init(iso:)),
              let maxDate = dates.max().flatMap(CalendarDate.init(iso:))
        else { return }
        let from = minDate.addingDays(-1).iso  // the same ±1 day the near check uses
        let to = maxDate.addingDays(1).iso
        let accountIds = Set(dedupeIndices.compactMap { planRows[$0].accountId })

        // Ordered the way the web app's `[accountId+date]` index yields them:
        // date ascending, then by primary key among equal dates. "First match
        // wins" and "prefer the nearest date" have to resolve to the same
        // transaction in both implementations or the two apps disagree about
        // which row the owner is being shown.
        let candidates = ledger.transactions
            .filter { accountIds.contains($0.accountId) && $0.date >= from && $0.date <= to }
            .sorted { ($0.date, $0.id) < ($1.date, $1.id) }

        var indexByAccount: [String: AccountDedupeIndex] = [:]
        for id in accountIds { indexByAccount[id] = AccountDedupeIndex() }
        for tx in candidates { indexByAccount[tx.accountId]?.insert(tx) }

        let payeeNameById = lastWins(ledger.payees.map { ($0.id, $0.name) })
        func payeeNameOf(_ t: Transaction) -> String {
            guard let id = t.payeeId else { return t.notes }
            return payeeNameById[id] ?? ""
        }
        /// The same payee-if-present-else-description rule the commit step uses
        /// for `dedupeHash`, so a re-import of this file matches its own rows.
        func labelOf(_ pr: ImportPlanRow) -> String {
            pr.row.payeeName ?? pr.row.description ?? ""
        }

        // Pass 1 -- exact. Candidates are queued per dedupe key and consumed
        // from the front, so N identical existing transactions absorb exactly N
        // incoming rows and no more (D32).
        var needsNearCheck: [Int] = []
        for i in dedupeIndices {
            guard let index = indexByAccount[planRows[i].accountId!],
                  let date = planRows[i].row.date, let amount = planRows[i].amountMinor
            else { continue }
            let hash = Dedupe.makeDedupeHash(
                accountId: planRows[i].accountId!, date: date, amountMinor: amount,
                payeeOrDescription: labelOf(planRows[i])
            )
            if index.takeExact(hash) != nil {
                planRows[i].action = .skipExactDuplicate
            } else {
                needsNearCheck.append(i)
            }
        }

        // Pass 2 -- near. Same account, same amount, within a day, similar
        // payee. Never resolved automatically: the row is flagged, defaulted to
        // skip, and shown. No exact-hash candidate can remain here, so this only
        // has to find the nearest similar row.
        for i in needsNearCheck {
            guard let index = indexByAccount[planRows[i].accountId!],
                  let date = planRows[i].row.date, let amount = planRows[i].amountMinor,
                  let day = CalendarDate(iso: date)
            else { continue }
            let label = labelOf(planRows[i])
            // Nearest first: a same-date partner always beats a day-apart one,
            // and the earlier neighbour beats the later, matching
            // `Dedupe.checkDuplicate`.
            let window = [date, day.addingDays(-1).iso, day.addingDays(1).iso]
            guard let found = index.takeNear(
                amountMinor: amount, dates: window,
                isSimilar: { Dedupe.similarPayee(label, payeeNameOf($0)) }
            ) else { continue }
            planRows[i].action = .needsDecision
            planRows[i].nearDuplicateOf = found
            planRows[i].decision = .skip  // never silently doubled -- the owner opts in
        }
    }

    /// One account's existing transactions, indexed for both dedupe passes and
    /// able to say what has already been claimed.
    ///
    /// A reference type on purpose: the alternative is copying two dictionaries
    /// of arrays on every row, which is the quadratic cost this index exists to
    /// remove.
    private final class AccountDedupeIndex {
        private struct Queue { var items: [Transaction]; var next: Int }
        private var byHash: [String: Queue] = [:]
        private var byAmountDate: [String: [Transaction]] = [:]
        private var consumed: Set<String> = []

        private static func amountDateKey(_ amountMinor: Int64, _ date: String) -> String {
            "\(amountMinor)|\(date)"
        }

        /// Insertion order is the caller's; both structures preserve it.
        func insert(_ t: Transaction) {
            byHash[t.dedupeHash, default: Queue(items: [], next: 0)].items.append(t)
            byAmountDate[Self.amountDateKey(t.amountMinor, t.date), default: []].append(t)
        }

        /// The next unclaimed transaction with this exact key, claimed.
        func takeExact(_ hash: String) -> Transaction? {
            guard var queue = byHash[hash], queue.next < queue.items.count else { return nil }
            let taken = queue.items[queue.next]
            queue.next += 1
            byHash[hash] = queue
            consumed.insert(taken.id)
            return taken
        }

        /// The nearest unclaimed transaction of this amount on one of `dates`
        /// (in the caller's preference order) whose payee is similar, claimed.
        func takeNear(
            amountMinor: Int64, dates: [String], isSimilar: (Transaction) -> Bool
        ) -> Transaction? {
            for date in dates {
                let key = Self.amountDateKey(amountMinor, date)
                guard var bucket = byAmountDate[key] else { continue }
                var found: Transaction? = nil
                var k = 0
                while k < bucket.count {
                    let t = bucket[k]
                    // Claimed by the exact pass: drop it lazily, which keeps the
                    // whole scan amortised linear.
                    if consumed.contains(t.id) { bucket.remove(at: k); continue }
                    if !isSimilar(t) { k += 1; continue }
                    found = t
                    bucket.remove(at: k)
                    break
                }
                byAmountDate[key] = bucket
                if let found {
                    consumed.insert(found.id)
                    return found
                }
            }
            return nil
        }
    }

    // MARK: - Small shared helpers

    /// A category path as one comparable key.
    static func pathKey(_ path: [String]) -> String {
        path.map(nameKey).joined(separator: ">")
    }

    /// Build a lookup where a repeated key keeps the LAST value, which is what
    /// the web app's `new Map(pairs)` does. Duplicate account or payee names
    /// should not exist, and a plan that silently changed behaviour if one did
    /// would be a difference between the two apps nobody could see.
    private static func lastWins<V>(_ pairs: [(String, V)]) -> [String: V] {
        Dictionary(pairs, uniquingKeysWith: { _, latest in latest })
    }
}
