// Turning parsed JSON rows into records, refusing rather than defaulting.
//
// THE RULE THIS FILE IS BUILT AROUND: a field that carries MEANING must be
// present, and a field that is STORAGE DETAIL may be absent. The oracle's
// books (tools/oracle/cases) deliberately omit colours, dedupe hashes and
// created/updated timestamps -- "a Swift port has no obligation to have those
// columns" -- while a missing `amountMinor` or a missing `currency` is a
// corrupt file and must say so, naming the row.
//
// Every error names its context ("transactions[4127].amountMinor"), because
// the alternative -- "invalid backup" -- is useless against a 5,127-row file
// and is what turns a five-minute fix into an evening.
import Foundation

public struct RecordDecodeError: Error, Equatable, Sendable, CustomStringConvertible {
    public let context: String
    public let message: String

    public var description: String { "\(context): \(message)" }
}

/// A reader over one JSON object, carrying the path it was found at.
public struct RowReader: Sendable {
    public let context: String
    public let members: [String: JSONValue]

    public init(_ value: JSONValue, context: String) throws {
        guard let members = value.objectValue else {
            throw RecordDecodeError(context: context, message: "expected an object, found \(value.kindName)")
        }
        self.context = context
        self.members = members
    }

    public init(members: [String: JSONValue], context: String) {
        self.context = context
        self.members = members
    }

    func fail(_ key: String, _ message: String) -> RecordDecodeError {
        RecordDecodeError(context: "\(context).\(key)", message: message)
    }

    public func raw(_ key: String) -> JSONValue? { members[key] }

    /// A required non-empty string.
    public func string(_ key: String) throws -> String {
        guard let value = members[key] else { throw fail(key, "is missing") }
        guard let s = value.stringValue else { throw fail(key, "must be a string, found \(value.kindName)") }
        return s
    }

    /// A required string that may be empty.
    public func string(_ key: String, default fallback: String) throws -> String {
        guard let value = members[key], !value.isNull else { return fallback }
        guard let s = value.stringValue else { throw fail(key, "must be a string, found \(value.kindName)") }
        return s
    }

    /// A nullable string. `null` and absent both mean nil -- they are different
    /// claims in JSON, but this format uses absence only for rows written by an
    /// older build, and both mean "there isn't one".
    public func optionalString(_ key: String) throws -> String? {
        guard let value = members[key], !value.isNull else { return nil }
        guard let s = value.stringValue else { throw fail(key, "must be a string or null, found \(value.kindName)") }
        return s
    }

    /// A required exact Int64. This is the one that guards the money.
    public func int64(_ key: String) throws -> Int64 {
        guard let value = members[key] else { throw fail(key, "is missing") }
        guard let i = value.intValue else {
            throw fail(key, "must be a whole number of minor units, found \(value.kindName)")
        }
        return i
    }

    public func int64(_ key: String, default fallback: Int64) throws -> Int64 {
        guard let value = members[key], !value.isNull else { return fallback }
        guard let i = value.intValue else {
            throw fail(key, "must be a whole number, found \(value.kindName)")
        }
        return i
    }

    public func optionalInt64(_ key: String) throws -> Int64? {
        guard let value = members[key], !value.isNull else { return nil }
        guard let i = value.intValue else { throw fail(key, "must be a whole number or null") }
        return i
    }

    public func int(_ key: String, default fallback: Int) throws -> Int {
        let value = try int64(key, default: Int64(fallback))
        guard let narrowed = Int(exactly: value) else { throw fail(key, "is out of range") }
        return narrowed
    }

    public func optionalInt(_ key: String) throws -> Int? {
        guard let value = try optionalInt64(key) else { return nil }
        guard let narrowed = Int(exactly: value) else { throw fail(key, "is out of range") }
        return narrowed
    }

    public func double(_ key: String) throws -> Double {
        guard let value = members[key] else { throw fail(key, "is missing") }
        guard let d = value.doubleValue else { throw fail(key, "must be a number, found \(value.kindName)") }
        return d
    }

    public func optionalDouble(_ key: String) throws -> Double? {
        guard let value = members[key], !value.isNull else { return nil }
        guard let d = value.doubleValue else { throw fail(key, "must be a number or null") }
        return d
    }

    public func bool(_ key: String, default fallback: Bool) throws -> Bool {
        guard let value = members[key], !value.isNull else { return fallback }
        guard let b = value.boolValue else { throw fail(key, "must be true or false, found \(value.kindName)") }
        return b
    }

    /// Exactly the TypeScript's `x === true`.
    ///
    /// Used for `excludeFromNetWorth`, which is optional there precisely so
    /// that every row written before the flag existed is already correct.
    /// Absent, null and false all mean "counts toward net worth"; only a
    /// literal `true` takes an account out of the total, and a string "true"
    /// does not -- a truthiness test here would be a net worth that changed
    /// because somebody hand-edited a file.
    public func trueFlag(_ key: String) -> Bool {
        members[key] == .bool(true)
    }

    /// `trueFlag`, but remembering whether the key was there at all.
    ///
    /// nil means ABSENT; `.some(false)` means the row said `false` out loud.
    /// The two are the same answer to every money question -- the only test
    /// anyone runs on the result is `== true` -- and DIFFERENT BYTES in a
    /// backup file, which a re-export has to reproduce exactly. Anything
    /// present but not a boolean reads as `.some(false)`: the file is already
    /// corrupt at that key, and normalising it is a smaller lie than promoting
    /// a string to a flag that decides what counts toward net worth.
    public func presentTrueFlag(_ key: String) -> Bool? {
        guard let value = members[key] else { return nil }
        return value == .bool(true)
    }

    public func strings(_ key: String, default fallback: [String] = []) throws -> [String] {
        guard let value = members[key], !value.isNull else { return fallback }
        guard let items = value.arrayValue else { throw fail(key, "must be an array of strings") }
        return try items.map {
            guard let s = $0.stringValue else { throw fail(key, "must contain only strings") }
            return s
        }
    }

    public func optionalStrings(_ key: String) throws -> [String]? {
        guard let value = members[key], !value.isNull else { return nil }
        return try strings(key)
    }

    public func enumeration<T: RawRepresentable & CaseIterable>(
        _ key: String, _ type: T.Type
    ) throws -> T where T.RawValue == String {
        let raw = try string(key)
        guard let value = T(rawValue: raw) else {
            let known = T.allCases.map { "\"\($0.rawValue)\"" }.joined(separator: ", ")
            throw fail(key, "is \"\(raw)\", which is not one of \(known)")
        }
        return value
    }

    public func enumeration<T: RawRepresentable & CaseIterable>(
        _ key: String, _ type: T.Type, default fallback: T
    ) throws -> T where T.RawValue == String {
        guard let value = members[key], !value.isNull else { return fallback }
        guard let s = value.stringValue else { throw fail(key, "must be a string") }
        guard let parsed = T(rawValue: s) else {
            let known = T.allCases.map { "\"\($0.rawValue)\"" }.joined(separator: ", ")
            throw fail(key, "is \"\(s)\", which is not one of \(known)")
        }
        return parsed
    }
}

// MARK: - Records from rows

public extension Account {
    init(row: RowReader) throws {
        self.init(
            id: try row.string("id"),
            name: try row.string("name", default: ""),
            type: try row.enumeration("type", AccountType.self, default: .current),
            currency: try row.string("currency"),
            openingBalanceMinor: try row.int64("openingBalanceMinor"),
            colour: try row.string("colour", default: ""),
            groupId: try row.optionalString("groupId"),
            sortOrder: try row.int("sortOrder", default: 0),
            archived: try row.bool("archived", default: false),
            excludeFromNetWorth: row.presentTrueFlag("excludeFromNetWorth"),
            loanPrincipalMinor: try row.optionalInt64("loanPrincipalMinor"),
            loanRatePct: try row.optionalDouble("loanRatePct"),
            loanTermMonths: try row.optionalInt("loanTermMonths")
        )
    }
}

public extension AccountGroup {
    init(row: RowReader) throws {
        self.init(
            id: try row.string("id"),
            name: try row.string("name", default: ""),
            sortOrder: try row.int("sortOrder", default: 0)
        )
    }
}

public extension Split {
    init(row: RowReader) throws {
        self.init(
            categoryId: try row.optionalString("categoryId"),
            amountMinor: try row.int64("amountMinor"),
            notes: try row.optionalString("notes")
        )
    }
}

public extension Transaction {
    init(row: RowReader) throws {
        var splits: [Split] = []
        if let raw = row.raw("splits"), !raw.isNull {
            guard let items = raw.arrayValue else {
                throw RecordDecodeError(context: "\(row.context).splits", message: "must be an array")
            }
            splits = try items.enumerated().map { index, item in
                try Split(row: RowReader(item, context: "\(row.context).splits[\(index)]"))
            }
        }
        self.init(
            id: try row.string("id"),
            accountId: try row.string("accountId"),
            date: try row.string("date"),
            amountMinor: try row.int64("amountMinor"),
            currency: try row.string("currency"),
            payeeId: try row.optionalString("payeeId"),
            categoryId: try row.optionalString("categoryId"),
            tagIds: try row.strings("tagIds"),
            notes: try row.string("notes", default: ""),
            status: try row.enumeration("status", TxStatus.self, default: .cleared),
            splits: splits,
            transferGroupId: try row.optionalString("transferGroupId"),
            importBatchId: try row.optionalString("importBatchId"),
            dedupeHash: try row.string("dedupeHash", default: ""),
            createdAt: try row.string("createdAt", default: ""),
            updatedAt: try row.string("updatedAt", default: "")
        )
    }
}

public extension Category {
    init(row: RowReader) throws {
        self.init(
            id: try row.string("id"),
            name: try row.string("name", default: ""),
            parentId: try row.optionalString("parentId"),
            kind: try row.enumeration("kind", CategoryKind.self),
            icon: try row.optionalString("icon"),
            colour: try row.optionalString("colour"),
            archived: try row.bool("archived", default: false),
            sortOrder: try row.int("sortOrder", default: 0)
        )
    }
}

public extension Payee {
    init(row: RowReader) throws {
        let name = try row.string("name", default: "")
        self.init(
            id: try row.string("id"),
            name: name,
            nameLower: try row.optionalString("nameLower"),
            defaultCategoryId: try row.optionalString("defaultCategoryId")
        )
    }
}

public extension Tag {
    init(row: RowReader) throws {
        self.init(
            id: try row.string("id"),
            name: try row.string("name", default: ""),
            nameLower: try row.optionalString("nameLower")
        )
    }
}

public extension Budget {
    init(row: RowReader) throws {
        self.init(
            id: try row.string("id"),
            name: try row.string("name", default: ""),
            categoryIds: try row.strings("categoryIds"),
            amountMinor: try row.int64("amountMinor"),
            period: try row.enumeration("period", BudgetPeriod.self),
            startDate: try row.string("startDate"),
            rollover: try row.bool("rollover", default: false),
            archived: try row.bool("archived", default: false)
        )
    }
}

public extension FxRate {
    init(row: RowReader) throws {
        let base = try row.string("base")
        let quote = try row.string("quote")
        self.init(
            id: try row.string("id", default: "\(base):\(quote)"),
            base: base,
            quote: quote,
            rate: try row.double("rate"),
            asOf: try row.string("asOf", default: ""),
            source: try row.enumeration("source", FxRateSource.self, default: .manual)
        )
    }
}

public extension ImportBatch {
    init(row: RowReader) throws {
        self.init(
            id: try row.string("id"),
            source: try row.enumeration("source", ImportSource.self),
            fileName: try row.string("fileName", default: ""),
            rowCount: try row.int("rowCount", default: 0),
            importedAt: try row.string("importedAt", default: ""),
            createdAccountIds: try row.strings("createdAccountIds"),
            createdCategoryIds: try row.strings("createdCategoryIds"),
            createdPayeeIds: try row.strings("createdPayeeIds"),
            createdTagIds: try row.strings("createdTagIds"),
            createdGroupIds: try row.strings("createdGroupIds"),
            createdBudgetIds: try row.optionalStrings("createdBudgetIds"),
            createdFxRateIds: try row.optionalStrings("createdFxRateIds")
        )
    }
}

public extension ColumnMapping {
    init(row: RowReader) throws {
        self.init(
            date: try row.int("date", default: -1),
            amount: try row.int("amount", default: -1),
            debit: try row.int("debit", default: -1),
            credit: try row.int("credit", default: -1),
            payee: try row.int("payee", default: -1),
            description: try row.int("description", default: -1),
            category: try row.int("category", default: -1),
            account: try row.int("account", default: -1),
            currency: try row.int("currency", default: -1),
            tags: try row.int("tags", default: -1),
            notes: try row.int("notes", default: -1),
            dateFormat: try row.string("dateFormat", default: "auto"),
            decimal: try row.string("decimal", default: "auto"),
            negate: try row.bool("negate", default: false),
            headerRow: try row.bool("headerRow", default: true)
        )
    }
}

public extension Settings {
    init(row: RowReader, value: JSONValue) throws {
        var mappings: [String: ColumnMapping] = [:]
        if let raw = row.raw("savedMappings"), !raw.isNull {
            guard let members = raw.objectValue else {
                throw RecordDecodeError(context: "\(row.context).savedMappings", message: "must be an object")
            }
            for (key, mapping) in members {
                mappings[key] = try ColumnMapping(
                    row: RowReader(mapping, context: "\(row.context).savedMappings[\(key)]")
                )
            }
        }
        self.init(
            id: try row.string("id"),
            schemaVersion: try row.int("schemaVersion", default: 1),
            // Defaulted rather than required. src/backup/manifest.ts's
            // baseCurrencyFromRows treats a missing OR EMPTY baseCurrency as
            // "not stated" and falls back; refusing here would make a file the
            // web app can still restore unreadable on the phone, which is
            // itself a way to lose data. Book.baseCurrency resolves the blank.
            baseCurrency: try row.string("baseCurrency", default: ""),
            theme: try row.enumeration("theme", ThemeChoice.self, default: .system),
            lastBackupAt: try row.optionalString("lastBackupAt"),
            onboarded: try row.bool("onboarded", default: false),
            lastUsedAccountId: try row.optionalString("lastUsedAccountId"),
            savedMappings: mappings,
            createdAt: try row.string("createdAt", default: ""),
            autoFxEnabled: try row.bool("autoFxEnabled", default: false),
            lastFxSyncAt: try row.optionalString("lastFxSyncAt"),
            lastFxSyncSource: try row.optionalString("lastFxSyncSource"),
            raw: value
        )
    }
}

/// Decode a whole table, naming the row that failed.
func decodeRows<T>(
    _ rows: [JSONValue],
    table: String,
    make: (RowReader) throws -> T
) throws -> [T] {
    try rows.enumerated().map { index, value in
        try make(RowReader(value, context: "\(table)[\(index)]"))
    }
}
