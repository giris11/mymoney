// Every persisted record shape, ported from src/db/types.ts.
//
// Monetary amounts are ALWAYS Int64 in the currency's minor units. There is no
// Double, no Decimal and no Float anywhere in this file, and there never will
// be: the type is the guarantee.
//
// These are value types with `let` members. They are the data, not a live view
// of a database, so nothing here is mutable and everything is Sendable -- which
// is also what makes strict concurrency free rather than a fight.
//
// WHAT IS DELIBERATELY NOT MODELLED. `scheduled`, `goals`, `holdings` and
// `attachments` are SPEC Phase 2/3 tables that do not exist in the TypeScript
// build either. Adding empty Swift types for them now would be inventing a
// schema nobody has designed.
import Foundation

// MARK: - Enumerations

public enum AccountType: String, Sendable, Hashable, CaseIterable {
    case current, savings
    case creditCard = "credit_card"
    case cash, loan, investment
}

public enum TxStatus: String, Sendable, Hashable, CaseIterable {
    case cleared, pending
}

public enum CategoryKind: String, Sendable, Hashable, CaseIterable {
    case income, expense
}

public enum BudgetPeriod: String, Sendable, Hashable, CaseIterable {
    case weekly, monthly, yearly
}

public enum ThemeChoice: String, Sendable, Hashable, CaseIterable {
    case system, light, dark
}

public enum ImportSource: String, Sendable, Hashable, CaseIterable {
    case moneywiz, csv, sample
}

public enum FxRateSource: String, Sendable, Hashable, CaseIterable {
    case manual, auto
}

// MARK: - Records

public struct Account: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let type: AccountType
    /// ISO code, e.g. "GBP". The account's balance is in THIS currency, always,
    /// and is never converted -- only a total is.
    public let currency: String
    public let openingBalanceMinor: Int64
    public let colour: String
    public let groupId: String?
    public let sortOrder: Int
    /// Retired. Out of net-worth totals, and out of the accounts list.
    public let archived: Bool
    /// "Show it, don't count it" -- SPEC's excludeFromNetWorth.
    ///
    /// It changes what a TOTAL counts and NOTHING else. The account keeps its
    /// own balance, every transaction is untouched, no amount is recomputed,
    /// and it stays visible: "not counted" is not "hidden", and the owner must
    /// never be unable to find their money. It composes with `archived`
    /// (archived OR excluded implies not counted).
    ///
    /// OPTIONAL, matching the TypeScript's `excludeFromNetWorth?: boolean`:
    /// nil means the row does not carry the key at all.
    ///
    /// It was a plain `Bool` here first, with the decoder resolving absent to
    /// false in one place so the rest of the package never had three states to
    /// reason about where the money rules only have two. THAT WAS RIGHT FOR
    /// THE ARITHMETIC AND WRONG FOR THE FILE. A backup's content hash covers
    /// key PRESENCE -- `{"archived":false}` and `{}` are different bytes -- and
    /// both spellings occur in the wild: every account row written before the
    /// flag existed omits it, and `setAccountExcluded` in
    /// src/domain/accounts.ts writes a literal `false` when the owner switches
    /// an excluded account back on. Collapsing them meant an exported row could
    /// not be written back the way it arrived, which is exactly the divergence
    /// this port has to be able to prove it does not have.
    ///
    /// The three states never reach the money rules: `Balances` asks
    /// `== true`, which is the TypeScript's `=== true`, so absent and false
    /// remain the same answer to the only question anyone asks of it.
    public let excludeFromNetWorth: Bool?

    // Loan fields (SPEC Phase 2 amortisation view). Absent on every other type.
    public let loanPrincipalMinor: Int64?
    public let loanRatePct: Double?
    public let loanTermMonths: Int?

    public init(
        id: String, name: String, type: AccountType, currency: String,
        openingBalanceMinor: Int64, colour: String = "", groupId: String? = nil,
        sortOrder: Int = 0, archived: Bool = false, excludeFromNetWorth: Bool? = nil,
        loanPrincipalMinor: Int64? = nil, loanRatePct: Double? = nil, loanTermMonths: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.currency = currency
        self.openingBalanceMinor = openingBalanceMinor
        self.colour = colour
        self.groupId = groupId
        self.sortOrder = sortOrder
        self.archived = archived
        self.excludeFromNetWorth = excludeFromNetWorth
        self.loanPrincipalMinor = loanPrincipalMinor
        self.loanRatePct = loanRatePct
        self.loanTermMonths = loanTermMonths
    }
}

public struct AccountGroup: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let sortOrder: Int

    public init(id: String, name: String, sortOrder: Int) {
        self.id = id
        self.name = name
        self.sortOrder = sortOrder
    }
}

public struct Split: Sendable, Hashable {
    public let categoryId: String?
    /// Signed, same convention as the parent transaction.
    public let amountMinor: Int64
    public let notes: String?

    public init(categoryId: String?, amountMinor: Int64, notes: String? = nil) {
        self.categoryId = categoryId
        self.amountMinor = amountMinor
        self.notes = notes
    }
}

public struct Transaction: Sendable, Hashable, Identifiable {
    public let id: String
    public let accountId: String
    /// "YYYY-MM-DD" -- a calendar date, deliberately not a Date.
    ///
    /// A Date is an instant, and an instant has a timezone. A transaction
    /// dated the 1st that becomes the 31st of the previous month when the
    /// phone is in Sydney is a real bug in real finance apps, and it moves
    /// money between budget periods and between tax years. The string IS the
    /// fact; anything that needs calendar arithmetic parses it explicitly.
    public let date: String
    /// Signed: expenses negative, income positive.
    public let amountMinor: Int64
    /// Equal to the account's currency, by construction.
    public let currency: String
    public let payeeId: String?
    /// nil for transfers and uncategorised.
    public let categoryId: String?
    public let tagIds: [String]
    public let notes: String
    public let status: TxStatus
    /// Non-empty implies these must sum EXACTLY to `amountMinor`.
    public let splits: [Split]
    /// The two legs of a transfer share one id.
    public let transferGroupId: String?
    public let importBatchId: String?
    public let dedupeHash: String
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String, accountId: String, date: String, amountMinor: Int64, currency: String,
        payeeId: String? = nil, categoryId: String? = nil, tagIds: [String] = [],
        notes: String = "", status: TxStatus = .cleared, splits: [Split] = [],
        transferGroupId: String? = nil, importBatchId: String? = nil,
        dedupeHash: String = "", createdAt: String = "", updatedAt: String = ""
    ) {
        self.id = id
        self.accountId = accountId
        self.date = date
        self.amountMinor = amountMinor
        self.currency = currency
        self.payeeId = payeeId
        self.categoryId = categoryId
        self.tagIds = tagIds
        self.notes = notes
        self.status = status
        self.splits = splits
        self.transferGroupId = transferGroupId
        self.importBatchId = importBatchId
        self.dedupeHash = dedupeHash
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// SPEC 6: splits must sum EXACTLY to the parent amount.
    ///
    /// "Exactly" with integers means exactly -- no epsilon, no tolerance, no
    /// "close enough to a penny". A transaction with no splits is trivially
    /// valid; one whose splits are short by a penny is not a rounding problem,
    /// it is a transaction that does not add up.
    public func validateSplits() throws -> Bool {
        if splits.isEmpty { return true }
        return try Money.sumSplits(splits) == amountMinor
    }
}

public struct Category: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    /// Multi-level tree. nil is a top-level category.
    public let parentId: String?
    public let kind: CategoryKind
    public let icon: String?
    public let colour: String?
    public let archived: Bool
    public let sortOrder: Int

    public init(
        id: String, name: String, parentId: String? = nil, kind: CategoryKind,
        icon: String? = nil, colour: String? = nil, archived: Bool = false, sortOrder: Int = 0
    ) {
        self.id = id
        self.name = name
        self.parentId = parentId
        self.kind = kind
        self.icon = icon
        self.colour = colour
        self.archived = archived
        self.sortOrder = sortOrder
    }
}

public struct Payee: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    /// Lowercased name, stored for a case-insensitive index. Storage detail
    /// the oracle books omit, so it defaults to the lowercased name.
    public let nameLower: String
    /// Learned from history (SPEC 7.4).
    public let defaultCategoryId: String?

    public init(id: String, name: String, nameLower: String? = nil, defaultCategoryId: String? = nil) {
        self.id = id
        self.name = name
        self.nameLower = nameLower ?? name.lowercased()
        self.defaultCategoryId = defaultCategoryId
    }
}

public struct Tag: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let nameLower: String

    public init(id: String, name: String, nameLower: String? = nil) {
        self.id = id
        self.name = name
        self.nameLower = nameLower ?? name.lowercased()
    }
}

public struct Budget: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    /// Descendants are included when computing spend (D16).
    public let categoryIds: [String]
    /// In BASE currency (D22), not in any account's currency.
    public let amountMinor: Int64
    public let period: BudgetPeriod
    /// "YYYY-MM-DD" anchor for the period windows.
    public let startDate: String
    /// SPEC Phase 2; stored now for forward compatibility.
    public let rollover: Bool
    public let archived: Bool

    public init(
        id: String, name: String, categoryIds: [String], amountMinor: Int64,
        period: BudgetPeriod, startDate: String, rollover: Bool = false, archived: Bool = false
    ) {
        self.id = id
        self.name = name
        self.categoryIds = categoryIds
        self.amountMinor = amountMinor
        self.period = period
        self.startDate = startDate
        self.rollover = rollover
        self.archived = archived
    }
}

/// 1 unit of `base` = `rate` units of `quote` (D11).
///
/// `rate` is the one Double in the record model, and it is a Double because a
/// rate is genuinely not a decimal quantity -- 0.007758418188252167 is what the
/// source published. It never touches a stored amount: it is an input to a
/// display-time conversion whose output is rounded back to Int64 exactly once
/// (Money.convert).
public struct FxRate: Sendable, Hashable, Identifiable {
    /// "\(base):\(quote)".
    public let id: String
    public let base: String
    public let quote: String
    public let rate: Double
    public let asOf: String
    public let source: FxRateSource

    public init(base: String, quote: String, rate: Double, asOf: String = "", source: FxRateSource = .manual) {
        self.id = "\(base):\(quote)"
        self.base = base
        self.quote = quote
        self.rate = rate
        self.asOf = asOf
        self.source = source
    }

    public init(id: String, base: String, quote: String, rate: Double, asOf: String, source: FxRateSource) {
        self.id = id
        self.base = base
        self.quote = quote
        self.rate = rate
        self.asOf = asOf
        self.source = source
    }
}

/// Every import is undoable as one unit, so it records what it created.
public struct ImportBatch: Sendable, Hashable, Identifiable {
    public let id: String
    public let source: ImportSource
    public let fileName: String
    public let rowCount: Int
    public let importedAt: String
    public let createdAccountIds: [String]
    public let createdCategoryIds: [String]
    public let createdPayeeIds: [String]
    public let createdTagIds: [String]
    public let createdGroupIds: [String]
    /// Only the sample-data batch creates these (D19), so they are optional --
    /// absent and empty are different claims and both occur in real files.
    public let createdBudgetIds: [String]?
    public let createdFxRateIds: [String]?

    public init(
        id: String, source: ImportSource, fileName: String, rowCount: Int, importedAt: String,
        createdAccountIds: [String] = [], createdCategoryIds: [String] = [],
        createdPayeeIds: [String] = [], createdTagIds: [String] = [], createdGroupIds: [String] = [],
        createdBudgetIds: [String]? = nil, createdFxRateIds: [String]? = nil
    ) {
        self.id = id
        self.source = source
        self.fileName = fileName
        self.rowCount = rowCount
        self.importedAt = importedAt
        self.createdAccountIds = createdAccountIds
        self.createdCategoryIds = createdCategoryIds
        self.createdPayeeIds = createdPayeeIds
        self.createdTagIds = createdTagIds
        self.createdGroupIds = createdGroupIds
        self.createdBudgetIds = createdBudgetIds
        self.createdFxRateIds = createdFxRateIds
    }
}

/// A saved generic-CSV column mapping (SPEC 7.2). Column indices; -1 means the
/// column is not present.
public struct ColumnMapping: Sendable, Hashable {
    public let date: Int
    public let amount: Int
    public let debit: Int
    public let credit: Int
    public let payee: Int
    public let description: Int
    public let category: Int
    public let account: Int
    public let currency: Int
    public let tags: Int
    public let notes: Int
    public let dateFormat: String
    public let decimal: String
    public let negate: Bool
    public let headerRow: Bool
}

/// The single settings row (id "app").
///
/// HALF BOOK, HALF DEVICE, and the split is load-bearing -- src/db/db.ts's
/// DEVICE_LOCAL_SETTING_KEYS is the authority on which is which. Only the
/// BOOK-level half is given typed fields here, because that is the half this
/// package reasons about (the base currency decides what net worth is
/// denominated in, and nothing else here cares about a sync revision).
///
/// `raw` keeps the entire row exactly as it was parsed, including the
/// device-local half and any key a newer build added. That is not tidiness: a
/// backup's hash covers the settings row, so a re-serialisation that dropped a
/// key it did not recognise would silently produce a different fingerprint for
/// the same file.
public struct Settings: Sendable, Hashable, Identifiable {
    public let id: String
    public let schemaVersion: Int
    public let baseCurrency: String
    public let theme: ThemeChoice
    public let lastBackupAt: String?
    public let onboarded: Bool
    public let lastUsedAccountId: String?
    public let savedMappings: [String: ColumnMapping]
    public let createdAt: String
    public let autoFxEnabled: Bool
    public let lastFxSyncAt: String?
    public let lastFxSyncSource: String?
    /// The whole row, verbatim.
    public let raw: JSONValue
}
