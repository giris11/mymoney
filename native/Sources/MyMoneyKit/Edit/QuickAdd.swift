// What the fast path needs to be fast.
//
// THE THREE-SECOND COFFEE IS A DATA PROBLEM BEFORE IT IS A UI PROBLEM. Amount,
// category, done -- that only works if the account is already right, the date is
// already right, the payee completes from two letters, and choosing the payee
// fills the category in. Every one of those is a lookup, and a lookup that
// touches the database on each keystroke is a lookup that stutters on a phone.
//
// So the ranking lives in a VALUE. `PayeeIndex` is read once when the screen
// opens, is `Sendable`, and answers every keystroke in memory. It is also, for
// exactly that reason, testable without a store: the interesting behaviour --
// which of two payees comes first -- is a pure function of a list and a query,
// and it is tested as one.
import Foundation

/// One completion, with everything the form fills in when it is chosen.
public struct PayeeSuggestion: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    /// What this payee has usually been filed under (D17, learned). Choosing
    /// the payee sets the category to this, which is the second of the three
    /// taps disappearing.
    public let defaultCategoryId: String?
    /// How many live transactions name this payee. The reason a payee used
    /// weekly beats one used once, for the same typed prefix.
    public let useCount: Int
    /// The newest date it appears on, "YYYY-MM-DD". Breaks ties towards the
    /// habit the owner currently has rather than the one they used to have.
    public let lastUsedDate: String?

    public init(
        id: String, name: String, defaultCategoryId: String?, useCount: Int,
        lastUsedDate: String?
    ) {
        self.id = id
        self.name = name
        self.defaultCategoryId = defaultCategoryId
        self.useCount = useCount
        self.lastUsedDate = lastUsedDate
    }
}

/// Every payee, with its usage, ready to be searched without touching the
/// database.
public struct PayeeIndex: Sendable {
    public let payees: [PayeeSuggestion]
    /// The lowercased match key for each, in the same order. Precomputed
    /// because it is the thing every keystroke compares against.
    private let keys: [String]

    public init(payees: [PayeeSuggestion]) {
        self.payees = payees
        self.keys = payees.map { Names.key($0.name) }
    }

    public var isEmpty: Bool { payees.isEmpty }

    public func payee(id: String) -> PayeeSuggestion? { payees.first { $0.id == id } }

    /// Completions for what has been typed so far.
    ///
    /// THE ORDER IS: everything whose name STARTS WITH the query, then
    /// everything that merely CONTAINS it; within each band, most-used first,
    /// then most-recently-used, then alphabetically.
    ///
    /// A DELIBERATE IMPROVEMENT ON THE WEB APP, which bands the same way and
    /// then sorts each band alphabetically (`searchPayees` in
    /// src/domain/payees.ts). Alphabetical is right when nothing is known about
    /// the payees; here something is: how often each has actually been used.
    /// Typing "s" in a real book should not offer a shop visited once in 2019
    /// ahead of the supermarket used every week, and it is safe to differ
    /// because the ORDER OF A MENU IS NOT DATA -- whichever row is chosen
    /// resolves to the same payee id in both apps.
    ///
    /// An empty query returns the most-used payees, which is what an empty
    /// field should offer: the answer is nearly always one of them.
    public func suggestions(matching query: String, limit: Int = 8) -> [PayeeSuggestion] {
        precondition(limit > 0, "a suggestion list of no rows is not a list")
        let key = Names.key(query)
        var prefix: [Int] = []
        var contains: [Int] = []
        for (index, candidate) in keys.enumerated() {
            if key.isEmpty || candidate.hasPrefix(key) {
                prefix.append(index)
            } else if candidate.contains(key) {
                contains.append(index)
            }
        }
        let ranked = rank(prefix) + rank(contains)
        return Array(ranked.prefix(limit))
    }

    /// Is this exactly the name of a payee that already exists? Asked so the UI
    /// can say "new payee" when it is about to create one -- creating a payee is
    /// not a problem, but doing it because of a typo silently is.
    public func exactMatch(_ query: String) -> PayeeSuggestion? {
        let key = Names.key(query)
        guard !key.isEmpty, let index = keys.firstIndex(of: key) else { return nil }
        return payees[index]
    }

    private func rank(_ indices: [Int]) -> [PayeeSuggestion] {
        indices.map { payees[$0] }.sorted { a, b in
            if a.useCount != b.useCount { return a.useCount > b.useCount }
            let dateA = a.lastUsedDate ?? ""
            let dateB = b.lastUsedDate ?? ""
            if dateA != dateB { return dateA > dateB }
            let byName = a.name.compare(
                b.name, options: [], range: nil, locale: Locale(identifier: "en_GB")
            )
            if byName != .orderedSame { return byName == .orderedAscending }
            // A total order, so the same book never offers two different menus.
            return a.id < b.id
        }
    }
}

/// A category as a picker shows it: the full path, already resolved.
public struct CategoryChoice: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    /// "Food \u{203A} Dining \u{203A} Coffee".
    public let path: String
    public let kind: CategoryKind
    /// 0 for a top-level category. Drives indentation without a second tree
    /// walk in the view.
    public let depth: Int
    public let archived: Bool

    public init(
        id: String, name: String, path: String, kind: CategoryKind, depth: Int, archived: Bool
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.kind = kind
        self.depth = depth
        self.archived = archived
    }
}

/// Everything the Quick Add sheet needs to open already filled in.
public struct QuickAddContext: Sendable {
    /// Live accounts in sidebar order, archived ones LAST but still present --
    /// an archived account can still receive a correction, and a picker that
    /// hid it would leave the owner unable to fix history.
    public let accounts: [Account]
    /// Where a new entry goes unless the owner says otherwise: the account last
    /// written to, else the first non-archived one.
    public let defaultAccountId: String?
    public let categories: [CategoryChoice]
    /// The categories this book actually uses, most-used first. The row of
    /// buttons that removes the second tap.
    public let frequentCategoryIds: [String]
    public let payees: PayeeIndex

    public var defaultAccount: Account? {
        defaultAccountId.flatMap { id in accounts.first { $0.id == id } }
    }
}

extension LedgerStore {

    /// Every payee with its usage, in one pass. Read once per screen.
    public func payeeIndex() throws -> PayeeIndex {
        // LEFT JOIN so a payee with no live transactions is still offered --
        // it exists because somebody typed it, and it is about to be used
        // again.
        let statement = try connection.prepare(
            """
            SELECT p.id, p.name, p.default_category_id, count(t.id), max(t.date)
            FROM live_payees p
            LEFT JOIN live_transactions t ON t.payee_id = p.id
            GROUP BY p.id, p.name, p.default_category_id
            """
        )
        defer { statement.finalize() }
        var rows: [PayeeSuggestion] = []
        while try statement.step() {
            rows.append(
                PayeeSuggestion(
                    id: try statement.text(0),
                    name: try statement.text(1),
                    defaultCategoryId: try statement.optionalText(2),
                    useCount: try statement.int(3),
                    lastUsedDate: try statement.optionalText(4)
                )
            )
        }
        return PayeeIndex(payees: rows)
    }

    /// The category tree, flattened into paths a picker can show.
    ///
    /// Ordered by PATH, so children fall under their parents and the list reads
    /// as the tree it is. Archived categories are included and marked -- for the
    /// same reason archived accounts are: an old transaction filed under one
    /// must remain editable.
    public func categoryChoices() throws -> [CategoryChoice] {
        let categories = try readCategories(from: "live_categories")
        var byId: [String: Category] = [:]
        for category in categories { byId[category.id] = category }

        func depth(of category: Category) -> Int {
            var count = 0
            var seen: Set<String> = [category.id]
            var current = category
            while let parentId = current.parentId, let parent = byId[parentId],
                !seen.contains(parent.id)
            {
                seen.insert(parent.id)
                current = parent
                count += 1
            }
            return count
        }

        return categories
            .map { category in
                CategoryChoice(
                    id: category.id,
                    name: category.name,
                    path: Categories.categoryPathName(byId, id: category.id),
                    kind: category.kind,
                    depth: depth(of: category),
                    archived: category.archived
                )
            }
            .sorted {
                if $0.path != $1.path { return $0.path < $1.path }
                return $0.id < $1.id
            }
    }

    /// The categories this book leans on, most-used first.
    ///
    /// COUNTED OVER THE RECENT PAST, not over all time, and "recent" is
    /// measured from the NEWEST TRANSACTION IN THE BOOK rather than from the
    /// device clock. An imported backup can be a week old or a year old; using
    /// today's date would silently return nothing for the older one, and a row
    /// of quick-pick buttons that is empty on some books and full on others is
    /// worse than one that is always full.
    ///
    /// Transfers are excluded: they have no category, by construction.
    public func frequentCategoryIds(limit: Int = 8, withinDays: Int = 120) throws -> [String] {
        guard let newest = try connection.scalarText("SELECT max(date) FROM live_transactions"),
            let anchor = CalendarDate(iso: newest)
        else { return [] }
        let since = anchor.addingDays(-withinDays).iso

        let statement = try connection.prepare(
            """
            SELECT cat, count(*) AS uses, max(day) AS latest FROM (
                SELECT CASE WHEN s.transaction_id IS NULL THEN t.category_id ELSE s.category_id END
                           AS cat,
                       t.date AS day
                FROM live_transactions t
                LEFT JOIN transaction_splits s ON s.transaction_id = t.id
                WHERE t.transfer_group_id IS NULL AND t.date >= ?
            )
            WHERE cat IS NOT NULL
            GROUP BY cat
            ORDER BY uses DESC, latest DESC, cat ASC
            LIMIT ?
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: since)
        statement.bind(2, integer: limit)
        var out: [String] = []
        while try statement.step() { out.append(try statement.text(0)) }
        return out
    }

    /// Everything Quick Add opens with, from one read of the ledger.
    ///
    /// One call rather than five, for the same reason `accountsSnapshot` is one
    /// call: the account the sheet defaults to and the list it offers must come
    /// from the same book.
    public func quickAddContext() throws -> QuickAddContext {
        let accounts = try readAccounts(from: "live_accounts")
        let enGB = Locale(identifier: "en_GB")
        let ordered = accounts.enumerated()
            .sorted { lhs, rhs in
                // Archived last, then sidebar order. An archived account is
                // still selectable; it is just not what a new entry means.
                if lhs.element.archived != rhs.element.archived { return !lhs.element.archived }
                if lhs.element.sortOrder != rhs.element.sortOrder {
                    return lhs.element.sortOrder < rhs.element.sortOrder
                }
                let byName = lhs.element.name.compare(
                    rhs.element.name, options: [], range: nil, locale: enGB
                )
                if byName != .orderedSame { return byName == .orderedAscending }
                return lhs.offset < rhs.offset
            }
            .map(\.element)

        let remembered = try readSettings()?.lastUsedAccountId
        // The remembered account may have been archived or deleted since. Fall
        // back rather than defaulting a new entry into a row that is not there.
        let usable = remembered.flatMap { id in ordered.first { $0.id == id && !$0.archived } }
        let fallback = ordered.first { !$0.archived } ?? ordered.first

        return QuickAddContext(
            accounts: ordered,
            defaultAccountId: (usable ?? fallback)?.id,
            categories: try categoryChoices(),
            frequentCategoryIds: try frequentCategoryIds(),
            payees: try payeeIndex()
        )
    }
}
