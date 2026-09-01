// MoneyWiz's flat transaction CSV, ported from src/import/moneywiz.ts
// (SPEC §7.1, D20).
//
// DETECTION IS BY HEADER SYNONYM, NOT BY POSITION. A file is MoneyWiz-ish when
// it has an Amount column, a Date column, an Account column and at least one of
// Payee/Description/Category, case-insensitively. Positional detection would
// break the first time an export reordered a column, and columns move between
// MoneyWiz versions.
//
// AND READ THE PRECEDENCE NOTE IN MoneyWizReport.swift BEFORE CALLING
// `isMoneyWizCsv`. The Report layout answers YES to this test as well — it has
// Account, Date, Amount and Payee, which is all this asks for. Nothing in this
// function can tell them apart, so every caller must ask
// `isMoneyWizReportCsv` FIRST.
import Foundation

public struct MoneyWizParseResult: Sendable {
    public let rows: [ParsedRow]
    public let headers: [String]
    /// English prose for a human. A re-implementation is bound by WHEN a
    /// warning is raised, not by its wording — the oracle marks these advisory.
    public let warnings: [String]
    /// What auto-detection made of the Date column, reported even when the
    /// caller forced a format so the UI can show what it would have picked.
    public let detectedDateFormat: DateOrder
}

enum MoneyWizField: String, CaseIterable {
    case account, transfers, description, payee, category, date
    case time, memo, amount, currency, check, tags, balance
}

/// Case-insensitive header synonyms. 'time', 'check' and 'balance' are
/// recognised so they do not trigger unknown-column warnings, then ignored.
private let moneyWizSynonyms: [MoneyWizField: [String]] = [
    .account: ["account", "account name"],
    .transfers: ["transfers", "transfer"],
    .description: ["description"],
    .payee: ["payee"],
    .category: ["category"],
    .date: ["date"],
    .time: ["time"],
    .memo: ["memo", "notes"],
    .amount: ["amount"],
    .currency: ["currency"],
    .check: ["check #", "check number", "check no.", "check no", "cheque", "cheque #"],
    .tags: ["tags", "tag"],
    .balance: ["balance"],
]

extension Import {
    /// Resolve headers to column indices, first-come-first-served, and report
    /// the headers nothing claimed.
    ///
    /// `order` matters: fields are resolved in the order given, and an earlier
    /// field takes a header an later one would also have matched. The Report
    /// parser depends on this to keep "Current balance" away from the plain
    /// "Balance" slot.
    static func resolveColumns<Field: Hashable>(
        _ headers: [String], order: [Field], synonyms: [Field: [String]]
    ) -> (cols: [Field: Int], unknown: [String]) {
        let norm = headers.map { nameKey($0) }
        var used = Set<Int>()
        var cols: [Field: Int] = [:]
        for field in order {
            cols[field] = -1
            for syn in synonyms[field] ?? [] {
                if let i = norm.indices.first(where: { !used.contains($0) && norm[$0] == syn }) {
                    used.insert(i)
                    cols[field] = i
                    break
                }
            }
        }
        let unknown = headers.enumerated()
            .filter { !used.contains($0.offset) && !trim($0.element).isEmpty }
            .map(\.element)
        return (cols, unknown)
    }

    /// Is this file a flat MoneyWiz export?
    public static func isMoneyWizCsv(headers: [String]) -> Bool {
        let (cols, _) = resolveColumns(
            headers, order: MoneyWizField.allCases, synonyms: moneyWizSynonyms
        )
        return cols[.amount]! >= 0 && cols[.date]! >= 0 && cols[.account]! >= 0
            && (cols[.payee]! >= 0 || cols[.description]! >= 0 || cols[.category]! >= 0)
    }

    /// Tags are separated by ';' when the cell contains one, and only otherwise
    /// by ','.
    ///
    /// Splitting on both at once tore a properly quoted `"Holiday, Spain;work"`
    /// into three tags and threw away information the file had stated
    /// unambiguously: a comma inside a semicolon-separated cell is part of the
    /// tag NAME, not a separator.
    static func splitMoneyWizTags(_ v: String) -> [String] {
        if v.isEmpty { return [] }
        let separator: Character = v.contains(";") ? ";" : ","
        return v.split(separator: separator, omittingEmptySubsequences: false)
            .map { trim(String($0)) }
            .filter { !$0.isEmpty }
    }

    /// Parse a flat MoneyWiz export.
    ///
    /// `dateFormat` overrides auto-detection (D20). An all-ambiguous column —
    /// every value ≤12/12 — is indistinguishable between dd/mm and mm/dd, so
    /// the default picks en-GB day-first and the caller must be able to correct
    /// it; a US MM/DD export would otherwise import every date transposed with
    /// no way to fix it afterwards.
    public static func parseMoneyWizCsv(
        _ text: String, dateFormat: DateOrderOption = .auto
    ) -> MoneyWizParseResult {
        let table = CSV.parse(text)
        var warnings = table.errors
        let headers = (table.data.first ?? []).map { trim($0) }
        let (cols, unknown) = resolveColumns(
            headers, order: MoneyWizField.allCases, synonyms: moneyWizSynonyms
        )
        for u in unknown { warnings.append("Ignoring unrecognised column “\(u)”") }

        let raw = table.data.dropFirst().filter { row in row.contains { !trim($0).isEmpty } }
        func col(_ f: MoneyWizField) -> Int { cols[f] ?? -1 }

        // Column-level detection, ONCE per file.
        let detected = detectDateFormat(raw.map { cell($0, col(.date)) })
        let order: DateOrder
        switch dateFormat {
        case .auto: order = detected
        case .fixed(let fixed): order = fixed
        }
        let decimal = detectDecimalStyle(raw.map { cell($0, col(.amount)) })
        // ' > ' is the MoneyWiz path separator; the '/' fallback applies ONLY
        // when no '>' occurs anywhere in the column, because a file that uses
        // '>' paths never means '/' as a level break.
        let columnHasGt = raw.contains { cell($0, col(.category)).contains(">") }
        var slashPaths: [String] = []  // insertion-ordered: the first is the example
        var seenSlashPaths = Set<String>()

        let rows: [ParsedRow] = raw.enumerated().map { offset, row in
            let currencyRaw = cell(row, col(.currency))
            let currency: String? =
                currencyRaw.count == 3 && currencyRaw.allSatisfy(isASCIILetter)
                ? currencyRaw.uppercased() : nil
            let dateRaw = cell(row, col(.date))
            let date = dateRaw.isEmpty ? nil : parseDateString(dateRaw, format: .fixed(order))
            let amountRaw = cell(row, col(.amount))
            // The minor-unit scale needs a currency, and rows without one use
            // the 2-decimal default. That is a GUESS — the account is not known
            // here — so `amountText` travels with the row and the importer
            // re-derives the amount once the real currency is known (¥ and KWD
            // scales differ from 2 decimals).
            let amountMinor = amountRaw.isEmpty
                ? nil
                : parseImportAmount(amountRaw, currency: currency ?? "GBP", decimal: .fixed(decimal))
            var error: String? = nil
            if date == nil {
                error = "Unrecognised date “\(dateRaw)”"
            } else if amountMinor == nil {
                error = "Unrecognised amount “\(amountRaw)”"
            }

            let catRaw = cell(row, col(.category))
            let categoryPath: [String]
            if catRaw.isEmpty {
                categoryPath = []
            } else {
                let separator: Character = columnHasGt ? ">" : "/"
                categoryPath = catRaw.split(separator: separator, omittingEmptySubsequences: false)
                    .map { trim(String($0)) }
                    .filter { !$0.isEmpty }
            }
            // A '/' read as a path separator INVENTS a category level the owner
            // never had ('Kids/School' ⇒ Kids › School). It is the documented
            // fallback and usually right, but it is a guess about his data, so
            // the preview has to say it happened.
            if !columnHasGt, categoryPath.count > 1, !seenSlashPaths.contains(catRaw) {
                seenSlashPaths.insert(catRaw)
                slashPaths.append(catRaw)
            }

            let accountName = cell(row, col(.account))
            let payeeName = cell(row, col(.payee))
            let descriptionCell = cell(row, col(.description))
            let memo = cell(row, col(.memo))
            let transfers = cell(row, col(.transfers))
            return ParsedRow(
                index: offset + 1,
                date: date,
                amountMinor: amountMinor,
                currency: currency,
                accountName: accountName.isEmpty ? nil : accountName,
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

        // Mixed currencies within one account name — worth surfacing, because
        // a transaction is always denominated in its account's currency and one
        // of the two readings must be wrong.
        var accountOrder: [String] = []
        var currenciesByAccount: [String: [String]] = [:]
        for row in rows {
            guard let account = row.accountName, let currency = row.currency else { continue }
            if currenciesByAccount[account] == nil {
                currenciesByAccount[account] = []
                accountOrder.append(account)
            }
            if !currenciesByAccount[account]!.contains(currency) {
                currenciesByAccount[account]!.append(currency)
            }
        }
        for account in accountOrder where currenciesByAccount[account]!.count > 1 {
            warnings.append(
                "Account “\(account)” has rows in mixed currencies "
                    + "(\(currenciesByAccount[account]!.joined(separator: ", ")))"
            )
        }
        if col(.currency) == -1 {
            warnings.append("No Currency column — amounts assume the account/base currency")
        }
        if let example = slashPaths.first {
            let n = slashPaths.count
            let rendered = example.split(separator: "/", omittingEmptySubsequences: false)
                .map { trim(String($0)) }.filter { !$0.isEmpty }
                .joined(separator: " \u{203A} ")
            warnings.append(
                "\(n) category \(n == 1 ? "path was" : "paths were") split on “/” because the file "
                    + "contains no “>” — “\(example)” becomes “\(rendered)”. "
                    + "Rename them after importing if they should stay one category."
            )
        }

        return MoneyWizParseResult(
            rows: rows, headers: headers, warnings: warnings, detectedDateFormat: detected
        )
    }
}
