// MoneyWiz's *Report* CSV, ported from src/import/moneywizReport.ts
// (SPEC §7.1). This is the layout the owner's real 58-account export arrives
// in, and it is structurally different from the flat transaction export:
//
//   Name,Current balance,Account,Transfers,Description,Payee,Category,Date,
//   Memo,Amount,Currency,Cheque N°,Tags,Balance
//
//  * the file is a sequence of GROUPS, each starting with an ACCOUNT HEADER
//    row — "Name" non-empty — carrying the account's name, its final balance,
//    and (the trap) its CURRENCY in the "Account" column;
//  * the rows after it are TRANSACTION rows with an empty "Name", where the
//    "Account" column holds the account NAME instead. Grouping is not relied
//    on: a transaction is attributed by its own Account cell, so a re-sorted
//    or filtered export still reads correctly;
//  * an Excel `sep=,` hint line precedes the header row, and `CSV.parse` drops
//    it.
//
// DETECTION PRECEDENCE — READ THIS. `isMoneyWizCsv` (the flat parser's test)
// ALSO returns true for these headers: they contain Account, Date, Amount and
// Payee, which is all it asks for. Nothing in that function can tell the two
// apart. So every caller MUST test `isMoneyWizReportCsv` FIRST and only fall
// through to `isMoneyWizCsv` when it is false. Reading a Report file with the
// flat parser is not a cosmetic failure: every account header row becomes a
// transaction with no date, the "Account" column reads GBP/TRY as an account
// NAME, and no opening balance is ever derived.
//
// BALANCES — THE POINT OF THIS PARSER. For every account:
//
//     openingBalanceMinor = currentBalanceMinor − Σ(that account's amounts)
//
// which is ORDER-INDEPENDENT, and therefore immune to the one thing this
// export gets wrong: its running "Balance" column disagrees with row order
// among same-date rows. That column is never used to derive anything.
//
// AND THE REFUSAL THAT MATTERS MOST: the opening balance is nil — refused —
// whenever it cannot be trusted (unreadable current balance, unknown currency,
// or ANY row of that account that will not import). A guessed opening balance
// silently poisons every balance, budget and report for that account for ever,
// and nothing downstream can detect it. A named refusal is recoverable; a
// plausible wrong number is not.
import Foundation

/// One account as the file's header rows describe it.
public struct ReportAccount: Sendable, Hashable {
    public let name: String
    /// ISO code from the header row's "Account" cell, or "" when unreadable.
    public let currency: String
    /// The file's stated final balance in minor units; nil = unreadable.
    public let currentBalanceMinor: Int64?
    /// currentBalanceMinor − Σ(amounts), or nil when it cannot be trusted.
    public let openingBalanceMinor: Int64?
}

public struct MoneyWizReportResult: Sendable {
    public let rows: [ParsedRow]
    public let accounts: [ReportAccount]
    /// English prose for a human; advisory in the oracle. A port is bound by
    /// WHEN a warning is raised, not by its wording.
    public let warnings: [String]
    public let detectedDateFormat: DateOrder
}

enum ReportField: String, CaseIterable {
    case name, currentBalance, account, transfers, description
    case payee, category, date, time, memo, amount, currency
    case cheque, tags, balance
}

/// Case-insensitive header synonyms. 'time', 'cheque' and 'balance' are
/// recognised so they do not trigger unknown-column warnings, then ignored.
///
/// `currentBalance` is resolved BEFORE `balance` (the declaration order of
/// `ReportField` is the resolution order) so a "Current balance" header can
/// never be consumed by the plain "Balance" slot — which would leave the
/// parser with no balances at all and every opening balance refused.
private let reportSynonyms: [ReportField: [String]] = [
    .name: ["name"],
    .currentBalance: ["current balance", "currentbalance"],
    .account: ["account", "account name"],
    .transfers: ["transfers", "transfer"],
    .description: ["description"],
    .payee: ["payee"],
    .category: ["category"],
    .date: ["date"],
    .time: ["time"],
    .memo: ["memo", "notes", "note"],
    .amount: ["amount"],
    .currency: ["currency"],
    .cheque: [
        "cheque n°", "cheque no", "cheque no.", "cheque #", "cheque number", "cheque",
        "check n°", "check no", "check no.", "check #", "check number",
    ],
    .tags: ["tags", "tag"],
    .balance: ["balance"],
]

extension Import {
    /// Is this the MoneyWiz *Report* layout?
    ///
    /// Deliberately STRICTER than `isMoneyWizCsv`: it demands the two columns
    /// only this layout has — "Name" and "Current balance" — alongside
    /// Account/Date/Amount. A flat export has neither, so this can never steal
    /// a file the flat parser handles. The reverse is not true; see the
    /// precedence note above.
    public static func isMoneyWizReportCsv(headers: [String]) -> Bool {
        let (cols, _) = resolveColumns(headers, order: ReportField.allCases, synonyms: reportSynonyms)
        return cols[.name]! >= 0 && cols[.currentBalance]! >= 0 && cols[.account]! >= 0
            && cols[.date]! >= 0 && cols[.amount]! >= 0
    }

    /// At most `max` names, then "and N more" — a warning about a file with
    /// dozens of accounts has to stay readable.
    static func nameList(_ names: [String], max: Int = 5) -> String {
        let quoted = names.prefix(max).map { "“\($0)”" }
        let rest = names.count - quoted.count
        return rest > 0
            ? "\(quoted.joined(separator: ", ")) and \(rest) more"
            : quoted.joined(separator: ", ")
    }

    /// '►' is what the Report export uses for a category path; '>' is the flat
    /// export's. Both are separators here, and '/' stays the D20 fallback —
    /// used ONLY when neither appears anywhere in the column.
    ///
    /// This is not cosmetic. Applying the flat parser's rule ("no '>' anywhere
    /// ⇒ split on '/'") to a '►' file cuts every path at the wrong character:
    /// a leaf whose NAME contains a slash mints a top-level category called
    /// "Parent ► Child" with an invented child of its own, and every
    /// transaction under it is filed there.
    static func isPathSeparator(_ c: Character) -> Bool { c == ">" || c == "\u{25BA}" }

    private struct AccountBuild {
        let name: String
        var currency: String
        let balanceText: String
        var sumMinor: Int64 = 0
        /// Rows of this account that will NOT import (bad date or bad amount).
        var unusableRows = 0
        var txRows = 0
        /// Distinct currencies this account's rows declare.
        var declaredCurrencies: [String] = []
    }

    /// Parse a MoneyWiz Report export.
    public static func parseMoneyWizReportCsv(
        _ text: String, dateFormat: DateOrderOption = .auto
    ) -> MoneyWizReportResult {
        let table = CSV.parse(text)
        var warnings = table.errors
        let headers = (table.data.first ?? []).map { trim($0) }
        let (cols, unknown) = resolveColumns(
            headers, order: ReportField.allCases, synonyms: reportSynonyms
        )
        for u in unknown { warnings.append("Ignoring unrecognised column “\(u)”") }
        func col(_ f: ReportField) -> Int { cols[f] ?? -1 }

        let raw = table.data.dropFirst().filter { row in row.contains { !trim($0).isEmpty } }
        // An account header row is the one with a non-empty "Name"; everything
        // else is a transaction. `index` counts EVERY data row, header rows
        // included, so the number a user is shown points at a findable line.
        func isAccountHeader(_ row: [String]) -> Bool { !cell(row, col(.name)).isEmpty }
        let txRaw = raw.enumerated()
            .map { (row: $0.element, index: $0.offset + 1) }
            .filter { !isAccountHeader($0.row) }

        // ---- account header rows -------------------------------------------
        var accountOrder: [String] = []           // nameKey, in file order
        var accounts: [String: AccountBuild] = [:]
        var duplicateNames: [String] = []
        for row in raw where isAccountHeader(row) {
            let name = cell(row, col(.name))
            let key = nameKey(name)
            if accounts[key] != nil {
                duplicateNames.append(name)
                continue  // first header wins; its balance is what we reconcile to
            }
            let currencyRaw = cell(row, col(.account))
            accountOrder.append(key)
            accounts[key] = AccountBuild(
                name: name,
                // The "Account" column on a HEADER row is the account's CURRENCY.
                currency: currencyRaw.count == 3 && currencyRaw.allSatisfy(isASCIILetter)
                    ? currencyRaw.uppercased() : "",
                balanceText: cell(row, col(.currentBalance))
            )
        }
        if !duplicateNames.isEmpty {
            var distinct: [String] = []
            for n in duplicateNames where !distinct.contains(n) { distinct.append(n) }
            warnings.append(
                "\(duplicateNames.count) account \(duplicateNames.count == 1 ? "row is" : "rows are") "
                    + "repeated in this file (\(nameList(distinct))); the first balance is used."
            )
        }

        // A header row with an unreadable currency falls back to what its own
        // transactions declare, so the minor-unit scale is still right.
        for entry in txRaw {
            let key = nameKey(cell(entry.row, col(.account)))
            guard var acc = accounts[key], acc.currency.isEmpty else { continue }
            let c = cell(entry.row, col(.currency))
            if c.count == 3, c.allSatisfy(isASCIILetter) {
                acc.currency = c.uppercased()
                accounts[key] = acc
            }
        }

        // ---- per-FILE detection (never per row) ----------------------------
        let detected = detectDateFormat(txRaw.map { cell($0.row, col(.date)) })
        let order: DateOrder
        switch dateFormat {
        case .auto: order = detected
        case .fixed(let fixed): order = fixed
        }
        // Both money columns feed the decimal-style vote: the balances are
        // written in the same style as the amounts and add one more sample per
        // account, which matters for an export whose amounts are all small and
        // unseparated.
        let decimal = detectDecimalStyle(
            txRaw.map { cell($0.row, col(.amount)) } + accountOrder.map { accounts[$0]!.balanceText }
        )
        let columnHasPathSep = txRaw.contains { cell($0.row, col(.category)).contains(where: isPathSeparator) }
        var slashPaths: [String] = []
        var seenSlashPaths = Set<String>()

        // ---- transaction rows ----------------------------------------------
        var unknownAccounts: [String] = []
        var seenUnknownAccounts = Set<String>()
        var badDates = 0
        var badAmounts = 0

        let rows: [ParsedRow] = txRaw.map { entry in
            let row = entry.row
            let accountNameCell = cell(row, col(.account))
            let accountName: String? = accountNameCell.isEmpty ? nil : accountNameCell
            let key = nameKey(accountNameCell)
            let acc = accountNameCell.isEmpty ? nil : accounts[key]
            if let name = accountName, acc == nil, !seenUnknownAccounts.contains(name) {
                seenUnknownAccounts.insert(name)
                unknownAccounts.append(name)
            }

            let currencyRaw = cell(row, col(.currency))
            let currency: String? =
                currencyRaw.count == 3 && currencyRaw.allSatisfy(isASCIILetter)
                ? currencyRaw.uppercased() : nil
            let dateRaw = cell(row, col(.date))
            let date = dateRaw.isEmpty ? nil : parseDateString(dateRaw, format: .fixed(order))
            let amountRaw = cell(row, col(.amount))
            // Scale at the ACCOUNT's currency first: this layout states it
            // outright, and a transaction is always denominated in its
            // account's currency (SPEC §6). The row's own Currency column is
            // the fallback, then GBP's 2 decimals.
            let scaleCurrency = (acc?.currency.isEmpty == false ? acc!.currency : nil) ?? currency ?? "GBP"
            let amountMinor = amountRaw.isEmpty
                ? nil
                : parseImportAmount(amountRaw, currency: scaleCurrency, decimal: .fixed(decimal))

            var error: String? = nil
            if date == nil {
                error = "Unrecognised date “\(dateRaw)”"
                badDates += 1
            } else if amountMinor == nil {
                error = "Unrecognised amount “\(amountRaw)”"
                badAmounts += 1
            }

            if var build = acc {
                build.txRows += 1
                if let currency, !build.declaredCurrencies.contains(currency) {
                    build.declaredCurrencies.append(currency)
                }
                if error != nil {
                    build.unusableRows += 1
                } else {
                    // The rows are what the opening balance is derived from, so
                    // an overflow here has to stop the derivation rather than
                    // wrap: `unusableRows` is the same refusal channel a bad
                    // row uses, and it is the honest one.
                    let (next, overflowed) = build.sumMinor.addingReportingOverflow(amountMinor!)
                    if overflowed { build.unusableRows += 1 } else { build.sumMinor = next }
                }
                accounts[key] = build
            }

            let catRaw = cell(row, col(.category))
            let categoryPath: [String]
            if catRaw.isEmpty {
                categoryPath = []
            } else if columnHasPathSep {
                categoryPath = catRaw.split(whereSeparator: isPathSeparator)
                    .map { trim(String($0)) }.filter { !$0.isEmpty }
            } else {
                categoryPath = catRaw.split(separator: "/", omittingEmptySubsequences: false)
                    .map { trim(String($0)) }.filter { !$0.isEmpty }
            }
            if !columnHasPathSep, categoryPath.count > 1, !seenSlashPaths.contains(catRaw) {
                seenSlashPaths.insert(catRaw)
                slashPaths.append(catRaw)
            }

            let payeeName = cell(row, col(.payee))
            let descriptionCell = cell(row, col(.description))
            let memo = cell(row, col(.memo))
            let transfers = cell(row, col(.transfers))
            return ParsedRow(
                index: entry.index,
                date: date,
                amountMinor: amountMinor,
                currency: currency,
                accountName: accountName,
                payeeName: payeeName.isEmpty ? nil : payeeName,
                description: descriptionCell.isEmpty ? nil : descriptionCell,
                categoryPath: categoryPath,
                tags: splitMoneyWizTags(cell(row, col(.tags))),
                notes: memo.isEmpty ? nil : memo,
                transferAccountName: transfers.isEmpty ? nil : transfers,
                amountText: amountRaw.isEmpty ? nil : amountRaw,
                amountRule: .asWritten,
                error: error
            )
        }

        // ---- balances -------------------------------------------------------
        var unreadableBalances: [String] = []
        var unknownCurrency: [String] = []
        var poisoned: [String] = []
        var balanceOnly: [String] = []
        let out: [ReportAccount] = accountOrder.map { key in
            let a = accounts[key]!
            let currentBalanceMinor = a.balanceText.isEmpty
                ? nil
                : parseImportAmount(
                    a.balanceText, currency: a.currency.isEmpty ? "GBP" : a.currency,
                    decimal: .fixed(decimal)
                )
            var openingBalanceMinor: Int64? = nil
            if currentBalanceMinor == nil {
                unreadableBalances.append(a.name)
            } else if a.currency.isEmpty {
                // No currency ⇒ no minor-unit SCALE, and the figures above were
                // read at the 2-decimal fallback. If the account then lands in
                // a 0- or 3-decimal currency, an opening balance carried over
                // from here is out by a factor of 100 or 1000 — invisibly.
                unknownCurrency.append(a.name)
            } else if a.unusableRows > 0 {
                // Every row that fails to import moves the account's balance by
                // its own amount, so `balance − Σ(the rows that DID parse)` is
                // not the opening balance — it is that number plus the missing
                // rows.
                poisoned.append(a.name)
            } else {
                let (opening, overflowed) = currentBalanceMinor!.subtractingReportingOverflow(a.sumMinor)
                openingBalanceMinor = overflowed ? nil : opening
            }
            if a.txRows == 0 { balanceOnly.append(a.name) }
            return ReportAccount(
                name: a.name, currency: a.currency,
                currentBalanceMinor: currentBalanceMinor,
                openingBalanceMinor: openingBalanceMinor
            )
        }

        // ---- warnings -------------------------------------------------------
        if !unreadableBalances.isEmpty {
            let n = unreadableBalances.count
            warnings.append(
                "\(n) \(n == 1 ? "account has" : "accounts have") an unreadable “Current balance” "
                    + "(\(nameList(unreadableBalances))); they will be created with a zero opening "
                    + "balance, so their totals will not match the file."
            )
        }
        if !unknownCurrency.isEmpty {
            warnings.append(
                "No currency could be read for \(nameList(unknownCurrency)) — the account row should "
                    + "carry an ISO code (GBP, TRY…) in its “Account” column. "
                    + "\(unknownCurrency.count == 1 ? "It is" : "They are") imported without an opening "
                    + "balance, because a balance read at the wrong number of decimals is out by a "
                    + "factor of 100."
            )
        }
        if !poisoned.isEmpty {
            warnings.append(
                "No opening balance could be derived for \(nameList(poisoned)) — "
                    + "\(poisoned.count == 1 ? "it has" : "they have") rows that cannot be imported, "
                    + "and guessing from the rest would leave every balance and report for "
                    + "\(poisoned.count == 1 ? "that account" : "those accounts") quietly wrong. "
                    + "Fix the rows flagged below and re-import."
            )
        }
        if !unknownAccounts.isEmpty {
            let n = unknownAccounts.count
            warnings.append(
                "\(n) account \(n == 1 ? "name is" : "names are") used by transactions but never "
                    + "declared by an account row (\(nameList(unknownAccounts))); those transactions "
                    + "import, but with no opening balance."
            )
        }
        if badDates > 0 {
            warnings.append(
                "\(badDates) row\(badDates == 1 ? "" : "s") have an unreadable date and cannot be imported."
            )
        }
        if badAmounts > 0 {
            warnings.append(
                "\(badAmounts) row\(badAmounts == 1 ? "" : "s") have an unreadable amount and cannot be imported."
            )
        }
        if !balanceOnly.isEmpty {
            let n = balanceOnly.count
            warnings.append(
                "\(n) account\(n == 1 ? "" : "s") have a balance but no transactions in this file "
                    + "(\(nameList(balanceOnly)))."
            )
        }
        // Mixed currencies inside one account, measured against the header
        // row's own declaration.
        for key in accountOrder {
            let a = accounts[key]!
            if a.currency.isEmpty { continue }
            let declared = a.declaredCurrencies.filter { $0 != a.currency }
            if declared.isEmpty { continue }
            warnings.append(
                "Account “\(a.name)” is \(a.currency) but has rows in \(declared.joined(separator: ", ")); "
                    + "those amounts are imported as stated, in the account's currency, never converted."
            )
        }
        if col(.currency) == -1 {
            warnings.append("No Currency column — amounts assume the account currency")
        }
        if let example = slashPaths.first {
            let n = slashPaths.count
            let rendered = example.split(separator: "/", omittingEmptySubsequences: false)
                .map { trim(String($0)) }.filter { !$0.isEmpty }
                .joined(separator: " \u{203A} ")
            warnings.append(
                "\(n) category \(n == 1 ? "path was" : "paths were") split on “/” because the file "
                    + "contains no “>” or “►” — “\(example)” becomes “\(rendered)”. "
                    + "Rename them after importing if they should stay one category."
            )
        }

        return MoneyWizReportResult(
            rows: rows, accounts: out, warnings: warnings, detectedDateFormat: detected
        )
    }
}
