// Writing a backup: the same bytes the browser would have written, from rows
// this package understands rather than from the file it read them out of.
//
// WHY THIS EXISTS AND WHY IT IS NOT AN ECHO. Reading a backup and re-emitting
// the JSON that was parsed proves that the canonical form is a fixed point,
// which is worth knowing and is not the question. The question a port has to
// answer is harder: take the owner's real file, decode every row into Swift
// records, THROW THE DOCUMENT AWAY, rebuild the file out of the records, and
// see whether it is byte-for-byte the file that arrived. That is the only test
// that can catch a field this build silently does not model, a flag it
// resolved to a default, a number it reformatted, or a row order it invented.
// A balance that agrees proves the arithmetic; only the bytes prove the DATA.
//
// THE ONE RULE THE FIELD SET FOLLOWS, and it comes straight from
// src/db/types.ts:
//
//   * A field typed `x: T | null` is ALWAYS WRITTEN -- `null` when there is no
//     value. It is a fact with a "none" state, and the file states it.
//   * A field typed `x?: T` is OMITTED when there is no value, never written
//     as `null`. `undefined` is not a value in JSON, and JSON.stringify drops
//     the key; writing `null` instead would be a different file for the same
//     book.
//
// Getting that backwards on a single field changes the content hash, which is
// exactly what makes it worth spelling out rather than leaving to whichever
// way each record happened to be modelled.
//
// WHAT THIS DOES NOT PRESERVE, said plainly because a writer that quietly
// dropped things would be worse than useless:
//
//   * A key no record type models is lost -- except on the `settings` row,
//     where the device-local `sync*` half is deliberately unmodelled and is
//     carried through verbatim (see `settingsRow`).
//   * A REQUIRED field that was absent in the source comes back present, at
//     the decoder's default (`name: ""`, `sortOrder: 0`). That is the current
//     schema being written out in full; the oracle's hand-built books omit
//     such fields and would gain them here.
//   * An OPTIONAL field written as an explicit `null` comes back omitted. No
//     build writes one; the TypeScript's own types forbid it.
//
// Each of those is a way an exported file could differ from its source, so
// each has a test that pins the behaviour rather than leaving it to be
// discovered by a hash mismatch years from now.
import Foundation

/// One row under construction.
///
/// The three verbs are the whole contract: `required` always writes,
/// `nullable` always writes and uses `null` for nil, `optional` writes nothing
/// for nil. Naming them after the TypeScript's three field spellings is what
/// keeps a reviewer able to check this file against src/db/types.ts line by
/// line without holding any of it in their head.
struct RowWriter {
    private(set) var members: [String: JSONValue] = [:]

    mutating func required(_ key: String, _ value: JSONValue) {
        members[key] = value
    }

    mutating func required(_ key: String, _ value: String) { members[key] = .string(value) }
    mutating func required(_ key: String, _ value: Int64) { members[key] = .int(value) }
    mutating func required(_ key: String, _ value: Int) { members[key] = .int(Int64(value)) }
    mutating func required(_ key: String, _ value: Bool) { members[key] = .bool(value) }
    mutating func required(_ key: String, _ value: Double) { members[key] = .double(value) }
    mutating func required(_ key: String, _ value: [String]) {
        members[key] = .array(value.map(JSONValue.string))
    }

    /// `T | null`: present always, `null` when there is nothing.
    mutating func nullable(_ key: String, _ value: String?) {
        members[key] = value.map(JSONValue.string) ?? .null
    }

    /// `T?`: absent when there is nothing. NOT `null` -- see the file comment.
    mutating func optional(_ key: String, _ value: String?) {
        if let value { members[key] = .string(value) }
    }

    mutating func optional(_ key: String, _ value: Bool?) {
        if let value { members[key] = .bool(value) }
    }

    mutating func optional(_ key: String, _ value: Int64?) {
        if let value { members[key] = .int(value) }
    }

    mutating func optional(_ key: String, _ value: Int?) {
        if let value { members[key] = .int(Int64(value)) }
    }

    mutating func optional(_ key: String, _ value: Double?) {
        if let value { members[key] = .double(value) }
    }

    mutating func optional(_ key: String, _ value: [String]?) {
        if let value { members[key] = .array(value.map(JSONValue.string)) }
    }

    var value: JSONValue { .object(members) }
}

public enum BackupWriter {
    /// Total rows above which a backup is written COMPACT (E3).
    /// src/backup/backup.ts's PRETTY_PRINT_ROW_LIMIT, and it has to be the same
    /// number here: a file written pretty where the browser would have written
    /// it compact is the same DATA and different BYTES, and only one of those
    /// two files can be compared to a stored hash by eye.
    public static let prettyPrintRowLimit = 2000

    // MARK: - Rows

    static func row(_ account: Account) -> JSONValue {
        var out = RowWriter()
        out.required("id", account.id)
        out.required("name", account.name)
        out.required("type", account.type.rawValue)
        out.required("currency", account.currency)
        out.required("openingBalanceMinor", account.openingBalanceMinor)
        out.required("colour", account.colour)
        out.nullable("groupId", account.groupId)
        out.required("sortOrder", account.sortOrder)
        out.required("archived", account.archived)
        out.optional("excludeFromNetWorth", account.excludeFromNetWorth)
        out.optional("loanPrincipalMinor", account.loanPrincipalMinor)
        out.optional("loanRatePct", account.loanRatePct)
        out.optional("loanTermMonths", account.loanTermMonths)
        return out.value
    }

    static func row(_ group: AccountGroup) -> JSONValue {
        var out = RowWriter()
        out.required("id", group.id)
        out.required("name", group.name)
        out.required("sortOrder", group.sortOrder)
        return out.value
    }

    static func row(_ split: Split) -> JSONValue {
        var out = RowWriter()
        out.nullable("categoryId", split.categoryId)
        out.required("amountMinor", split.amountMinor)
        out.optional("notes", split.notes)
        return out.value
    }

    static func row(_ tx: Transaction) -> JSONValue {
        var out = RowWriter()
        out.required("id", tx.id)
        out.required("accountId", tx.accountId)
        out.required("date", tx.date)
        out.required("amountMinor", tx.amountMinor)
        out.required("currency", tx.currency)
        out.nullable("payeeId", tx.payeeId)
        out.nullable("categoryId", tx.categoryId)
        out.required("tagIds", tx.tagIds)
        out.required("notes", tx.notes)
        out.required("status", tx.status.rawValue)
        out.required("splits", .array(tx.splits.map(row(_:))))
        out.nullable("transferGroupId", tx.transferGroupId)
        out.nullable("importBatchId", tx.importBatchId)
        out.required("dedupeHash", tx.dedupeHash)
        out.required("createdAt", tx.createdAt)
        out.required("updatedAt", tx.updatedAt)
        return out.value
    }

    static func row(_ category: Category) -> JSONValue {
        var out = RowWriter()
        out.required("id", category.id)
        out.required("name", category.name)
        out.nullable("parentId", category.parentId)
        out.required("kind", category.kind.rawValue)
        out.optional("icon", category.icon)
        out.optional("colour", category.colour)
        out.required("archived", category.archived)
        out.required("sortOrder", category.sortOrder)
        return out.value
    }

    static func row(_ payee: Payee) -> JSONValue {
        var out = RowWriter()
        out.required("id", payee.id)
        out.required("name", payee.name)
        out.required("nameLower", payee.nameLower)
        out.nullable("defaultCategoryId", payee.defaultCategoryId)
        return out.value
    }

    static func row(_ tag: Tag) -> JSONValue {
        var out = RowWriter()
        out.required("id", tag.id)
        out.required("name", tag.name)
        out.required("nameLower", tag.nameLower)
        return out.value
    }

    static func row(_ budget: Budget) -> JSONValue {
        var out = RowWriter()
        out.required("id", budget.id)
        out.required("name", budget.name)
        out.required("categoryIds", budget.categoryIds)
        out.required("amountMinor", budget.amountMinor)
        out.required("period", budget.period.rawValue)
        out.required("startDate", budget.startDate)
        out.required("rollover", budget.rollover)
        out.required("archived", budget.archived)
        return out.value
    }

    static func row(_ rate: FxRate) -> JSONValue {
        var out = RowWriter()
        out.required("id", rate.id)
        out.required("base", rate.base)
        out.required("quote", rate.quote)
        // The one Double in the record model, emitted through JSNumber so it
        // gets JavaScript's shortest round-tripping form. A rate written as
        // 0.007758418188252168 instead of ...67 is a different file, and it is
        // the sort of difference no balance check would ever notice.
        out.required("rate", rate.rate)
        out.required("asOf", rate.asOf)
        out.required("source", rate.source.rawValue)
        return out.value
    }

    static func row(_ batch: ImportBatch) -> JSONValue {
        var out = RowWriter()
        out.required("id", batch.id)
        out.required("source", batch.source.rawValue)
        out.required("fileName", batch.fileName)
        out.required("rowCount", batch.rowCount)
        out.required("importedAt", batch.importedAt)
        out.required("createdAccountIds", batch.createdAccountIds)
        out.required("createdCategoryIds", batch.createdCategoryIds)
        out.required("createdPayeeIds", batch.createdPayeeIds)
        out.required("createdTagIds", batch.createdTagIds)
        out.required("createdGroupIds", batch.createdGroupIds)
        out.optional("createdBudgetIds", batch.createdBudgetIds)
        out.optional("createdFxRateIds", batch.createdFxRateIds)
        return out.value
    }

    static func row(_ mapping: ColumnMapping) -> JSONValue {
        var out = RowWriter()
        out.required("date", mapping.date)
        out.required("amount", mapping.amount)
        out.required("debit", mapping.debit)
        out.required("credit", mapping.credit)
        out.required("payee", mapping.payee)
        out.required("description", mapping.description)
        out.required("category", mapping.category)
        out.required("account", mapping.account)
        out.required("currency", mapping.currency)
        out.required("tags", mapping.tags)
        out.required("notes", mapping.notes)
        out.required("dateFormat", mapping.dateFormat)
        out.required("decimal", mapping.decimal)
        out.required("negate", mapping.negate)
        out.required("headerRow", mapping.headerRow)
        return out.value
    }

    /// The settings row: every BOOK-level field rebuilt from the typed record,
    /// every DEVICE-LOCAL field carried through from the row as it arrived.
    ///
    /// The split is not a shortcut, it is the design. src/db/db.ts's
    /// DEVICE_LOCAL_SETTING_KEYS is the authority on which half is which, and
    /// this package deliberately models only the book-level half -- the base
    /// currency decides what a total is denominated in, and nothing here has
    /// any business having an opinion about a sync revision or a device name.
    /// But a backup's fingerprint covers the whole row, so dropping the keys
    /// this build does not model would mean a Swift export of an unchanged
    /// book could never match the browser's hash. Passing them through
    /// untouched is what lets both statements be true at once.
    ///
    /// Anything the pass-through carries is REPORTED by
    /// `unmodelledSettingsKeys`, so "which keys did we not understand?" is a
    /// question with an answer rather than a silence.
    static func settingsRow(_ settings: Settings) -> JSONValue {
        var out = RowWriter()
        out.required("id", settings.id)
        out.required("schemaVersion", settings.schemaVersion)
        out.required("baseCurrency", settings.baseCurrency)
        out.required("theme", settings.theme.rawValue)
        out.nullable("lastBackupAt", settings.lastBackupAt)
        out.required("onboarded", settings.onboarded)
        out.nullable("lastUsedAccountId", settings.lastUsedAccountId)
        var mappings: [String: JSONValue] = [:]
        for (signature, mapping) in settings.savedMappings { mappings[signature] = row(mapping) }
        out.required("savedMappings", .object(mappings))
        out.required("createdAt", settings.createdAt)
        out.required("autoFxEnabled", settings.autoFxEnabled)
        out.nullable("lastFxSyncAt", settings.lastFxSyncAt)
        out.nullable("lastFxSyncSource", settings.lastFxSyncSource)

        var members = out.members
        for key in unmodelledSettingsKeys(settings) {
            members[key] = settings.raw[key]
        }
        return .object(members)
    }

    /// Keys on the settings row this package has no typed field for, in sorted
    /// order. The `sync*` half, on any row the current build wrote.
    public static func unmodelledSettingsKeys(_ settings: Settings) -> [String] {
        guard let raw = settings.raw.objectValue else { return [] }
        return raw.keys.filter { !modelledSettingsKeys.contains($0) }.sorted(by: jsStringLess)
    }

    static let modelledSettingsKeys: Set<String> = [
        "id", "schemaVersion", "baseCurrency", "theme", "lastBackupAt", "onboarded",
        "lastUsedAccountId", "savedMappings", "createdAt", "autoFxEnabled", "lastFxSyncAt",
        "lastFxSyncSource",
    ]

    // MARK: - Tables

    /// Rows in a defined order: by primary key, never "whatever came back".
    ///
    /// Row order is DATA in JSON -- an array in a different order is a
    /// different file -- so two exports of an unchanged book can only be
    /// byte-identical if the exporter decides the order. Sorted by UTF-16 code
    /// unit (`jsStringLess`), which is what the TypeScript's `a.id < b.id`
    /// does; Swift's own `String <` normalises and is a different comparison.
    /// Ties fall back to input position because Swift's sort is not stable and
    /// JavaScript's has been since ES2019 -- a duplicate id is refused on read,
    /// so this only ever decides an order that cannot occur, and it decides it
    /// the same way twice.
    /// NOTE THE ABSENCE OF `==`. Ordering is decided by asking `jsStringLess`
    /// BOTH WAYS, never by testing the two ids for equality first: Swift's
    /// `String ==` is canonical equivalence, so "a" + U+0308 and precomposed
    /// "ä" are the SAME string to it and two different keys in the file. An
    /// equality short-circuit would leave that pair in arrival order, which is
    /// not an order at all -- and it would do it silently, on the one input
    /// nobody thinks to test.
    static func sortedById<T>(_ items: [T], id: (T) -> String) -> [T] {
        items.enumerated()
            .sorted {
                let a = id($0.element), b = id($1.element)
                if jsStringLess(a, b) { return true }
                if jsStringLess(b, a) { return false }
                return $0.offset < $1.offset
            }
            .map(\.element)
    }

    /// Every table, as JSON rows, in the order the file will carry them.
    public static func tables(_ book: Book) -> [String: [JSONValue]] {
        var tables: [String: [JSONValue]] = [:]
        tables["accounts"] = sortedById(book.accounts, id: \.id).map(row(_:))
        tables["accountGroups"] = sortedById(book.accountGroups, id: \.id).map(row(_:))
        tables["transactions"] = sortedById(book.transactions, id: \.id).map(row(_:))
        tables["categories"] = sortedById(book.categories, id: \.id).map(row(_:))
        tables["payees"] = sortedById(book.payees, id: \.id).map(row(_:))
        tables["tags"] = sortedById(book.tags, id: \.id).map(row(_:))
        tables["budgets"] = sortedById(book.budgets, id: \.id).map(row(_:))
        tables["fxRates"] = sortedById(book.fxRates, id: \.id).map(row(_:))
        tables["importBatches"] = sortedById(book.importBatches, id: \.id).map(row(_:))
        tables["settings"] = book.settings.map { [settingsRow($0)] } ?? []
        return tables
    }

    // MARK: - The manifest, as JSON

    static func encode(_ manifest: BackupManifest) -> JSONValue {
        var out = RowWriter()
        out.required("manifestVersion", manifest.manifestVersion)
        out.required("schemaVersion", manifest.schemaVersion)
        out.required("exportedAt", manifest.exportedAt)
        var counts: [String: JSONValue] = [:]
        for (name, count) in manifest.rowCounts { counts[name] = .int(Int64(count)) }
        out.required("rowCounts", .object(counts))
        out.required("accounts", .array(manifest.accounts.map { account in
            var entry = RowWriter()
            entry.required("id", account.id)
            entry.required("name", account.name)
            entry.required("currency", account.currency)
            entry.required("closingBalanceMinor", account.closingBalanceMinor)
            entry.required("txCount", account.txCount)
            entry.required("counted", account.counted)
            return entry.value
        }))
        var netWorth = RowWriter()
        netWorth.required("baseCurrency", manifest.netWorth.baseCurrency)
        netWorth.required("totalMinor", manifest.netWorth.totalMinor)
        netWorth.required("rates", .array(manifest.netWorth.rates.map { rate in
            var entry = RowWriter()
            entry.required("from", rate.from)
            entry.required("to", rate.to)
            entry.required("rate", rate.rate)
            return entry.value
        }))
        netWorth.required("missingRateCurrencies", manifest.netWorth.missingRateCurrencies)
        out.required("netWorth", netWorth.value)
        return out.value
    }

    // MARK: - The file

    /// A whole backup document, manifest included.
    ///
    /// The manifest is computed from THE VERY ROWS ABOUT TO BE WRITTEN, never
    /// from a second pass over the book: a manifest that describes a different
    /// moment -- or a different sort order -- is worse than no manifest at all,
    /// because it will be believed.
    ///
    /// `netWorthRule` DEFAULTS TO THE RULE THIS BUILD WRITES (per currency,
    /// manifest version 2) and the app never passes anything else: an export is
    /// a statement about the book as it stands now, so it uses the arithmetic
    /// the app's own headline figure uses. The parameter exists for exactly one
    /// other job -- reproducing a file that was written under an OLDER rule,
    /// byte for byte, to prove the writer is faithful to it (see
    /// FrozenGateTests and ManifestVersionTests). Passing `.perAccount` here to
    /// make some other comparison come out even would be writing a v1 file in
    /// 2026, which is not a thing this app may do.
    public static func file(
        _ book: Book,
        exportedAt: String,
        schemaVersion: Int = Schema.version,
        netWorthRule: NetWorthRule = Manifest.currentNetWorthRule
    ) throws -> JSONValue {
        let tables = tables(book)
        var rowCounts: [String: Int] = [:]
        for name in Schema.allTables { rowCounts[name] = tables[name]?.count ?? 0 }

        var totals = TxTotals()
        for tx in book.transactions {
            try totals.add(accountId: tx.accountId, amountMinor: tx.amountMinor)
        }
        let manifest = try Manifest.compute(
            ManifestSource(
                rowCounts: rowCounts,
                accounts: book.accounts,
                fxRates: book.fxRates,
                txByAccount: totals
            ),
            schemaVersion: schemaVersion,
            exportedAt: exportedAt,
            baseCurrency: book.baseCurrency,
            netWorthRule: netWorthRule
        )

        var root = RowWriter()
        root.required("app", "MyMoney")
        root.required("schemaVersion", schemaVersion)
        root.required("exportedAt", exportedAt)
        root.required("manifest", encode(manifest))
        var tableMembers: [String: JSONValue] = [:]
        for (name, rows) in tables { tableMembers[name] = .array(rows) }
        root.required("tables", .object(tableMembers))
        return root.value
    }

    /// The file as text: indented while it is small enough for a human to
    /// read, compact once it is big enough for the size to matter. The
    /// threshold is counted over the rows of the document itself, exactly as
    /// src/backup/backup.ts's `totalRows` does.
    public static func serialise(_ file: JSONValue) -> String {
        var rows = 0
        for (_, table) in file["tables"]?.objectValue ?? [:] {
            rows += table.arrayValue?.count ?? 0
        }
        return CanonicalJSON.text(file, indent: rows > prettyPrintRowLimit ? 0 : 2)
    }

    /// Book in, bytes out.
    public static func text(
        _ book: Book,
        exportedAt: String,
        schemaVersion: Int = Schema.version
    ) throws -> String {
        serialise(try file(book, exportedAt: exportedAt, schemaVersion: schemaVersion))
    }
}
