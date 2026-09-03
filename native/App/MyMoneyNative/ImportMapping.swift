// A generic CSV's column mapping: how the phone edits it, and how it is
// remembered for the next file of the same shape.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A SECOND MAPPING TYPE AT ALL
//
// `MyMoneyKit.ColumnMapping` is what the parser takes and what a backup file
// carries, and every one of its fields is a `let` whose memberwise initialiser
// is internal to the package. That is right for a record: a mapping stored in a
// book should not be half-edited in place. It is the wrong shape for a screen,
// where the whole point is that the owner changes one column at a time and sees
// what it does.
//
// So the screen edits `CSVMapping` -- the same fifteen fields, all `var` -- and
// converts to the kit's record at the one moment it is needed, which is the
// call to `Import.parseWithMapping`. The conversion goes through
// `ColumnMapping(row:)`, the kit's own public decoder, which is the SAME door a
// backup file's saved mapping comes through. That is not a workaround: it means
// a mapping this phone builds is byte-for-byte a mapping the book could carry,
// and the web app's saved mappings and this app's are the same values keyed the
// same way.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE A REMEMBERED MAPPING LIVES, AND WHY IT IS NOT IN THE BOOK
//
// The web app writes it to `settings.savedMappings`, which travels in a backup
// file. This app READS that -- a book imported from the web app already knows
// how to read the statements the web app has read -- and writes its own to this
// device's defaults instead.
//
// Two reasons, and only the first is about ownership:
//
//   * `MyMoneyKit` exposes no writer for `savedMappings`. There is
//     `setBaseCurrency` and nothing else that touches the settings row, and
//     this app does not add write paths to the kit from the outside.
//   * A remembered mapping is not the owner's money. Writing one would count
//     as a local edit -- the banner would climb by one every time a statement
//     was previewed -- and it would change the book's content hash, so the
//     round-trip check that says "nothing was lost and nothing was invented"
//     would start reporting a difference caused by looking at a file.
//
// The cost is that a mapping corrected on the phone does not travel back to the
// browser. That is a smaller price than a ledger that changes when you read a
// statement, and the screen says which of the two mappings it loaded.
import Foundation
import MyMoneyKit

// MARK: - The eleven things a column can be

/// One field a CSV column can be mapped to. `ignore` is the absence of one and
/// is deliberately not a case: a column maps to a field or to nothing, and
/// "nothing" is already spelled -1 in the record.
enum CSVField: String, CaseIterable, Identifiable, Hashable {
    case date, amount, debit, credit, payee, description
    case category, account, currency, tags, notes

    var id: String { rawValue }

    /// The same words the web app's Map step uses, so the two screens can be
    /// read side by side.
    var label: String {
        switch self {
        case .date: return "Date"
        case .amount: return "Amount"
        case .debit: return "Debit (money out)"
        case .credit: return "Credit (money in)"
        case .payee: return "Payee"
        case .description: return "Description"
        case .category: return "Category"
        case .account: return "Account"
        case .currency: return "Currency"
        case .tags: return "Tags"
        case .notes: return "Notes"
        }
    }
}

// MARK: - The mapping the screen edits

/// The fifteen values of a `ColumnMapping`, mutable.
///
/// Column indices are 0-based; -1 means "this file has no such column".
struct CSVMapping: Equatable, Codable, Sendable {
    var date = -1
    var amount = -1
    var debit = -1
    var credit = -1
    var payee = -1
    var description = -1
    var category = -1
    var account = -1
    var currency = -1
    var tags = -1
    var notes = -1
    /// "auto", "DMY", "MDY" or "YMD".
    var dateFormat = "auto"
    /// "auto", "dot" or "comma".
    var decimal = "auto"
    /// Money out is written positive in this file, so every sign flips.
    var negate = false
    /// The first row of the file is column names rather than a transaction.
    var headerRow = true

    init() {}

    /// A mapping that arrived from the kit -- a guess, or one a book carries.
    init(_ mapping: ColumnMapping) {
        date = mapping.date
        amount = mapping.amount
        debit = mapping.debit
        credit = mapping.credit
        payee = mapping.payee
        description = mapping.description
        category = mapping.category
        account = mapping.account
        currency = mapping.currency
        tags = mapping.tags
        notes = mapping.notes
        dateFormat = mapping.dateFormat
        decimal = mapping.decimal
        negate = mapping.negate
        headerRow = mapping.headerRow
    }

    subscript(field: CSVField) -> Int {
        get {
            switch field {
            case .date: return date
            case .amount: return amount
            case .debit: return debit
            case .credit: return credit
            case .payee: return payee
            case .description: return description
            case .category: return category
            case .account: return account
            case .currency: return currency
            case .tags: return tags
            case .notes: return notes
            }
        }
        set {
            switch field {
            case .date: date = newValue
            case .amount: amount = newValue
            case .debit: debit = newValue
            case .credit: credit = newValue
            case .payee: payee = newValue
            case .description: description = newValue
            case .category: category = newValue
            case .account: account = newValue
            case .currency: currency = newValue
            case .tags: tags = newValue
            case .notes: notes = newValue
            }
        }
    }

    /// Which field, if any, this column is currently mapped to.
    func field(forColumn column: Int) -> CSVField? {
        CSVField.allCases.first { self[$0] == column }
    }

    /// Point one column at one field, taking it away from whatever field held
    /// it before.
    ///
    /// ONE COLUMN CANNOT BE TWO FIELDS. `parseWithMapping` reads each field's
    /// index independently, so a file whose Amount and Debit both pointed at
    /// column 3 would have its amount computed twice by two different rules --
    /// once as a signed amount, once as a forced-negative debit -- and the
    /// second would win. Clearing first makes that unrepresentable rather than
    /// unlikely.
    mutating func assign(column: Int, to field: CSVField?) {
        for existing in CSVField.allCases where self[existing] == column {
            self[existing] = -1
        }
        if let field { self[field] = column }
    }

    /// What is still missing before this file can be previewed, in the owner's
    /// words. Empty means it can.
    ///
    /// The same three requirements the engine has: a date, an amount, and an
    /// account for the row to land in. `fixedAccountChosen` satisfies the third
    /// on its own, because it overrides the mapped Account column for every row.
    ///
    /// `accountAdvice` COMES FROM THE CALLER because the advice depends on the
    /// book, not on the mapping: "choose one above" cannot be followed when the
    /// picker is empty. See `ImportAdvice.accountRequirement`.
    func missingRequirements(fixedAccountChosen: Bool, accountAdvice: String) -> [String] {
        var missing: [String] = []
        if date < 0 { missing.append("a Date column") }
        if amount < 0 && debit < 0 && credit < 0 {
            missing.append("an Amount column, or a Debit and Credit pair")
        }
        if account < 0 && !fixedAccountChosen {
            missing.append(accountAdvice)
        }
        return missing
    }

    /// The kit's record, built through the kit's own public decoder.
    ///
    /// IT CANNOT THROW FOR ANYTHING THIS TYPE CAN HOLD: every key below is
    /// written here, with the type `ColumnMapping(row:)` reads it as. The
    /// fallback is `Import.emptyMapping()`, which maps NOTHING -- so if this
    /// ever did fail, every row of the file would come back as "No date column
    /// mapped" and the preview would refuse the lot. A loud nothing, never a
    /// quiet wrong column.
    var columnMapping: ColumnMapping {
        let members: [String: JSONValue] = [
            "date": .int(Int64(date)),
            "amount": .int(Int64(amount)),
            "debit": .int(Int64(debit)),
            "credit": .int(Int64(credit)),
            "payee": .int(Int64(payee)),
            "description": .int(Int64(description)),
            "category": .int(Int64(category)),
            "account": .int(Int64(account)),
            "currency": .int(Int64(currency)),
            "tags": .int(Int64(tags)),
            "notes": .int(Int64(notes)),
            "dateFormat": .string(dateFormat),
            "decimal": .string(decimal),
            "negate": .bool(negate),
            "headerRow": .bool(headerRow),
        ]
        let reader = RowReader(members: members, context: "columnMapping")
        return (try? ColumnMapping(row: reader)) ?? Import.emptyMapping()
    }
}

// MARK: - Which file this is

enum ImportFileSignature {

    /// The key a mapping is remembered under. `fileSignature` in
    /// src/import/generic.ts, with one deliberate difference noted below.
    ///
    /// With a header row the headers ARE the signature. A headerless export has
    /// none -- `headers` is then the first DATA row, and keying on it would
    /// mint a new signature every month as the dates and amounts changed, so a
    /// saved mapping could never be found again. The column count is the one
    /// property of a headerless layout that does not vary row to row.
    ///
    /// THE DIFFERENCE, AND WHY IT IS THE SAFE DIRECTION. The web app builds
    /// each piece with `h.trim().toLowerCase()`; this uses `Names.key`, which
    /// also collapses a run of whitespace INSIDE a header to one space. The
    /// stricter rule is the one available: `Money.trimmingJSWhitespace` is
    /// internal to the kit, and copying its whitespace set into this app is the
    /// duplication `Names.swift` exists to argue against. So a header written
    /// "Current  balance" keys differently here from in the browser -- and
    /// `matches` below closes that gap by normalising the stored key the same
    /// way before comparing, so a mapping the web app saved is still found.
    static func of(headers: [String], headerRow: Bool) -> String {
        if !headerRow { return "nohdr:\(headers.count)" }
        return headers.map(Names.key).joined(separator: "|")
    }

    /// Is `storedKey` -- a key written by whichever app saved it -- the key for
    /// this file? Both sides are put through the same rule first, so the
    /// browser's looser trim and this app's stricter one agree.
    static func matches(storedKey: String, signature: String) -> Bool {
        if storedKey == signature { return true }
        return storedKey.split(separator: "|", omittingEmptySubsequences: false)
            .map { Names.key(String($0)) }
            .joined(separator: "|") == signature
    }
}

// MARK: - Remembering one

/// Where a mapping the owner corrected on this device is kept.
///
/// Device defaults, not the book -- see this file's header. Small, bounded, and
/// throwaway: losing it costs one screen of taps on the next statement of the
/// same shape, so nothing here is worth a migration or an error path.
enum MappingMemory {
    /// Everything under one key, so the whole thing can be read and written in
    /// one go and there is no chance of a half-updated set.
    private static let storageKey = "import.mappings.v1"
    /// How many layouts are remembered. A phone that has previewed twenty
    /// different bank exports is not a phone anybody has; the cap exists so a
    /// defaults value cannot grow without limit, which is the same reason the
    /// web app's canonical form treats this map as unbounded and orders it.
    static let capacity = 20

    private struct Entry: Codable {
        var mapping: CSVMapping
        /// When it was last used, so the cap drops the least recently useful.
        var usedAt: Date
    }

    private static func load(from defaults: UserDefaults) -> [String: Entry] {
        guard let data = defaults.data(forKey: storageKey) else { return [:] }
        return (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    /// The mapping this device remembers for a file of this shape.
    static func remembered(
        for signature: String, in defaults: UserDefaults = .standard
    ) -> CSVMapping? {
        load(from: defaults)[signature]?.mapping
    }

    /// Remember it, replacing anything held for the same shape.
    ///
    /// Called when the owner moves PAST the map step, not while they are
    /// editing: a half-built mapping remembered mid-edit would be offered back
    /// as the answer next time.
    static func remember(
        _ mapping: CSVMapping, for signature: String, in defaults: UserDefaults = .standard,
        now: Date = Date()
    ) {
        guard !signature.isEmpty else { return }
        var stored = load(from: defaults)
        stored[signature] = Entry(mapping: mapping, usedAt: now)
        if stored.count > capacity {
            let oldest = stored.sorted { $0.value.usedAt < $1.value.usedAt }
                .prefix(stored.count - capacity)
            for (key, _) in oldest { stored.removeValue(forKey: key) }
        }
        guard let data = try? JSONEncoder().encode(stored) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

/// Where the mapping on screen came from, so the screen can say so rather than
/// silently pre-filling boxes.
enum MappingOrigin: Hashable {
    /// Worked out from the headers and the first few rows.
    case guessed
    /// Corrected on this device for a file of this shape, and remembered.
    case device
    /// Carried in the book -- saved by the web app when it read a file of this
    /// shape.
    case book

    var note: String? {
        switch self {
        case .guessed:
            return nil
        case .device:
            return "Loaded the mapping you saved on this device for this layout. Change anything "
                + "that is wrong."
        case .book:
            return "Loaded the mapping your web app saved for this layout. Change anything that "
                + "is wrong."
        }
    }
}
