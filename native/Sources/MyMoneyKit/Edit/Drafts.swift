// What a screen hands the store when the owner taps Save.
//
// A DRAFT IS NOT A RECORD, and keeping them separate types is the whole point.
// A `Transaction` carries `currency`, `dedupeHash`, `createdAt`, `updatedAt`,
// `payeeId`, `tagIds` -- six fields nobody types, four of which the store is the
// only correct source of. A form that filled in a `Transaction` would have to
// invent them, and the first thing it would get wrong is `currency`: it belongs
// to the ACCOUNT, and a transaction whose currency disagrees with its account's
// is a row whose amount means something other than what it says.
//
// So a draft carries only what a person decides, in the vocabulary a person
// uses -- a payee NAME, not a payee id; tag NAMES, not tag ids -- and the store
// resolves it. That is also what makes "payee autocomplete that learns" work
// without the form knowing anything: typing a name that does not exist yet
// creates it, typing one that does reuses it, and the case they typed it in
// does not make a second payee.
import Foundation

/// One ordinary transaction, as a form holds it.
public struct TransactionDraft: Sendable, Hashable {
    /// nil to create. Present to update THAT row -- there is no upsert-by-value
    /// anywhere in this package, because "save this transaction" and "save a
    /// transaction that looks like this" are different requests and a ledger
    /// that confuses them acquires duplicates.
    public var id: String?
    public var accountId: String
    /// "YYYY-MM-DD".
    public var date: String
    /// Signed minor units in the ACCOUNT's currency: negative is money out.
    public var amountMinor: Int64
    /// Typed, not chosen. Blank means no payee.
    public var payeeName: String
    public var categoryId: String?
    /// Typed, not chosen. Blank entries are skipped; case-insensitive
    /// duplicates collapse.
    public var tagNames: [String]
    public var notes: String
    public var status: TxStatus
    /// Empty for an unsplit transaction. When non-empty these must sum EXACTLY
    /// to `amountMinor` -- see `SplitTally`.
    public var splits: [Split]

    public init(
        id: String? = nil,
        accountId: String,
        date: String,
        amountMinor: Int64,
        payeeName: String = "",
        categoryId: String? = nil,
        tagNames: [String] = [],
        notes: String = "",
        status: TxStatus = .cleared,
        splits: [Split] = []
    ) {
        self.id = id
        self.accountId = accountId
        self.date = date
        self.amountMinor = amountMinor
        self.payeeName = payeeName
        self.categoryId = categoryId
        self.tagNames = tagNames
        self.notes = notes
        self.status = status
        self.splits = splits
    }

    /// The tally for this draft's splits, for the live remainder on screen.
    /// `currency` is the account's -- the draft does not carry it, on purpose.
    public func splitTally(currency: String) -> SplitTally {
        SplitTally.of(amountMinor: amountMinor, splits: splits, currency: currency)
    }
}

/// A transfer, as a form holds it: ONE thing the owner edits, which the store
/// writes as two rows.
///
/// THE AMOUNTS ARE MAGNITUDES, both positive, and the sign is decided by which
/// account each is attached to. A draft that carried signed amounts would let a
/// form send two negatives and produce a "transfer" that destroys money.
///
/// BOTH AMOUNTS ARE EXPLICIT even when the accounts share a currency, and
/// especially when they do not (SPEC 5). A cross-currency transfer whose second
/// figure was derived from a stored rate would change value every time the rate
/// table was edited, which is not what happened in the world: the bank moved
/// one number out and put a different number in, and both are facts.
public struct TransferDraft: Sendable, Hashable {
    /// nil to create a new transfer; the group id to edit an existing pair.
    public var transferGroupId: String?
    public var fromAccountId: String
    public var toAccountId: String
    public var date: String
    /// Positive magnitude leaving `from`, in the FROM account's currency.
    public var amountFromMinor: Int64
    /// Positive magnitude arriving in `to`, in the TO account's currency.
    public var amountToMinor: Int64
    public var notes: String
    public var status: TxStatus

    public init(
        transferGroupId: String? = nil,
        fromAccountId: String,
        toAccountId: String,
        date: String,
        amountFromMinor: Int64,
        amountToMinor: Int64,
        notes: String = "",
        status: TxStatus = .cleared
    ) {
        self.transferGroupId = transferGroupId
        self.fromAccountId = fromAccountId
        self.toAccountId = toAccountId
        self.date = date
        self.amountFromMinor = amountFromMinor
        self.amountToMinor = amountToMinor
        self.notes = notes
        self.status = status
    }
}

/// An account, as the account editor holds it.
///
/// WHAT IS NOT HERE IS AS IMPORTANT AS WHAT IS. `excludeFromNetWorth` and the
/// three loan fields are absent, so a rename CANNOT drop them: the store
/// carries them over from the existing row. That mirrors the web app's
/// `...existing` spread, and the comment there is worth repeating -- renaming an
/// account must never silently pull an excluded property back into net worth.
public struct AccountDraft: Sendable, Hashable {
    public var id: String?
    public var name: String
    public var type: AccountType
    /// Three letters. IMMUTABLE once the account has transactions.
    public var currency: String
    public var openingBalanceMinor: Int64
    /// "#rrggbb" or "#rgb".
    public var colour: String
    public var groupId: String?
    /// nil: keep the existing order, or append at the end for a new account.
    public var sortOrder: Int?
    /// nil: keep the existing flag, or false for a new account.
    public var archived: Bool?

    public init(
        id: String? = nil,
        name: String,
        type: AccountType,
        currency: String,
        openingBalanceMinor: Int64 = 0,
        colour: String = "#64748b",
        groupId: String? = nil,
        sortOrder: Int? = nil,
        archived: Bool? = nil
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
    }
}

/// An account group.
public struct AccountGroupDraft: Sendable, Hashable {
    public var id: String?
    public var name: String
    public var sortOrder: Int?

    public init(id: String? = nil, name: String, sortOrder: Int? = nil) {
        self.id = id
        self.name = name
        self.sortOrder = sortOrder
    }
}

/// Which way a row moves when the owner reorders.
public enum MoveDirection: Sendable, Hashable {
    case up, down
}
