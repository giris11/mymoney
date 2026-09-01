// Accepting a backup: parse, validate, decode, and make the file PROVE ITSELF
// before a single record is handed to a caller.
//
// The TypeScript checks the manifest AFTER the rows have landed in IndexedDB,
// inside a transaction it can abort. There is no transaction here yet -- this
// package has no store -- so the check is done against the rows as DECODED,
// which is the same question asked one step earlier: do these rows produce the
// arithmetic the file says they produce? Whatever persistence arrives later
// must keep the property that matters: nothing is written until the answer is
// yes (D21, all-or-nothing).
import Foundation

/// The owner's book, decoded. Every table, plus the two things every figure
/// needs: what currency the book is denominated in, and the rates it knows.
public struct Book: Sendable {
    public let accounts: [Account]
    public let accountGroups: [AccountGroup]
    public let transactions: [Transaction]
    public let categories: [Category]
    public let payees: [Payee]
    public let tags: [Tag]
    public let budgets: [Budget]
    public let fxRates: [FxRate]
    public let importBatches: [ImportBatch]
    /// nil for a file that carried no settings row -- reachable for a book that
    /// has never been written to, and for a sync snapshot.
    public let settings: Settings?
    /// The base currency the book is denominated in, read from the rows
    /// themselves. Explicit, never inferred later: a total in an unnamed
    /// currency is not a number.
    public let baseCurrency: String

    public var rateTable: RateTable { RateTable(rates: fxRates) }

    public func accountBalances() throws -> [AccountBalance] {
        try Balances.accountBalances(accounts: accounts, transactions: transactions)
    }

    public func netWorth() throws -> NetWorth {
        try Balances.netWorth(
            try accountBalances(), baseCurrency: baseCurrency, rates: rateTable
        )
    }
}

public enum BackupImportError: Error, Sendable, CustomStringConvertible {
    /// The file did not survive validation or decoding.
    case invalid(String)
    /// The rows do not add up to what the file says they do. Every
    /// disagreement, named.
    case manifestDisagrees([String])

    public var description: String {
        switch self {
        case .invalid(let message):
            return message
        case .manifestDisagrees(let problems):
            let shown = problems.prefix(BackupImporter.maxReportedProblems)
            let more = problems.count - shown.count
            var lines = [
                "Import refused: the data in this file does not match what the file says it contains."
            ]
            lines += shown.map { "\u{2022} \($0)" }
            if more > 0 { lines.append("\u{2022} \u{2026}and \(more) more") }
            lines.append("Nothing was changed.")
            return lines.joined(separator: "\n")
        }
    }
}

public struct ImportedBackup: Sendable {
    public let file: BackupFile
    public let book: Book
    /// What the file claimed, when it carried a manifest this build can check.
    public let claimedManifest: BackupManifest?
    /// What the rows actually produce. Present whenever `claimedManifest` is,
    /// and equal to it in every compared field -- otherwise the import would
    /// have been refused.
    public let recomputedManifest: BackupManifest?
    /// The canonical content fingerprint of the file as it was read.
    public let contentHash: String
    /// Things worth saying out loud that are not grounds for refusal. Empty for
    /// every file the browser has ever written.
    public let warnings: [String]

    /// Did this file prove itself, or merely fail to contradict itself?
    public var verified: Bool { claimedManifest != nil }
}

public enum BackupImporter {
    public static let maxReportedProblems = 12

    /// The base currency to assume when the rows carry no settings row at all.
    /// SPEC 13: GBP.
    public static let fallbackBaseCurrency = "GBP"

    public static func load(text: String) throws -> ImportedBackup {
        let parsed: JSONValue
        do {
            parsed = try JSONParser.parse(text)
        } catch let error as JSONParseError {
            throw BackupImportError.invalid("Not a valid backup: \(error.description)")
        }
        return try load(parsed: parsed)
    }

    public static func load(data: Data) throws -> ImportedBackup {
        let parsed: JSONValue
        do {
            parsed = try JSONParser.parse(data)
        } catch let error as JSONParseError {
            throw BackupImportError.invalid("Not a valid backup: \(error.description)")
        }
        return try load(parsed: parsed)
    }

    public static func load(parsed: JSONValue) throws -> ImportedBackup {
        let file: BackupFile
        do {
            file = try BackupReader.validate(parsed)
        } catch let error as BackupValidationError {
            throw BackupImportError.invalid(error.description)
        }

        let book: Book
        do {
            book = try decodeBook(file)
        } catch let error as RecordDecodeError {
            throw BackupImportError.invalid("Invalid backup: \(error.description)")
        }

        var recomputed: BackupManifest?
        if let claimed = file.manifest {
            // Which base currency the recomputation is done in: the file's own,
            // because a manifest names the currency its total is in and the
            // rows must agree with it. Falling back to the manifest's when the
            // file carries no settings row keeps a legitimate snapshot
            // checkable instead of refusing it over a currency the file never
            // stated twice.
            let base = (book.settings?.baseCurrency).flatMap { $0.isEmpty ? nil : $0 }
                ?? claimed.netWorth.baseCurrency
            let landed = try Manifest.compute(
                manifestSource(file: file, book: book),
                schemaVersion: claimed.schemaVersion,
                exportedAt: claimed.exportedAt,
                baseCurrency: base,
                // THE FILE'S OWN VERSION CHOOSES THE ARITHMETIC -- never this
                // build's preference. The claim was computed by whichever build
                // wrote the file, under the rule its manifestVersion names, and
                // the only question an import may ask is "do these rows still
                // produce THAT". Recomputing an old file the new way would
                // refuse a backup that is perfectly sound, over a penny of
                // rounding, and refusing a sound backup is the one failure this
                // whole subsystem exists to prevent.
                // Unreachable as a throw -- `file.manifest` is only set when
                // `Manifest.isCheckable` agreed, which is exactly "this version
                // has a known rule" -- but stated as one anyway, because the
                // alternative to throwing here is verifying under the wrong
                // rule and calling it verified.
                netWorthRule: try Manifest.netWorthRule(of: claimed)
            )
            let problems = Manifest.compare(claimed: claimed, recomputed: landed)
            if !problems.isEmpty { throw BackupImportError.manifestDisagrees(problems) }
            recomputed = landed
        }

        return ImportedBackup(
            file: file,
            book: book,
            claimedManifest: file.manifest,
            recomputedManifest: recomputed,
            contentHash: BackupReader.canonicalHash(parsed),
            warnings: try warnings(for: file, book: book)
        )
    }

    /// A ManifestSource straight from the rows just decoded. Every number comes
    /// from those rows and nothing else.
    static func manifestSource(file: BackupFile, book: Book) throws -> ManifestSource {
        var rowCounts: [String: Int] = [:]
        for name in Schema.allTables {
            rowCounts[name] = file.tables[name]?.count ?? 0
        }
        var totals = TxTotals()
        for tx in book.transactions {
            try totals.add(accountId: tx.accountId, amountMinor: tx.amountMinor)
        }
        return ManifestSource(
            rowCounts: rowCounts,
            accounts: book.accounts,
            fxRates: book.fxRates,
            txByAccount: totals
        )
    }

    static func decodeBook(_ file: BackupFile) throws -> Book {
        func rows(_ name: String) -> [JSONValue] { file.tables[name] ?? [] }

        let settingsRows = rows("settings")
        var settings: Settings?
        if let first = settingsRows.first {
            settings = try Settings(row: RowReader(first, context: "settings[0]"), value: first)
        }

        return Book(
            accounts: try decodeRows(rows("accounts"), table: "accounts", make: Account.init(row:)),
            accountGroups: try decodeRows(rows("accountGroups"), table: "accountGroups", make: AccountGroup.init(row:)),
            transactions: try decodeRows(rows("transactions"), table: "transactions", make: Transaction.init(row:)),
            categories: try decodeRows(rows("categories"), table: "categories", make: Category.init(row:)),
            payees: try decodeRows(rows("payees"), table: "payees", make: Payee.init(row:)),
            tags: try decodeRows(rows("tags"), table: "tags", make: Tag.init(row:)),
            budgets: try decodeRows(rows("budgets"), table: "budgets", make: Budget.init(row:)),
            fxRates: try decodeRows(rows("fxRates"), table: "fxRates", make: FxRate.init(row:)),
            importBatches: try decodeRows(rows("importBatches"), table: "importBatches", make: ImportBatch.init(row:)),
            settings: settings,
            // Empty counts as unstated, matching the TypeScript's `||` (where
            // "" is falsy) rather than Swift's `??` (where "" is a value).
            baseCurrency: (settings?.baseCurrency).flatMap { $0.isEmpty ? nil : $0 }
                ?? fallbackBaseCurrency
        )
    }

    /// The largest integer a JavaScript number holds exactly.
    static let javaScriptSafeInteger: Int64 = 9_007_199_254_740_991

    /// Amounts that no browser could have written, and that no browser could
    /// read back.
    ///
    /// Int64 goes further than a JS number, which is the whole reason the port
    /// exists (CloudKit preserves Int64 exactly). But the web build is still
    /// the app the owner uses today, and a file written here containing an
    /// amount past 2^53 - 1 would be silently corrupted the moment it was
    /// restored there. That is not grounds to REFUSE a file -- refusing would
    /// itself be a way to lose data -- so it is said out loud instead, naming
    /// the row.
    static func warnings(for file: BackupFile, book: Book) throws -> [String] {
        var found: [String] = splitWarnings(book)
        for name in Schema.allTables {
            for (index, row) in (file.tables[name] ?? []).enumerated() {
                guard let fields = row.objectValue else { continue }
                for (key, value) in fields {
                    guard case .int(let i) = value, i.magnitude > UInt64(javaScriptSafeInteger) else { continue }
                    found.append(
                        "\(name)[\(index)].\(key) is \(i), beyond the range a browser can hold exactly "
                            + "(\u{00B1}\(javaScriptSafeInteger)); this file cannot be restored into the web app "
                            + "without changing that number"
                    )
                    if found.count >= maxReportedProblems { return found }
                }
            }
        }
        return found
    }

    /// Transactions whose splits do not sum to the transaction.
    ///
    /// SPEC 6 says splits must sum EXACTLY to their parent, and the write path
    /// is where that is ENFORCED. Reading is different: the TypeScript's
    /// restore does not re-check it either, and refusing a file over it would
    /// mean an owner whose data already contains one bad row could no longer
    /// restore ANY of it -- turning a one-transaction problem into a total
    /// loss. So it is reported, precisely, and the file still loads.
    ///
    /// "Exactly" is exact: no epsilon, no penny of slack. A split set that is
    /// out by one is not a rounding artefact -- integers do not have those --
    /// it is a transaction that does not add up.
    static func splitWarnings(_ book: Book) -> [String] {
        var found: [String] = []
        for tx in book.transactions where !tx.splits.isEmpty {
            guard let sum = try? Money.sumSplits(tx.splits) else {
                found.append("transaction \(tx.id): its splits overflow Int64")
                continue
            }
            if sum != tx.amountMinor {
                found.append(
                    "transaction \(tx.id): its \(tx.splits.count) splits sum to "
                        + Money.formatPlain(sum, currency: tx.currency)
                        + " but the transaction is "
                        + Money.formatPlain(tx.amountMinor, currency: tx.currency)
                )
            }
            if found.count >= maxReportedProblems { return found }
        }
        return found
    }
}
