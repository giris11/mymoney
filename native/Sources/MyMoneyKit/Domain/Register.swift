// One row of the transaction register, as a person reads it.
//
// WHY THIS IS IN THE KIT AND NOT IN THE APP. Everything below is a RULE about
// what a row says -- which name wins when a transaction has both a payee and a
// note, what a transfer leg is called, what a split says instead of a category,
// what "no category" is called. The web app states those rules in
// src/ui/tx/TxRow.tsx, and if the phone stated them separately the two apps
// would drift the first time either was edited. A view is not a place a rule
// can be tested; this is.
//
// THE RUNNING BALANCE IS THE ONE PIECE OF ARITHMETIC HERE, and it is stated as
// a subtraction going BACKWARDS through time, because that is the only shape
// that survives paging. See `RunningBalance` at the bottom.
import Foundation

/// What the middle line of a register row says, already decided.
///
/// A closed set rather than a string so the app cannot invent a fourth kind,
/// and so a test can assert the choice rather than the wording.
public enum RegisterCategoryLine: Sendable, Hashable {
    /// A transfer leg. `otherAccountName` is nil when the other leg is not in
    /// this book (a half-imported transfer) -- said out loud rather than
    /// guessed at.
    case transfer(outgoing: Bool, otherAccountName: String?)
    /// A split transaction, and how many DISTINCT categories it touches.
    case split(categoryCount: Int)
    /// "Food › Dining › Coffee", already resolved through the tree.
    case category(String)
    /// No category, and not a transfer or a split.
    case uncategorised
}

/// One row, resolved: no ids left, nothing further to look up, nothing left to
/// decide. Sendable because it crosses from the store's actor to the main one.
public struct RegisterRow: Sendable, Hashable, Identifiable {
    public let id: String
    public let accountId: String
    public let accountName: String
    /// The account's colour, "#rrggbb" as the file carries it.
    public let accountColour: String
    /// "YYYY-MM-DD". A calendar date, never an instant.
    public let date: String
    /// The line the eye goes to first: payee, else the first line of the note,
    /// else "Transfer", else "No payee".
    public let title: String
    /// True when `title` is a stand-in ("No payee") rather than something the
    /// owner actually wrote -- so the UI can render it quietly without
    /// second-guessing the string.
    public let titleIsPlaceholder: Bool
    public let categoryLine: RegisterCategoryLine
    /// Signed minor units, in `currency`. Negative is money out.
    public let amountMinor: Int64
    /// The TRANSACTION's currency as the row carries it. Displayed with the
    /// row, never converted, never added to anything in another currency.
    public let currency: String
    public let status: TxStatus
    public let notes: String
    /// Tag names, in the order the transaction carries them.
    public let tagNames: [String]
    /// The sort key this row was returned under, and the cursor a later page
    /// resumes from. Carried on the row so paging cannot be driven by anything
    /// other than what was actually read.
    public let cursor: RegisterCursor

    public init(
        id: String,
        accountId: String,
        accountName: String,
        accountColour: String,
        date: String,
        title: String,
        titleIsPlaceholder: Bool,
        categoryLine: RegisterCategoryLine,
        amountMinor: Int64,
        currency: String,
        status: TxStatus,
        notes: String,
        tagNames: [String],
        cursor: RegisterCursor
    ) {
        self.id = id
        self.accountId = accountId
        self.accountName = accountName
        self.accountColour = accountColour
        self.date = date
        self.title = title
        self.titleIsPlaceholder = titleIsPlaceholder
        self.categoryLine = categoryLine
        self.amountMinor = amountMinor
        self.currency = currency
        self.status = status
        self.notes = notes
        self.tagNames = tagNames
        self.cursor = cursor
    }
}

/// Where a page of the register stopped: the exact sort key of its last row.
///
/// KEYSET, NOT OFFSET. `LIMIT ? OFFSET ?` makes the database walk and discard
/// every row before the window, so page 40 of a long register costs forty times
/// page 1 -- and if a row is inserted or removed between two pages, offsets
/// skip or repeat a row silently. A cursor is a position in the ordering
/// itself: page N+1 is "the rows strictly after this key", which is one index
/// seek regardless of how deep it is, and cannot double-count.
public struct RegisterCursor: Sendable, Hashable {
    public let date: String
    public let createdAt: String
    public let id: String

    public init(date: String, createdAt: String, id: String) {
        self.date = date
        self.createdAt = createdAt
        self.id = id
    }
}

/// A page, plus whether there is more behind it.
public struct RegisterPage: Sendable {
    public let rows: [RegisterRow]
    /// nil when this page reached the end of the register.
    public let nextCursor: RegisterCursor?

    public init(rows: [RegisterRow], nextCursor: RegisterCursor?) {
        self.rows = rows
        self.nextCursor = nextCursor
    }

    public var isLastPage: Bool { nextCursor == nil }
}

public enum Register {
    /// The register's order, stated ONCE, in order of significance: the whole
    /// sort key, and the only place it is written down.
    ///
    /// The TypeScript (`queryTransactions`) sorts on `date` then `createdAt` and
    /// stops, relying on JavaScript's sort being stable to leave equal rows in
    /// index order. SQL has no such thing as "the order they were already in",
    /// so this adds `id` as a THIRD key. It is a tie-break, not a change: it
    /// only ever orders rows the TypeScript comparator calls equal, and without
    /// it a paged read could return the same row twice or skip one, because a
    /// cursor needs a TOTAL order to resume from.
    public static let orderColumns = ["date", "created_at", "id"]

    /// `ORDER BY` for the register, optionally qualified by a table alias.
    ///
    /// Built from `orderColumns` rather than written out, and taking the alias
    /// as an argument rather than being patched afterwards: the first version of
    /// this substituted ", " for ", t." in a fixed string, which produced the
    /// right SQL and would have produced silently WRONG SQL the moment anyone
    /// changed the spacing.
    public static func orderClause(qualifiedBy alias: String? = nil) -> String {
        let prefix = alias.map { "\($0)." } ?? ""
        return orderColumns.map { "\(prefix)\($0) DESC" }.joined(separator: ", ")
    }

    /// The cursor comparison, as a row-value expression over the same columns.
    /// One place, so the ordering and the thing that resumes it cannot drift.
    public static func cursorPredicate(qualifiedBy alias: String? = nil) -> String {
        let prefix = alias.map { "\($0)." } ?? ""
        let columns = orderColumns.map { "\(prefix)\($0)" }.joined(separator: ", ")
        let placeholders = Array(repeating: "?", count: orderColumns.count).joined(separator: ", ")
        return "(\(columns)) < (\(placeholders))"
    }

    /// The first line of a multi-line note; the whole thing when it has one line.
    /// `indexOf('\n')`, character for character with the TypeScript.
    ///
    /// SCALARS, because Swift's `Character` makes "\r\n" a single grapheme that
    /// equals neither "\r" nor "\n" -- searched as Characters, a note saved
    /// with Windows line endings has no `\n` in it at all and the register row
    /// shows the whole note instead of its first line. JS strings are UTF-16
    /// code units, so `indexOf` finds the LF of the pair and the slice keeps
    /// the CR; this now does the same.
    public static func firstLine(_ s: String) -> String {
        let scalars = s.unicodeScalars
        guard let i = scalars.firstIndex(of: "\n") else { return s }
        return String(String.UnicodeScalarView(scalars[scalars.startIndex..<i]))
    }

    /// What the row is called: payee, else the first line of the note, else
    /// "Transfer" for a transfer leg, else "No payee".
    ///
    /// `title.isEmpty` decides, not `title == nil` -- the TypeScript's `||`
    /// treats an empty payee name as absent and so does this.
    public static func title(
        payeeName: String?, notes: String, isTransfer: Bool
    ) -> (text: String, isPlaceholder: Bool) {
        if let payeeName, !payeeName.isEmpty { return (payeeName, false) }
        let note = firstLine(notes)
        if !note.isEmpty { return (note, false) }
        if isTransfer { return ("Transfer", false) }
        return ("No payee", true)
    }

    /// The middle line, chosen in the same order as the web app's row:
    /// transfer first, then split, then the category path, then nothing.
    public static func categoryLine(
        isTransfer: Bool,
        amountMinor: Int64,
        otherAccountName: String?,
        splitCategoryCount: Int,
        hasSplits: Bool,
        categoryPath: String?
    ) -> RegisterCategoryLine {
        if isTransfer {
            return .transfer(outgoing: amountMinor < 0, otherAccountName: otherAccountName)
        }
        if hasSplits { return .split(categoryCount: splitCategoryCount) }
        if let categoryPath, !categoryPath.isEmpty { return .category(categoryPath) }
        return .uncategorised
    }

    /// The middle line as text.
    public static func categoryText(_ line: RegisterCategoryLine) -> String {
        switch line {
        case .transfer(let outgoing, let other):
            let name = other ?? "another account"
            return outgoing ? "Transfer to \(name)" : "Transfer from \(name)"
        case .split(let n):
            return "Split \u{00B7} \(n) categor\(n == 1 ? "y" : "ies")"
        case .category(let path):
            return path
        case .uncategorised:
            return "Uncategorised"
        }
    }
}

/// The running balance down a register that is read NEWEST FIRST.
///
/// THE SHAPE IS FORCED BY PAGING. A running balance is naturally "opening plus
/// everything up to here", which is a sum over every OLDER row -- and the app
/// has not read the older rows yet, and must not have to in order to draw the
/// first screen. Going the other way is exact and needs nothing:
///
///     the newest row's running balance IS the account's balance;
///     the next row down is that, minus the newer row's amount.
///
/// Every value it produces is therefore the same integer the account's own
/// balance is built from, arrived at by subtraction rather than by a second
/// summation -- so the top of the register and the accounts screen cannot
/// disagree, whatever the paging did.
///
/// PER ACCOUNT ONLY, and the type will not pretend otherwise: `start` is a
/// balance in ONE account's currency, and a running total across accounts in
/// different currencies is not a number. The all-accounts register shows no
/// running balance for exactly that reason.
public struct RunningBalance: Sendable {
    /// The balance after the next row to be handed to `next(_:)`.
    public private(set) var current: Int64

    public init(startingAt balanceMinor: Int64) {
        self.current = balanceMinor
    }

    /// The running balance AT this row, then step back one row in time.
    /// Throws rather than wraps: see `Money.sum`.
    public mutating func next(_ amountMinor: Int64) throws -> Int64 {
        let atThisRow = current
        let (previous, overflowed) = current.subtractingReportingOverflow(amountMinor)
        if overflowed { throw MoneyError.overflow("running balance") }
        current = previous
        return atThisRow
    }
}
