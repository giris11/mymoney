// The numbers the preview shows, worked out once, away from the drawing.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PREVIEW IS THE POINT, AND A PREVIEW IS ONLY WORTH READING IF IT CAN BE
// CHECKED
//
// "312 transactions will be imported" is a reassurance. "312 transactions, into
// these four accounts, 47 of them here and 9 skipped as already present, and
// this account ends at the balance your file states" is arithmetic somebody can
// hold against the file on their screen. So every figure below is derived from
// the plan's own rows -- the same rows the commit will write -- and never from
// a separate count that could drift from them.
//
// ONE RULE FOR "WILL THIS ROW BE WRITTEN", AND IT IS THE ENGINE'S. `isImportable`
// is a stored flag on the plan row, set by `ImportPlan.refreshCounts` alongside
// every total the screen shows. Nothing here re-derives it. If this file
// answered that question its own way, the account balances shown would be sums
// over a different set of rows from the one the commit writes -- and the
// preview would promise a balance the import does not deliver.
import Foundation
import MyMoneyKit

// MARK: - Where the money is going

/// One account this file touches, and what the import does to it.
struct ImportAccountLine: Identifiable, Hashable {
    enum Status: Hashable {
        /// Already in the book. Its rows are added to it.
        case existing
        /// Will be created by this import.
        case willCreate
        /// Would be created, but the owner has unticked it -- so its rows are
        /// not imported either.
        case notCreated
        /// The file names it and nothing is going into it.
        case untouched
    }

    /// Matched the way every account lookup is matched: case and whitespace
    /// insensitively. `Names.key` is the rule the store's own `name_lower`
    /// column is written with, and the kit holds a test asserting it is the
    /// same rule the importer uses.
    let key: String
    let name: String
    let currency: String
    let status: Status
    /// Transactions that will be written into this account.
    let importedCount: Int
    /// Their sum, in this account's currency (a transaction is always stored in
    /// its account's currency -- D30 -- so this is a real total, not a mixture).
    let importedNetMinor: Int64
    /// Rows of this account that will NOT be written: duplicates, near
    /// duplicates left set to skip, rows that could not be read.
    let skippedCount: Int

    // The rest is only ever filled for a MoneyWiz Report export, which is the
    // one layout that states each account's balance.

    /// The opening balance derived from the file: stated closing balance minus
    /// that account's own rows. nil when the file could not be trusted to state
    /// one.
    let fileOpeningMinor: Int64?
    /// True when that opening balance will actually be written -- which is only
    /// for an account being CREATED. An account already here keeps the opening
    /// balance it has.
    let openingApplied: Bool
    /// opening + net: where the account ends up. nil when either half is
    /// unknown.
    let finalMinor: Int64?
    /// The balance the file states for this account.
    let fileBalanceMinor: Int64?
    /// finalMinor − fileBalanceMinor. Zero means this account will end up
    /// exactly where the file says it should.
    let differenceMinor: Int64?

    var id: String { key }

    /// True when this account will land exactly on the figure the file states.
    var matchesFile: Bool { differenceMinor == 0 }
}

enum ImportPreview {

    /// One line per account the file touches, in the file's own order.
    ///
    /// File order, not alphabetical: it is the order the accounts appear in the
    /// export, so the list and the file can be read side by side. For a Report
    /// export that is the order MoneyWiz itself lists them in.
    static func accountLines(
        plan: ImportPlan, context: ImportContext, reportAccounts: [ReportAccount]
    ) -> [ImportAccountLine] {
        struct Tally {
            var name: String
            var currency: String
            var imported = 0
            var net: Int64 = 0
            var skipped = 0
            var resolvedToExisting = false
        }

        var order: [String] = []
        var tallies: [String: Tally] = [:]

        for row in plan.rows {
            // The name to show is the one the account will HAVE: an existing
            // account's own name where the row resolved to one, so a file
            // spelling it differently does not appear as a second account.
            let existing = row.accountId.flatMap { context.accountsById[$0] }
            // THE PLAN'S ANSWER FOR A NEW ACCOUNT, not the file's. A statement
            // pinned to an account the owner named has no account name on any
            // of its rows, and reading `row.row.accountName` here left every
            // one of them nameless -- so the section that exists to say where
            // the money is going drew nothing at all.
            let displayName =
                existing?.name ?? row.newAccountName ?? Names.clean(row.row.accountName ?? "")
            guard !displayName.isEmpty else { continue }
            let key = Names.key(displayName)
            let currency =
                existing?.currency ?? row.resolvedCurrency
                ?? plan.newAccounts.first { Names.key($0.name) == key }?.currency
                ?? context.baseCurrency
            if tallies[key] == nil {
                order.append(key)
                tallies[key] = Tally(name: displayName, currency: currency)
            }
            if existing != nil { tallies[key]?.resolvedToExisting = true }
            if row.isImportable {
                tallies[key]?.imported += 1
                tallies[key]?.net += row.amountMinor ?? 0
            } else {
                tallies[key]?.skipped += 1
            }
        }

        // Accounts the FILE declares that no row uses. A Report export lists
        // every account, including ones with no transactions in the exported
        // window -- and the plan may still be creating them, at the balance
        // that makes net worth right. Leaving them out of this list would leave
        // an account being created with nothing on screen to say so.
        for account in reportAccounts {
            let key = Names.key(account.name)
            guard !key.isEmpty, tallies[key] == nil else { continue }
            order.append(key)
            tallies[key] = Tally(
                name: account.name,
                currency: account.currency.isEmpty ? context.baseCurrency : account.currency
            )
        }

        // Report order wins where there is one: it is the file's own order.
        if !reportAccounts.isEmpty {
            var fileOrder: [String] = []
            for account in reportAccounts {
                let key = Names.key(account.name)
                if tallies[key] != nil, !fileOrder.contains(key) { fileOrder.append(key) }
            }
            for key in order where !fileOrder.contains(key) { fileOrder.append(key) }
            order = fileOrder
        }

        let existingKeys = Set(context.ledger.accounts.map { Names.key($0.name) })
        let plannedByKey = Dictionary(
            plan.newAccounts.map { (Names.key($0.name), $0) }, uniquingKeysWith: { first, _ in first }
        )
        let reportByKey = Dictionary(
            reportAccounts.map { (Names.key($0.name), $0) }, uniquingKeysWith: { first, _ in first }
        )

        return order.compactMap { key -> ImportAccountLine? in
            guard let tally = tallies[key] else { return nil }
            let planned = plannedByKey[key]
            let status: ImportAccountLine.Status
            if existingKeys.contains(key) || tally.resolvedToExisting {
                status = .existing
            } else if let planned {
                status = planned.create ? .willCreate : .notCreated
            } else {
                status = .untouched
            }

            // The engine's opening balance beats the parser's where both exist:
            // the engine knows the account's real currency, and so its real
            // minor-unit scale.
            let fileOpening = planned?.openingBalanceMinor ?? reportByKey[key]?.openingBalanceMinor
            let openingApplied = status == .willCreate && fileOpening != nil
            let finalMinor = openingApplied ? fileOpening.map { $0 + tally.net } : nil
            let fileBalance = reportByKey[key]?.currentBalanceMinor
            return ImportAccountLine(
                key: key,
                name: planned?.name ?? tally.name,
                currency: planned?.currency ?? tally.currency,
                status: status,
                importedCount: tally.imported,
                importedNetMinor: tally.net,
                skippedCount: tally.skipped,
                fileOpeningMinor: fileOpening,
                openingApplied: openingApplied,
                finalMinor: finalMinor,
                fileBalanceMinor: fileBalance,
                differenceMinor: (finalMinor != nil && fileBalance != nil)
                    ? finalMinor! - fileBalance! : nil
            )
        }
    }

    // MARK: - The awkward things, said out loud

    /// Rows whose file declares a currency their account does not use.
    ///
    /// The import is not blocked and nothing is converted: the row is written
    /// in the ACCOUNT's currency, because balances, net worth and every chart
    /// sum an account's amounts with no currency check (D30). A guessed
    /// exchange rate would be a made-up number in a ledger. So it is disclosed.
    static func currencyMismatchNote(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        if count == 1 {
            return "1 row is in a different currency from its account. It will be stored in the "
                + "account\u{2019}s currency, at the number written in the file \u{2014} nothing "
                + "is converted, because this app never guesses an exchange rate."
        }
        return "\(Display.grouped(count)) rows are in a different currency from their accounts. "
            + "They will be stored in their accounts\u{2019} currencies, at the numbers written "
            + "in the file \u{2014} nothing is converted, because this app never guesses an "
            + "exchange rate."
    }

    /// Transfer legs whose opposite half is not being written.
    ///
    /// Each becomes an ordinary uncategorised transaction, and every report in
    /// this app reads an uncategorised transaction BY SIGN -- so each one is
    /// real income or real spending as far as the charts are concerned. That is
    /// worth a sentence rather than a silent absorption.
    static func unpairedTransferNote(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        if count == 1 {
            return "1 transfer leg has no matching opposite row in this file, so it imports as an "
                + "ordinary uncategorised transaction. It will count as income or spending in "
                + "your reports until you categorise it."
        }
        return "\(Display.grouped(count)) transfer legs have no matching opposite row in this "
            + "file, so they import as ordinary uncategorised transactions. They will count as "
            + "income or spending in your reports until you categorise them."
    }

    /// Accounts the file states a balance for that this book already has.
    ///
    /// Their opening balance is deliberately left alone -- rewriting a balance
    /// the owner set, or one a previous import derived from a longer history,
    /// would move money they never touched. The cost is that these accounts can
    /// end up disagreeing with the file, and that has to be said rather than
    /// discovered.
    static func existingOpeningBalanceNote(_ names: [String]) -> String? {
        guard !names.isEmpty else { return nil }
        let list = names.joined(separator: ", ")
        if names.count == 1 {
            return "\(list) is already here, so the opening balance in the file was NOT applied "
                + "to it. Only its transactions are being added, so its total may not match the "
                + "file."
        }
        return "\(Display.grouped(names.count)) of these accounts are already here (\(list)), so "
            + "the opening balances in the file were NOT applied to them. Only their transactions "
            + "are being added, so their totals may not match the file."
    }

    // MARK: - One row

    /// What is happening to a single row, in two or three words.
    static func statusLabel(_ row: ImportPlanRow, in plan: ImportPlan) -> (text: String, tone: RowTone)? {
        switch row.action {
        case .error:
            return ("Cannot be read", .problem)
        case .skipExactDuplicate:
            return ("Already in your book", .muted)
        case .needsDecision:
            return row.decision == .add
                ? ("Near-duplicate \u{2014} importing", .warning)
                : ("Near-duplicate \u{2014} skipped", .warning)
        case .add:
            if !row.isImportable { return ("Account not being created", .muted) }
            // The same rule the engine counts `unpairedTransferCount` by, so
            // the summary figure can be traced to these exact rows.
            if row.row.transferAccountName != nil {
                let partner = row.transferPairIndex.flatMap { index in
                    plan.rows.indices.contains(index) ? plan.rows[index] : nil
                }
                if partner == nil || partner?.isImportable != true {
                    return ("Unpaired transfer leg", .warning)
                }
                return ("Transfer", .accent)
            }
            return nil
        }
    }

    enum RowTone { case muted, warning, problem, accent }
}
