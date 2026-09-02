// Starting a book here, with no backup and no browser involved.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. Until now the only way a book could get into this store was
// `importBackup`: the empty state said "export a backup from your web app, then
// import it here", the Add menu was disabled while there was no book, and there
// was no seed anywhere in the package. That is the right shape for the ONE book
// this app was built around -- the owner's real ledger, which the web app holds
// and which must be copied rather than retyped -- and it is the wrong shape for
// anybody opening the app for the first time, who is told that the only way to
// begin is to go and use a different app first.
//
// So: a book can now be created. It is not a lesser book -- it gets the same
// category tree the browser seeds, it takes the same edits, it exports to the
// same file format -- it simply has no counterpart anywhere else, and the store
// remembers that (see BookOrigin.swift) so that nothing in the app tells its
// owner that a web app they may never have used holds the real version.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO RULES THIS PATH DOES NOT GET TO BEND
//
//   1. IT CANNOT DESTROY ANYTHING. A create is refused outright on a store that
//      already holds a book, with no flag to override it. `importBackup` has
//      such a flag because a restore is asked for by somebody holding the file
//      they mean to restore; "start fresh" is a button, and a button that can
//      silently replace an imported ledger is a way to lose a book.
//
//   2. IT IS ONE TRANSACTION. The settings row, the sixty-one categories, the
//      origin, and any starting accounts either all land or none do. A book
//      half-created -- categories but no settings, or a settings row with no
//      base currency behind it -- is worse than no book at all: the app would
//      open, look like it worked, and be wrong about what currency the owner's
//      money is in.
import Foundation

/// What creating a book put in the store.
public struct CreatedBook: Sendable {
    /// The settings row, including the base currency every total is
    /// denominated in.
    public let settings: Settings
    /// The seeded category tree, in the order it was written.
    public let categories: [Category]
    /// The starting accounts, if the caller asked for any. Empty is the normal
    /// case: a book is created first and accounts are added afterwards through
    /// the ordinary account editor.
    public let accounts: [Account]

    public var baseCurrency: String { settings.baseCurrency }
}

extension LedgerStore {

    /// The id of the single settings row, matching `defaultSettings()` in
    /// src/db/db.ts. A book whose settings row had a different id would be a
    /// book the browser's `getSettings()` could not find.
    static let settingsRowId = "app"

    /// Create an empty book: a settings row in the chosen base currency, the
    /// seeded category tree, and nothing else.
    ///
    /// `startingAccounts` is the ONE optional extra, and it is optional in both
    /// senses -- absent by default, and expressible as an ordinary
    /// `saveAccount` afterwards. It exists because the web app's onboarding
    /// writes the base currency and the ticked starter accounts in a SINGLE
    /// transaction (src/ui/onboarding/setup.ts), and for the same reason: a
    /// first run interrupted between "book created" and "accounts created"
    /// leaves a state somebody then has to reason about. Passing drafts here
    /// makes the whole of first-run one commit. Each draft goes through
    /// `saveAccount`, so it is validated, named, coloured and ordered exactly
    /// as an account added later would be -- there is no second account writer.
    ///
    /// THE OPENING BALANCES ARE THE CALLER'S. `AccountTemplate.draft` hands
    /// back zero, and a screen that collects a typed amount must parse it with
    /// `Money`/`MoneyText` and refuse what does not parse rather than passing
    /// zero -- an opening balance quietly defaulted to zero is the one figure
    /// every future balance of that account is built on.
    ///
    /// Throws `EditError.badCurrency` for a code that is not three letters, and
    /// `StoreError.bookAlreadyExists` when this device already holds a book.
    /// Nothing is written in either case.
    @discardableResult
    public func createBook(
        baseCurrency: String,
        startingAccounts: [AccountDraft] = []
    ) throws -> CreatedBook {
        let currency = Names.clean(baseCurrency).uppercased()
        guard Validate.isCurrencyCode(currency) else {
            throw EditError.badCurrency(baseCurrency)
        }

        return try connection.transaction {
            // ASKED INSIDE THE TRANSACTION, for the reason the web app's
            // `createAccountsAndSettings` gives: a check that happens before
            // the write is a check another writer can slip past. `BEGIN
            // IMMEDIATE` (SQLite.swift) takes the write lock here, so the
            // answer cannot change under us.
            guard try isEmpty() else {
                throw StoreError.bookAlreadyExists(
                    accounts: try liveCount("accounts"),
                    transactions: try liveCount("transactions")
                )
            }

            // THE ORIGIN GOES FIRST, before a single row of the book. Two
            // reasons, and the second is not obvious: `saveAccount` below calls
            // `recordLocalEdit`, which asks the store where the book came from
            // and counts nothing for a created one. Writing the origin after
            // the accounts would leave this book claiming, for ever, that the
            // owner's first four accounts are "changes not in your web app".
            try setBookOrigin(.created)
            // A store with no book has no drift to report either. Explicit
            // rather than assumed: the counters live in `store_meta`, which
            // `isEmpty()` does not look at.
            try clearLocalEdits()

            let settings = Self.newSettings(baseCurrency: currency, createdAt: environment.now())
            try writeSettings(settings)

            let categories = StarterBook.categories(newId: environment.newId)
            try writeCategories(categories)

            var accounts: [Account] = []
            for draft in startingAccounts {
                // Through the ordinary editor path: one account writer, one set
                // of refusals, one place that decides a sort order.
                accounts.append(try saveAccount(draft))
            }

            // The same audit `importBackup` runs, in the same place -- inside
            // the transaction, so a store that somehow held a floating-point
            // amount is never committed. Unreachable through this package's
            // writers, which is exactly why it is worth asking.
            if let problem = try auditMoneyColumns().first { throw problem }

            return CreatedBook(settings: settings, categories: categories, accounts: accounts)
        }
    }

    /// The settings row a new book starts with, matching `defaultSettings()` in
    /// src/db/db.ts field for field where the field means anything here.
    ///
    /// `onboarded` IS TRUE, and that is a decision rather than a copy. In the
    /// browser the flag is written LAST, at the end of the wizard, so that an
    /// interrupted first run comes back to step one; here the whole of setting
    /// up is this one transaction, so by the time the row exists it is done. It
    /// also matters on the way out: a backup of this book restored into the web
    /// app would otherwise drop the browser into its onboarding wizard for a
    /// book that has already been set up.
    ///
    /// THE `sync*` KEYS ARE ABSENT, not defaulted. They are device-local
    /// bookkeeping for a sync engine this app does not have, and writing
    /// `syncDeviceId: ""` here would be this device claiming a sync identity it
    /// has never had. The browser's `getSettings()` spreads a stored row over
    /// its own defaults, so an absent key gains the default there and nothing
    /// is lost; a fabricated one, by contrast, would travel in the file.
    static func newSettings(baseCurrency: String, createdAt: String) -> Settings {
        let bare = Settings(
            id: settingsRowId,
            schemaVersion: Schema.version,
            baseCurrency: baseCurrency,
            theme: .system,
            lastBackupAt: nil,
            onboarded: true,
            lastUsedAccountId: nil,
            savedMappings: [:],
            createdAt: createdAt,
            autoFxEnabled: true,
            lastFxSyncAt: nil,
            lastFxSyncSource: nil,
            raw: .object([:])
        )
        // `raw` is the row VERBATIM, and every reader in this package that
        // re-serialises settings works from it. Building it from the record
        // through the same function the backup writer uses means a created
        // book's settings row is written out the way the browser writes one --
        // and it is a fixed point: `unmodelledSettingsKeys` finds nothing extra
        // in it, so a second pass would produce the same object.
        let row = BackupWriter.settingsRow(bare)
        return Settings(
            id: bare.id,
            schemaVersion: bare.schemaVersion,
            baseCurrency: bare.baseCurrency,
            theme: bare.theme,
            lastBackupAt: bare.lastBackupAt,
            onboarded: bare.onboarded,
            lastUsedAccountId: bare.lastUsedAccountId,
            savedMappings: bare.savedMappings,
            createdAt: bare.createdAt,
            autoFxEnabled: bare.autoFxEnabled,
            lastFxSyncAt: bare.lastFxSyncAt,
            lastFxSyncSource: bare.lastFxSyncSource,
            raw: row
        )
    }
}
