// The one door to the database.
//
// `LedgerStore` says of itself: "deliberately not Sendable: one owner, one
// thread. A later phase that needs it from several tasks should put an actor in
// front of it." This is that actor. It is the ONLY thing in the app that holds
// a store, and nothing it returns is a reference to one -- every value that
// leaves here is a `Sendable` struct, so there is no way for a view to end up
// holding the database and touching it from the main thread while an import is
// running on another.
//
// WHY THE WORK IS OFF THE MAIN ACTOR AT ALL. Importing the owner's real backup
// parses 3 MB of JSON, validates it against its own manifest, and writes eleven
// tables inside one transaction. On the main thread that is a frozen app for
// as long as it takes. Every method here is `async` from the caller's side, so
// the UI keeps drawing and can say what it is doing.
//
// READ-ONLY, AND STRUCTURALLY SO. There is no method here that edits a row.
// The only write is `importBackup`, which replaces the whole local copy with a
// file the owner chose -- and even that cannot change the web app, which is the
// system of record.
import Foundation
import MyMoneyKit

/// What the app knows about the book it is holding, without holding the book.
struct LedgerSummary: Sendable {
    let snapshot: AccountsSnapshot
    let transactionCount: Int
    let accountCount: Int
    let provenance: StoreProvenance
    /// Where the local copy lives, so the owner can be told exactly what this
    /// app has and where.
    let storePath: String
}

/// What an import verified, in the words the owner should see.
struct ImportSummary: Sendable {
    let accountCount: Int
    let transactionCount: Int
    /// Every table the file carried, for the detail list.
    let rowCounts: [(table: String, count: Int)]
    let netWorthMinor: Int64
    let baseCurrency: String
    let missingRateCurrencies: [String]
    /// The file carried a manifest this build knows how to check, and the rows
    /// were recomputed against it and agreed. False means the file simply made
    /// no checkable claim -- not that a claim failed, which is a refusal.
    let manifestVerified: Bool
    /// The store re-exported to the same canonical content hash it read.
    let reproducesSource: Bool
    let contentHash: String
    let exportedAt: String
    let warnings: [String]
    let fileName: String
}

/// Why an import was refused, with the disagreement named.
struct ImportRefusal: Error, Sendable {
    let headline: String
    /// One line per thing that disagreed. Empty for a file that was not a
    /// backup at all.
    let problems: [String]
    let fileName: String
}

actor LedgerService {
    private var store: LedgerStore?

    /// Where the local copy of the book lives.
    ///
    /// Application Support, under the bundle id, which is the directory macOS
    /// and iOS both mean by "data this app owns that the user did not create".
    /// NOT Documents: on iOS that is user-visible and syncable, and a shadow
    /// copy of a ledger appearing in Files beside the real backups is exactly
    /// the confusion this whole phase is trying to avoid.
    static func defaultStoreURL() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        )
        let directory = base.appendingPathComponent(
            Bundle.main.bundleIdentifier ?? "com.gs.MyMoneyNative", isDirectory: true
        )
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("ledger.sqlite")
    }

    private func opened() throws -> LedgerStore {
        if let store { return store }
        let store = try LedgerStore.open(at: try Self.defaultStoreURL())
        self.store = store
        return store
    }

    /// Everything the accounts screen needs, or nil when this device holds no
    /// book yet.
    func summary() throws -> LedgerSummary? {
        let store = try opened()
        if try store.isEmpty() { return nil }
        return LedgerSummary(
            snapshot: try store.accountsSnapshot(),
            transactionCount: try store.registerCount(scope: .allAccounts),
            accountCount: try store.liveCount("accounts"),
            provenance: try store.provenance(),
            storePath: store.path
        )
    }

    func registerLookups() throws -> RegisterLookups {
        try opened().registerLookups()
    }

    func registerCount(scope: RegisterScope) throws -> Int {
        try opened().registerCount(scope: scope)
    }

    func registerPage(
        scope: RegisterScope, after cursor: RegisterCursor?, limit: Int,
        lookups: RegisterLookups
    ) throws -> RegisterPage {
        try opened().registerPage(scope: scope, after: cursor, limit: limit, lookups: lookups)
    }

    /// Read a backup file into the local copy, replacing whatever was there.
    ///
    /// THE REFUSAL IS THE FEATURE. `BackupImporter` recomputes every count and
    /// every total the file claims, from the file's own rows, under the file's
    /// own manifest version, and throws before the database is opened for
    /// writing if any of them disagree. This method's whole job is to turn that
    /// into something a person can read; it adds no check of its own and
    /// relaxes none.
    ///
    /// `requiringExactRoundTrip` is deliberately NOT set. It would turn "this
    /// build cannot re-serialise one key it does not model" into a refusal of a
    /// perfectly sound backup, and refusing a sound backup is the worst outcome
    /// available here. The round trip is REPORTED instead -- see
    /// `ImportSummary.reproducesSource` -- so the owner sees the evidence
    /// rather than being protected from it.
    func importBackup(data: Data, fileName: String) throws -> ImportSummary {
        let store = try opened()
        let result: StoreImportResult
        do {
            result = try store.importBackup(data: data, replacingExistingBook: true)
        } catch let error as BackupImportError {
            switch error {
            case .manifestDisagrees(let problems):
                throw ImportRefusal(
                    headline:
                        "This file's own summary does not match the rows inside it, so nothing "
                        + "was imported and the copy already on this device is untouched.",
                    problems: problems,
                    fileName: fileName
                )
            case .invalid(let message):
                throw ImportRefusal(
                    headline: "This is not a backup this app can read.",
                    problems: [message],
                    fileName: fileName
                )
            }
        }

        let snapshot = try store.accountsSnapshot()
        let counts = Schema.allTables.map { table in
            (table: table, count: result.rowCounts[table] ?? 0)
        }
        return ImportSummary(
            accountCount: result.rowCounts["accounts"] ?? 0,
            transactionCount: result.rowCounts["transactions"] ?? 0,
            rowCounts: counts,
            netWorthMinor: snapshot.netWorth.totalBaseMinor,
            baseCurrency: snapshot.netWorth.baseCurrency,
            missingRateCurrencies: snapshot.netWorth.missingRateCurrencies,
            manifestVerified: result.imported.verified,
            reproducesSource: result.reproducesSource,
            contentHash: result.sourceContentHash,
            exportedAt: result.imported.file.exportedAt,
            warnings: result.warnings,
            fileName: fileName
        )
    }
}
